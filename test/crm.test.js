'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.ADMIN_PASSWORD = 'secreto';
process.env.SESSION_SECRET = 'test-secret';
process.env.PAYMENTS_DEMO = '1';
process.env.BASE_URL = 'https://mdo.example';

let server;
let base;
let db;

function client() {
  const jar = new Map();
  return async function req(method, url, body) {
    const opts = { method, headers: {}, redirect: 'manual' };
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) opts.headers.cookie = cookie;
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(base + url, opts);
    for (const c of res.headers.getSetCookie()) {
      const [k, v] = c.split(';')[0].split(/=(.*)/s);
      if (v) jar.set(k, v);
      else jar.delete(k);
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* no json */
    }
    return { status: res.status, json, text, headers: res.headers };
  };
}

async function advertiser(email, type, extra = {}) {
  const req = client();
  await req('POST', '/api/account/register', { type, name: `Nombre ${email}`, business_name: `Negocio ${email}`, email, password: 'clave1234', accept_terms: true, ...extra });
  return req;
}

async function publishPaid(req, category) {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ category, title: 'Aviso de prueba CRM', description: 'Descripción suficientemente larga para validar el aviso.', contact_phone: '099' })) fd.set(k, v);
  const l = await req('POST', '/api/account/listings', fd);
  const plan = (await req('GET', '/api/account/plans')).json.plans[0];
  await req('POST', `/api/account/listings/${l.json.id}/checkout`, { plan_id: plan.id, method: 'demo' });
  return l.json.id;
}

let admin;
test.before(async () => {
  const { openDb } = require('../src/db');
  const { createApp } = require('../src/app');
  db = openDb(':memory:');
  const app = createApp(db, {
    uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mo-up-')),
    receiptDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mo-rc-')),
  });
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;

  // Tres anunciantes: una empresa con aviso pago, una inmobiliaria sin avisos y uno que no quiere promociones
  const emp = await advertiser('empresa@crm.example', 'empresa');
  await publishPaid(emp, 'empleo-maldonado');
  await advertiser('alquila@crm.example', 'alquileres');
  await advertiser('noquiere@crm.example', 'servicios', { marketing_opt_in: false });
  admin = client();
  await admin('POST', '/api/admin/login', { password: 'secreto' });
});
test.after(() => server.close());

test('el CRM requiere el login de administrador', async () => {
  assert.equal((await client()('GET', '/api/admin/crm/contacts')).status, 401);
  assert.equal((await client()('POST', '/api/admin/crm/campaigns', { subject: 'x', body: 'y' })).status, 401);
});

test('contactos con actividad y segmentos', async () => {
  const all = await admin('GET', '/api/admin/crm/contacts');
  assert.equal(all.json.total, 3);
  assert.equal(all.json.reachable, 2, 'el que no quiere promociones no cuenta');
  const emp = all.json.items.find((c) => c.email === 'empresa@crm.example');
  assert.equal(emp.active_listings, 1);

  const active = await admin('GET', '/api/admin/crm/contacts?activity=active');
  assert.deepEqual(active.json.items.map((c) => c.email), ['empresa@crm.example']);
  const none = await admin('GET', '/api/admin/crm/contacts?activity=no_active&type=alquileres');
  assert.deepEqual(none.json.items.map((c) => c.email), ['alquila@crm.example']);
  const optOut = await admin('GET', '/api/admin/crm/contacts?opt_in=0');
  assert.deepEqual(optOut.json.items.map((c) => c.email), ['noquiere@crm.example']);
});

test('etiquetas y notas de un contacto', async () => {
  const id = db.prepare("SELECT id FROM users WHERE email = 'alquila@crm.example'").get().id;
  await admin('PUT', `/api/admin/crm/contacts/${id}`, { tags: ['Inmobiliaria', 'VIP', 'VIP', ''] });
  const byTag = await admin('GET', '/api/admin/crm/contacts?tag=vip');
  assert.deepEqual(byTag.json.items.map((c) => c.id), [id]);
  const note = await admin('POST', `/api/admin/crm/contacts/${id}/notes`, { body: 'Llamar en diciembre' });
  assert.equal(note.status, 201);
  const detail = await admin('GET', `/api/admin/crm/contacts/${id}`);
  assert.deepEqual(detail.json.tags, ['Inmobiliaria', 'VIP']);
  assert.equal(detail.json.notes[0].body, 'Llamar en diciembre');
  const meta = await admin('GET', '/api/admin/crm/meta');
  assert.ok(meta.json.tags.includes('VIP'));
  assert.ok(meta.json.templates.length >= 3);
});

