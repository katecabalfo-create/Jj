'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');

const { CATEGORIES, MALDONADO_LOCALITIES, DEPARTMENTS, getCategory, locationsFor } = require('./categories');
const { getSettings, setSettings, token } = require('./db');
const { searchListings, getPublicListing, validateListing, insertListing, updateListing } = require('./listings');
const { notifyNewListing, buildDigests, flushOutbox, smtpConfigured, enqueueEmail } = require('./notify');
const auth = require('./auth');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Limitador simple en memoria: `max` peticiones por `windowMs` por clave. */
function rateLimiter(max, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Demasiados intentos. Probá de nuevo más tarde.' });
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > 5000) hits.clear();
    next();
  };
}

function createApp(db, options = {}) {
  const uploadDir = options.uploadDir || path.join(__dirname, '..', 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === '0' ? false : 1);
  app.use(express.json({ limit: '200kb' }));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  const baseUrl = (req) => process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const settings = () => getSettings(db);

  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (req, file, cb) => {
        const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[file.mimetype];
        cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
      },
    }),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
      if (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype)) cb(null, true);
      else cb(new Error('Solo se aceptan imágenes JPG, PNG, WEBP o GIF.'));
    },
  });

  const handleUpload = (req, res, next) =>
    upload.single('imageFile')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'La imagen supera los 5 MB.' : err.message });
      next();
    });

  // ---------- Páginas con AdSense inyectado ----------
  const indexTemplate = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

  function renderIndex(req, res) {
    const s = settings();
    let head = '';
    if (s.adsense_enabled === '1' && /^ca-pub-\d{10,20}$/.test(s.adsense_client)) {
      head = `<meta name="google-adsense-account" content="${escapeHtml(s.adsense_client)}">\n    <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${escapeHtml(s.adsense_client)}" crossorigin="anonymous"></script>`;
    }
    const html = indexTemplate
      .replace('<!--ADSENSE_HEAD-->', head)
      .replaceAll('{{SITE_NAME}}', escapeHtml(s.site_name))
      .replaceAll('{{SITE_TAGLINE}}', escapeHtml(s.site_tagline))
      .replaceAll('{{BASE_URL}}', escapeHtml(baseUrl(req)));
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  }

  app.get(['/', '/index.html'], renderIndex);

  app.get('/ads.txt', (req, res) => {
    const s = settings();
    const pub = s.adsense_client.replace(/^ca-/, '');
    if (!/^pub-\d{10,20}$/.test(pub)) return res.status(404).type('text').send('');
    res.type('text').send(`google.com, ${pub}, DIRECT, f08c47fec0942fa0\n`);
  });

  app.get('/robots.txt', (req, res) => {
    res.type('text').send(`User-agent: *\nDisallow: /admin/\nDisallow: /api/admin/\nSitemap: ${baseUrl(req)}/sitemap.xml\n`);
  });

  app.get('/sitemap.xml', (req, res) => {
    const b = baseUrl(req);
    const rows = db
      .prepare("SELECT id, updated_at FROM listings WHERE status = 'approved' ORDER BY id DESC LIMIT 5000")
      .all();
    const urls = [
      `<url><loc>${b}/</loc></url>`,
      ...rows.map((r) => `<url><loc>${b}/aviso/${r.id}</loc><lastmod>${r.updated_at.slice(0, 10)}</lastmod></url>`),
    ];
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`);
  });

  // Enlace compartible a un aviso: página con metadatos (para buscadores y redes) que abre la app.
  app.get('/aviso/:id', (req, res) => {
    const l = getPublicListing(db, Number(req.params.id));
    if (!l) return res.redirect('/');
    const s = settings();
    const desc = escapeHtml(l.description.slice(0, 200));
    const img = l.image ? (l.image.startsWith('/') ? baseUrl(req) + l.image : l.image) : '';
    res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>${escapeHtml(l.title)} | ${escapeHtml(s.site_name)}</title>
<meta name="description" content="${desc}">
<meta property="og:title" content="${escapeHtml(l.title)}"><meta property="og:description" content="${desc}">
${img ? `<meta property="og:image" content="${escapeHtml(img)}">` : ''}
<meta http-equiv="refresh" content="0; url=/#/aviso/${l.id}"></head>
<body><h1>${escapeHtml(l.title)}</h1><p>${escapeHtml(l.description)}</p><a href="/#/aviso/${l.id}">Ver aviso</a></body></html>`);
  });

  app.use('/uploads', express.static(uploadDir, { maxAge: '30d', fallthrough: false }));
  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));

  // ---------- API pública ----------
  app.get('/api/meta', (req, res) => {
    const s = settings();
    res.json({
      siteName: s.site_name,
      tagline: s.site_tagline,
      contactEmail: s.contact_email,
      pageSize: Number(s.page_size) || 12,
      categories: CATEGORIES.map((c) => ({ ...c, locations: locationsFor(c.id) })),
      localities: MALDONADO_LOCALITIES,
      departments: DEPARTMENTS,
      adsense:
        s.adsense_enabled === '1' && s.adsense_client
          ? {
              client: s.adsense_client,
              slotTop: s.adsense_slot_top,
              slotFeed: s.adsense_slot_feed,
              slotDetail: s.adsense_slot_detail,
              feedEvery: Number(s.adsense_feed_every) || 6,
            }
          : null,
    });
  });

  app.get('/api/listings', (req, res) => {
    const s = settings();
    res.json(searchListings(db, req.query, { defaultPageSize: Number(s.page_size) || 12 }));
  });

  app.get('/api/counts', (req, res) => {
    const rows = db
      .prepare(
        `SELECT category, COUNT(*) n FROM listings WHERE status = 'approved'
         AND (expires_at IS NULL OR expires_at = '' OR expires_at >= strftime('%Y-%m-%d','now')) GROUP BY category`,
      )
      .all();
    res.json(Object.fromEntries(rows.map((r) => [r.category, r.n])));
  });

  app.get('/api/listings/:id', (req, res) => {
    const id = Number(req.params.id);
    const l = getPublicListing(db, id);
    if (!l) return res.status(404).json({ error: 'Aviso no encontrado' });
    db.prepare('UPDATE listings SET views = views + 1 WHERE id = ?').run(id);
    const related = db
      .prepare(
        `SELECT id, title, location, price, currency, image, category FROM listings
         WHERE status = 'approved' AND category = ? AND id <> ? ORDER BY published_at DESC LIMIT 4`,
      )
      .all(l.category, id);
    res.json({ ...l, related });
  });

  const submitLimiter = rateLimiter(Number(process.env.SUBMIT_LIMIT_PER_HOUR || 10), 60 * 60 * 1000);
  app.post('/api/listings', submitLimiter, handleUpload, (req, res) => {
    const body = req.body || {};
    if (body.hp_field) return res.status(201).json({ ok: true, id: 0, status: 'pending' }); // honeypot anti-spam
    const input = { ...body };
    if (req.file) input.image = `/uploads/${req.file.filename}`;
    delete input.expires_at;
    const { data, errors } = validateListing(input);
    if (body.accept_terms !== 'on' && body.accept_terms !== true && body.accept_terms !== '1') {
      errors.accept_terms = 'Tenés que aceptar las condiciones.';
    }
    if (Object.keys(errors).length) {
      if (req.file) fs.rm(req.file.path, () => {});
      return res.status(400).json({ error: 'Revisá los campos marcados.', fields: errors });
    }
    const s = settings();
    const approved = s.moderation !== '1';
    const id = insertListing(db, data, {
      status: approved ? 'approved' : 'pending',
      published_at: approved ? new Date().toISOString() : null,
    });
    if (approved) notifyNewListing(db, db.prepare('SELECT * FROM listings WHERE id = ?').get(id), baseUrl(req));
    if (s.contact_email) {
      enqueueEmail(db, s.contact_email, `Nuevo aviso ${approved ? 'publicado' : 'para revisar'}: ${data.title}`, `Sección: ${getCategory(data.category).label}\n${baseUrl(req)}/admin/#/avisos/${id}`);
    }
    res.status(201).json({ ok: true, id, status: approved ? 'approved' : 'pending' });
  });

  // ---------- Alertas / notificaciones ----------
  function normalizeSub(body) {
    const errors = {};
    const email = String(body.email || '').trim().toLowerCase().slice(0, 160);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Email no válido.';
    const cats = Array.isArray(body.categories) ? body.categories.filter((c) => getCategory(c)) : [];
    const frequency = ['instant', 'daily', 'weekly'].includes(body.frequency) ? body.frequency : 'instant';
    return {
      errors,
      data: {
        email,
        categories: JSON.stringify(cats),
        keywords: String(body.keywords || '').slice(0, 300),
        location: String(body.location || '').slice(0, 80),
        frequency,
      },
    };
  }

  function publicSub(sub) {
    return {
      email: sub.email,
      categories: JSON.parse(sub.categories),
      keywords: sub.keywords,
      location: sub.location,
      frequency: sub.frequency,
      active: Boolean(sub.active),
      token: sub.token,
    };
  }

  const subLimiter = rateLimiter(20, 60 * 60 * 1000);
  app.post('/api/subscriptions', subLimiter, (req, res) => {
    const { data, errors } = normalizeSub(req.body || {});
    if (Object.keys(errors).length) return res.status(400).json({ error: 'Revisá los campos marcados.', fields: errors });
    const existing = db.prepare('SELECT * FROM subscriptions WHERE email = ?').get(data.email);
    if (existing) {
      // No se exponen ni modifican las preferencias de otra persona: se le envía su enlace de gestión.
      enqueueEmail(
        db,
        existing.email,
        'Gestioná tus alertas de Maldonado Oportunidades',
        `Recibimos un pedido para configurar alertas con este email.\nPodés modificarlas acá: ${baseUrl(req)}/#/alertas?token=${existing.token}`,
      );
      return res.json({ ok: true, existing: true });
    }
    const t = token();
    db.prepare('INSERT INTO subscriptions (email, categories, keywords, location, frequency, token) VALUES (?, ?, ?, ?, ?, ?)').run(
      data.email, data.categories, data.keywords, data.location, data.frequency, t,
    );
    enqueueEmail(
      db,
      data.email,
      'Tus alertas de Maldonado Oportunidades están activas',
      `¡Listo! Te avisaremos cuando se publiquen avisos que coincidan con tu búsqueda.\nModificar o cancelar: ${baseUrl(req)}/#/alertas?token=${t}`,
    );
    res.status(201).json({ ok: true, subscription: publicSub(db.prepare('SELECT * FROM subscriptions WHERE token = ?').get(t)) });
  });

  app.get('/api/subscriptions/:token', (req, res) => {
    const sub = db.prepare('SELECT * FROM subscriptions WHERE token = ?').get(req.params.token);
    if (!sub) return res.status(404).json({ error: 'Alerta no encontrada' });
    res.json(publicSub(sub));
  });

  app.put('/api/subscriptions/:token', (req, res) => {
    const sub = db.prepare('SELECT * FROM subscriptions WHERE token = ?').get(req.params.token);
    if (!sub) return res.status(404).json({ error: 'Alerta no encontrada' });
    const { data } = normalizeSub({ ...req.body, email: sub.email });
    const active = req.body.active === false ? 0 : 1;
    db.prepare('UPDATE subscriptions SET categories = ?, keywords = ?, location = ?, frequency = ?, active = ? WHERE id = ?').run(
      data.categories, data.keywords, data.location, data.frequency, active, sub.id,
    );
    res.json(publicSub(db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(sub.id)));
  });

  app.delete('/api/subscriptions/:token', (req, res) => {
    const r = db.prepare('DELETE FROM subscriptions WHERE token = ?').run(req.params.token);
    if (!r.changes) return res.status(404).json({ error: 'Alerta no encontrada' });
    res.json({ ok: true });
  });

  app.get('/api/subscriptions/:token/unsubscribe', (req, res) => {
    const r = db.prepare('UPDATE subscriptions SET active = 0 WHERE token = ?').run(req.params.token);
    res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Alertas</title><body style="font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem">
<h1>${r.changes ? 'Te diste de baja' : 'Alerta no encontrada'}</h1>
<p>${r.changes ? 'No vas a recibir más correos de esta alerta.' : ''}</p><p><a href="/">Volver a Maldonado Oportunidades</a></p></body>`);
  });

  // ---------- API de administración ----------
  const loginLimiter = rateLimiter(10, 15 * 60 * 1000);
  app.post('/api/admin/login', loginLimiter, (req, res) => {
    if (!auth.checkPassword(req.body?.password || '')) return res.status(401).json({ error: 'Contraseña incorrecta' });
    auth.issueSession(res, req.secure);
    res.json({ ok: true });
  });
  app.post('/api/admin/logout', (req, res) => {
    auth.clearSession(res);
    res.json({ ok: true });
  });
  app.get('/api/admin/me', (req, res) => {
    res.json({ admin: auth.isAdmin(req), defaultPassword: auth.usingDefaultPassword(), smtp: smtpConfigured() });
  });

  const admin = express.Router();
  admin.use(auth.requireAdmin);

  admin.get('/stats', (req, res) => {
    const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM listings GROUP BY status').all().map((r) => [r.status, r.n]));
    const byCategory = db.prepare('SELECT category, status, COUNT(*) n FROM listings GROUP BY category, status').all();
    const views = db.prepare('SELECT COALESCE(SUM(views),0) n FROM listings').get().n;
    const subs = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(active),0) active FROM subscriptions').get();
    const outbox = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM outbox GROUP BY status').all().map((r) => [r.status, r.n]));
    const last7 = db.prepare("SELECT COUNT(*) n FROM listings WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')").get().n;
    res.json({ byStatus, byCategory, views, subs, outbox, last7, smtp: smtpConfigured() });
  });

  admin.get('/listings', (req, res) => res.json(searchListings(db, req.query, { admin: true, defaultPageSize: 20 })));

  admin.get('/listings/:id', (req, res) => {
    const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(Number(req.params.id));
    if (!l) return res.status(404).json({ error: 'No encontrado' });
    res.json(l);
  });

  function applyStatus(id, status, req) {
    const cur = db.prepare('SELECT * FROM listings WHERE id = ?').get(id);
    if (!cur) return false;
    const patch = { status };
    if (status === 'approved' && !cur.published_at) patch.published_at = new Date().toISOString();
    updateListing(db, id, patch);
    if (status === 'approved') notifyNewListing(db, db.prepare('SELECT * FROM listings WHERE id = ?').get(id), baseUrl(req));
    return true;
  }

  admin.post('/listings', handleUpload, (req, res) => {
    const input = { ...req.body };
    if (req.file) input.image = `/uploads/${req.file.filename}`;
    const { data, errors } = validateListing(input);
    delete errors.contact; // el administrador puede publicar sin contacto
    if (Object.keys(errors).length) return res.status(400).json({ error: 'Revisá los campos marcados.', fields: errors });
    const status = ['pending', 'approved', 'rejected'].includes(req.body.status) ? req.body.status : 'approved';
    const featured = req.body.featured === '1' || req.body.featured === 'on' || req.body.featured === true ? 1 : 0;
    const id = insertListing(db, data, { status: 'pending', featured });
    if (status !== 'pending') applyStatus(id, status, req);
    res.status(201).json(db.prepare('SELECT * FROM listings WHERE id = ?').get(id));
  });

  admin.put('/listings/:id', handleUpload, (req, res) => {
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM listings WHERE id = ?').get(id);
    if (!cur) return res.status(404).json({ error: 'No encontrado' });
    const input = { ...req.body };
    if (req.file) input.image = `/uploads/${req.file.filename}`;
    const { data, errors } = validateListing(input, { partial: true });
    if (Object.keys(errors).length) return res.status(400).json({ error: 'Revisá los campos marcados.', fields: errors });
    if (req.body.featured !== undefined) data.featured = req.body.featured === '1' || req.body.featured === 'on' || req.body.featured === true ? 1 : 0;
    updateListing(db, id, data);
    if (req.body.status && req.body.status !== cur.status && ['pending', 'approved', 'rejected'].includes(req.body.status)) {
      applyStatus(id, req.body.status, req);
    }
    res.json(db.prepare('SELECT * FROM listings WHERE id = ?').get(id));
  });

  admin.delete('/listings/:id', (req, res) => {
    const r = db.prepare('DELETE FROM listings WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: r.changes > 0 });
  });

  admin.post('/listings/bulk', (req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger).slice(0, 500);
    const action = req.body?.action;
    let n = 0;
    for (const id of ids) {
      if (['approved', 'rejected', 'pending'].includes(action)) n += applyStatus(id, action, req) ? 1 : 0;
      else if (action === 'delete') n += db.prepare('DELETE FROM listings WHERE id = ?').run(id).changes;
      else if (action === 'feature' || action === 'unfeature') {
        n += db.prepare('UPDATE listings SET featured = ? WHERE id = ?').run(action === 'feature' ? 1 : 0, id).changes;
      } else return res.status(400).json({ error: 'Acción no válida' });
    }
    res.json({ ok: true, affected: n });
  });

  admin.get('/settings', (req, res) => res.json(settings()));
  admin.put('/settings', (req, res) => {
    const body = req.body || {};
    if (body.adsense_client && !/^ca-pub-\d{10,20}$/.test(String(body.adsense_client).trim())) {
      return res.status(400).json({ error: 'El ID de AdSense debe tener el formato ca-pub-1234567890123456', fields: { adsense_client: 'Formato: ca-pub-…' } });
    }
    if (body.adsense_client) body.adsense_client = String(body.adsense_client).trim();
    setSettings(db, body);
    res.json(settings());
  });

  admin.get('/subscriptions', (req, res) => {
    res.json(db.prepare('SELECT id, email, categories, keywords, location, frequency, active, last_sent_at, created_at FROM subscriptions ORDER BY id DESC LIMIT 1000').all());
  });
  admin.delete('/subscriptions/:id', (req, res) => {
    db.prepare('DELETE FROM subscriptions WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });
  admin.put('/subscriptions/:id', (req, res) => {
    db.prepare('UPDATE subscriptions SET active = ? WHERE id = ?').run(req.body?.active ? 1 : 0, Number(req.params.id));
    res.json({ ok: true });
  });

  admin.get('/outbox', (req, res) => {
    res.json(db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT 200').all());
  });
  admin.post('/outbox/flush', async (req, res) => {
    const digests = buildDigests(db, baseUrl(req));
    const r = await flushOutbox(db);
    res.json({ ...r, digests, smtp: smtpConfigured() });
  });
  admin.delete('/outbox', (req, res) => {
    db.prepare("DELETE FROM outbox WHERE status <> 'queued'").run();
    res.json({ ok: true });
  });
  admin.post('/test-email', async (req, res) => {
    const to = String(req.body?.to || settings().contact_email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'Indicá un email válido' });
    enqueueEmail(db, to, 'Prueba de Maldonado Oportunidades', 'Si recibiste este correo, las notificaciones funcionan correctamente.');
    const r = await flushOutbox(db);
    res.json({ ...r, smtp: smtpConfigured() });
  });

  app.use('/api/admin', admin);

  app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado' }));
  app.get('/admin', (req, res) => {
    if (!req.originalUrl.split('?')[0].endsWith('/')) return res.redirect('/admin/');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUBLIC_DIR, 'admin', 'index.html'));
  });
  app.use((req, res) => res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>No encontrado</title><p>Página no encontrada. <a href="/">Volver al inicio</a></p>'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON no válido' });
    res.status(500).json({ error: 'Error interno' });
  });

  return app;
}

module.exports = { createApp, escapeHtml };
