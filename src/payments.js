'use strict';

const crypto = require('node:crypto');
const { getSettings } = require('./db');
const { updateListing } = require('./listings');
const { notifyNewListing, enqueueEmail } = require('./notify');

const MP_API = process.env.MP_API_URL || 'https://api.mercadopago.com';

const mpConfigured = () => Boolean(process.env.MP_ACCESS_TOKEN);
const demoEnabled = () => process.env.PAYMENTS_DEMO === '1';

function availableMethods(db) {
  const s = getSettings(db);
  const m = [];
  if (mpConfigured()) m.push('mercadopago');
  if (s.payments_transfer_enabled === '1' && (s.transfer_account_uyu || s.transfer_account_usd)) m.push('transfer');
  if (demoEnabled()) m.push('demo');
  return m;
}

async function mpFetch(path, opts = {}) {
  const res = await fetch(MP_API + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Mercado Pago ${res.status}: ${data.message || JSON.stringify(data).slice(0, 200)}`);
  return data;
}

function addDays(fromYmd, days) {
  const d = new Date(`${fromYmd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Marca un pago como aprobado y publica/extiende el aviso. Es idempotente:
 * si el pago ya estaba aprobado no vuelve a sumar días.
 */
function applyPayment(db, paymentId, { providerPaymentId = '', note = '' } = {}, baseUrl = '') {
  const res = db
    .prepare(
      `UPDATE payments SET status = 'approved', paid_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       provider_payment_id = CASE WHEN ? <> '' THEN ? ELSE provider_payment_id END,
       note = CASE WHEN ? <> '' THEN ? ELSE note END
       WHERE id = ? AND status <> 'approved'`,
    )
    .run(providerPaymentId, providerPaymentId, note, note, paymentId);
  if (!res.changes) return false;

  const pay = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  const listing = pay.listing_id ? db.prepare('SELECT * FROM listings WHERE id = ?').get(pay.listing_id) : null;
  if (listing) {
    const today = new Date().toISOString().slice(0, 10);
    const from = listing.expires_at && listing.expires_at > today ? listing.expires_at.slice(0, 10) : today;
    const s = getSettings(db);
    const patch = {
      payment_status: 'paid',
      plan_id: pay.plan_id,
      expires_at: addDays(from, pay.duration_days),
    };
    if (pay.featured) patch.featured = 1;
    if (listing.status !== 'rejected') {
      patch.status = s.moderation_accounts === '1' && listing.status !== 'approved' ? 'pending' : 'approved';
      if (patch.status === 'approved' && !listing.published_at) patch.published_at = new Date().toISOString();
    }
    updateListing(db, listing.id, patch);
    if (patch.status === 'approved') notifyNewListing(db, db.prepare('SELECT * FROM listings WHERE id = ?').get(listing.id), baseUrl);
  }
  const user = db.prepare('SELECT email, name FROM users WHERE id = ?').get(pay.user_id);
  if (user) {
    enqueueEmail(
      db,
      user.email,
      `Pago confirmado #${pay.id}`,
      `Hola ${user.name}, confirmamos tu pago de ${pay.currency === 'USD' ? 'US$' : '$'} ${pay.amount} (${pay.description}).\n` +
        (listing ? `Tu aviso "${listing.title}" está activo hasta el ${db.prepare('SELECT expires_at FROM listings WHERE id = ?').get(listing.id).expires_at}.\n` : '') +
        `Ver tu panel: ${baseUrl}/cuenta/`,
    );
  }
  return true;
}

/** Datos de la cuenta bancaria para transferir en una moneda (null si no hay cuenta en esa moneda). */
function transferDetails(db, currency) {
  const s = getSettings(db);
  const account = currency === 'USD' ? s.transfer_account_usd : s.transfer_account_uyu;
  if (!account) return null;
  return {
    bank: s.transfer_bank || 'Itaú',
    accountType: s.transfer_account_type,
    currency,
    account,
    branch: s.transfer_branch,
    holder: s.transfer_holder,
    holderDoc: s.transfer_holder_doc,
    instructions: s.bank_transfer_info,
  };
}

/** Crea el pago y, si corresponde, la preferencia de Mercado Pago. */
async function createCheckout(db, { user, listing, plan, method, baseUrl }) {
  const free = Number(plan.price) === 0;
  const m = free ? 'free' : method;
  if (!free && !availableMethods(db).includes(m)) throw Object.assign(new Error('Medio de pago no disponible'), { status: 400 });
  if (m === 'transfer' && !transferDetails(db, plan.currency)) {
    throw Object.assign(new Error(`No hay una cuenta para transferencias en ${plan.currency === 'USD' ? 'dólares' : 'pesos'}. Elegí otro medio de pago.`), { status: 400 });
  }

  const description = `${plan.name} — ${listing.title}`.slice(0, 250);
  const id = Number(
    db
      .prepare(
        `INSERT INTO payments (user_id, listing_id, plan_id, description, amount, currency, duration_days, featured, method)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(user.id, listing.id, plan.id, description, plan.price, plan.currency, plan.duration_days, plan.featured, m).lastInsertRowid,
  );
  if (listing.payment_status !== 'paid') updateListing(db, listing.id, { payment_status: 'unpaid' });

  if (m === 'free' || m === 'demo') {
    applyPayment(db, id, { note: m === 'demo' ? 'Pago de prueba (modo demo)' : 'Plan gratuito' }, baseUrl);
    return db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
  }

  if (m === 'mercadopago') {
    const https = baseUrl.startsWith('https://');
    const back = `${baseUrl}/cuenta/#/pagos/${id}`;
    const pref = await mpFetch('/checkout/preferences', {
      method: 'POST',
      headers: { 'X-Idempotency-Key': `mo-pay-${id}` },
      body: JSON.stringify({
        items: [{ id: `plan-${plan.id}`, title: description, quantity: 1, unit_price: Number(plan.price), currency_id: plan.currency }],
        external_reference: String(id),
        payer: { email: user.email, name: user.name },
        back_urls: { success: back, failure: back, pending: back },
        ...(https ? { auto_return: 'approved', notification_url: `${baseUrl}/api/payments/mercadopago/webhook` } : {}),
        statement_descriptor: 'MALDONADO OPORT',
        metadata: { payment_id: id, listing_id: listing.id },
      }),
    }).catch((err) => {
      db.prepare("UPDATE payments SET status = 'cancelled', note = ? WHERE id = ?").run(String(err.message).slice(0, 300), id);
      throw Object.assign(new Error('No se pudo iniciar el pago con Mercado Pago. Probá de nuevo más tarde.'), { status: 502 });
    });
    const url = process.env.MP_USE_SANDBOX === '1' && pref.sandbox_init_point ? pref.sandbox_init_point : pref.init_point;
    db.prepare('UPDATE payments SET provider_ref = ?, checkout_url = ? WHERE id = ?').run(pref.id || '', url || '', id);
  }
  // Transferencia: queda pendiente hasta que el administrador la confirme.
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
}

/** Aplica el estado de un pago de Mercado Pago (obtenido de su API, nunca del cuerpo del webhook). */
function handleMpPayment(db, mpPayment, baseUrl) {
  const pay = db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(mpPayment.external_reference));
  if (!pay || pay.method !== 'mercadopago') return null;
  if (mpPayment.status === 'approved') {
    const amountOk = Number(mpPayment.transaction_amount) + 0.001 >= Number(pay.amount);
    const currencyOk = !mpPayment.currency_id || mpPayment.currency_id === pay.currency;
    if (!amountOk || !currencyOk) {
      db.prepare('UPDATE payments SET note = ? WHERE id = ?').run(`Monto o moneda no coinciden (MP ${mpPayment.id})`, pay.id);
      return pay;
    }
    applyPayment(db, pay.id, { providerPaymentId: String(mpPayment.id) }, baseUrl);
  } else if (['rejected', 'cancelled'].includes(mpPayment.status) && pay.status === 'pending') {
    db.prepare('UPDATE payments SET status = ?, provider_payment_id = ? WHERE id = ?').run(mpPayment.status, String(mpPayment.id), pay.id);
  }
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(pay.id);
}

async function fetchMpPayment(mpPaymentId) {
  return mpFetch(`/v1/payments/${encodeURIComponent(mpPaymentId)}`);
}

/** Consulta a Mercado Pago el estado de un pago pendiente (por si el webhook no llegó). */
async function syncPayment(db, pay, baseUrl) {
  if (!mpConfigured() || pay.method !== 'mercadopago' || pay.status !== 'pending') return pay;
  try {
    const r = await mpFetch(`/v1/payments/search?external_reference=${encodeURIComponent(pay.id)}&sort=date_created&criteria=desc`);
    const results = r.results || [];
    const best = results.find((p) => p.status === 'approved') || results[0];
    if (best) return handleMpPayment(db, best, baseUrl) || pay;
  } catch (err) {
    console.error('No se pudo consultar Mercado Pago:', err.message);
  }
  return pay;
}

/** Valida la firma x-signature de los webhooks de Mercado Pago (si MP_WEBHOOK_SECRET está definido). */
function verifyMpSignature(req, dataId) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true;
  const header = String(req.headers['x-signature'] || '');
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=')));
  if (!parts.ts || !parts.v1) return false;
  const id = /^[a-z0-9]+$/i.test(dataId) ? String(dataId).toLowerCase() : dataId;
  let manifest = `id:${id};`;
  if (req.headers['x-request-id']) manifest += `request-id:${req.headers['x-request-id']};`;
  manifest += `ts:${parts.ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return expected.length === parts.v1.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

module.exports = {
  mpConfigured, demoEnabled, availableMethods, transferDetails, applyPayment, createCheckout, handleMpPayment,
  fetchMpPayment, syncPayment, verifyMpSignature, addDays,
};
