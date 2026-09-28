'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.ADMIN_PASSWORD = 'secreto';
process.env.SESSION_SECRET = 'test-secret';
const { openDb, setSettings } = require('../src/db');
const { createApp } = require('../src/app');
const { seedIfEmpty } = require('../src/seed');

let server;
let base;
let cookie = '';

async function req(method, url, body, headers = {}) {
  const opts = { method, headers: { ...headers } };
  if (cookie) opts.headers.cookie = cookie;
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(base + url, opts);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* no json */
  }
  return { status: res.status, json, text, headers: res.headers };
}

test.before(async () => {
  const db = openDb(':memory:');
  seedIfEmpty(db);
  setSettings(db, { public_free_posting: '1' });
  const app = createApp(db, { uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mo-up-')) });
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('lista, filtra, ordena y pagina', async () => {
  const all = await req('GET', '/api/listings?category=alquileres');
  assert.equal(all.status, 200);
  assert.equal(all.json.total, 3);
  const cheap = await req('GET', '/api/listings?category=alquileres&currency=UYU&sort=price_asc');
  assert.deepEqual(cheap.json.items.map((i) => i.price), [14000, 22000]);
  const q = await req('GET', '/api/listings?q=parrillero');
  assert.equal(q.json.total, 1);
  const loc = await req('GET', '/api/listings?location=San%20Carlos');
  assert.ok(loc.json.items.every((i) => i.location === 'San Carlos'));
  const page2 = await req('GET', '/api/listings?pageSize=4&page=2');
  assert.equal(page2.json.page, 2);
  assert.equal(page2.json.items.length, 4);
  assert.ok(!('status' in page2.json.items[0]), 'no expone columnas internas');
});

test('publicación del público queda pendiente y valida campos', async () => {
  const bad = new FormData();
  bad.set('category', 'empleo-maldonado');
  bad.set('title', 'x');
  const r1 = await req('POST', '/api/listings', bad);
  assert.equal(r1.status, 400);
  assert.ok(r1.json.fields.title && r1.json.fields.accept_terms);

  const fd = new FormData();
  fd.set('category', 'empleo-maldonado');
  fd.set('title', 'Cocinero para parador');
  fd.set('description', 'Parador en Playa Brava busca cocinero con experiencia.');
  fd.set('contact_phone', '099111222');
  fd.set('accept_terms', 'on');
  const r2 = await req('POST', '/api/listings', fd);
  assert.equal(r2.status, 201);
  assert.equal(r2.json.status, 'pending');
  const pub = await req('GET', `/api/listings/${r2.json.id}`);
  assert.equal(pub.status, 404, 'no visible hasta aprobar');
});

test('admin requiere login, aprueba y dispara alertas', async () => {
  assert.equal((await req('GET', '/api/admin/stats')).status, 401);
  assert.equal((await req('POST', '/api/admin/login', { password: 'mal' })).status, 401);
  const login = await req('POST', '/api/admin/login', { password: 'secreto' });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];

  const sub = await req('POST', '/api/subscriptions', { email: 'Ana@Example.com', categories: ['empleo-maldonado'], keywords: 'cocinero', frequency: 'instant' });
  assert.equal(sub.status, 201);

  const pending = await req('GET', '/api/admin/listings?status=pending');
  assert.equal(pending.json.total, 1);
  const id = pending.json.items[0].id;
  const upd = await req('PUT', `/api/admin/listings/${id}`, { status: 'approved' });
  assert.equal(upd.json.status, 'approved');
  assert.ok(upd.json.published_at);
  assert.equal((await req('GET', `/api/listings/${id}`)).status, 200);

  const outbox = await req('GET', '/api/admin/outbox');
  assert.ok(outbox.json.some((m) => m.to_email === 'ana@example.com' && m.subject.includes('Cocinero')));

  const bulk = await req('POST', '/api/admin/listings/bulk', { ids: [id], action: 'feature' });
  assert.equal(bulk.json.affected, 1);
  cookie = '';
});

test('suscripción existente no se sobrescribe ni se expone', async () => {
  const r = await req('POST', '/api/subscriptions', { email: 'ana@example.com', categories: [], frequency: 'weekly' });
  assert.equal(r.status, 200);
  assert.equal(r.json.existing, true);
  assert.equal(r.json.subscription, undefined);
});

test('AdSense: ads.txt e inyección del script', async () => {
  assert.equal((await req('GET', '/ads.txt')).status, 404);
  const login = await req('POST', '/api/admin/login', { password: 'secreto' });
  cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await req('PUT', '/api/admin/settings', { adsense_client: 'pub-123' })).status, 400);
  await req('PUT', '/api/admin/settings', { adsense_enabled: '1', adsense_client: 'ca-pub-1234567890123456' });
  cookie = '';
  const ads = await req('GET', '/ads.txt');
  assert.match(ads.text, /google\.com, pub-1234567890123456, DIRECT/);
  const home = await req('GET', '/');
  assert.match(home.text, /adsbygoogle\.js\?client=ca-pub-1234567890123456/);
});
