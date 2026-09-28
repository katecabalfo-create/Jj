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
};

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
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v);
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
