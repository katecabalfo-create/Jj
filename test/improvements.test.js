'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.ADMIN_PASSWORD = 'secreto';
process.env.SESSION_SECRET = 'test-secret';
process.env.PAYMENTS_DEMO = '1';
delete process.env.MP_ACCESS_TOKEN;

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

const png = () => new Blob([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')], { type: 'image/png' });

function rentalForm(extra = {}) {
  const fd = new FormData();
  const data = {
    category: 'alquileres',
    title: 'Casa con fondo en San Carlos',
    description: 'Casa de dos dormitorios con fondo y parrillero, a cinco cuadras del centro.',
    contact_phone: '099555444',
    ...extra,
  };
  for (const [k, v] of Object.entries(data)) fd.set(k, v);
  return fd;
}

async function register(req, email, type = 'alquileres', extra = {}) {
  return req('POST', '/api/account/register', { type, name: 'Prueba', business_name: 'Empresa de prueba', email, password: 'clave1234', accept_terms: true, ...extra });
}

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
});
test.after(() => server.close());

test('varias fotos: subir, conservar, reordenar y límite', async () => {
  const req = client();
  await register(req, 'fotos@example.com');
  const fd = rentalForm();
  fd.append('imageFiles', png(), 'a.png');
  fd.append('imageFiles', png(), 'b.png');
  fd.append('imageFiles', png(), 'c.png');
  const created = await req('POST', '/api/account/listings', fd);
  assert.equal(created.status, 201);
  const imgs = JSON.parse(created.json.images);
  assert.equal(imgs.length, 3);
  assert.equal(created.json.image, imgs[0]);

  // Quitar la primera y poner la tercera de portada
  const edit = new FormData();
  edit.set('keep_images', JSON.stringify([imgs[2], imgs[1]]));
  const upd = await req('PUT', `/api/account/listings/${created.json.id}`, edit);
  assert.deepEqual(JSON.parse(upd.json.images), [imgs[2], imgs[1]]);
  assert.equal(upd.json.image, imgs[2]);

  // Editar otro campo sin tocar las fotos no las cambia
  const other = new FormData();
  other.set('title', 'Casa con fondo en San Carlos centro');
  const same = await req('PUT', `/api/account/listings/${created.json.id}`, other);
  assert.deepEqual(JSON.parse(same.json.images), [imgs[2], imgs[1]]);

  // Más de 8 fotos: error
  const many = rentalForm();
  for (let i = 0; i < 9; i++) many.append('imageFiles', png(), `${i}.png`);
  const tooMany = await req('POST', '/api/account/listings', many);
  assert.equal(tooMany.status, 400);

  // Rutas ajenas o inválidas en keep_images: rechazadas
  const bad = new FormData();
  bad.set('keep_images', JSON.stringify(['javascript:alert(1)']));
  assert.equal((await req('PUT', `/api/account/listings/${created.json.id}`, bad)).status, 400);
});

test('mapa: coordenadas dentro de Uruguay y visibles en el aviso', async () => {
  const req = client();
  await register(req, 'mapa@example.com');
  const out = await req('POST', '/api/account/listings', rentalForm({ lat: '40.7', lng: '-74' }));
  assert.equal(out.status, 400);
  assert.ok(out.json.fields.map);
  const ok = await req('POST', '/api/account/listings', rentalForm({ lat: '-34.9123456', lng: '-54.8654321' }));
  assert.equal(ok.status, 201);
  assert.equal(ok.json.lat, -34.91235);
  const plan = (await req('GET', '/api/account/plans')).json.plans[0];
  await req('POST', `/api/account/listings/${ok.json.id}/checkout`, { plan_id: plan.id, method: 'demo' });
  const pub = await client()('GET', `/api/listings/${ok.json.id}`);
  assert.equal(pub.json.lng, -54.86543);
});

test('confirmación de email: se exige solo con SMTP y el enlace confirma', async () => {
  process.env.SMTP_HOST = 'smtp.example.com'; // sin enviar de verdad: los correos quedan en cola
  try {
    const req = client();
    const r = await register(req, 'confirmar@example.com', 'servicios');
    assert.equal(r.json.user.needs_verification, true);
    const mail = db.prepare("SELECT body FROM outbox WHERE to_email = 'confirmar@example.com' ORDER BY id DESC").get();
    const token = mail.body.match(/verify\?token=([\w-]+)/)[1];

    const fd = new FormData();
    for (const [k, v] of Object.entries({ category: 'avisos-maldonado', title: 'Clases de inglés', description: 'Clases particulares de inglés para todas las edades.', contact_phone: '099' })) fd.set(k, v);
    const l = await req('POST', '/api/account/listings', fd);
    const plan = (await req('GET', '/api/account/plans')).json.plans[0];
    const blocked = await req('POST', `/api/account/listings/${l.json.id}/checkout`, { plan_id: plan.id, method: 'demo' });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.code, 'email_not_verified');

    const bad = await req('GET', '/api/account/verify?token=nada');
    assert.match(bad.headers.get('location'), /invalido/);
    const good = await req('GET', `/api/account/verify?token=${token}`);
    assert.match(good.headers.get('location'), /confirmado/);
    assert.equal((await req('GET', '/api/account/me')).json.user.needs_verification, false);
    assert.equal((await req('POST', `/api/account/listings/${l.json.id}/checkout`, { plan_id: plan.id, method: 'demo' })).status, 201);
  } finally {
    delete process.env.SMTP_HOST;
  }
});