test('campaña: segmento, personalización, envío único y baja', async () => {
  const bad = await admin('POST', '/api/admin/crm/campaigns', { subject: '', body: '' });
  assert.equal(bad.status, 400);

  const audience = await admin('POST', '/api/admin/crm/audience', { segment: {} });
  assert.equal(audience.json.count, 2);

  const c = await admin('POST', '/api/admin/crm/campaigns', {
    subject: '{nombre}, promo de temporada',
    body: 'Hola {nombre} de {empresa}:\n\n**50% off** en destacados.',
    cta_text: 'Ir a mi panel',
    cta_url: '{panel}',
    segment: {},
  });
  assert.equal(c.status, 201);

  const pv = await admin('POST', '/api/admin/crm/preview', { subject: 'Hola {nombre}', body: 'Texto <script>alert(1)</script> de prueba', segment: {} });
  assert.doesNotMatch(pv.json.html, /<script>/, 'el HTML del email se escapa');

  const test1 = await admin('POST', `/api/admin/crm/campaigns/${c.json.id}/test`, { to: 'yo@mdo.example' });
  assert.equal(test1.json.to, 'yo@mdo.example');

  const sent = await admin('POST', `/api/admin/crm/campaigns/${c.json.id}/send`, {});
  assert.equal(sent.json.recipients, 2);
  assert.equal((await admin('POST', `/api/admin/crm/campaigns/${c.json.id}/send`, {})).status, 400, 'no se envía dos veces');
  assert.equal((await admin('PUT', `/api/admin/crm/campaigns/${c.json.id}`, { subject: 'otro', body: 'otro texto largo' })).status, 400);

  const mails = db.prepare('SELECT * FROM outbox WHERE campaign_id = ?').all(c.json.id);
  assert.equal(mails.length, 2);
  assert.ok(!mails.some((m) => m.to_email === 'noquiere@crm.example'));
  const m = mails.find((x) => x.to_email === 'empresa@crm.example');
  assert.match(m.subject, /^Nombre, promo de temporada$/);
  assert.match(m.html, /<strong>50% off<\/strong>/);
  assert.match(m.html, /https:\/\/mdo\.example\/cuenta\//);
  assert.match(m.unsubscribe_url, /^https:\/\/mdo\.example\/api\/crm\/baja\//);

  // Apertura (píxel) y estadísticas
  const openToken = m.html.match(/\/api\/crm\/abierto\/([\w-]+)\.gif/)[1];
  const px = await fetch(`${base}/api/crm/abierto/${openToken}.gif`);
  assert.equal(px.headers.get('content-type'), 'image/gif');
  const list = await admin('GET', '/api/admin/crm/campaigns');
  assert.equal(list.json[0].opens, 1);
  assert.equal(list.json[0].recipients, 2);

  // Baja desde el enlace del email
  const token = m.unsubscribe_url.split('/').pop();
  const page = await fetch(`${base}/api/crm/baja/${token}`);
  assert.match(await page.text(), /no vas a recibir más promociones/);
  assert.equal(db.prepare("SELECT marketing_opt_in FROM users WHERE email = 'empresa@crm.example'").get().marketing_opt_in, 0);
  assert.equal((await admin('POST', '/api/admin/crm/audience', { segment: {} })).json.count, 1);
});

test('el anunciante puede cambiar su preferencia desde el perfil', async () => {
  const req = await advertiser('perfil@crm.example', 'empresa');
  assert.equal((await req('GET', '/api/account/me')).json.user.marketing_opt_in, true);
  await req('PUT', '/api/account/me', { marketing_opt_in: false });
  assert.equal((await req('GET', '/api/account/me')).json.user.marketing_opt_in, false);
});

test('exportación CSV de contactos', async () => {
  const csv = await admin('GET', '/api/admin/crm/contacts.csv?type=empresa');
  assert.equal(csv.status, 200);
  assert.match(csv.text, /empresa@crm\.example/);
  assert.doesNotMatch(csv.text, /alquila@crm\.example/);
});
