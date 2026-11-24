'use strict';
// REST API for AE agents. Bearer auth with a per-client key; a key can only touch its own client_id.
//   POST /api/v1/{service}/events
//   POST /api/v1/webhooks/telnyx/call-summary      (relay from the WordPress webhook, Bearer key)
//   POST /api/v1/webhooks/telnyx                   (direct from Telnyx, Ed25519 signed, no Bearer key)
//   GET  /api/v1/clients/{client_id}/services
//   GET  /api/v1/clients/{client_id}/activity?limit=50
const config = require('./config');
const { db } = require('./db');
const h = require('./http');
const store = require('./store');
const sec = require('./security');
const onboarding = require('./onboarding');
const telnyx = require('./telnyx');
const telnyxSync = require('./telnyx-sync');
const { BY_SLUG } = require('./services');

const eventLimiter = new sec.RateLimiter(config.eventRateLimitPerHour, 3_600_000); // per API key
const badAuthLimiter = new sec.RateLimiter(30, 10 * 60_000);                       // per IP

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function authenticate(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  const key = m && db.prepare('SELECT id, client_id, label FROM api_keys WHERE key_hash=? AND revoked_at IS NULL').get(sec.sha256(m[1]));
  if (!key) return null;
  db.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(store.nowIso(), key.id);
  return key;
}

function logAccess(key, req, pathname, status) {
  db.prepare('INSERT INTO api_access_log (key_id, key_label, method, endpoint, status, at) VALUES (?,?,?,?,?,?)')
    .run(key?.id || null, key?.label || null, req.method, pathname.slice(0, 200), status, store.nowIso());
}

const str = (v, name, { min = 0, max }) => {
  if (typeof v !== 'string' || v.trim().length < min) throw new ApiError(400, `${name} is required`);
  if (v.length > max) throw new ApiError(400, `${name} is too long (max ${max} characters)`);
  return v.trim();
};

/** Validates and stores one event for the authenticated client. */
function ingest(key, input, serviceFromUrl) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new ApiError(400, 'Body must be a JSON object');
  if (input.client_id !== key.client_id) throw new ApiError(403, 'client_id does not match this API key');
  const service = serviceFromUrl || input.service;
  if (!BY_SLUG.has(service)) throw new ApiError(404, 'Unknown service');
  if (input.service !== undefined && input.service !== service) throw new ApiError(400, 'service in body does not match the URL');
  if (!store.hasSubscription(key.client_id, service)) throw new ApiError(422, 'This client does not have that service');

  const eventType = str(input.event_type, 'event_type', { min: 1, max: 64 });
  if (!/^[a-z][a-z0-9_]*$/.test(eventType)) throw new ApiError(400, 'event_type must be lowercase letters, digits and underscores');
  const title = str(input.title, 'title', { min: 1, max: 200 });
  const detail = input.detail == null ? null : str(input.detail, 'detail', { max: 2000 });

  let occurredAt = new Date();
  if (input.occurred_at != null) {
    occurredAt = new Date(input.occurred_at);
    if (Number.isNaN(occurredAt.getTime())) throw new ApiError(400, 'occurred_at must be an ISO 8601 date');
    if (occurredAt.getTime() > Date.now() + 86_400_000) throw new ApiError(400, 'occurred_at is in the future');
  }
  let metadata;
  try { metadata = sec.sanitizeMetadata(input.metadata); } catch (e) { throw new ApiError(400, e.message); }

  // Unknown event types are accepted (spec 5.2): stored and shown, they just never change the status.
  return store.addEvent({ clientId: key.client_id, service, eventType, title, detail, occurredAt, metadata });
}

/**
 * STUB for the Telnyx call-summary webhook (spec 8). The AE-site webhook posts a normalised payload:
 *   { client_id, service?, outcome: "answered"|"missed", caller_name?, caller_number?,
 *     started_at?, duration_seconds?, summary? }
 * Only the last 4 digits of the caller number and the caller's first name are kept.
 * TODO when the real webhook is live: confirm the payload shape and add retry de-duplication.
 */
