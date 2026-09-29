'use strict';

const { getCategory } = require('./categories');

let transporter = null;
let transporterChecked = false;

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST);
}

function getTransporter() {
  if (transporterChecked) return transporter;
  transporterChecked = true;
  if (!smtpConfigured()) return null;
  const nodemailer = require('nodemailer');
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === '1' || Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transporter;
}

function matches(sub, listing) {
  let cats = [];
  try {
    cats = JSON.parse(sub.categories);
  } catch {
    cats = [];
  }
  if (cats.length && !cats.includes(listing.category)) return false;
  if (sub.location && listing.location !== sub.location) return false;
  const kws = sub.keywords
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  if (kws.length) {
    const text = `${listing.title} ${listing.description} ${listing.company}`.toLowerCase();
    if (!kws.some((k) => text.includes(k))) return false;
  }
  return true;
}

function listingLine(l, baseUrl) {
  const cat = getCategory(l.category);
  return `• [${cat ? cat.label : l.category}] ${l.title}${l.location ? ` — ${l.location}` : ''}\n  ${baseUrl}/#/aviso/${l.id}`;
}

function footer(sub, baseUrl) {
  return `\n\n—\nRecibís este correo porque configuraste alertas en Maldonado Oportunidades.\nModificar o cancelar: ${baseUrl}/#/alertas?token=${sub.token}\nDarte de baja: ${baseUrl}/api/subscriptions/${sub.token}/unsubscribe`;
}

function enqueueEmail(db, to, subject, body, { html = '', campaignId = null, unsubscribeUrl = '' } = {}) {
  db.prepare('INSERT INTO outbox (to_email, subject, body, html, campaign_id, unsubscribe_url) VALUES (?, ?, ?, ?, ?, ?)').run(
    to, subject, body, html, campaignId, unsubscribeUrl,
  );
}

/** Se llama cuando un aviso pasa a "aprobado". */
function notifyNewListing(db, listing, baseUrl) {
  if (!listing || listing.status !== 'approved' || listing.notified || listing.payment_status === 'unpaid') return 0;
  const subs = db.prepare('SELECT * FROM subscriptions WHERE active = 1 AND confirmed = 1').all();
  let count = 0;
  for (const sub of subs) {
    if (!matches(sub, listing)) continue;
    count++;
    if (sub.frequency === 'instant') {
      enqueueEmail(
        db,
        sub.email,
        `Nuevo aviso: ${listing.title}`,
        `Hay un nuevo aviso que coincide con tu alerta:\n\n${listingLine(listing, baseUrl)}${footer(sub, baseUrl)}`,
      );
    } else {
      db.prepare('INSERT OR IGNORE INTO digest_queue (subscription_id, listing_id) VALUES (?, ?)').run(sub.id, listing.id);
    }
  }
  db.prepare('UPDATE listings SET notified = 1 WHERE id = ?').run(listing.id);
  return count;
}

/** Arma los resúmenes diarios/semanales pendientes. */
function buildDigests(db, baseUrl) {
  const subs = db
    .prepare(
      `SELECT * FROM subscriptions WHERE active = 1 AND frequency IN ('daily','weekly') AND (
        last_sent_at IS NULL
        OR (frequency = 'daily' AND last_sent_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'))
        OR (frequency = 'weekly' AND last_sent_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')))`,
    )
    .all();
  let built = 0;
  for (const sub of subs) {
    const items = db
      .prepare(
        `SELECT l.* FROM digest_queue q JOIN listings l ON l.id = q.listing_id
         WHERE q.subscription_id = ? AND l.status = 'approved' ORDER BY l.published_at DESC LIMIT 50`,
      )
      .all(sub.id);
    db.prepare('DELETE FROM digest_queue WHERE subscription_id = ?').run(sub.id);
    if (!items.length) continue;
    const label = sub.frequency === 'daily' ? 'diario' : 'semanal';
    enqueueEmail(
      db,
      sub.email,
      `Tu resumen ${label}: ${items.length} aviso${items.length === 1 ? '' : 's'} nuevo${items.length === 1 ? '' : 's'}`,
      `Estos son los avisos nuevos que coinciden con tu alerta:\n\n${items.map((l) => listingLine(l, baseUrl)).join('\n\n')}${footer(sub, baseUrl)}`,
    );
    db.prepare("UPDATE subscriptions SET last_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(sub.id);
    built++;
  }
  return built;
}

/** Envía los correos en cola si hay SMTP configurado. */
async function flushOutbox(db) {
  const t = getTransporter();
  if (!t) return { sent: 0, pending: db.prepare("SELECT COUNT(*) n FROM outbox WHERE status = 'queued'").get().n };
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const rows = db.prepare("SELECT * FROM outbox WHERE status = 'queued' ORDER BY id LIMIT 200").all();
  let sent = 0;
  for (const m of rows) {
    try {
      const msg = { from, to: m.to_email, subject: m.subject, text: m.body };
      if (m.html) msg.html = m.html;
      // Las promociones incluyen la baja con un clic que ofrecen Gmail y otros clientes de correo
      if (m.unsubscribe_url) msg.list = { unsubscribe: { url: m.unsubscribe_url, comment: 'Dejar de recibir promociones' } };
      await t.sendMail(msg);
      db.prepare("UPDATE outbox SET status = 'sent', sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), error = '' WHERE id = ?").run(m.id);
      sent++;
    } catch (err) {
      db.prepare("UPDATE outbox SET status = 'error', error = ? WHERE id = ?").run(String(err.message).slice(0, 500), m.id);
    }
  }
  return { sent, pending: 0 };
}

/**
 * Avisa por email a los anunciantes cuyos avisos vencen en los próximos días.
 * Se envía una vez por cada fecha de vencimiento (si renuevan, se vuelve a avisar antes del nuevo vencimiento).
 */
function sendExpiryReminders(db, baseUrl) {
  const s = db.prepare("SELECT value FROM settings WHERE key = 'expiry_reminder_days'").get();
  const days = Math.max(0, Number.parseInt(s ? s.value : '3', 10) || 0);
  if (!days) return 0;
  const rows = db
    .prepare(
      `SELECT l.id, l.title, l.expires_at, u.email, u.name FROM listings l JOIN users u ON u.id = l.user_id
       WHERE l.status = 'approved' AND l.payment_status = 'paid' AND u.active = 1
         AND l.expires_at >= date('now') AND l.expires_at <= date('now', ?)
         AND l.expiry_notice_for <> l.expires_at`,
    )
    .all(`+${days} days`);
  for (const r of rows) {
    const [y, m, d] = r.expires_at.slice(0, 10).split('-');
    enqueueEmail(
      db,
      r.email,
      `Tu aviso vence el ${d}/${m}/${y}: ${r.title}`,
      `Hola ${r.name}, tu aviso "${r.title}" deja de mostrarse el ${d}/${m}/${y}.\nRenovalo para que siga visible (los días se suman al vencimiento actual):\n${baseUrl}/cuenta/#/avisos/${r.id}/pagar`,
    );
    db.prepare('UPDATE listings SET expiry_notice_for = expires_at WHERE id = ?').run(r.id);
  }
  return rows.length;
}

module.exports = { sendExpiryReminders, notifyNewListing, buildDigests, flushOutbox, smtpConfigured, matches, enqueueEmail };
