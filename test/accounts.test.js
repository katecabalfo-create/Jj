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

/** El vencimiento guardado cae dentro del minuto esperado. */
function assertNear(iso, expectedMs) {
  assert.ok(Math.abs(Date.parse(iso) - expectedMs) < 60000, `${iso} debería ser ${new Date(expectedMs).toISOString()}`);
}
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
  assertNear(l.expires_at, Date.now() + plan.duration_days * 86400000);

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
  assertNear(l.expires_at, Date.now() + 2 * plan.duration_days * 86400000);
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

test('planes por semanas con destacado +20% y baja automática al terminar el tiempo pagado', async () => {
  const { expireFeatured } = require('../src/listings');
  const req = client();
  const reg = await req('POST', '/api/account/register', { type: 'empresa', name: 'Sofía', business_name: 'Parador del Este', email: 'sofia@example.com', password: 'clave1234', accept_terms: true });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  const plansRes = await req('GET', '/api/account/plans');
  assert.equal(plansRes.status, 200, JSON.stringify(plansRes.json));
  const plans = plansRes.json.plans;
  const byName = Object.fromEntries(plans.map((p) => [p.name, p]));
  assert.equal(byName['Plan Impulso – 1 semana'].price, 3900);
  assert.equal(byName['Plan Impulso – 1 semana'].duration_days, 7);
  assert.equal(byName['Plan Impulso – 1 semana (destacado)'].price, 4680);
  assert.equal(byName['Plan Presencia Total – 1 mes'].price, 24900);
  assert.equal(byName['Plan Presencia Total – 1 mes (destacado)'].price, 29880);
  assert.equal(byName['Individual – solo historias'].duration_days, 1);
  for (const p of plans.filter((x) => x.featured)) {
    const base = byName[p.name.replace(' (destacado)', '')];
    assert.equal(p.price, Math.round(base.price * 1.2), p.name);
    assert.equal(p.duration_days, base.duration_days);
  }

  const created = await req('POST', '/api/account/listings', listingForm({ category: 'empleo-maldonado', title: 'Cocinero para temporada' }));
  const id = created.json.id;
  const plan = byName['Plan Alcance – 1 semana (destacado)'];
  const pay = await req('POST', `/api/account/listings/${id}/checkout`, { plan_id: plan.id, method: 'demo' });
  assert.equal(pay.json.status, 'approved');
  let l = db.prepare('SELECT * FROM listings WHERE id = ?').get(id);
  assertNear(l.expires_at, Date.now() + 7 * 86400000);
  assert.equal(l.featured, 1);
  assertNear(l.featured_until, Date.now() + 7 * 86400000);
  assert.equal((await client()('GET', `/api/listings/${id}`)).status, 200);

  // Un minuto después del vencimiento el aviso ya no se muestra y pierde el destacado
  const past = new Date(Date.now() - 60000).toISOString();
  db.prepare('UPDATE listings SET expires_at = ?, featured_until = ? WHERE id = ?').run(past, past, id);
  assert.equal((await client()('GET', `/api/listings/${id}`)).status, 404);
  assert.equal(expireFeatured(db) >= 1, true);
  l = db.prepare('SELECT featured, featured_until FROM listings WHERE id = ?').get(id);
  assert.equal(l.featured, 0);
  assert.equal(l.featured_until, null);
  const stats = (await req('GET', '/api/account/stats')).json;
  assert.equal(stats.expired, 1);
  assert.equal(stats.active, 0);

  // Renovar con un plan común lo vuelve a publicar desde ahora, sin destacado
  await req('POST', `/api/account/listings/${id}/checkout`, { plan_id: byName['Plan Impulso – 2 semanas'].id, method: 'demo' });
  l = db.prepare('SELECT * FROM listings WHERE id = ?').get(id);
  assertNear(l.expires_at, Date.now() + 14 * 86400000);
  assert.equal(l.featured, 0);
  assert.equal((await client()('GET', `/api/listings/${id}`)).status, 200);
});

test('renovar un aviso le avisa al administrador por email y se marca en Pagos', async () => {
  const admin = client();
  await admin('POST', '/api/admin/login', { password: 'secreto' });
  await admin('PUT', '/api/admin/settings', { contact_email: 'dueña@maldonado.example' });
  const req = client();
  await req('POST', '/api/account/register', { type: 'servicios', name: 'Rita', email: 'rita@example.com', password: 'clave1234', accept_terms: true });
  const created = await req('POST', '/api/account/listings', listingForm({ category: 'avisos-maldonado', title: 'Limpieza de piscinas' }));
  const id = created.json.id;
  const plans = (await req('GET', '/api/account/plans')).json.plans;
  const plan = plans.find((p) => p.name === 'Plan Impulso – 1 semana');
  const mails = () => db.prepare("SELECT subject, body FROM outbox WHERE to_email = 'dueña@maldonado.example' AND subject LIKE 'Renovación%'").all();

  // Primera compra: no es renovación
  const first = await req('POST', `/api/account/listings/${id}/checkout`, { plan_id: plan.id, method: 'demo' });
  assert.equal(first.json.renewal, 0);
  assert.equal(mails().length, 0);

  // Renovar: avisa al admin con el plan, el monto y el vencimiento actual
  const again = await req('POST', `/api/account/listings/${id}/checkout`, { plan_id: plan.id, method: 'transfer' });
  assert.equal(again.status, 201);
  assert.equal(again.json.renewal, 1);
  const sent = mails();
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /Limpieza de piscinas/);
  assert.match(sent[0].body, /Rita \(rita@example\.com\) eligió renovar/);
  assert.match(sent[0].body, /Plan Impulso – 1 semana — \$ 3\.900/);
  assert.match(sent[0].body, /vigente hasta el/);
  const pays = (await admin('GET', '/api/admin/payments?status=pending')).json;
  assert.equal(pays.find((p) => p.id === again.json.id).renewal, 1);
});