function ingestTelnyx(key, input) {
  if (typeof input !== 'object' || input === null) throw new ApiError(400, 'Body must be a JSON object');
  if (!['answered', 'missed'].includes(input.outcome)) throw new ApiError(400, 'outcome must be "answered" or "missed"');
  const service = input.service || 'front-desk';
  if (!['front-desk', 'always-on-front-desk'].includes(service)) throw new ApiError(400, 'service must be a Front Desk service');

  const last4 = String(input.caller_number || '').replace(/\D/g, '').slice(-4);
  const firstName = String(input.caller_name || '').trim().split(/\s+/)[0].slice(0, 40);
  const who = firstName || (last4.length === 4 ? `a caller ending in ${last4}` : 'a caller');
  const answered = input.outcome === 'answered';
  const summary = input.summary == null ? null : String(input.summary).trim().slice(0, 500);
  const duration = Number.isFinite(input.duration_seconds) ? Math.max(0, Math.round(input.duration_seconds)) : null;

  return ingest(key, {
    client_id: input.client_id,
    service,
    event_type: answered ? 'call_answered' : 'call_missed',
    title: answered ? `Front Desk answered a call from ${who}` : `Missed a call from ${who}`,
    detail: summary || (answered ? null : 'No summary available.'),
    occurred_at: input.started_at,
    metadata: { source: 'telnyx', duration_seconds: duration, last4: last4.length === 4 ? last4 : null },
  }, service);
}

/**
 * One-time admin bootstrap. Creates AE Software Solutions LLC as a client
 * (if it does not exist), ensures a Front Desk subscription, creates a client
 * login for Anthony (if one does not exist), and creates one API key labelled
 * "front-desk webhook" (if one does not already exist). Returns the client id,
 * the API key ONCE when newly created, and a temporary login password ONCE
 * when a new user was just created (only hashes are stored). Fully idempotent:
 * repeat calls return the existing ids and create nothing new.
 * Gated by the BOOTSTRAP_SECRET env var (config.bootstrapSecret). The route
 * is 404 when no secret is configured. Remove/rotate the secret after use.
 */
async function handleBootstrap(req, res, ip) {
  if (!config.bootstrapSecret) return h.json(res, 404, { error: 'Not found' });
  if (req.method !== 'POST') return h.json(res, 405, { error: 'Use POST' });
  let body = {};
  try { body = await h.readBody(req); } catch (err) { return h.json(res, err.status || 400, { error: err.message }); }
  const given = String(req.headers['x-bootstrap-secret'] || body.bootstrap_secret || '');
  const bad = badAuthLimiter.hit(`bootstrap:${ip}`);
  if (!bad.ok) { res.setHeader('Retry-After', String(bad.retryAfter)); return h.json(res, 429, { error: 'Too many failed attempts' }); }
  if (!given || !sec.safeEqual(given, config.bootstrapSecret)) {
    logAccess(null, req, '/api/v1/admin/bootstrap', 401);
    return h.json(res, 401, { error: 'Invalid bootstrap secret' });
  }
  badAuthLimiter.reset(`bootstrap:${ip}`);

  try {
    const AE_EMAIL = 'anthony@aesoftwaresolutions.com';
    const row = db.prepare('SELECT id FROM clients WHERE email = ?').get(AE_EMAIL);
    const clientId = row ? row.id : store.createClient({
      businessName: 'AE Software Solutions LLC',
      contactName: 'Anthony Pioquinto',
      email: AE_EMAIL,
      phone: '+17179771021',
    });
    if (!store.hasSubscription(clientId, 'front-desk')) {
      store.addSubscription({ clientId, service: 'front-desk', plan: 'Front Desk 99', priceCents: 9900, billing: 'monthly' });
    }
    // Client login for Anthony (role client, so he sees AE's own dashboard).
    let tempPassword = null;
    let userCreated = false;
    let welcomeEmailSent = false;
    const userRow = db.prepare('SELECT id FROM users WHERE email = ?').get(AE_EMAIL);
    if (!userRow) {
      tempPassword = sec.newToken(12);
      await store.createUser({ clientId, email: AE_EMAIL, password: tempPassword, role: 'client', tempPassword: true });
      userCreated = true;
      // New-member onboarding: email the set-password link (7-day link, reminders day 3 + 6).
      // Mail failing must not fail the bootstrap; the temp password still works.
      try { welcomeEmailSent = await onboarding.sendPasswordResetEmail({ id: db.prepare('SELECT id FROM users WHERE email = ?').get(AE_EMAIL).id, email: AE_EMAIL }, { reason: 'welcome' }); } catch (e) { console.error('[api] bootstrap welcome email failed:', e.message); }
    }
    const existing = db.prepare("SELECT id FROM api_keys WHERE client_id = ? AND label = ? AND revoked_at IS NULL").get(clientId, 'front-desk webhook');
    let apiKey = null;
    let keyId = existing ? existing.id : null;
    let keyNote = null;
    if (!existing) {
      const created = store.createApiKey({ clientId, label: 'front-desk webhook' });
      apiKey = created.key;
      keyId = created.id;
    } else {
      keyNote = 'An active front-desk webhook key already exists for this client';
    }
    logAccess(null, req, '/api/v1/admin/bootstrap', 200);
    return h.json(res, 200, {
      ok: true,
      client_id: clientId,
      api_key: apiKey,
      key_id: keyId,
      key_note: keyNote,
      user_created: userCreated,
      user_email: AE_EMAIL,
      temp_password: tempPassword,
      welcome_email_sent: welcomeEmailSent,
    });
  } catch (err) {
    console.error('[api] bootstrap error:', err);
    logAccess(null, req, '/api/v1/admin/bootstrap', 500);
    return h.json(res, 500, { error: 'Server error' });
  }
}

