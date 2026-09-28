'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { CATEGORY_IDS } = require('./categories');

const DEFAULT_SETTINGS = {
  site_name: 'Maldonado Oportunidades',
  site_tagline: 'Empleos, alquileres, avisos, noticias y eventos de Maldonado y todo Uruguay',
  contact_email: '',
  page_size: '12',
  moderation: '1', // 1 = los avisos enviados por el público quedan pendientes hasta aprobarlos
  adsense_enabled: '0',
  adsense_client: '', // ca-pub-XXXXXXXXXXXXXXXX
  adsense_slot_top: '',
  adsense_slot_feed: '',
  adsense_slot_detail: '',
  adsense_feed_every: '6',
  adsense_auto_ads: '0',
  public_free_posting: '0', // 1 = se permite publicar gratis sin cuenta (formulario anónimo)
  moderation_accounts: '0', // 1 = los avisos pagos de cuentas también se revisan antes de publicarse
  payments_transfer_enabled: '1',
  // Transferencia bancaria (Itaú). Se ofrece solo si hay al menos una cuenta cargada.
  transfer_bank: 'Itaú',
  transfer_holder: '',
  transfer_holder_doc: '', // RUT o CI del titular
  transfer_account_type: 'Caja de ahorro',
  transfer_account_uyu: '',
  transfer_account_usd: '',
  transfer_branch: '',
  bank_transfer_info: 'Indicá el número de pago en el concepto de la transferencia y subí el comprobante desde tu panel.',
};

// Planes iniciales (se editan desde el panel de administración).
const DEFAULT_PLANS = [
  ['empresa', 'Aviso 30 días', 'Publicación de empleo, aviso o evento durante 30 días.', 490, 30, 0],
  ['empresa', 'Aviso destacado 30 días', 'Aparece primero en su sección y en la portada, con distintivo de destacado.', 990, 30, 1],
  ['servicios', 'Servicio 30 días', 'Publicá tu servicio durante 30 días.', 290, 30, 0],
  ['servicios', 'Servicio destacado 30 días', 'Tu servicio primero en la sección, con distintivo de destacado.', 590, 30, 1],
  ['alquileres', 'Alquiler 30 días', 'Publicá tu propiedad durante 30 días.', 390, 30, 0],
  ['alquileres', 'Alquiler destacado 30 días', 'Tu propiedad primero en Alquileres, con distintivo de destacado.', 790, 30, 1],
];

function openDb(file) {
  const dbFile = file || process.env.DB_FILE || path.join(__dirname, '..', 'data', 'maldonado.db');
  if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL CHECK (category IN (${CATEGORY_IDS.map((c) => `'${c}'`).join(',')})),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      subtype TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      price REAL,
      currency TEXT NOT NULL DEFAULT 'UYU',
      event_date TEXT,
      company TEXT NOT NULL DEFAULT '',
      contact_name TEXT NOT NULL DEFAULT '',
      contact_phone TEXT NOT NULL DEFAULT '',
      contact_email TEXT NOT NULL DEFAULT '',
      website TEXT NOT NULL DEFAULT '',
      image TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      featured INTEGER NOT NULL DEFAULT 0,
      views INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      published_at TEXT,
      expires_at TEXT,
      notified INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_listings_cat ON listings(category, status, published_at);
    CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);

    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      categories TEXT NOT NULL DEFAULT '[]',
      keywords TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      frequency TEXT NOT NULL DEFAULT 'instant' CHECK (frequency IN ('instant','daily','weekly')),
      token TEXT NOT NULL UNIQUE,
      confirmed INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      last_sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_subs_email ON subscriptions(email);

    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      to_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      sent_at TEXT
    );

    CREATE TABLE IF NOT EXISTS digest_queue (
      subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      PRIMARY KEY (subscription_id, listing_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('empresa','servicios','alquileres')),
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      business_name TEXT NOT NULL DEFAULT '',
      rut TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      website TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      about TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_type TEXT NOT NULL CHECK (account_type IN ('empresa','servicios','alquileres')),
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'UYU',
      duration_days INTEGER NOT NULL DEFAULT 30,
      featured INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,
      plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
      description TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'UYU',
      duration_days INTEGER NOT NULL DEFAULT 30,
      featured INTEGER NOT NULL DEFAULT 0,
      method TEXT NOT NULL CHECK (method IN ('mercadopago','transfer','free','demo')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
      provider_ref TEXT NOT NULL DEFAULT '',
      provider_payment_id TEXT NOT NULL DEFAULT '',
      checkout_url TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      paid_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
  `);
  addColumn(db, 'listings', 'user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
  // none = aviso sin cuenta o cargado por el admin; unpaid = esperando pago; paid = pago confirmado
  addColumn(db, 'listings', 'payment_status', "TEXT NOT NULL DEFAULT 'none'");
  addColumn(db, 'listings', 'plan_id', 'INTEGER');
  addColumn(db, 'listings', 'paused', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'payments', 'receipt_file', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'payments', 'receipt_at', 'TEXT');
  addColumn(db, 'payments', 'payer_note', "TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_listings_user ON listings(user_id)');

  if (db.prepare('SELECT COUNT(*) n FROM plans').get().n === 0) {
    const ins = db.prepare('INSERT INTO plans (account_type, name, description, price, duration_days, featured, sort) VALUES (?, ?, ?, ?, ?, ?, ?)');
    DEFAULT_PLANS.forEach((p, i) => ins.run(...p, i));
  }

  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v);
}

function addColumn(db, table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}

function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function setSettings(db, values) {
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(values)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    up.run(k, String(v ?? ''));
  }
}

function token() {
  return crypto.randomBytes(18).toString('base64url');
}

module.exports = { openDb, getSettings, setSettings, token, DEFAULT_SETTINGS };
