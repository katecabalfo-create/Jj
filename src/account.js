'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');

const { ACCOUNT_TYPE_IDS, getAccountType, getCategory } = require('./categories');
const { getSettings } = require('./db');
const { searchListings, validateListing, insertListing, updateListing } = require('./listings');
const { enqueueEmail } = require('./notify');
const payments = require('./payments');
const auth = require('./auth');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(u) {
  const t = getAccountType(u.type);
  return {
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
  const { user_id, provider_ref, ...rest } = p; // eslint-disable-line no-unused-vars
  return rest;
}

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
  if ((!partial || body.name !== undefined) && (!data.name || data.name.length < 2)) errors.name = 'Indicá tu nombre.';
  if (data.website && !/^https?:\/\//i.test(data.website)) data.website = `https://${data.website}`;
  return { data, errors };
}

function createAccountRouter(db, { handleUpload, baseUrl, rateLimiter }) {
  const r = express.Router();
  const needUser = auth.requireUser(db);

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

    const keys = Object.keys(data);
    const id = Number(
      db
        .prepare(`INSERT INTO users (type, email, password_hash, ${keys.join(', ')}) VALUES (?, ?, ?, ${keys.map(() => '?').join(', ')})`)
        .run(body.type, email, auth.hashPassword(body.password), ...keys.map((k) => data[k])).lastInsertRowid,
    );
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    auth.issueUserSession(res, user, req.secure);
    const t = getAccountType(user.type);
    enqueueEmail(db, email, `Bienvenido/a al ${t.panel} de Maldonado Oportunidades`, `Hola ${user.name}, tu cuenta está lista.\nIngresá a tu panel: ${baseUrl(req)}/cuenta/`);
    const s = getSettings(db);
    if (s.contact_email) enqueueEmail(db, s.contact_email, `Nueva cuenta (${t.label}): ${user.business_name || user.name}`, `${email}\n${baseUrl(req)}/admin/#/usuarios`);
    res.status(201).json({ user: publicUser(user) });
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
    res.json({ user: publicUser(user) });
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
    res.json({ user: publicUser(user) });
  });

  r.get('/me', (req, res) => {
    const user = auth.currentUser(req, db);
    res.json({ user: user ? publicUser(user) : null, paymentMethods: payments.availableMethods(db) });
  });

  r.put('/me', needUser, (req, res) => {
    const { data, errors } = validateProfile(req.body || {}, { partial: true });
    if (Object.keys(errors).length) return res.status(400).json({ error: 'Revisá los campos marcados.', fields: errors });
    const keys = Object.keys(data);
    if (keys.length) db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => data[k]), req.user.id);
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
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
      expiringSoon: db
        .prepare("SELECT id, title, expires_at FROM listings WHERE user_id = ? AND status = 'approved' AND expires_at BETWEEN ? AND date(?, '+5 days') ORDER BY expires_at")
        .all(uid, today, today),
    });
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
    if (req.file) input.image = `/uploads/${req.file.filename}`;
    delete input.expires_at;
    const { data, errors } = validateListing(input);
    if (data.category && !checkCategory(req.user, data.category)) errors.category = 'Tu tipo de cuenta no puede publicar en esa sección.';
    if (Object.keys(errors).length) {
      if (req.file) fs.rm(req.file.path, () => {});
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
    if (req.file) input.image = `/uploads/${req.file.filename}`;
    delete input.expires_at;
    const { data, errors } = validateListing(input, { partial: true });
    if (data.category && !checkCategory(req.user, data.category)) errors.category = 'Tu tipo de cuenta no puede publicar en esa sección.';
    if (Object.keys(errors).length) return res.status(400).json({ error: 'Revisá los campos marcados.', fields: errors });
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
      transferInfo: getSettings(db).bank_transfer_info,
    });
  });

  r.post('/listings/:id/checkout', needUser, rateLimiter(30, 60 * 60 * 1000), async (req, res, next) => {
    try {
      const l = ownListing(req, res);
      if (!l) return;
      if (l.status === 'rejected') return res.status(400).json({ error: 'El aviso fue rechazado. Editalo para que lo revisemos antes de pagar.' });
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

  r.get('/payments/:id', needUser, async (req, res) => {
    let pay = db.prepare('SELECT * FROM payments WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
    if (!pay) return res.status(404).json({ error: 'Pago no encontrado' });
    pay = await payments.syncPayment(db, pay, baseUrl(req));
    const listing = pay.listing_id ? db.prepare('SELECT id, title, status, expires_at, payment_status FROM listings WHERE id = ?').get(pay.listing_id) : null;
    res.json({ ...publicPayment(pay), listing, transferInfo: pay.method === 'transfer' ? getSettings(db).bank_transfer_info : undefined });
  });

  r.post('/payments/:id/cancel', needUser, (req, res) => {
    const r2 = db.prepare("UPDATE payments SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'").run(Number(req.params.id), req.user.id);
    res.json({ ok: r2.changes > 0 });
  });

  return r;
}

function publicAdvertiser(u) {
  const t = getAccountType(u.type);
  return { id: u.id, type: u.type, typeLabel: t ? t.label : u.type, name: u.business_name || u.name, verified: Boolean(u.verified) };
}

module.exports = { createAccountRouter, publicUser, publicAdvertiser, getCategory };
