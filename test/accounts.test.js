'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.ADMIN_PASSWORD = 'secreto';
process.env.SESSION_SECRET = 'test-secret';
process.env.PAYMENTS_DEMO = '1';

let server;
let base;

function client() {
  const jar = new Map();
  return async function req(method, url, body) {
    const opts = { method, headers: {} };
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) opts.headers.cookie = cookie;
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(base + url, opts);
    const set = res.headers.getSetCookie();
    for (const c of set) {
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
    return { status: res.status, json };
  };
}

const listingForm = (extra = {}) => {
  const fd = new FormData();
  const data = {
    category: 'empleo-maldonado',
    title: 'Encargado de depósito',
    description: 'Empresa de logística busca encargado de depósito con experiencia.',
    contact_phone: '099123456',
    ...extra,
  };
  for (const [k, v] of Object.entries(data)) fd.set(k, v);
  return fd;
};

let db;
test.before(async () => {
  const { openDb, setSettings } = require('../src/db');
  const { createApp } = require('../src/app');
  db = openDb(':memory:');
  const app = createApp(db, { uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mo-up-')), receiptDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mo-rc-')) });
  setSettings(db, { transfer_account_uyu: '1234567', transfer_holder: 'Maldonado Oportunidades', transfer_holder_doc: '210000000011' });
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
});

test('registro, login y permisos por tipo de cuenta', async () => {
  const req = client();
  const bad = await req('POST', '/api/account/register', { type: 'empresa', email: 'x', password: '1' });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.fields.email && bad.json.fields.password && bad.json.fields.business_name);

  const r = await req('POST', '/api/account/register', {
    type: 'servicios', name: 'Juan Pérez', business_name: 'Plomería Juan', email: 'juan@example.com', password: 'clave1234', accept_terms: true,
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.user.type, 'servicios');
  assert.equal((await req('GET', '/api/account/me')).json.user.email, 'juan@example.com');

  // Servicios no puede publicar empleos ni alquileres
  const wrong = await req('POST', '/api/account/listings', listingForm());
  assert.equal(wrong.status, 400);
  assert.ok(wrong.json.fields.category);

  await req('POST', '/api/account/logout');
  assert.equal((await req('GET', '/api/account/me')).json.user, null);
  assert.equal((await req('POST', '/api/account/login', { email: 'juan@example.com', password: 'mala' })).status, 401);
  assert.equal((await req('POST', '/api/account/login', { email: 'JUAN@example.com', password: 'clave1234' })).status, 200);

  const plans = await req('GET', '/api/account/plans');
  assert.ok(plans.json.plans.length >= 1);
  assert.ok(plans.json.plans.every((p) => p.account_type === 'servicios'));
});

