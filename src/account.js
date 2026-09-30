'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');

const { ACCOUNT_TYPE_IDS, getAccountType, getCategory } = require('./categories');
const { getSettings } = require('./db');
const { searchListings, validateListing, insertListing, updateListing } = require('./listings');
const { enqueueEmail, smtpConfigured } = require('./notify');
const payments = require('./payments');
const auth = require('./auth');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// La confirmación del email solo se exige si está activada y hay servidor de correo para enviarla.
function verificationRequired(db) {
  return getSettings(db).require_email_verification === '1' && smtpConfigured();
}

function publicUser(u, db) {
  const t = getAccountType(u.type);
  return {
    email_verified: Boolean(u.email_verified),
    marketing_opt_in: Boolean(u.marketing_opt_in),
    needs_verification: !u.email_verified && Boolean(db) && verificationRequired(db),
    billing_address: u.billing_address,
    id: u.id,
    type: u.type,
    typeLabel: t.label,
    panel: t.panel,
    email: u.email,
    name: u.name,
    business_name: u.business_name,
    rut: u.rut,
    phone: u.phone,
    website: u.website,
    location: u.location,
    about: u.about,
    verified: Boolean(u.verified),
    categories: t.categories,
    created_at: u.created_at,
  };
}

function publicPayment(p) {
  const { user_id, provider_ref, receipt_file, ...rest } = p; // eslint-disable-line no-unused-vars
  return { ...rest, has_receipt: Boolean(receipt_file) };
}

const RECEIPT_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };

