'use strict';

const { CATEGORY_IDS, getCategory } = require('./categories');

const SORTS = {
  relevance: 'l.featured DESC, COALESCE(l.published_at, l.created_at) DESC',
  recent: 'COALESCE(l.published_at, l.created_at) DESC',
  oldest: 'COALESCE(l.published_at, l.created_at) ASC',
  price_asc: 'l.price IS NULL, l.price ASC',
  price_desc: 'l.price IS NULL, l.price DESC',
  popular: 'l.views DESC',
  event_date: 'l.event_date IS NULL, l.event_date ASC',
  title: 'l.title COLLATE NOCASE ASC',
};

// Condición para que un aviso sea visible al público: aprobado, vigente, pagado si lo requiere y con cuenta activa.
const PUBLIC_WHERE = `l.status = 'approved'
  AND (l.expires_at IS NULL OR l.expires_at = '' OR l.expires_at >= strftime('%Y-%m-%d','now'))
  AND l.payment_status <> 'unpaid' AND l.paused = 0
  AND (l.user_id IS NULL OR EXISTS (SELECT 1 FROM users u WHERE u.id = l.user_id AND u.active = 1))`;

const FIELDS = [
  'category', 'title', 'description', 'subtype', 'location', 'price', 'currency', 'event_date',
  'company', 'contact_name', 'contact_phone', 'contact_email', 'website', 'image', 'expires_at',
];

