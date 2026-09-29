'use strict';

const crypto = require('node:crypto');
const express = require('express');

const { ACCOUNT_TYPE_IDS, getAccountType } = require('./categories');
const { getSettings } = require('./db');
const { enqueueEmail } = require('./notify');

const ACTIVITIES = {
  active: 'Con avisos publicados',
  no_active: 'Sin avisos publicados',
  expired: 'Con avisos vencidos',
  unpaid: 'Con avisos sin pagar',
  never_paid: 'Nunca pagaron',
  paid: 'Pagaron alguna vez',
};

// Subconsultas reutilizadas en filtros y listados
const ACTIVE_SQL = `(SELECT COUNT(*) FROM listings l WHERE l.user_id = u.id AND l.status = 'approved' AND l.paused = 0
  AND l.payment_status <> 'unpaid' AND (l.expires_at IS NULL OR l.expires_at = '' OR l.expires_at >= date('now')))`;
const EXPIRED_SQL = `(SELECT COUNT(*) FROM listings l WHERE l.user_id = u.id AND l.expires_at IS NOT NULL AND l.expires_at <> '' AND l.expires_at < date('now'))`;
const UNPAID_SQL = `(SELECT COUNT(*) FROM listings l WHERE l.user_id = u.id AND l.payment_status = 'unpaid')`;
const PAID_SQL = `(SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.user_id = u.id AND p.status = 'approved' AND p.method NOT IN ('demo','free'))`;
const PAYCOUNT_SQL = `(SELECT COUNT(*) FROM payments p WHERE p.user_id = u.id AND p.status = 'approved' AND p.method NOT IN ('demo','free'))`;

function tokenFor(db, user) {
  if (user.marketing_token) return user.marketing_token;
  const t = crypto.randomBytes(18).toString('base64url');
  db.prepare('UPDATE users SET marketing_token = ? WHERE id = ?').run(t, user.id);
  user.marketing_token = t;
  return t;
}

/** Normaliza un segmento recibido del panel. */
function normalizeSegment(input = {}) {
  const s = {};
  if (ACCOUNT_TYPE_IDS.includes(input.type)) s.type = input.type;
  if (ACTIVITIES[input.activity]) s.activity = input.activity;
  if (typeof input.tag === 'string' && input.tag.trim()) s.tag = input.tag.trim().slice(0, 40);
  if (typeof input.q === 'string' && input.q.trim()) s.q = input.q.trim().slice(0, 80);
  const inactive = Number.parseInt(input.inactive_days, 10);
  if (inactive > 0) s.inactive_days = Math.min(inactive, 3650);
  const recent = Number.parseInt(input.created_days, 10);
  if (recent > 0) s.created_days = Math.min(recent, 3650);
  if (input.opt_in === '1' || input.opt_in === '0') s.opt_in = input.opt_in;
  return s;
}

