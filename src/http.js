'use strict';
// Small HTTP helpers so the app needs no framework.
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { newToken, safeEqual } = require('./security');

/** Client IP. Behind one trusted proxy (Hostinger) the real client is the LAST X-Forwarded-For entry. */
function clientIp(req) {
  if (config.trustProxy) {
    const parts = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, { maxAgeSec } = {}) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeSec != null) attrs.push(`Max-Age=${maxAgeSec}`);
  if (config.isProd) attrs.push('Secure');
  res.appendHeader('Set-Cookie', attrs.join('; '));
}

const SESSION_COOKIE = config.isProd ? '__Host-ae_session' : 'ae_session';
const CSRF_COOKIE = config.isProd ? '__Host-ae_csrf' : 'ae_csrf';

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  if (config.isProd) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
const html = (res, status, body) => send(res, status, body, 'text/html; charset=utf-8');
function redirect(res, location) { res.writeHead(303, { Location: location }); res.end(); }

/** Reads the exact request body bytes (max 64 KB by default). Needed for webhook signatures. */
async function readRawBody(req, max = 65536) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) { const e = new Error('Request body too large'); e.status = 413; throw e; }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/** Reads the request body (max 64 KB) and parses JSON or form-encoded data. */
async function readBody(req, max = 65536) {
  const raw = (await readRawBody(req, max)).toString('utf8');
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/json')) {
    try { return raw ? JSON.parse(raw) : {}; } catch { const e = new Error('Invalid JSON'); e.status = 400; throw e; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

// ---- CSRF: double-submit cookie. Forms carry a hidden _csrf that must equal the cookie. ----
function ensureCsrf(req, res) {
  const existing = parseCookies(req)[CSRF_COOKIE];
  if (existing && /^[\w-]{20,}$/.test(existing)) return existing;
  const token = newToken(24);
  setCookie(res, CSRF_COOKIE, token);
  return token;
}
function checkCsrf(req, body) {
  const cookie = parseCookies(req)[CSRF_COOKIE];
  return !!cookie && typeof body._csrf === 'string' && safeEqual(cookie, body._csrf);
}

// ---- Static files (only the two public assets) ----
const STATIC = { '/static/style.css': 'text/css; charset=utf-8', '/static/app.js': 'text/javascript; charset=utf-8' };
function serveStatic(res, pathname) {
  const type = STATIC[pathname];
  if (!type) return false;
  const body = fs.readFileSync(path.join(config.root, 'public', path.basename(pathname)));
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'public, max-age=300' });
  res.end(body);
  return true;
}

module.exports = {
  clientIp, parseCookies, setCookie, SESSION_COOKIE, securityHeaders,
  send, json, html, redirect, readBody, readRawBody, ensureCsrf, checkCsrf, serveStatic,
};
