'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const COOKIE = 'mo_admin';
const TTL_MS = 12 * 60 * 60 * 1000;

function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(__dirname, '..', 'data', '.session-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const s = crypto.randomBytes(32).toString('hex');
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, s, { mode: 0o600 });
    } catch {
      /* sin disco: el secreto dura hasta reiniciar */
    }
    return s;
  }
}

const SECRET = loadSecret();

function adminPassword() {
  return process.env.ADMIN_PASSWORD || 'admin';
}

function usingDefaultPassword() {
  return !process.env.ADMIN_PASSWORD;
}

function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function checkPassword(pw) {
  // Se compara el hash para no filtrar la longitud.
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
  return safeEqual(h(pw), h(adminPassword()));
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function issueSession(res, secure) {
  const exp = String(Date.now() + TTL_MS);
  const value = `${exp}.${sign(exp)}`;
  res.append(
    'Set-Cookie',
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TTL_MS / 1000}${secure ? '; Secure' : ''}`,
  );
}

function clearSession(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function isAdmin(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (!raw) return false;
  const [exp, sig] = raw.split('.');
  if (!exp || !sig || !safeEqual(sig, sign(exp))) return false;
  return Number(exp) > Date.now();
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// ---------- Cuentas de anunciantes ----------
const USER_COOKIE = 'mo_user';
const USER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(got, expected);
}

// La sesión incluye un fragmento del hash de la contraseña: al cambiarla se cierran las demás sesiones.
function pwVersion(user) {
  return crypto.createHash('sha256').update(user.password_hash).digest('base64url').slice(0, 10);
}

function issueUserSession(res, user, secure) {
  const exp = String(Date.now() + USER_TTL_MS);
  const payload = `${user.id}.${exp}.${pwVersion(user)}`;
  res.append(
    'Set-Cookie',
    `${USER_COOKIE}=${payload}.${sign(`u:${payload}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${USER_TTL_MS / 1000}${secure ? '; Secure' : ''}`,
  );
}

function clearUserSession(res) {
  res.append('Set-Cookie', `${USER_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Devuelve el usuario activo de la sesión o null. */
function currentUser(req, db) {
  const raw = parseCookies(req.headers.cookie)[USER_COOKIE];
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  const [id, exp, pwv, sig] = parts;
  if (!safeEqual(sig, sign(`u:${id}.${exp}.${pwv}`)) || Number(exp) < Date.now()) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
  if (!user || !user.active || pwVersion(user) !== pwv) return null;
  return user;
}

function requireUser(db) {
  return (req, res, next) => {
    const user = currentUser(req, db);
    if (!user) return res.status(401).json({ error: 'Iniciá sesión para continuar' });
    req.user = user;
    next();
  };
}

module.exports = {
  checkPassword, issueSession, clearSession, isAdmin, requireAdmin, usingDefaultPassword,
  hashPassword, verifyPassword, issueUserSession, clearUserSession, currentUser, requireUser,
};