function segmentWhere(seg, { forCampaign = false } = {}) {
  const where = [];
  const args = [];
  if (seg.id) {
    where.push('u.id = ?');
    args.push(seg.id);
  }
  if (seg.type) {
    where.push('u.type = ?');
    args.push(seg.type);
  }
  if (seg.q) {
    where.push('(u.email LIKE ? OR u.name LIKE ? OR u.business_name LIKE ? OR u.phone LIKE ?)');
    const like = `%${seg.q}%`;
    args.push(like, like, like, like);
  }
  if (seg.tag) {
    where.push('EXISTS (SELECT 1 FROM json_each(u.tags) t WHERE lower(t.value) = lower(?))');
    args.push(seg.tag);
  }
  if (seg.activity === 'active') where.push(`${ACTIVE_SQL} > 0`);
  if (seg.activity === 'no_active') where.push(`${ACTIVE_SQL} = 0`);
  if (seg.activity === 'expired') where.push(`${EXPIRED_SQL} > 0`);
  if (seg.activity === 'unpaid') where.push(`${UNPAID_SQL} > 0`);
  if (seg.activity === 'never_paid') where.push(`${PAYCOUNT_SQL} = 0`);
  if (seg.activity === 'paid') where.push(`${PAYCOUNT_SQL} > 0`);
  if (seg.inactive_days) {
    where.push("COALESCE(u.last_login_at, u.created_at) < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)");
    args.push(`-${seg.inactive_days} days`);
  }
  if (seg.created_days) {
    where.push("u.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)");
    args.push(`-${seg.created_days} days`);
  }
  if (forCampaign) {
    // Las promociones van solo a cuentas activas que aceptan recibirlas
    where.push('u.active = 1', 'u.marketing_opt_in = 1');
  } else if (seg.opt_in) {
    where.push('u.marketing_opt_in = ?');
    args.push(Number(seg.opt_in));
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

function listContacts(db, seg, { forCampaign = false, limit = 1000 } = {}) {
  const { sql, args } = segmentWhere(seg, { forCampaign });
  return db
    .prepare(
      `SELECT u.id, u.type, u.email, u.name, u.business_name, u.phone, u.active, u.verified, u.marketing_opt_in, u.tags,
        u.created_at, u.last_login_at,
        ${ACTIVE_SQL} AS active_listings,
        (SELECT COUNT(*) FROM listings l WHERE l.user_id = u.id) AS total_listings,
        ${PAID_SQL} AS paid_total,
        (SELECT MAX(p.paid_at) FROM payments p WHERE p.user_id = u.id AND p.status = 'approved') AS last_paid_at
       FROM users u ${sql} ORDER BY u.id DESC LIMIT ?`,
    )
    .all(...args, limit)
    .map((r) => ({ ...r, tags: parseTags(r.tags) }));
}

function parseTags(raw) {
  try {
    const t = JSON.parse(raw || '[]');
    return Array.isArray(t) ? t : [];
  } catch {
    return [];
  }
}

// ---------- Emails de campaña ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function personalize(text, user, baseUrl) {
  const vars = {
    nombre: (user.name || '').split(' ')[0] || user.name || '',
    nombre_completo: user.name || '',
    empresa: user.business_name || user.name || '',
    email: user.email || '',
    tipo: (getAccountType(user.type) || {}).label || '',
    panel: `${baseUrl}/cuenta/`,
    publicar: `${baseUrl}/cuenta/#/avisos/nuevo`,
  };
  return String(text).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

/** Convierte el texto de la campaña en HTML simple: párrafos, enlaces y **negrita**. */
function textToHtml(text) {
  return esc(text)
    .split(/\n{2,}/)
    .map((p) =>
      `<p style="margin:0 0 14px">${p
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#0b6e8a">$1</a>')
        .replace(/\n/g, '<br>')}</p>`,
    )
    .join('');
}

function renderCampaign(db, campaign, user, baseUrl, { openToken = '' } = {}) {
  const s = getSettings(db);
  const token = user.id ? tokenFor(db, user) : 'vista-previa';
  const unsubscribeUrl = `${baseUrl}/api/crm/baja/${token}`;
  const subject = personalize(campaign.subject, user, baseUrl);
  const body = personalize(campaign.body, user, baseUrl);
  const ctaUrl = campaign.cta_url ? personalize(campaign.cta_url, user, baseUrl) : '';
  const cta = campaign.cta_text && ctaUrl
    ? `<p style="margin:22px 0"><a href="${esc(ctaUrl)}" style="background:#0b6e8a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700;display:inline-block">${esc(personalize(campaign.cta_text, user, baseUrl))}</a></p>`
    : '';
  const pixel = openToken ? `<img src="${baseUrl}/api/crm/abierto/${openToken}.gif" width="1" height="1" alt="" style="display:block;border:0">` : '';
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;background:#f4f7f9;font-family:Arial,Helvetica,sans-serif;color:#16232b">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f7f9"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden">
<tr><td style="background:#000;padding:18px 24px"><table role="presentation" cellspacing="0" cellpadding="0"><tr>
<td><img src="${baseUrl}/img/icon-192.png" width="40" height="40" alt="" style="display:block;border-radius:8px"></td>
<td style="padding-left:12px;color:#fff;font-size:18px;font-weight:700">${esc(s.site_name)}</td></tr></table></td></tr>
<tr><td style="padding:26px 24px 10px;font-size:16px;line-height:1.55">${textToHtml(body)}${cta}</td></tr>
<tr><td style="padding:16px 24px 24px;font-size:12px;color:#5b6b75;border-top:1px solid #e3e9ec">
Recibís este correo porque tenés una cuenta de anunciante en ${esc(s.site_name)}.<br>
<a href="${esc(unsubscribeUrl)}" style="color:#5b6b75">Dejar de recibir promociones</a></td></tr>
</table>${pixel}</td></tr></table></body></html>`;
  const text = `${body}${ctaUrl ? `\n\n${personalize(campaign.cta_text || 'Ver más', user, baseUrl)}: ${ctaUrl}` : ''}\n\n—\nDejar de recibir promociones: ${unsubscribeUrl}`;
  return { subject, html, text, unsubscribeUrl };
}

function validateCampaign(b) {
  const errors = {};
  const data = {
    subject: String(b.subject || '').trim().slice(0, 150),
    body: String(b.body || '').trim().slice(0, 20000),
    cta_text: String(b.cta_text || '').trim().slice(0, 60),
    cta_url: String(b.cta_url || '').trim().slice(0, 500),
    segment: JSON.stringify(normalizeSegment(b.segment || {})),
  };
  if (data.subject.length < 3) errors.subject = 'Escribí el asunto.';
  if (data.body.length < 10) errors.body = 'Escribí el mensaje.';
  if (data.cta_url && !/^(https?:\/\/|\{\w+\})/i.test(data.cta_url)) errors.cta_url = 'El enlace tiene que empezar con https://';
  if (data.cta_url && !data.cta_text) errors.cta_text = 'Escribí el texto del botón.';
  return { data, errors };
}

// Plantillas para empezar rápido (se editan antes de enviar)
const TEMPLATES = [
  {
    id: 'destacado',
    name: 'Promoción de avisos destacados',
    subject: '{nombre}, destacá tu aviso y aparecé primero',
    body: 'Hola {nombre}:\n\nEsta semana los avisos **destacados** tienen un precio especial en Maldonado Oportunidades. Tu publicación aparece primero en su sección y en la portada, con el distintivo de destacado.\n\nEs ideal para llegar a más gente en plena temporada.',
    cta_text: 'Destacar mi aviso',
    cta_url: '{panel}',
  },
  {
    id: 'volver',
    name: 'Volvé a publicar',
    subject: 'Te extrañamos en Maldonado Oportunidades',
    body: 'Hola {nombre}:\n\nHace un tiempo que no publicás. Cada semana miles de personas buscan empleos, alquileres y servicios en Maldonado.\n\nCargá tu próximo aviso en un par de minutos desde tu panel.',
    cta_text: 'Publicar un aviso',
    cta_url: '{publicar}',
  },
  {
    id: 'temporada',
    name: 'Temporada de verano',
    subject: 'Llega la temporada: preparate con tus avisos',
    body: 'Hola {nombre}:\n\nSe viene la temporada en Punta del Este y todo Maldonado. Es el mejor momento para publicar alquileres de temporada, buscar personal y ofrecer tus servicios.\n\nPublicá ahora y llegá antes que nadie.',
    cta_text: 'Ir a mi panel',
    cta_url: '{panel}',
  },
  { id: 'blanco', name: 'En blanco', subject: '', body: 'Hola {nombre}:\n\n', cta_text: '', cta_url: '' },
];

// Imagen GIF transparente de 1x1 para registrar aperturas
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function createCrm(db, { baseUrl, requireAdmin }) {
  // ---------- Rutas públicas (enlaces de los emails) ----------
  const pub = express.Router();

  pub.get('/baja/:token', (req, res) => {
    const u = req.params.token.length >= 16 && db.prepare("SELECT id, email FROM users WHERE marketing_token = ? AND marketing_token <> ''").get(req.params.token);
    if (u) db.prepare('UPDATE users SET marketing_opt_in = 0 WHERE id = ?').run(u.id);
    res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Promociones</title><body style="font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
<img src="/img/icon.svg" width="56" height="56" alt="" style="border-radius:12px">
<h1>${u ? 'Listo, no vas a recibir más promociones' : 'Enlace no válido'}</h1>
<p>${u ? `Dimos de baja <strong>${esc(u.email)}</strong> de nuestras promociones. Vas a seguir recibiendo los avisos importantes de tu cuenta (pagos, vencimientos).` : ''}</p>
<p>${u ? 'Si cambiás de idea, podés volver a activarlas desde tu perfil en el panel.' : ''}</p>
<p><a href="/">Volver a Maldonado Oportunidades</a></p></body>`);
  });

  // La baja con un clic de Gmail y otros clientes llega por POST
  pub.post('/baja/:token', (req, res) => {
    db.prepare("UPDATE users SET marketing_opt_in = 0 WHERE marketing_token = ? AND marketing_token <> ''").run(req.params.token);
    res.sendStatus(200);
  });

  pub.get('/abierto/:token.gif', (req, res) => {
    db.prepare("UPDATE campaign_recipients SET opened_at = COALESCE(opened_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE open_token = ?").run(req.params.token);
    res.setHeader('Cache-Control', 'no-store');
    res.type('image/gif').send(PIXEL);
  });

  // ---------- Rutas del panel de administración ----------
  const admin = express.Router();
  admin.use(requireAdmin);

  admin.get('/meta', (req, res) => {
    const tags = db
      .prepare("SELECT DISTINCT t.value AS tag FROM users u, json_each(u.tags) t ORDER BY lower(t.value)")
      .all()
      .map((r) => r.tag);
    const totals = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(marketing_opt_in AND active), 0) reachable FROM users').get();
    res.json({ activities: ACTIVITIES, tags, templates: TEMPLATES, totals });
  });

  admin.get('/contacts', (req, res) => {
    const seg = normalizeSegment(req.query);
    const rows = listContacts(db, seg);
    res.json({ total: rows.length, reachable: rows.filter((r) => r.active && r.marketing_opt_in).length, items: rows });
  });

  admin.get('/contacts.csv', (req, res) => {
    const rows = listContacts(db, normalizeSegment(req.query), { limit: 100000 });
    const cell = (v) => {
      let t = String(v ?? '');
      if (/^[=+\-@]/.test(t)) t = `'${t}`;
      return `"${t.replace(/"/g, '""')}"`;
    };
    const head = ['Nombre', 'Empresa', 'Email', 'Teléfono', 'Tipo', 'Avisos publicados', 'Avisos totales', 'Pagado ($)', 'Último pago', 'Acepta promociones', 'Etiquetas', 'Alta'];
    const lines = rows.map((r) =>
      [r.name, r.business_name, r.email, r.phone, (getAccountType(r.type) || {}).label, r.active_listings, r.total_listings, r.paid_total, (r.last_paid_at || '').slice(0, 10), r.marketing_opt_in ? 'Sí' : 'No', r.tags.join(', '), r.created_at.slice(0, 10)]
        .map(cell)
        .join(';'),
    );
    res.setHeader('Content-Disposition', 'attachment; filename="contactos-anunciantes.csv"');
    res.type('text/csv; charset=utf-8').send('﻿' + [head.map(cell).join(';'), ...lines].join('\r\n'));
  });

  admin.get('/contacts/:id', (req, res) => {
    const id = Number(req.params.id);
    const [c] = listContacts(db, { id }, { limit: 1 });
    if (!c) return res.status(404).json({ error: 'Contacto no encontrado' });
    const u = db.prepare('SELECT rut, website, location, about, billing_address FROM users WHERE id = ?').get(id);
    res.json({
      ...c,
      ...u,
      notes: db.prepare('SELECT id, body, created_at FROM crm_notes WHERE user_id = ? ORDER BY id DESC').all(id),
      listings: db.prepare('SELECT id, title, category, status, payment_status, paused, expires_at, views FROM listings WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(id),
      payments: db.prepare('SELECT id, description, amount, currency, method, status, created_at, paid_at FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(id),
      campaigns: db
        .prepare('SELECT c.id, c.subject, c.sent_at, r.opened_at FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id WHERE r.user_id = ? ORDER BY c.id DESC')
        .all(id),
    });
  });

  admin.put('/contacts/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return res.status(404).json({ error: 'Contacto no encontrado' });
    const b = req.body || {};
    if (Array.isArray(b.tags)) {
      const tags = [...new Set(b.tags.map((t) => String(t).trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
      db.prepare('UPDATE users SET tags = ? WHERE id = ?').run(JSON.stringify(tags), id);
    }
    if (b.marketing_opt_in !== undefined) db.prepare('UPDATE users SET marketing_opt_in = ? WHERE id = ?').run(b.marketing_opt_in ? 1 : 0, id);
    res.json({ ok: true });
  });

  admin.post('/contacts/:id/notes', (req, res) => {
    const id = Number(req.params.id);
    const body = String(req.body?.body || '').trim().slice(0, 4000);
    if (!body) return res.status(400).json({ error: 'Escribí la nota.' });
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return res.status(404).json({ error: 'Contacto no encontrado' });
    const nid = db.prepare('INSERT INTO crm_notes (user_id, body) VALUES (?, ?)').run(id, body).lastInsertRowid;
    res.status(201).json(db.prepare('SELECT id, body, created_at FROM crm_notes WHERE id = ?').get(nid));
  });

  admin.delete('/notes/:id', (req, res) => {
    db.prepare('DELETE FROM crm_notes WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // Cuántos reciben la campaña con este segmento
  admin.post('/audience', (req, res) => {
    const rows = listContacts(db, normalizeSegment(req.body?.segment || {}), { forCampaign: true, limit: 100000 });
    res.json({ count: rows.length, sample: rows.slice(0, 5).map((r) => ({ id: r.id, name: r.name, business_name: r.business_name, email: r.email })) });
  });

  admin.post('/preview', (req, res) => {
    const { data } = validateCampaign(req.body || {});
    const sample = listContacts(db, JSON.parse(data.segment), { forCampaign: true, limit: 1 })[0];
    const user = sample
      ? db.prepare('SELECT * FROM users WHERE id = ?').get(sample.id)
      : { id: 0, name: 'María Pérez', business_name: 'Empresa de ejemplo', email: 'maria@example.com', type: 'empresa' };
    const r = renderCampaign(db, data, sample ? user : { ...user, id: 0 }, baseUrl(req));
    res.json({ subject: r.subject, html: r.html, to: user.email });
  });

  admin.get('/campaigns', (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT c.*, (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.opened_at IS NOT NULL) AS opens,
            (SELECT COUNT(*) FROM outbox o WHERE o.campaign_id = c.id AND o.status = 'sent') AS delivered,
            (SELECT COUNT(*) FROM outbox o WHERE o.campaign_id = c.id AND o.status = 'queued') AS queued,
            (SELECT COUNT(*) FROM outbox o WHERE o.campaign_id = c.id AND o.status = 'error') AS failed
           FROM campaigns c ORDER BY c.id DESC LIMIT 200`,
        )
        .all()
        .map((c) => ({ ...c, segment: JSON.parse(c.segment) })),
    );
  });

  admin.get('/campaigns/:id', (req, res) => {
    const c = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    res.json({ ...c, segment: JSON.parse(c.segment) });
  });

  function saveCampaign(req, res, id) {
    const { data, errors } = validateCampaign(req.body || {});
    if (Object.keys(errors).length) {
      res.status(400).json({ error: 'Revisá los campos marcados.', fields: errors });
      return null;
    }
    if (id) {
      const cur = db.prepare('SELECT status FROM campaigns WHERE id = ?').get(id);
      if (!cur) {
        res.status(404).json({ error: 'Campaña no encontrada' });
        return null;
      }
      if (cur.status === 'sent') {
        res.status(400).json({ error: 'La campaña ya se envió; no se puede modificar.' });
        return null;
      }
      db.prepare('UPDATE campaigns SET subject = ?, body = ?, cta_text = ?, cta_url = ?, segment = ? WHERE id = ?').run(
        data.subject, data.body, data.cta_text, data.cta_url, data.segment, id,
      );
      return id;
    }
    return Number(
      db.prepare('INSERT INTO campaigns (subject, body, cta_text, cta_url, segment) VALUES (?, ?, ?, ?, ?)').run(
        data.subject, data.body, data.cta_text, data.cta_url, data.segment,
      ).lastInsertRowid,
    );
  }

  admin.post('/campaigns', (req, res) => {
    const id = saveCampaign(req, res, null);
    if (id) res.status(201).json(db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id));
  });

  admin.put('/campaigns/:id', (req, res) => {
    const id = saveCampaign(req, res, Number(req.params.id));
    if (id) res.json(db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id));
  });

  admin.delete('/campaigns/:id', (req, res) => {
    const r = db.prepare("DELETE FROM campaigns WHERE id = ? AND status = 'draft'").run(Number(req.params.id));
    res.json({ ok: r.changes > 0 });
  });

  admin.post('/campaigns/:id/test', (req, res) => {
    const c = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    const to = String(req.body?.to || getSettings(db).contact_email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'Indicá un email válido para la prueba.' });
    const sample = listContacts(db, JSON.parse(c.segment), { forCampaign: true, limit: 1 })[0];
    const user = sample ? db.prepare('SELECT * FROM users WHERE id = ?').get(sample.id) : { id: 0, name: 'María Pérez', business_name: 'Empresa de ejemplo', email: to, type: 'empresa' };
    const r = renderCampaign(db, c, user, baseUrl(req));
    enqueueEmail(db, to, `[Prueba] ${r.subject}`, r.text, { html: r.html });
    res.json({ ok: true, to });
  });

  admin.post('/campaigns/:id/send', (req, res) => {
    const c = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    if (c.status === 'sent') return res.status(400).json({ error: 'Esta campaña ya se envió.' });
    const contacts = listContacts(db, JSON.parse(c.segment), { forCampaign: true, limit: 100000 });
    if (!contacts.length) return res.status(400).json({ error: 'El segmento no tiene contactos que acepten promociones.' });
    const base = baseUrl(req);
    const insRecipient = db.prepare('INSERT OR IGNORE INTO campaign_recipients (campaign_id, user_id, email, open_token) VALUES (?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
      for (const ct of contacts) {
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ct.id);
        const openToken = crypto.randomBytes(12).toString('base64url');
        insRecipient.run(c.id, user.id, user.email, openToken);
        const r = renderCampaign(db, c, user, base, { openToken });
        enqueueEmail(db, user.email, r.subject, r.text, { html: r.html, campaignId: c.id, unsubscribeUrl: r.unsubscribeUrl });
      }
      db.prepare("UPDATE campaigns SET status = 'sent', recipients = ?, sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(contacts.length, c.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    res.json({ ok: true, recipients: contacts.length });
  });

  return { pub, admin };
}

module.exports = { createCrm, normalizeSegment, listContacts, renderCampaign, personalize, TEMPLATES, ACTIVITIES };