test('empresa: aviso sin pagar no se publica; transferencia confirmada por admin lo publica', async () => {
  const req = client();
  await req('POST', '/api/account/register', {
    type: 'empresa', name: 'Ana', business_name: 'Logística del Este', email: 'ana@empresa.com', password: 'clave1234', accept_terms: 'on',
  });
  const created = await req('POST', '/api/account/listings', listingForm());
  assert.equal(created.status, 201);
  assert.equal(created.json.payment_status, 'unpaid');
  assert.equal(created.json.company, 'Logística del Este');
  const id = created.json.id;
  assert.equal((await client()('GET', `/api/listings/${id}`)).status, 404);

  const plan = (await req('GET', '/api/account/plans')).json.plans[0];
  const pay = await req('POST', `/api/account/listings/${id}/checkout`, { plan_id: plan.id, method: 'transfer' });
  assert.equal(pay.status, 201);
  assert.equal(pay.json.status, 'pending');

  // Datos de Itaú y comprobante
  const detail = await req('GET', `/api/account/payments/${pay.json.id}`);
  assert.equal(detail.json.transfer.bank, 'Itaú');
  assert.equal(detail.json.transfer.account, '1234567');
  assert.equal(detail.json.has_receipt, false);
  const badFile = new FormData();
  badFile.set('receipt', new Blob(['hola'], { type: 'text/plain' }), 'x.txt');
  assert.equal((await req('POST', `/api/account/payments/${pay.json.id}/receipt`, badFile)).status, 400);
  const rc = new FormData();
  rc.set('receipt', new Blob(['%PDF-1.4 comprobante'], { type: 'application/pdf' }), 'comprobante.pdf');
  rc.set('payer_note', 'Operación 998877');
  const up = await req('POST', `/api/account/payments/${pay.json.id}/receipt`, rc);
  assert.equal(up.status, 200);
  assert.equal(up.json.has_receipt, true);
  assert.equal(up.json.receipt_file, undefined, 'no expone el nombre del archivo');
  assert.equal((await req('GET', `/api/account/payments/${pay.json.id}/receipt`)).status, 200);
  assert.equal((await client()('GET', `/api/admin/payments/${pay.json.id}/receipt`)).status, 401);

  // Otra empresa no puede ver ni pagar ese aviso
  const other = client();
  await other('POST', '/api/account/register', { type: 'empresa', name: 'Otro', business_name: 'Otra SA', email: 'otro@empresa.com', password: 'clave1234', accept_terms: true });
  assert.equal((await other('GET', `/api/account/listings/${id}`)).status, 404);
  assert.equal((await other('GET', `/api/account/payments/${pay.json.id}`)).status, 404);
  assert.equal((await other('GET', `/api/account/payments/${pay.json.id}/receipt`)).status, 404);

  const admin = client();
  await admin('POST', '/api/admin/login', { password: 'secreto' });
  assert.equal((await admin('GET', `/api/admin/payments/${pay.json.id}/receipt`)).status, 200);
  const ok = await admin('POST', `/api/admin/payments/${pay.json.id}/approve`, {});
  assert.equal(ok.json.ok, true);
  const again = await admin('POST', `/api/admin/payments/${pay.json.id}/approve`, {});
  assert.equal(again.json.ok, false, 'no se aplica dos veces');

  const pub = await client()('GET', `/api/listings/${id}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.json.advertiser.name, 'Logística del Este');
  const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(id);
  assert.equal(l.payment_status, 'paid');
  const expected = new Date(Date.now() + plan.duration_days * 86400000).toISOString().slice(0, 10);
  assert.equal(l.expires_at, expected);

  // Pausar lo oculta
  await req('POST', `/api/account/listings/${id}/pause`, { paused: true });
  assert.equal((await client()('GET', `/api/listings/${id}`)).status, 404);
  await req('POST', `/api/account/listings/${id}/pause`, { paused: false });
  assert.equal((await client()('GET', `/api/listings/${id}`)).status, 200);

  // Suspender la cuenta lo oculta
  const uid = db.prepare("SELECT id FROM users WHERE email = 'ana@empresa.com'").get().id;
  await admin('PUT', `/api/admin/users/${uid}`, { active: false });
  assert.equal((await client()('GET', `/api/listings/${id}`)).status, 404);
  assert.equal((await req('GET', '/api/account/me')).json.user, null);
});

test('alquileres: plan destacado por transferencia y medios de pago disponibles', async () => {
  const req = client();
  await req('POST', '/api/account/register', { type: 'alquileres', name: 'Laura', email: 'laura@example.com', password: 'clave1234', accept_terms: true });
  const created = await req('POST', '/api/account/listings', listingForm({ category: 'alquileres', title: 'Casa en Punta Ballena', price: '1200', currency: 'USD' }));
  assert.equal(created.status, 201);
  const plans = await req('GET', '/api/account/plans');
  assert.ok(!plans.json.methods.includes('mercadopago'), 'no se ofrece Mercado Pago');
  assert.ok(plans.json.methods.includes('transfer'));
  const featured = plans.json.plans.find((p) => p.featured);
  assert.equal((await req('POST', `/api/account/listings/${created.json.id}/checkout`, { plan_id: featured.id, method: 'mercadopago' })).status, 400);
  const pay = await req('POST', `/api/account/listings/${created.json.id}/checkout`, { plan_id: featured.id, method: 'transfer' });
  assert.equal(pay.status, 201);
  const admin = client();
  await admin('POST', '/api/admin/login', { password: 'secreto' });
  await admin('POST', `/api/admin/payments/${pay.json.id}/approve`, {});
  const p = await req('GET', `/api/account/payments/${pay.json.id}`);
  assert.equal(p.json.status, 'approved');
  assert.equal(p.json.listing.status, 'approved');
  const pub = await client()('GET', `/api/listings/${created.json.id}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.json.featured, 1);
  assert.equal((await fetch(`${base}/api/payments/mercadopago/webhook`, { method: 'POST' })).status, 404, 'ya no existe el webhook');
});

test('modo demo y renovación suman días', async () => {
  const req = client();
  await req('POST', '/api/account/register', { type: 'servicios', name: 'Pepe', email: 'pepe@example.com', password: 'clave1234', accept_terms: true });
  const created = await req('POST', '/api/account/listings', listingForm({ category: 'avisos-maldonado', title: 'Clases de guitarra' }));
  const plan = (await req('GET', '/api/account/plans')).json.plans[0];
  const p1 = await req('POST', `/api/account/listings/${created.json.id}/checkout`, { plan_id: plan.id, method: 'demo' });
  assert.equal(p1.json.status, 'approved');
  await req('POST', `/api/account/listings/${created.json.id}/checkout`, { plan_id: plan.id, method: 'demo' });
  const l = db.prepare('SELECT expires_at FROM listings WHERE id = ?').get(created.json.id);
  const expected = new Date(Date.now() + 2 * plan.duration_days * 86400000).toISOString().slice(0, 10);
  assert.equal(l.expires_at, expected);
  const adv = await client()('GET', `/api/advertisers/${created.json.user_id}`);
  assert.equal(adv.json.listings.total, 1);
});

test('transferencia no disponible en una moneda sin cuenta cargada', async () => {
  const req = client();
  await req('POST', '/api/account/register', { type: 'alquileres', name: 'Mario', email: 'mario@example.com', password: 'clave1234', accept_terms: true });
  const created = await req('POST', '/api/account/listings', listingForm({ category: 'alquileres', title: 'Apartamento en Piriápolis' }));
  const admin = client();
  await admin('POST', '/api/admin/login', { password: 'secreto' });
  const plan = await admin('POST', '/api/admin/plans', { account_type: 'alquileres', name: 'Plan en dólares', price: 20, currency: 'USD', duration_days: 30 });
  const r = await req('POST', `/api/account/listings/${created.json.id}/checkout`, { plan_id: plan.json.id, method: 'transfer' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /dólares/);
});

test('publicar sin cuenta está desactivado por defecto', async () => {
  const fd = listingForm();
  fd.set('accept_terms', 'on');
  assert.equal((await client()('POST', '/api/listings', fd)).status, 403);
});
