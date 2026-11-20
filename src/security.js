'use strict';
// Passwords, tokens, CSRF, rate limiting, and privacy masking.
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

// ---- Passwords (scrypt, memory-hard, built into Node) ----------------------
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 128 * 1024 * 1024 };

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [alg, N, r, p, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const dk = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length,
    { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(dk, expected);
}

// Used so a login for an unknown email takes as long as a real one.
let dummyHash;
async function burnPasswordTime(password) {
  dummyHash ||= await hashPassword('dummy-password-for-timing');
  await verifyPassword(password, dummyHash);
}

const MIN_PASSWORD = 10;
const MAX_PASSWORD = 200; // cap input so scrypt cannot be used for CPU abuse

// ---- Tokens ------------------------------------------------------------------
const newToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---- Rate limiting (in memory, sliding window; fine for one Node process) ---
class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit; this.windowMs = windowMs; this.hits = new Map();
    setInterval(() => this.sweep(), 60_000).unref();
  }
  /** Record a hit. Returns { ok, retryAfter } where retryAfter is in seconds. */
  hit(key) {
    const now = Date.now();
    const recent = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { ok: false, retryAfter: Math.max(1, Math.ceil((recent[0] + this.windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { ok: true };
  }
  reset(key) { this.hits.delete(key); }
  sweep() {
    const now = Date.now();
    for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
  }
}

// ---- Privacy: never keep full phone numbers ---------------------------------
// ISO dates are matched first and returned untouched so "2026-11-20 14:30" is not
// mistaken for a phone number. Any other 7-15 digit run (with common separators)
// is masked down to its last four digits.
const PHONE_OR_DATE = /\d{4}-\d{2}-\d{2}|\+?\(?\d[\d\s().-]{4,}\d/g;

function maskPhones(text) {
  return String(text).replace(PHONE_OR_DATE, (m) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(m)) return m;
    const digits = m.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) return m;
    return `***-***-${digits.slice(-4)}`;
  });
}

// Keys that must never be kept in event metadata.
const SENSITIVE_KEY = /phone|number|card|cvv|password|passwd|secret|token|ssn|caller|^from$|^to$/i;

/** Returns a cleaned copy of metadata, or throws if it is not a small plain object. */
function sanitizeMetadata(meta) {
  if (meta == null) return {};
  if (typeof meta !== 'object' || Array.isArray(meta)) throw new Error('metadata must be an object');
  if (JSON.stringify(meta).length > 4096) throw new Error('metadata is too large (4 KB max)');
  const clean = (v, depth) => {
    if (typeof v === 'string') return maskPhones(v).slice(0, 500);
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (depth >= 4) return null;
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => clean(x, depth + 1));
    if (typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) if (!SENSITIVE_KEY.test(k)) out[k] = clean(val, depth + 1);
      return out;
    }
    return null;
  };
  return clean(meta, 0);
}

module.exports = {
  hashPassword, verifyPassword, burnPasswordTime, MIN_PASSWORD, MAX_PASSWORD,
  newToken, sha256, newId, safeEqual, RateLimiter, maskPhones, sanitizeMetadata,
};
