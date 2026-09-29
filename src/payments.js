'use strict';

const { getSettings } = require('./db');
const { updateListing } = require('./listings');
const { notifyNewListing, enqueueEmail } = require('./notify');

const demoEnabled = () => process.env.PAYMENTS_DEMO === '1';

function availableMethods(db) {
  const s = getSettings(db);
  const m = [];
  if (s.payments_transfer_enabled === '1' && (s.transfer_account_uyu || s.transfer_account_usd)) m.push('transfer');
  if (demoEnabled()) m.push('demo');
  return m;
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
        `Comprobante de pago: ${baseUrl}/cuenta/#/pagos/${pay.id}\nVer tu panel: ${baseUrl}/cuenta/`,
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

/** Crea el pago. La transferencia queda pendiente hasta que el administrador la confirma. */
async function createCheckout(db, { user, listing, plan, method, baseUrl }) {
  const free = Number(plan.price) === 0;
  const m = free ? 'free' : method;
  if (!free && !availableMethods(db).includes(m)) throw Object.assign(new Error('Medio de pago no disponible'), { status: 400 });
  if (m === 'transfer' && !transferDetails(db, plan.currency)) {
    throw Object.assign(new Error(`No hay una cuenta para transferencias en ${plan.currency === 'USD' ? 'dólares' : 'pesos'}.`), { status: 400 });
  }

  const description = `${plan.name} — ${listing.title}`.slice(0, 250);
  const id = Number(
    db
      .prepare(
        `INSERT INTO payments (user_id, listing_id, plan_id, description, amount, currency, duration_days, featured, method, invoice_name, invoice_rut, invoice_address)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        user.id, listing.id, plan.id, description, plan.price, plan.currency, plan.duration_days, plan.featured, m,
        user.business_name || user.name, user.rut || '', user.billing_address || '',
      ).lastInsertRowid,
  );
  if (listing.payment_status !== 'paid') updateListing(db, listing.id, { payment_status: 'unpaid' });

  if (m === 'free' || m === 'demo') {
    applyPayment(db, id, { note: m === 'demo' ? 'Pago de prueba (modo demo)' : 'Plan gratuito' }, baseUrl);
    return db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
  }

  // Transferencia: queda pendiente hasta que el administrador la confirme.
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
}

module.exports = { demoEnabled, availableMethods, transferDetails, applyPayment, createCheckout, addDays };
