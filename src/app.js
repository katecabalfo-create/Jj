'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');

const { CATEGORIES, MALDONADO_LOCALITIES, DEPARTMENTS, getCategory, locationsFor, MAX_IMAGES, UY_BOUNDS } = require('./categories');
const { getSettings, setSettings, token } = require('./db');
const { PUBLIC_WHERE, searchListings, getPublicListing, validateListing, insertListing, updateListing } = require('./listings');
const { notifyNewListing, buildDigests, flushOutbox, smtpConfigured, enqueueEmail } = require('./notify');
const auth = require('./auth');
const payments = require('./payments');
const { createAccountRouter, publicAdvertiser, renderReceipt } = require('./account');
const { createCrm } = require('./crm');
const { ACCOUNT_TYPES, ACCOUNT_TYPE_IDS } = require('./categories');

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
  const uploadDir = options.uploadDir || process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
  const receiptDir = options.receiptDir || process.env.RECEIPTS_DIR || path.join(__dirname, '..', 'data', 'receipts');
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
    limits: { fileSize: 5 * 1024 * 1024, files: MAX_IMAGES + 1 },
    fileFilter: (req, file, cb) => {
      if (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype)) cb(null, true);
      else cb(new Error('Solo se aceptan imágenes JPG, PNG, WEBP o GIF.'));
    },
  });

  // Acepta "imageFiles" (varias fotos) y "imageFile" (una, por compatibilidad).
  const handleUpload = (req, res, next) =>
    upload.fields([{ name: 'imageFiles', maxCount: MAX_IMAGES }, { name: 'imageFile', maxCount: 1 }])(req, res, (err) => {
      if (err) {
        const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Cada foto puede pesar hasta 5 MB.' : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `Podés subir hasta ${MAX_IMAGES} fotos.` : err.message;
        return res.status(400).json({ error: msg, fields: { image: msg } });
      }
      req.uploaded = [...((req.files && req.files.imageFile) || []), ...((req.files && req.files.imageFiles) || [])];
      next();
    });

  const discardUploads = (req) => (req.uploaded || []).forEach((f) => fs.rm(f.path, () => {}));

  /**
   * Arma la lista de fotos del aviso: las que se conservan (keep_images, en orden) más las subidas.
   * Si el formulario no toca las fotos, no cambia nada.
   */
  function prepareImages(req, input, current = null) {
    const uploaded = (req.uploaded || []).map((f) => `/uploads/${f.filename}`);
    const hasKeep = input.keep_images !== undefined;
    const hasUrl = typeof input.image === 'string' && input.image.trim() !== '';
    if (!uploaded.length && !hasKeep && !hasUrl) {
      delete input.image;
      return;
    }
    let keep = [];
    if (hasKeep) {
      try {
        keep = JSON.parse(input.keep_images || '[]');
      } catch {
        keep = [];
      }
    } else if (current) {
      try {
        keep = JSON.parse(current.images || '[]');
      } catch {
        keep = [];
      }
      if (!keep.length && current.image) keep = [current.image];
    }
    if (!Array.isArray(keep)) keep = [];
    if (hasUrl && !keep.includes(input.image.trim())) keep.unshift(input.image.trim());
    input.images = JSON.stringify([...keep, ...uploaded]);
    delete input.keep_images;
    delete input.image;
  }

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
    res.type('text').send(`User-agent: *\nDisallow: /admin/\nDisallow: /api/admin/\nDisallow: /cuenta/\nDisallow: /api/account/\nSitemap: ${baseUrl(req)}/sitemap.xml\n`);
  });

  app.get('/sitemap.xml', (req, res) => {
    const b = baseUrl(req);
    const rows = db
      .prepare(`SELECT l.id, l.updated_at FROM listings l WHERE ${PUBLIC_WHERE} ORDER BY l.id DESC LIMIT 5000`)
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
<meta property="og:image" content="${escapeHtml(img || `${baseUrl(req)}/img/og-image.png`)}"><meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/img/icon.svg" type="image/svg+xml">
<meta http-equiv="refresh" content="0; url=/#/aviso/${l.id}"></head>
<body><h1>${escapeHtml(l.title)}</h1><p>${escapeHtml(l.description)}</p><a href="/#/aviso/${l.id}">Ver aviso</a></body></html>`);
  });

  app.use('/uploads', express.static(uploadDir, { maxAge: '30d', fallthrough: false }));
  // Leaflet (mapas) servido desde el propio sitio, sin depender de un CDN.
  app.use('/vendor/leaflet', express.static(path.dirname(require.resolve('leaflet/dist/leaflet.js')), { maxAge: '30d', fallthrough: false }));
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
      accountTypes: ACCOUNT_TYPES,
      maxImages: MAX_IMAGES,
      uyBounds: UY_BOUNDS,
      cookieBanner: s.cookie_banner === '1',
      freePosting: s.public_free_posting === '1',
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
        `SELECT l.category, COUNT(*) n FROM listings l WHERE ${PUBLIC_WHERE} GROUP BY l.category`,
      )
      .all();
    res.json(Object.fromEntries(rows.map((r) => [r.category, r.n])));
  });

  app.get('/api/listings/:id', (req, res) => {
    const id = Number(req.params.id);
    const l = getPublicListing(db, id);
    if (!l) return res.status(404).json({ error: 'Aviso no encontrado' });
    db.prepare('UPDATE listings SET views = views + 1 WHERE id = ?').run(id);
    db.prepare(
      `INSERT INTO listing_views_daily (listing_id, day, views) VALUES (?, date('now'), 1)
       ON CONFLICT(listing_id, day) DO UPDATE SET views = views + 1`,
    ).run(id);
    const related = db
      .prepare(
        `SELECT l.id, l.title, l.location, l.price, l.currency, l.image, l.category, l.featured, l.published_at FROM listings l
         WHERE ${PUBLIC_WHERE} AND l.category = ? AND l.id <> ? ORDER BY l.published_at DESC LIMIT 4`,
      )
      .all(l.category, id);
    const advertiser = l.user_id
      ? db.prepare('SELECT id, type, name, business_name, verified FROM users WHERE id = ?').get(l.user_id)
      : null;
    res.json({ ...l, related, advertiser: advertiser ? publicAdvertiser(advertiser) : null });
  });

  const submitLimiter = rateLimiter(Number(process.env.SUBMIT_LIMIT_PER_HOUR || 10), 60 * 60 * 1000);
  app.post('/api/listings', submitLimiter, handleUpload, (req, res) => {
    const body = req.body || {};
    if (body.hp_field) return res.status(201).json({ ok: true, id: 0, status: 'pending' }); // honeypot anti-spam
    if (settings().public_free_posting !== '1') {
      discardUploads(req);
      return res.status(403).json({ error: 'Para publicar creá una cuenta de anunciante.' });
    }
    const input = { ...body };
    delete input.expires_at;
    prepareImages(req, input);
    const { data, errors } = validateListing(input);
    if (body.accept_terms !== 'on' && body.accept_terms !== true && body.accept_terms !== '1') {
      errors.accept_terms = 'Tenés que aceptar las condiciones.';
    }
    if (Object.keys(errors).length) {
      discardUploads(req);
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

  // Perfil público de un anunciante con sus avisos vigentes.
  app.get('/api/advertisers/:id', (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(Number(req.params.id));
    if (!u) return res.status(404).json({ error: 'Anunciante no encontrado' });
    const s = settings();
    res.json({
      ...publicAdvertiser(u),
      about: u.about,
      location: u.location,
      website: u.website,
      since: u.created_at,
      listings: searchListings(db, { ...req.query, user: u.id }, { defaultPageSize: Number(s.page_size) || 12 }),
    });
  });

  // ---------- Cuentas de anunciantes ----------
  app.use('/api/account', createAccountRouter(db, { handleUpload, prepareImages, discardUploads, baseUrl, rateLimiter, receiptDir }));

  // ---------- Webhook de Mercado Pago ----------
  app.post('/api/payments/mercadopago/webhook', async (req, res) => {
    const type = req.query.type || req.query.topic || req.body?.type;
    const dataId = String(req.query['data.id'] || req.query.id || req.body?.data?.id || '');
    if (type !== 'payment' || !dataId) return res.sendStatus(200);
    if (!payments.verifyMpSignature(req, dataId)) return res.sendStatus(401);
    if (!payments.mpConfigured()) return res.sendStatus(200);
    try {
      const mp = await payments.fetchMpPayment(dataId);
      payments.handleMpPayment(db, mp, baseUrl(req));
      res.sendStatus(200);
    } catch (err) {
      console.error('Webhook Mercado Pago:', err.message);
      res.sendStatus(500); // Mercado Pago reintenta
    }
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
    res.json({ admin: auth.isAdmin(req), defaultPassword: auth.usingDefaultPassword(), smtp: smtpConfigured(), mercadopago: payments.mpConfigured() });
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
    const users = Object.fromEntries(db.prepare('SELECT type, COUNT(*) n FROM users GROUP BY type').all().map((r) => [r.type, r.n]));
    const revenue = db.prepare("SELECT currency, SUM(amount) total, COUNT(*) n FROM payments WHERE status = 'approved' AND method <> 'demo' GROUP BY currency").all();
    const revenue30 = db
      .prepare("SELECT currency, SUM(amount) total FROM payments WHERE status = 'approved' AND method <> 'demo' AND paid_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days') GROUP BY currency")
      .all();
    const pendingTransfers = db.prepare("SELECT COUNT(*) n FROM payments WHERE status = 'pending' AND method = 'transfer'").get().n;
    const unpaid = db.prepare("SELECT COUNT(*) n FROM listings WHERE payment_status = 'unpaid'").get().n;
    const pendingReady = db.prepare("SELECT COUNT(*) n FROM listings WHERE status = 'pending' AND payment_status <> 'unpaid'").get().n;
    res.json({
      byStatus, byCategory, views, subs, outbox, last7, smtp: smtpConfigured(), users, revenue, revenue30,
      pendingTransfers, unpaid, pendingReady, mercadopago: payments.mpConfigured(), demo: payments.demoEnabled(),
      transferReady: payments.availableMethods(db).includes('transfer'),
      receiptsToReview: db.prepare("SELECT COUNT(*) n FROM payments WHERE status = 'pending' AND method = 'transfer' AND receipt_file <> ''").get().n,
    });
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
    prepareImages(req, input);
    const { data, errors } = validateListing(input);
    delete errors.contact; // el administrador puede publicar sin contacto
    if (Object.keys(errors).length) {
      discardUploads(req);
      return res.status(400).json({ error: 'Revisá los campos marcados.', fields: errors });
    }
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
    prepareImages(req, input, cur);
    const { data, errors } = validateListing(input, { partial: true });
    if (Object.keys(errors).length) {
      discardUploads(req);
      return res.status(400).json({ error: 'Revisá los campos marcados.', fields: errors });
    }
    if (req.body.featured !== undefined) data.featured = req.body.featured === '1' || req.body.featured === 'on' || req.body.featured === true ? 1 : 0;
    if (req.body.paused !== undefined) data.paused = req.body.paused === '1' || req.body.paused === true ? 1 : 0;
    if (['none', 'unpaid', 'paid'].includes(req.body.payment_status)) data.payment_status = req.body.payment_status;
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

  // Usuarios anunciantes
  admin.get('/users', (req, res) => {
    const where = [];
    const args = [];
    if (ACCOUNT_TYPE_IDS.includes(req.query.type)) {
      where.push('u.type = ?');
      args.push(req.query.type);
    }
    if (req.query.q) {
      where.push('(u.email LIKE ? OR u.name LIKE ? OR u.business_name LIKE ? OR u.rut LIKE ?)');
      const like = `%${String(req.query.q).trim()}%`;
      args.push(like, like, like, like);
    }
    const rows = db
      .prepare(
        `SELECT u.id, u.type, u.email, u.name, u.business_name, u.rut, u.phone, u.active, u.verified, u.email_verified, u.created_at, u.last_login_at,
          (SELECT COUNT(*) FROM listings l WHERE l.user_id = u.id) AS listings,
          (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.user_id = u.id AND p.status = 'approved' AND p.method <> 'demo') AS paid
         FROM users u ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY u.id DESC LIMIT 500`,
      )
      .all(...args);
    res.json(rows);
  });
  admin.put('/users/:id', (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    if (b.active !== undefined) db.prepare('UPDATE users SET active = ? WHERE id = ?').run(b.active ? 1 : 0, id);
    if (b.verified !== undefined) db.prepare('UPDATE users SET verified = ? WHERE id = ?').run(b.verified ? 1 : 0, id);
    if (b.email_verified !== undefined) db.prepare("UPDATE users SET email_verified = ?, verify_token_hash = '' WHERE id = ?").run(b.email_verified ? 1 : 0, id);
    if (b.password) {
      if (String(b.password).length < 8) return res.status(400).json({ error: 'Mínimo 8 caracteres' });
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(b.password), id);
    }
    res.json({ ok: true });
  });
  admin.delete('/users/:id', (req, res) => {
    db.prepare('DELETE FROM users WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // Pagos
  admin.get('/payments', (req, res) => {
    const where = [];
    const args = [];
    if (['pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status)) {
      where.push('p.status = ?');
      args.push(req.query.status);
    }
    if (['mercadopago', 'transfer', 'free', 'demo'].includes(req.query.method)) {
      where.push('p.method = ?');
      args.push(req.query.method);
    }
    res.json(
      db
        .prepare(
          `SELECT p.*, u.email, u.name, u.business_name, u.type, l.title AS listing_title FROM payments p
           JOIN users u ON u.id = p.user_id LEFT JOIN listings l ON l.id = p.listing_id
           ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.id DESC LIMIT 500`,
        )
        .all(...args),
    );
  });
  admin.post('/payments/:id/approve', (req, res) => {
    const pay = db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(req.params.id));
    if (!pay) return res.status(404).json({ error: 'No encontrado' });
    const ok = payments.applyPayment(db, pay.id, { note: String(req.body?.note || 'Confirmado por el administrador').slice(0, 300) }, baseUrl(req));
    res.json({ ok });
  });
  admin.post('/payments/:id/reject', (req, res) => {
    const r = db
      .prepare("UPDATE payments SET status = 'rejected', note = ? WHERE id = ? AND status = 'pending'")
      .run(String(req.body?.note || 'Rechazado por el administrador').slice(0, 300), Number(req.params.id));
    res.json({ ok: r.changes > 0 });
  });
  // Exportación para el contador (se abre en Excel).
  admin.get('/payments.csv', (req, res) => {
    const where = ["p.status = 'approved'", "p.method <> 'demo'"];
    const args = [];
    if (/^\d{4}-\d{2}$/.test(String(req.query.month || ''))) {
      where.push("substr(p.paid_at, 1, 7) = ?");
      args.push(req.query.month);
    }
    const rows = db
      .prepare(
        `SELECT p.*, u.email FROM payments p JOIN users u ON u.id = p.user_id WHERE ${where.join(' AND ')} ORDER BY p.paid_at`,
      )
      .all(...args);
    const cell = (v) => {
      let t = String(v ?? '');
      if (/^[=+\-@]/.test(t)) t = `'${t}`; // evita fórmulas al abrirlo en Excel
      return `"${t.replace(/"/g, '""')}"`;
    };
    const header = ['N.º pago', 'Fecha de pago', 'Cliente', 'RUT', 'Dirección', 'Email', 'Concepto', 'Medio', 'Moneda', 'Monto', 'Ref. Mercado Pago'];
    const lines = rows.map((p) =>
      [p.id, (p.paid_at || '').slice(0, 10), p.invoice_name, p.invoice_rut, p.invoice_address, p.email, p.description, p.method, p.currency, String(p.amount).replace('.', ','), p.provider_payment_id]
        .map(cell)
        .join(';'),
    );
    res.setHeader('Content-Disposition', `attachment; filename="pagos-${req.query.month || 'todos'}.csv"`);
    res.type('text/csv; charset=utf-8').send('\ufeff' + [header.map(cell).join(';'), ...lines].join('\r\n'));
  });

  admin.get('/payments/:id/recibo', (req, res) => {
    const pay = db.prepare("SELECT * FROM payments WHERE id = ? AND status = 'approved'").get(Number(req.params.id));
    if (!pay) return res.status(404).type('text').send('Comprobante no disponible');
    res.type('html').send(renderReceipt(db, pay));
  });

  admin.get('/payments/:id/receipt', (req, res) => {
    const pay = db.prepare('SELECT receipt_file FROM payments WHERE id = ?').get(Number(req.params.id));
    if (!pay || !pay.receipt_file) return res.status(404).json({ error: 'Sin comprobante' });
    res.sendFile(path.join(receiptDir, pay.receipt_file), { headers: { 'Cache-Control': 'private, no-store' } });
  });
  admin.post('/payments/:id/sync', async (req, res) => {
    const pay = db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(req.params.id));
    if (!pay) return res.status(404).json({ error: 'No encontrado' });
    res.json(await payments.syncPayment(db, pay, baseUrl(req)));
  });

  // Planes y precios
  function validatePlan(b) {
    const errors = {};
    const data = {
      account_type: b.account_type,
      name: String(b.name || '').trim().slice(0, 120),
      description: String(b.description || '').trim().slice(0, 500),
      price: Number(b.price),
      currency: b.currency === 'USD' ? 'USD' : 'UYU',
      duration_days: Number.parseInt(b.duration_days, 10),
      featured: b.featured ? 1 : 0,
      active: b.active === false || b.active === 0 || b.active === '0' ? 0 : 1,
      sort: Number.parseInt(b.sort, 10) || 0,
    };
    if (!ACCOUNT_TYPE_IDS.includes(data.account_type)) errors.account_type = 'Tipo no válido';
    if (!data.name) errors.name = 'Indicá un nombre';
    if (!Number.isFinite(data.price) || data.price < 0) errors.price = 'Precio no válido';
    if (!Number.isInteger(data.duration_days) || data.duration_days < 1 || data.duration_days > 365) errors.duration_days = 'Entre 1 y 365 días';
    return { data, errors };
  }
  admin.get('/plans', (req, res) => res.json(db.prepare('SELECT * FROM plans ORDER BY account_type, sort, price').all()));
  admin.post('/plans', (req, res) => {
    const { data, errors } = validatePlan(req.body || {});
    if (Object.keys(errors).length) return res.status(400).json({ error: 'Revisá los campos', fields: errors });
    const keys = Object.keys(data);
    const id = db.prepare(`INSERT INTO plans (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => data[k])).lastInsertRowid;
    res.status(201).json(db.prepare('SELECT * FROM plans WHERE id = ?').get(id));
  });
  admin.put('/plans/:id', (req, res) => {
    const { data, errors } = validatePlan(req.body || {});
    if (Object.keys(errors).length) return res.status(400).json({ error: 'Revisá los campos', fields: errors });
    const keys = Object.keys(data);
    db.prepare(`UPDATE plans SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => data[k]), Number(req.params.id));
    res.json(db.prepare('SELECT * FROM plans WHERE id = ?').get(Number(req.params.id)));
  });
  admin.delete('/plans/:id', (req, res) => {
    // Se desactiva en vez de borrar para conservar el historial de pagos.
    db.prepare('UPDATE plans SET active = 0 WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // CRM de anunciantes: contactos, segmentos y campañas de email
  const crm = createCrm(db, { baseUrl, requireAdmin: auth.requireAdmin });
  app.use('/api/crm', crm.pub);
  app.use('/api/admin/crm', crm.admin);

  app.use('/api/admin', admin);

  app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado' }));
  app.get('/cuenta', (req, res) => {
    if (!req.originalUrl.split('?')[0].endsWith('/')) return res.redirect('/cuenta/');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUBLIC_DIR, 'cuenta', 'index.html'));
  });
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