test('aviso de vencimiento: una sola vez por fecha', async () => {
  const { sendExpiryReminders } = require('../src/notify');
  const req = client();
  await register(req, 'vence@example.com');
  const l = await req('POST', '/api/account/listings', rentalForm());
  const plan = (await req('GET', '/api/account/plans')).json.plans[0];
  await req('POST', `/api/account/listings/${l.json.id}/checkout`, { plan_id: plan.id, method: 'demo' });
  const soon = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  db.prepare('UPDATE listings SET expires_at = ? WHERE id = ?').run(soon, l.json.id);
  assert.ok(sendExpiryReminders(db, 'http://x') >= 1);
  assert.equal(sendExpiryReminders(db, 'http://x'), 0, 'no repite');
  const mail = db.prepare("SELECT subject, body FROM outbox WHERE to_email = 'vence@example.com' AND subject LIKE 'Tu aviso vence%'").get();
  assert.ok(mail);
  assert.match(mail.body, new RegExp(`/cuenta/#/avisos/${l.json.id}/pagar`));
});

test('visitas por día y estadísticas del anunciante', async () => {
  const req = client();
  await register(req, 'visitas@example.com');
  const l = await req('POST', '/api/account/listings', rentalForm());
  const plan = (await req('GET', '/api/account/plans')).json.plans[0];
  await req('POST', `/api/account/listings/${l.json.id}/checkout`, { plan_id: plan.id, method: 'demo' });
  const anon = client();
  for (let i = 0; i < 3; i++) await anon('GET', `/api/listings/${l.json.id}`);
  const st = await req('GET', `/api/account/listings/${l.json.id}/stats`);
  assert.equal(st.json.daily.length, 30);
  assert.equal(st.json.daily.at(-1).views, 3);
  const dash = await req('GET', '/api/account/stats');
  assert.equal(dash.json.daily.at(-1).views, 3);
  assert.equal((await client()('GET', `/api/account/listings/${l.json.id}/stats`)).status, 401);
});

test('facturación: datos del cliente, comprobante, n.º de e-factura y CSV', async () => {
  const req = client();
  await register(req, 'factura@example.com', 'empresa', { rut: '211234560018', business_name: 'Hotel =Punta SA', billing_address: 'Gorlero 123' });
  const fd = new FormData();
  for (const [k, v] of Object.entries({ category: 'empleo-maldonado', title: 'Cocinero de temporada', description: 'Hotel busca cocinero con experiencia para la temporada.', contact_phone: '099' })) fd.set(k, v);
  const l = await req('POST', '/api/account/listings', fd);
  const plan = (await req('GET', '/api/account/plans')).json.plans[0];
  const pay = await req('POST', `/api/account/listings/${l.json.id}/checkout`, { plan_id: plan.id, method: 'demo' });
  const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(pay.json.id);
  assert.equal(row.invoice_rut, '211234560018');
  assert.equal(row.invoice_address, 'Gorlero 123');

  const admin = client();
  await admin('POST', '/api/admin/login', { password: 'secreto' });
  await admin('PUT', `/api/admin/payments/${pay.json.id}/invoice`, { invoice_number: 'e-Factura A-1234' });
  const recibo = await req('GET', `/api/account/payments/${pay.json.id}/recibo`);
  assert.equal(recibo.status, 200);
  assert.match(recibo.text, /211234560018/);
  assert.match(recibo.text, /e-Factura A-1234/);
  assert.equal((await client()('GET', `/api/account/payments/${pay.json.id}/recibo`)).status, 401);

  // El CSV excluye pagos de prueba; se verifica un pago real confirmado a mano
  db.prepare("UPDATE payments SET method = 'transfer' WHERE id = ?").run(pay.json.id);
  const csv = await admin('GET', `/api/admin/payments.csv?month=${new Date().toISOString().slice(0, 7)}`);
  assert.equal(csv.status, 200);
  assert.match(csv.text, /"211234560018"/);
  assert.match(csv.text, /"'Hotel =Punta SA"|"Hotel =Punta SA"/);
  assert.match(csv.text, /e-Factura A-1234/);
  assert.equal((await client()('GET', '/api/admin/payments.csv')).status, 401);
});

test('portada: filtro por varias secciones para empleos destacados', async () => {
  const admin = client();
  await admin('POST', '/api/admin/login', { password: 'secreto' });
  for (const category of ['empleo-maldonado', 'empleo-pais', 'alquileres']) {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ category, title: `Destacado ${category}`, description: 'Descripción suficientemente larga para validar.', status: 'approved', featured: '1' })) fd.set(k, v);
    await admin('POST', '/api/admin/listings', fd);
  }
  const r = await client()('GET', '/api/listings?categories=empleo-maldonado,empleo-pais&featured=1');
  assert.ok(r.json.total >= 2);
  assert.ok(r.json.items.every((i) => i.category.startsWith('empleo') && i.featured === 1));
  const meta = await client()('GET', '/api/meta');
  assert.equal(meta.json.maxImages, 8);
  assert.equal(meta.json.cookieBanner, true);
});