function validateProfile(body, { partial = false } = {}) {
  const errors = {};
  const data = {};
  const str = (k, max) => {
    if (body[k] !== undefined) data[k] = String(body[k] ?? '').trim().slice(0, max);
  };
  str('name', 120);
  str('business_name', 160);
  str('rut', 20);
  str('phone', 40);
  str('website', 300);
  str('location', 80);
  str('about', 2000);
  str('billing_address', 200);
  if (body.marketing_opt_in !== undefined) data.marketing_opt_in = body.marketing_opt_in === true || body.marketing_opt_in === '1' || body.marketing_opt_in === 'on' ? 1 : 0;
  if ((!partial || body.name !== undefined) && (!data.name || data.name.length < 2)) errors.name = 'Indicá tu nombre.';
  if (data.website && !/^https?:\/\//i.test(data.website)) data.website = `https://${data.website}`;
  return { data, errors };
}

function createAccountRouter(db, { handleUpload, prepareImages, discardUploads, baseUrl, rateLimiter, receiptDir }) {
  const r = express.Router();
  fs.mkdirSync(receiptDir, { recursive: true });
  // Los comprobantes contienen datos bancarios: se guardan fuera de la carpeta pública.
  const receiptUpload = multer({
    storage: multer.diskStorage({
      destination: receiptDir,
      filename: (req, file, cb) => cb(null, `pago-${req.params.id}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${RECEIPT_TYPES[file.mimetype]}`),
    }),
    limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => (RECEIPT_TYPES[file.mimetype] ? cb(null, true) : cb(new Error('El comprobante debe ser una imagen (JPG, PNG, WEBP) o un PDF.'))),
  });
  const needUser = auth.requireUser(db);

  function sendVerification(user, req) {
    const token = crypto.randomBytes(24).toString('base64url');
    db.prepare('UPDATE users SET verify_token_hash = ? WHERE id = ?').run(crypto.createHash('sha256').update(token).digest('hex'), user.id);
    enqueueEmail(
      db,
      user.email,
      'Confirmá tu email en Maldonado Oportunidades',
      `Hola ${user.name}, para empezar a publicar confirmá tu email entrando a este enlace:\n${baseUrl(req)}/api/account/verify?token=${token}\n\nSi no creaste esta cuenta, ignorá este correo.`,
    );
  }

  // ---------- Registro y sesión ----------
  r.post('/register', rateLimiter(10, 60 * 60 * 1000), (req, res) => {
    const body = req.body || {};
    const errors = {};
    if (!ACCOUNT_TYPE_IDS.includes(body.type)) errors.type = 'Elegí el tipo de cuenta.';
    const email = String(body.email || '').trim().toLowerCase().slice(0, 160);
    if (!EMAIL_RE.test(email)) errors.email = 'Email no válido.';
    if (String(body.password || '').length < 8) errors.password = 'La contraseña debe tener al menos 8 caracteres.';
    if (body.accept_terms !== true && body.accept_terms !== 'on') errors.accept_terms = 'Tenés que aceptar las condiciones.';
    const { data, errors: pErr } = validateProfile(body);
    Object.assign(errors, pErr);
    if (body.type === 'empresa' && !data.business_name) errors.business_name = 'Indicá el nombre de la empresa.';
    if (!errors.email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) errors.email = 'Ya existe una cuenta con ese email. Iniciá sesión.';
    if (Object.keys(errors).length) return res.status(400).json({ error: 'Revisá los campos marcados.', fields: errors });

    data.marketing_opt_in = body.marketing_opt_in === false || body.marketing_opt_in === '0' ? 0 : 1;
    const keys = Object.keys(data);
    const id = Number(
      db
        .prepare(`INSERT INTO users (type, email, password_hash, ${keys.join(', ')}) VALUES (?, ?, ?, ${keys.map(() => '?').join(', ')})`)
        .run(body.type, email, auth.hashPassword(body.password), ...keys.map((k) => data[k])).lastInsertRowid,
    );
    let user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    auth.issueUserSession(res, user, req.secure);
    const t = getAccountType(user.type);
    if (verificationRequired(db)) sendVerification(user, req);
    else {
      db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(user.id);
      enqueueEmail(db, email, `Bienvenido/a al ${t.panel} de Maldonado Oportunidades`, `Hola ${user.name}, tu cuenta está lista.\nIngresá a tu panel: ${baseUrl(req)}/cuenta/`);
    }
    const s = getSettings(db);
    if (s.contact_email) enqueueEmail(db, s.contact_email, `Nueva cuenta (${t.label}): ${user.business_name || user.name}`, `${email}\n${baseUrl(req)}/admin/#/usuarios`);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    res.status(201).json({ user: publicUser(user, db) });
  });

  r.post('/login', rateLimiter(15, 15 * 60 * 1000), (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !auth.verifyPassword(req.body?.password || '', user.password_hash)) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }
    if (!user.active) return res.status(403).json({ error: 'Tu cuenta está suspendida. Contactanos para más información.' });
    db.prepare("UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(user.id);
    auth.issueUserSession(res, user, req.secure);
    res.json({ user: publicUser(user, db) });
  });

  // Enlace del email de confirmación.
  r.get('/verify', (req, res) => {
    const hash = crypto.createHash('sha256').update(String(req.query.token || '')).digest('hex');
    const user = String(req.query.token || '') && db.prepare("SELECT id FROM users WHERE verify_token_hash = ? AND verify_token_hash <> ''").get(hash);
    if (user) db.prepare("UPDATE users SET email_verified = 1, verify_token_hash = '' WHERE id = ?").run(user.id);
    res.redirect(`/cuenta/#/${user ? '?email=confirmado' : '?email=invalido'}`);
  });

  r.post('/resend-verification', needUser, rateLimiter(5, 60 * 60 * 1000), (req, res) => {
    if (req.user.email_verified) return res.json({ ok: true, already: true });
    sendVerification(req.user, req);
    res.json({ ok: true });
  });

  r.post('/logout', (req, res) => {
    auth.clearUserSession(res);
    res.json({ ok: true });
  });

  r.post('/forgot', rateLimiter(5, 60 * 60 * 1000), (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
    if (user) {
      const token = crypto.randomBytes(24).toString('base64url');
      const hash = crypto.createHash('sha256').update(token).digest('hex');
      db.prepare("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 hours'))").run(hash, user.id);
      enqueueEmail(db, user.email, 'Recuperar contraseña', `Para elegir una nueva contraseña entrá a este enlace (vale 2 horas):\n${baseUrl(req)}/cuenta/#/restablecer?token=${token}\n\nSi no lo pediste, ignorá este correo.`);
    }
    // Misma respuesta exista o no la cuenta.
    res.json({ ok: true });
  });

  r.post('/reset', rateLimiter(10, 60 * 60 * 1000), (req, res) => {
    const hash = crypto.createHash('sha256').update(String(req.body?.token || '')).digest('hex');
    const row = db.prepare("SELECT * FROM password_resets WHERE token_hash = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')").get(hash);
    if (!row) return res.status(400).json({ error: 'El enlace venció o no es válido. Pedí uno nuevo.' });
    if (String(req.body?.password || '').length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.', fields: { password: 'Mínimo 8 caracteres.' } });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(req.body.password), row.user_id);
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(row.user_id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    auth.issueUserSession(res, user, req.secure);
    res.json({ user: publicUser(user, db) });
  });

  r.get('/me', (req, res) => {
    const user = auth.currentUser(req, db);
    res.json({ user: user ? publicUser(user, db) : null, paymentMethods: payments.availableMethods(db) });
  });

  r.put('/me', needUser, (req, res) => {
    const { data, errors } = validateProfile(req.body || {}, { partial: true });
    if (Object.keys(errors).length) return res.status(400).json({ error: 'Revisá los campos marcados.', fields: errors });
    const keys = Object.keys(data);
    if (keys.length) db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => data[k]), req.user.id);
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id), db) });
  });

  r.put('/password', needUser, (req, res) => {
    if (!auth.verifyPassword(req.body?.current || '', req.user.password_hash)) {
      return res.status(400).json({ error: 'La contraseña actual no es correcta.', fields: { current: 'Contraseña incorrecta.' } });
    }
    if (String(req.body?.password || '').length < 8) return res.status(400).json({ error: 'Mínimo 8 caracteres.', fields: { password: 'Mínimo 8 caracteres.' } });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(req.body.password), req.user.id);
    auth.issueUserSession(res, db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id), req.secure);
    res.json({ ok: true });
  });

  // ---------- Resumen ----------
  r.get('/stats', needUser, (req, res) => {
    const uid = req.user.id;
    const today = new Date().toISOString().slice(0, 10);
    const q = (sql, ...a) => db.prepare(sql).get(uid, ...a);
    res.json({
      active: q(`SELECT COUNT(*) n FROM listings WHERE user_id = ? AND status = 'approved' AND paused = 0 AND payment_status <> 'unpaid' AND (expires_at IS NULL OR expires_at >= ?)`, today).n,
      unpaid: q("SELECT COUNT(*) n FROM listings WHERE user_id = ? AND payment_status = 'unpaid'").n,
      pending: q("SELECT COUNT(*) n FROM listings WHERE user_id = ? AND status = 'pending' AND payment_status <> 'unpaid'").n,
      expired: q("SELECT COUNT(*) n FROM listings WHERE user_id = ? AND expires_at IS NOT NULL AND expires_at <> '' AND expires_at < ?", today).n,
      views: q('SELECT COALESCE(SUM(views),0) n FROM listings WHERE user_id = ?').n,
      spent: db.prepare("SELECT currency, SUM(amount) total FROM payments WHERE user_id = ? AND status = 'approved' GROUP BY currency").all(uid),
      daily: dailyViews(db, 'l.user_id = ?', uid),
      expiringSoon: db
        .prepare("SELECT id, title, expires_at FROM listings WHERE user_id = ? AND status = 'approved' AND expires_at BETWEEN ? AND date(?, '+5 days') ORDER BY expires_at")
        .all(uid, today, today),
    });
  });

  r.get('/listings/:id/stats', needUser, (req, res) => {
    const l = ownListing(req, res);
    if (!l) return;
    res.json({ id: l.id, title: l.title, views: l.views, daily: dailyViews(db, 'l.id = ?', l.id) });
  });

  // ---------- Mis avisos ----------
  function ownListing(req, res) {
    const l = db.prepare('SELECT * FROM listings WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
    if (!l) res.status(404).json({ error: 'Aviso no encontrado' });
    return l;
  }

  function checkCategory(user, category) {
    return getAccountType(user.type).categories.includes(category);
  }

  r.get('/listings', needUser, (req, res) => {
    res.json(searchListings(db, { sort: 'recent', ...req.query }, { ownerId: req.user.id, defaultPageSize: 20 }));
  });

  r.get('/listings/:id', needUser, (req, res) => {
    const l = ownListing(req, res);
    if (l) res.json(l);
  });

  r.post('/listings', needUser, handleUpload, (req, res) => {
    const input = { ...req.body };
    delete input.expires_at;
    prepareImages(req, input);
    const { data, errors } = validateListing(input);
    if (data.category && !checkCategory(req.user, data.category)) errors.category = 'Tu tipo de cuenta no puede publicar en esa sección.';
    if (Object.keys(errors).length) {
      discardUploads(req);
      return res.status(400).json({ error: 'Revisá los campos marcados.', fields: errors });
    }
    if (!data.company && req.user.business_name) data.company = req.user.business_name;
    const id = insertListing(db, data, { user_id: req.user.id, status: 'pending', payment_status: 'unpaid' });
    res.status(201).json(db.prepare('SELECT * FROM listings WHERE id = ?').get(id));
  });

  r.put('/listings/:id', needUser, handleUpload, (req, res) => {
    const l = ownListing(req, res);
    if (!l) return;
    const input = { ...req.body };
    delete input.expires_at;
    prepareImages(req, input, l);
    const { data, errors } = validateListing(input, { partial: true });
    if (data.category && !checkCategory(req.user, data.category)) errors.category = 'Tu tipo de cuenta no puede publicar en esa sección.';
    if (Object.keys(errors).length) {
      discardUploads(req);
      return res.status(400).json({ error: 'Revisá los campos marcados.', fields: errors });
    }
    // Un aviso rechazado vuelve a revisión al editarlo.
    if (l.status === 'rejected') data.status = 'pending';
    updateListing(db, l.id, data);
    res.json(db.prepare('SELECT * FROM listings WHERE id = ?').get(l.id));
  });

  // Pausar / reactivar: el dueño puede ocultar su aviso sin perder los días pagos.
  r.post('/listings/:id/pause', needUser, (req, res) => {
    const l = ownListing(req, res);
    if (!l) return;
    updateListing(db, l.id, { paused: req.body?.paused === false ? 0 : 1 });
    res.json(db.prepare('SELECT * FROM listings WHERE id = ?').get(l.id));
  });

  r.delete('/listings/:id', needUser, (req, res) => {
    const l = ownListing(req, res);
    if (!l) return;
    db.prepare('DELETE FROM listings WHERE id = ?').run(l.id);
    res.json({ ok: true });
  });

  // ---------- Planes y pagos ----------
  r.get('/plans', needUser, (req, res) => {
    res.json({
      plans: db.prepare('SELECT * FROM plans WHERE account_type = ? AND active = 1 ORDER BY sort, price').all(req.user.type),
      methods: payments.availableMethods(db),
      transfer: { UYU: payments.transferDetails(db, 'UYU'), USD: payments.transferDetails(db, 'USD') },
    });
  });

  r.post('/listings/:id/checkout', needUser, rateLimiter(30, 60 * 60 * 1000), async (req, res, next) => {
    try {
      const l = ownListing(req, res);
      if (!l) return;
      if (l.status === 'rejected') return res.status(400).json({ error: 'El aviso fue rechazado. Editalo para que lo revisemos antes de pagar.' });
      if (!req.user.email_verified && verificationRequired(db)) {
        return res.status(403).json({ error: 'Confirmá tu email para publicar. Te enviamos un enlace a tu correo.', code: 'email_not_verified' });
      }
      const plan = db.prepare('SELECT * FROM plans WHERE id = ? AND account_type = ? AND active = 1').get(Number(req.body?.plan_id), req.user.type);
      if (!plan) return res.status(400).json({ error: 'Elegí un plan válido.' });
      const pay = await payments.createCheckout(db, { user: req.user, listing: l, plan, method: req.body?.method, baseUrl: baseUrl(req) });
      res.status(201).json(publicPayment(pay));
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

  r.get('/payments', needUser, (req, res) => {
    const rows = db
      .prepare('SELECT p.*, l.title AS listing_title FROM payments p LEFT JOIN listings l ON l.id = p.listing_id WHERE p.user_id = ? ORDER BY p.id DESC LIMIT 200')
      .all(req.user.id);
    res.json(rows.map(publicPayment));
  });

  r.get('/payments/:id', needUser, (req, res) => {
    const pay = db.prepare('SELECT * FROM payments WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
    if (!pay) return res.status(404).json({ error: 'Pago no encontrado' });
    const listing = pay.listing_id ? db.prepare('SELECT id, title, status, expires_at, payment_status FROM listings WHERE id = ?').get(pay.listing_id) : null;
    res.json({ ...publicPayment(pay), listing, transfer: pay.method === 'transfer' ? payments.transferDetails(db, pay.currency) : undefined });
  });

  // El anunciante sube el comprobante de la transferencia.
  r.post('/payments/:id/receipt', needUser, rateLimiter(20, 60 * 60 * 1000), (req, res, next) => {
    const pay = db.prepare('SELECT * FROM payments WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
    if (!pay) return res.status(404).json({ error: 'Pago no encontrado' });
    if (pay.method !== 'transfer' || pay.status !== 'pending') return res.status(400).json({ error: 'Este pago no admite comprobante.' });
    receiptUpload.single('receipt')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera los 8 MB.' : err.message });
      if (!req.file) return res.status(400).json({ error: 'Adjuntá el comprobante.' });
      try {
        if (pay.receipt_file) fs.rm(path.join(receiptDir, pay.receipt_file), () => {});
        db.prepare("UPDATE payments SET receipt_file = ?, receipt_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), payer_note = ? WHERE id = ?").run(
          req.file.filename, String(req.body?.payer_note || '').slice(0, 300), pay.id,
        );
        const s = getSettings(db);
        if (s.contact_email) {
          enqueueEmail(db, s.contact_email, `Comprobante recibido: pago #${pay.id}`, `${req.user.business_name || req.user.name} (${req.user.email}) subió el comprobante de ${pay.currency === 'USD' ? 'US$' : '$'} ${pay.amount}.\nRevisalo y confirmalo: ${baseUrl(req)}/admin/#/pagos?status=pending&method=transfer`);
        }
        res.json(publicPayment(db.prepare('SELECT * FROM payments WHERE id = ?').get(pay.id)));
      } catch (e) {
        next(e);
      }
    });
  });

  r.get('/payments/:id/receipt', needUser, (req, res) => {
    const pay = db.prepare('SELECT receipt_file FROM payments WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
    if (!pay || !pay.receipt_file) return res.status(404).json({ error: 'Sin comprobante' });
    res.sendFile(path.join(receiptDir, pay.receipt_file), { headers: { 'Cache-Control': 'private, no-store' } });
  });

  // Comprobante de pago imprimible.
  r.get('/payments/:id/recibo', needUser, (req, res) => {
    const pay = db.prepare("SELECT * FROM payments WHERE id = ? AND user_id = ? AND status = 'approved'").get(Number(req.params.id), req.user.id);
    if (!pay) return res.status(404).type('text').send('Comprobante no disponible');
    res.type('html').send(renderReceipt(db, pay));
  });

  r.post('/payments/:id/cancel', needUser, (req, res) => {
    const r2 = db.prepare("UPDATE payments SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'").run(Number(req.params.id), req.user.id);
    res.json({ ok: r2.changes > 0 });
  });

  return r;
}

/** Visitas por día de los últimos `days` días (incluye los días sin visitas). */
function dailyViews(db, where, arg, days = 30) {
  const rows = db
    .prepare(
      `SELECT v.day, SUM(v.views) n FROM listing_views_daily v JOIN listings l ON l.id = v.listing_id
       WHERE ${where} AND v.day >= date('now', ?) GROUP BY v.day`,
    )
    .all(arg, `-${days - 1} days`);
  const map = Object.fromEntries(rows.map((r) => [r.day, r.n]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    out.push({ day: d, views: map[d] || 0 });
  }
  return out;
}

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const METHOD_NAMES = { transfer: 'Transferencia bancaria', free: 'Sin cargo', demo: 'Prueba' };

function renderReceipt(db, pay) {
  const s = getSettings(db);
  const money = `${pay.currency === 'USD' ? 'US$' : '$'} ${Number(pay.amount).toLocaleString('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const e = escapeHtml;
  const row = (k, v) => (v ? `<tr><th>${e(k)}</th><td>${e(v)}</td></tr>` : '');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Comprobante de pago N.º ${pay.id}</title>
<style>
  body{font-family:system-ui,sans-serif;color:#10252d;max-width:640px;margin:32px auto;padding:0 16px;line-height:1.5}
  h1{font-size:1.4rem;margin:0}.muted{color:#5b6b75}table{width:100%;border-collapse:collapse;margin:16px 0}
  th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #dbe3e8;vertical-align:top}th{width:40%;color:#5b6b75;font-weight:600}
  .total{font-size:1.5rem;font-weight:800}.box{border:1px solid #dbe3e8;border-radius:12px;padding:18px}
  .note{font-size:.85rem;color:#5b6b75}button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid #0b6e8a;background:#0b6e8a;color:#fff;cursor:pointer}
  @media print{button{display:none}body{margin:0}}
</style></head><body>
<div class="box">
  <img src="/img/icon.svg" alt="Maldonado Oportunidades" width="48" height="48" style="display:block;margin-bottom:10px">
  <p class="muted" style="margin:0">${e(s.billing_name || s.site_name)}${s.billing_rut ? ` · RUT ${e(s.billing_rut)}` : ''}${s.billing_address ? ` · ${e(s.billing_address)}` : ''}</p>
  <h1>Comprobante de pago N.º ${pay.id}</h1>
  <table>
    ${row('Fecha de pago', new Date(pay.paid_at || pay.created_at).toLocaleString('es-UY'))}
    ${row('Cliente', pay.invoice_name)}
    ${row('RUT', pay.invoice_rut)}
    ${row('Dirección', pay.invoice_address)}
    ${row('Concepto', pay.description)}
    ${row('Medio de pago', METHOD_NAMES[pay.method] || pay.method)}
    <tr><th>Total</th><td class="total">${e(money)}</td></tr>
  </table>
  <p class="note">Este comprobante acredita el pago del servicio de publicación.</p>
</div>
<p><button type="button" onclick="window.print()">Imprimir o guardar como PDF</button></p>
</body></html>`;
}

function publicAdvertiser(u) {
  const t = getAccountType(u.type);
  return { id: u.id, type: u.type, typeLabel: t ? t.label : u.type, name: u.business_name || u.name, verified: Boolean(u.verified) };
}

module.exports = { createAccountRouter, publicUser, publicAdvertiser, getCategory, dailyViews, renderReceipt };