const telnyxBadSigLimiter = new sec.RateLimiter(60, 10 * 60_000); // per IP, failed signatures only

async function handleTelnyxDirect(req, res, ip, pathname) {
  if (req.method !== 'POST') return h.json(res, 405, { error: 'Use POST' });
  let raw;
  try { raw = await h.readRawBody(req, 256 * 1024); } catch (err) { return h.json(res, err.status || 400, { error: err.message }); }
  const check = telnyx.verifyTelnyxSignature({ rawBody: raw, headers: req.headers });
  if (!check.ok) {
    if (check.status === 503) console.error('[api] telnyx webhook rejected: TELNYX_PUBLIC_KEY is not set');
    const bad = telnyxBadSigLimiter.hit(`bad:${ip}`);
    logAccess(null, req, pathname, bad.ok ? check.status : 429);
    if (!bad.ok) { res.setHeader('Retry-After', String(bad.retryAfter)); return h.json(res, 429, { error: 'Too many failed attempts' }); }
    return h.json(res, check.status, { error: check.reason });
  }
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch {
    logAccess(null, req, pathname, 400);
    return h.json(res, 400, { error: 'Invalid JSON' });
  }
  try {
    const result = telnyx.handleTelnyxEvent(body);
    logAccess(null, req, pathname, 200);
    return h.json(res, 200, { ok: true, ...result });
  } catch (err) {
    console.error('[api] telnyx webhook error:', err);
    logAccess(null, req, pathname, 500);
    return h.json(res, 500, { error: 'Server error' }); // non 2xx so Telnyx retries
  }
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const ip = h.clientIp(req);

  // ---- One-time admin bootstrap (bypasses Bearer auth: no key exists yet) ----
  if (pathname === '/api/v1/admin/bootstrap') {
    return handleBootstrap(req, res, ip);
  }

  // ---- Daily password-reminder trigger (bypasses Bearer auth; gated by REMINDER_SECRET) ----
  // POST /api/v1/admin/send-password-reminders with { "reminder_secret": "..." }
  // (or an X-Reminder-Secret header). Runs the day-3 / day-6 onboarding reminders.
  // Call it once a day from a cron. When REMINDER_SECRET is unset the route is 404.
  if (pathname === '/api/v1/admin/send-password-reminders') {
    if (!config.reminderSecret) return h.json(res, 404, { error: 'Not found' });
    if (req.method !== 'POST') return h.json(res, 405, { error: 'Use POST' });
    let body = {};
    try { body = await h.readBody(req); } catch (err) { return h.json(res, err.status || 400, { error: err.message }); }
    const given = String(req.headers['x-reminder-secret'] || body.reminder_secret || '');
    const bad = badAuthLimiter.hit(`reminders:${ip}`);
    if (!bad.ok) { res.setHeader('Retry-After', String(bad.retryAfter)); return h.json(res, 429, { error: 'Too many failed attempts' }); }
    if (!given || !sec.safeEqual(given, config.reminderSecret)) {
      logAccess(null, req, pathname, 401);
      return h.json(res, 401, { error: 'Invalid reminder secret' });
    }
    badAuthLimiter.reset(`reminders:${ip}`);
    try {
      const result = await onboarding.runReminders();
      logAccess(null, req, pathname, 200);
      return h.json(res, 200, { ok: true, ...result });
    } catch (err) {
      console.error('[api] reminders error:', err);
      logAccess(null, req, pathname, 500);
      return h.json(res, 500, { error: 'Server error' });
    }
  }

  // ---- Telnyx active sync trigger (bypasses Bearer auth; gated by TELNYX_SYNC_SECRET) ----
  // POST /api/v1/admin/telnyx-sync with { "sync_secret": "..." }
  // (or an X-Telnyx-Sync-Secret header). Pulls assistants, conversations, phone
  // numbers and balance from Telnyx (read-only GETs) into the dashboard DB.
  // Call it from a cron (hourly is plenty; the sync itself skips a run within
  // 5 minutes of the last one). When TELNYX_SYNC_SECRET is unset the route is 404.
  if (pathname === '/api/v1/admin/telnyx-sync') {
    if (!config.telnyxSyncSecret) return h.json(res, 404, { error: 'Not found' });
    if (req.method !== 'POST') return h.json(res, 405, { error: 'Use POST' });
    let body = {};
    try { body = await h.readBody(req); } catch (err) { return h.json(res, err.status || 400, { error: err.message }); }
    const given = String(req.headers['x-telnyx-sync-secret'] || body.sync_secret || '');
    const bad = badAuthLimiter.hit(`telnyx-sync:${ip}`);
    if (!bad.ok) { res.setHeader('Retry-After', String(bad.retryAfter)); return h.json(res, 429, { error: 'Too many failed attempts' }); }
    if (!given || !sec.safeEqual(given, config.telnyxSyncSecret)) {
      logAccess(null, req, pathname, 401);
      return h.json(res, 401, { error: 'Invalid sync secret' });
    }
    badAuthLimiter.reset(`telnyx-sync:${ip}`);
    try {
      const result = await telnyxSync.syncTelnyx();
      logAccess(null, req, pathname, result.ok ? 200 : 500);
      return h.json(res, result.ok ? 200 : 500, result);
    } catch (err) {
      console.error('[api] telnyx sync error:', err);
      logAccess(null, req, pathname, 500);
      return h.json(res, 500, { error: 'Server error' });
    }
  }

  // ---- Link a Telnyx agent to a client (one-time provisioning, same gate) ----
  // POST /api/v1/admin/link-telnyx-agent with { "sync_secret": "...",
  //   "client_id": "cl_...", "service": "front-desk",
  //   "assistant_id": "assistant-...", "phone": "+19729440615",
  //   "transfer_phone": "+17179771021", "call_limit": 60 }.
  // Creates the telnyx_agents row the sync and the webhook both need to map
  // calls to a client. Without this row the sync reports assistants: 0 and
  // the webhook ignores call summaries. Idempotent-ish: a duplicate
  // (assistant_id or phone) is a 409, not a second row.
  if (pathname === '/api/v1/admin/link-telnyx-agent') {
    if (!config.telnyxSyncSecret) return h.json(res, 404, { error: 'Not found' });
    if (req.method !== 'POST') return h.json(res, 405, { error: 'Use POST' });
    let body = {};
    try { body = await h.readBody(req); } catch (err) { return h.json(res, err.status || 400, { error: err.message }); }
    const given = String(req.headers['x-telnyx-sync-secret'] || body.sync_secret || '');
    const bad = badAuthLimiter.hit(`telnyx-link:${ip}`);
    if (!bad.ok) { res.setHeader('Retry-After', String(bad.retryAfter)); return h.json(res, 429, { error: 'Too many failed attempts' }); }
    if (!given || !sec.safeEqual(given, config.telnyxSyncSecret)) {
      logAccess(null, req, pathname, 401);
      return h.json(res, 401, { error: 'Invalid sync secret' });
    }
    badAuthLimiter.reset(`telnyx-link:${ip}`);
    try {
      const agentId = store.addTelnyxAgent({
        clientId: String(body.client_id || ''),
        service: String(body.service || ''),
        assistantId: String(body.assistant_id || ''),
        phone: String(body.phone || ''),
        transferPhone: String(body.transfer_phone || ''),
        callLimit: Number(body.call_limit) || 60,
      });
      logAccess(null, req, pathname, 200);
      return h.json(res, 200, { ok: true, agent_id: agentId });
    } catch (err) {
      const msg = err && err.message ? err.message : 'Server error';
      const dup = /UNIQUE constraint failed/i.test(msg);
      logAccess(null, req, pathname, dup ? 409 : 400);
      return h.json(res, dup ? 409 : 400, { ok: false, error: msg });
    }
  }

  // ---- Direct Telnyx webhook (bypasses Bearer auth; Ed25519 signature instead) ----
  // Telnyx cannot send our Bearer key, so the tenant comes from telnyx_agents
  // (assistant id or dialled number), never from the request.
  if (pathname === '/api/v1/webhooks/telnyx') {
    return handleTelnyxDirect(req, res, ip, pathname);
  }

  // Reject repeated bad keys before doing anything else.
  const bad = badAuthLimiter.hit(`probe:${ip}`);
  let key = null;
  try {
    key = authenticate(req);
    if (!key) {
      if (!bad.ok) { res.setHeader('Retry-After', String(bad.retryAfter)); return h.json(res, 429, { error: 'Too many failed attempts' }); }
      logAccess(null, req, pathname, 401);
      res.setHeader('WWW-Authenticate', 'Bearer');
      return h.json(res, 401, { error: 'Missing or invalid API key' });
    }
    badAuthLimiter.reset(`probe:${ip}`);

    let m;
    // ---- Write: POST /api/v1/webhooks/telnyx/call-summary or /api/v1/{service}/events ----
    const isWebhook = pathname === '/api/v1/webhooks/telnyx/call-summary';
    const eventsMatch = /^\/api\/v1\/([a-z0-9-]+)\/events$/.exec(pathname);
    if (isWebhook || eventsMatch) {
      if (req.method !== 'POST') throw new ApiError(405, 'Use POST');
      const rl = eventLimiter.hit(key.id);
      if (!rl.ok) { res.setHeader('Retry-After', String(rl.retryAfter)); throw new ApiError(429, 'Rate limit exceeded'); }
      const body = await h.readBody(req);
      const id = isWebhook ? ingestTelnyx(key, body) : ingest(key, body, eventsMatch[1]);
      logAccess(key, req, pathname, 200);
      return h.json(res, 200, { ok: true, event_id: id });
    }

    // ---- Read: GET /api/v1/clients/{id}/services|activity ----
    if ((m = /^\/api\/v1\/clients\/([\w-]+)\/(services|activity)$/.exec(pathname))) {
      if (req.method !== 'GET') throw new ApiError(405, 'Use GET');
      if (m[1] !== key.client_id) throw new ApiError(403, 'This API key cannot access that client');
      const data = m[2] === 'services'
        ? { client_id: key.client_id, services: store.listServiceCards(key.client_id) }
        : { client_id: key.client_id, activity: store.listActivity(key.client_id, url.searchParams.get('limit')) };
      logAccess(key, req, pathname, 200);
      return h.json(res, 200, data);
    }

    throw new ApiError(404, 'Not found');
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[api] error:', err); // never echo internals to the caller
    if (key || status !== 401) logAccess(key, req, pathname, status);
    return h.json(res, status, { error: status === 500 ? 'Server error' : err.message });
  }
}

module.exports = { handleApi };