function clampInt(v, def, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Búsqueda con filtros, orden y paginación.
 * `admin` permite ver cualquier estado y avisos vencidos.
 */
function searchListings(db, params, { admin = false, ownerId = null, defaultPageSize = 12 } = {}) {
  const where = [];
  const args = [];
  const privileged = admin || ownerId !== null;
  if (ownerId !== null) {
    where.push('l.user_id = ?');
    args.push(ownerId);
  } else if (params.user) {
    where.push('l.user_id = ?');
    args.push(Number(params.user) || 0);
  }

  if (params.category && CATEGORY_IDS.includes(params.category)) {
    where.push('l.category = ?');
    args.push(params.category);
  }
  if (privileged) {
    if (params.status && ['pending', 'approved', 'rejected'].includes(params.status)) {
      where.push('l.status = ?');
      args.push(params.status);
    }
    if (params.payment === 'ready') where.push("l.payment_status <> 'unpaid'");
    else if (['none', 'unpaid', 'paid'].includes(params.payment)) {
      where.push('l.payment_status = ?');
      args.push(params.payment);
    }
    if (params.expired === '1') where.push("l.expires_at IS NOT NULL AND l.expires_at <> '' AND l.expires_at < strftime('%Y-%m-%d','now')");
  } else {
    where.push(PUBLIC_WHERE);
  }

  const q = String(params.q || '').trim();
  if (q) {
    for (const word of q.split(/\s+/).slice(0, 8)) {
      where.push("(l.title LIKE ? ESCAPE '\\' OR l.description LIKE ? ESCAPE '\\' OR l.company LIKE ? ESCAPE '\\' OR l.location LIKE ? ESCAPE '\\')");
      const like = `%${word.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
      args.push(like, like, like, like);
    }
  }
  if (params.location) {
    where.push('l.location = ?');
    args.push(String(params.location));
  }
  if (params.subtype) {
    where.push('l.subtype = ?');
    args.push(String(params.subtype));
  }
  if (params.currency && ['UYU', 'USD'].includes(params.currency)) {
    where.push('l.currency = ?');
    args.push(params.currency);
  }
  const minPrice = num(params.minPrice);
  if (minPrice !== null) {
    where.push('l.price >= ?');
    args.push(minPrice);
  }
  const maxPrice = num(params.maxPrice);
  if (maxPrice !== null) {
    where.push('l.price <= ?');
    args.push(maxPrice);
  }
  const days = clampInt(params.days, 0, 0, 3650);
  if (days > 0) {
    where.push("COALESCE(l.published_at, l.created_at) >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)");
    args.push(`-${days} days`);
  }
  if (params.featured === '1' || params.featured === true) where.push('l.featured = 1');
  if (params.withImage === '1') where.push("l.image <> ''");
  if (params.upcoming === '1') where.push("l.event_date >= strftime('%Y-%m-%d','now')");

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sortKey = SORTS[params.sort] ? params.sort : (params.category === 'eventos' && !admin ? 'event_date' : 'relevance');
  const pageSize = clampInt(params.pageSize, defaultPageSize, 1, privileged ? 200 : 50);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM listings l ${whereSql}`).get(...args).n;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = clampInt(params.page, 1, 1, pages);

  const cols = privileged ? 'l.*' : publicColumns('l');
  const items = db
    .prepare(`SELECT ${cols} FROM listings l ${whereSql} ORDER BY ${SORTS[sortKey]}, l.id DESC LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize);

  return { items, total, page, pages, pageSize, sort: sortKey };
}

function publicColumns(alias) {
  const cols = ['id', ...FIELDS.filter((f) => f !== 'expires_at'), 'featured', 'views', 'published_at', 'created_at', 'user_id'];
  return cols.map((c) => `${alias}.${c}`).join(', ');
}

function getPublicListing(db, id) {
  return db
    .prepare(`SELECT ${publicColumns('l')} FROM listings l WHERE l.id = ? AND ${PUBLIC_WHERE}`)
    .get(id);
}

/** Valida y normaliza los datos de un aviso. Devuelve { data, errors }. */
function validateListing(input, { partial = false } = {}) {
  const errors = {};
  const data = {};
  const str = (k, max) => {
    if (input[k] === undefined) return;
    data[k] = String(input[k] ?? '').trim().slice(0, max);
  };
  if (input.category !== undefined || !partial) {
    if (!CATEGORY_IDS.includes(input.category)) errors.category = 'Elegí una sección válida.';
    else data.category = input.category;
  }
  str('title', 140);
  str('description', 6000);
  str('subtype', 60);
  str('location', 80);
  str('company', 120);
  str('contact_name', 120);
  str('contact_phone', 40);
  str('contact_email', 160);
  str('website', 300);
  str('image', 400);

  if (!partial || input.title !== undefined) {
    if (!data.title || data.title.length < 5) errors.title = 'El título debe tener al menos 5 caracteres.';
  }
  if (!partial || input.description !== undefined) {
    if (!data.description || data.description.length < 20) errors.description = 'La descripción debe tener al menos 20 caracteres.';
  }
  if (data.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.contact_email)) {
    errors.contact_email = 'Email no válido.';
  }
  if (data.website && !/^https?:\/\//i.test(data.website)) data.website = `https://${data.website}`;
  if (data.image && !/^(https?:\/\/|\/uploads\/)/i.test(data.image)) errors.image = 'La imagen debe ser una URL http(s).';

  if (input.price !== undefined) {
    const p = num(input.price);
    if (input.price !== '' && input.price !== null && p === null) errors.price = 'Precio no válido.';
    else if (p !== null && p < 0) errors.price = 'El precio no puede ser negativo.';
    else data.price = p;
  }
  if (input.currency !== undefined) data.currency = input.currency === 'USD' ? 'USD' : 'UYU';
  for (const k of ['event_date', 'expires_at']) {
    if (input[k] === undefined) continue;
    const v = String(input[k] || '').trim();
    if (v && !/^\d{4}-\d{2}-\d{2}/.test(v)) errors[k] = 'Fecha no válida.';
    else data[k] = v || null;
  }

  const cat = getCategory(data.category || input.category);
  if (cat && cat.hasEventDate && !partial && !data.event_date) errors.event_date = 'Indicá la fecha del evento.';
  if (!partial && !data.contact_phone && !data.contact_email && !data.website && data.category !== 'noticias') {
    errors.contact = 'Indicá al menos un teléfono, email o sitio web de contacto.';
  }
  return { data, errors };
}

function insertListing(db, data, extra = {}) {
  const row = { ...data, ...extra };
  const keys = Object.keys(row);
  const res = db
    .prepare(`INSERT INTO listings (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...keys.map((k) => row[k]));
  return Number(res.lastInsertRowid);
}

function updateListing(db, id, data) {
  const keys = Object.keys(data);
  if (!keys.length) return;
  db.prepare(
    `UPDATE listings SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
  ).run(...keys.map((k) => data[k]), id);
}

module.exports = { PUBLIC_WHERE, searchListings, getPublicListing, validateListing, insertListing, updateListing, SORTS, FIELDS };
