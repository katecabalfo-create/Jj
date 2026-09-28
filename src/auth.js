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
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TTL_MS / 1000}${secure ? '; Secure' : ''}`,
  );
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
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

module.exports = { checkPassword, issueSession, clearSession, isAdmin, requireAdmin, usingDefaultPassword };
