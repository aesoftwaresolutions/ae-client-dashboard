'use strict';
// Browser-facing routes: login, logout, password reset, dashboard shell, session JSON.
const config = require('./config');
const { db } = require('./db');
const h = require('./http');
const views = require('./views');
const store = require('./store');
const sec = require('./security');
const { sendMail } = require('./mail');
const fulfillment = require('../scripts/purchase-fulfillment');
const telnyxSync = require('./telnyx-sync');
const agentSettings = require('./telnyx-agent-settings');
const transcript = require('./telnyx-transcript');
const profile = require('./client-profile');
const notifications = require('./notifications');
const fs = require('node:fs');

// Brute-force protection (per IP and per email).
const loginIpLimiter = new sec.RateLimiter(30, 15 * 60_000);
const loginEmailLimiter = new sec.RateLimiter(8, 15 * 60_000);
const forgotLimiter = new sec.RateLimiter(5, 60 * 60_000);
const supportLimiter = new sec.RateLimiter(10, 60 * 60_000); // per user
const agentSettingsLimiter = new sec.RateLimiter(10, 60 * 60_000); // per user
const callDetailLimiter = new sec.RateLimiter(30, 60 * 60_000); // per user; each open may call Telnyx for a fresh recording URL
const profileLimiter = new sec.RateLimiter(10, 60 * 60_000); // per user; profile save, logo upload and logo removal
const notificationLimiter = new sec.RateLimiter(10, 60 * 60_000); // per user; notification settings saves

const SUPPORT_SUBJECT_MAX = 120;
const SUPPORT_MESSAGE_MAX = 2000;

// ---- Sessions ----------------------------------------------------------------
function createSession(res, userId) {
  const token = sec.newToken(32);
  const ttlMs = config.sessionDays * 86_400_000;
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(sec.sha256(token), userId, store.nowIso(), new Date(Date.now() + ttlMs).toISOString());
  h.setCookie(res, h.SESSION_COOKIE, token, { maxAgeSec: ttlMs / 1000 });
}

/** Returns { user, client } for a valid session cookie, else null. */
function currentUser(req) {
  const token = h.parseCookies(req)[h.SESSION_COOKIE];
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.email, u.role, u.client_id, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sec.sha256(token));
  if (!row || row.expires_at < store.nowIso()) return null;
  const client = row.client_id ? db.prepare('SELECT id, business_name FROM clients WHERE id=?').get(row.client_id) : null;
  return { user: row, client };
}

/** AE staff: role 'admin' with no client attached (see users.role in src/db.js). */
const isAdmin = (me) => !!me && me.user.role === 'admin' && !me.user.client_id;

const tooMany = (res, retryAfter) => {
  res.setHeader('Retry-After', String(retryAfter));
  h.html(res, 429, views.messagePage('Too many attempts', 'Please wait a few minutes and try again.'));
};

// ---- Route handlers ------------------------------------------------------------
async function handleWeb(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (method === 'GET' && pathname === '/') {
    return h.redirect(res, currentUser(req) ? '/dashboard' : '/login');
  }

  // --- Login ---
  if (pathname === '/login') {
    if (method === 'GET') {
      if (currentUser(req)) return h.redirect(res, '/dashboard');
      const info = url.searchParams.get('notice') === 'reset' ? 'Password updated. Please sign in.' : '';
      return h.html(res, 200, views.loginPage({ csrf: h.ensureCsrf(req, res), info }));
    }
    if (method === 'POST') {
      const body = await h.readBody(req);
      const csrf = h.ensureCsrf(req, res);
      if (!h.checkCsrf(req, body)) return h.html(res, 400, views.loginPage({ csrf, error: 'Your session expired. Please try again.' }));
      const email = String(body.email || '').trim().toLowerCase().slice(0, 254);
      const password = String(body.password || '').slice(0, sec.MAX_PASSWORD);
      const a = loginIpLimiter.hit(h.clientIp(req));
      const b = loginEmailLimiter.hit(email);
      if (!a.ok || !b.ok) return tooMany(res, Math.max(a.retryAfter || 0, b.retryAfter || 0));

      const user = db.prepare('SELECT id, password_hash, password_set_at, must_reset_password FROM users WHERE email = ?').get(email);
      // Same work and same message whether or not the email exists.
      const ok = user ? await sec.verifyPassword(password, user.password_hash) : (await sec.burnPasswordTime(password), false);
      if (!ok) return h.html(res, 401, views.loginPage({ csrf, error: 'That email and password do not match.', email }));

      // A password older than the 1-year expiry cannot sign in: send a fresh reset link.
      if (user && store.passwordExpired(user)) {
        const { sendPasswordResetEmail } = require('./onboarding');
        const sent = await sendPasswordResetEmail(user, { reason: 'expired' }).catch(() => false);
        return h.html(res, 401, views.loginPage({ csrf, error: sent
          ? 'Your password has expired. We just emailed you a reset link.'
          : 'Your password has expired. Request a reset link below.', email }));
      }

      loginEmailLimiter.reset(email);
      db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(store.nowIso(), user.id);
      createSession(res, user.id);
      return h.redirect(res, '/dashboard');
    }
  }

  // --- Logout (POST only, CSRF-checked) ---
  if (method === 'POST' && pathname === '/logout') {
    const body = await h.readBody(req);
    if (h.checkCsrf(req, body)) {
      const token = h.parseCookies(req)[h.SESSION_COOKIE];
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sec.sha256(token));
    }
    h.setCookie(res, h.SESSION_COOKIE, '', { maxAgeSec: 0 });
    return h.redirect(res, '/login');
  }

  // --- Password reset ---
  if (pathname === '/forgot') {
    if (method === 'GET') return h.html(res, 200, views.forgotPage({ csrf: h.ensureCsrf(req, res) }));
    if (method === 'POST') {
      const body = await h.readBody(req);
      if (!h.checkCsrf(req, body)) return h.html(res, 400, views.forgotPage({ csrf: h.ensureCsrf(req, res) }));
      const rl = forgotLimiter.hit(h.clientIp(req));
      if (!rl.ok) return tooMany(res, rl.retryAfter);
      const email = String(body.email || '').trim().toLowerCase().slice(0, 254);
      const user = db.prepare('SELECT id, email FROM users WHERE email=?').get(email);
      if (user) {
        const token = sec.newToken(32);
        db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?,?,?)')
          .run(sec.sha256(token), user.id, new Date(Date.now() + config.resetTokenMinutes * 60_000).toISOString());
        await sendMail({
          to: user.email,
          subject: 'Reset your AE dashboard password',
          text: `Use this link to choose a new password. It works for one hour.\n\n${config.baseUrl}/reset/${token}\n\nIf you did not ask for this, you can ignore this email.`,
        }).catch((e) => console.error('[mail] failed:', e.message));
      }
      // Identical response whether or not the account exists.
      return h.html(res, 200, views.forgotPage({ sent: true }));
    }
  }

  const resetMatch = /^\/reset\/([\w-]{20,100})$/.exec(pathname);
  if (resetMatch) {
    const token = resetMatch[1];
    const findReset = () => db.prepare('SELECT user_id, expires_at, used_at FROM password_resets WHERE token_hash=?').get(sec.sha256(token));
    const valid = (r) => r && !r.used_at && r.expires_at > store.nowIso();
    if (!valid(findReset())) {
      return h.html(res, 400, views.messagePage('Link expired', 'This reset link is no longer valid. Please request a new one.'));
    }
    if (method === 'GET') return h.html(res, 200, views.resetPage({ csrf: h.ensureCsrf(req, res), token }));
    if (method === 'POST') {
      const body = await h.readBody(req);
      const csrf = h.ensureCsrf(req, res);
      if (!h.checkCsrf(req, body)) return h.html(res, 400, views.resetPage({ csrf, token, error: 'Your session expired. Please try again.' }));
      const pw = String(body.password || '');
      if (pw.length < sec.MIN_PASSWORD || pw.length > sec.MAX_PASSWORD) {
        return h.html(res, 400, views.resetPage({ csrf, token, error: `Password must be at least ${sec.MIN_PASSWORD} characters.` }));
      }
      if (pw !== body.confirm) return h.html(res, 400, views.resetPage({ csrf, token, error: 'The two passwords do not match.' }));
      const r = findReset();
      // setPassword restarts the 1-year expiry, clears the temp-password flag,
      // and marks the new-member onboarding complete.
      await store.setPassword(r.user_id, pw);
      db.prepare('UPDATE password_resets SET used_at=? WHERE token_hash=?').run(store.nowIso(), sec.sha256(token));
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(r.user_id); // sign out everywhere
      return h.redirect(res, '/login?notice=reset');
    }
  }

  // --- Dashboard (requires a session) ---
  if (method === 'GET' && (pathname === '/dashboard' || pathname === '/app/data')) {
    const me = currentUser(req);
    if (!me) {
      if (pathname === '/app/data') return h.json(res, 401, { error: 'Not signed in' });
      return h.redirect(res, '/login');
    }
    if (pathname === '/dashboard') {
      const csrf = h.ensureCsrf(req, res);
      // AE staff are users with role 'admin' (and no client). They get the admin view.
      if (isAdmin(me)) {
        return h.html(res, 200, views.adminPage({
          email: me.user.email, csrf,
          clients: store.listClientsOverview(),
          messages: store.listSupportMessages({ limit: 100 }),
          fulfillments: fulfillment.listFulfillments(config.dataDir),
          telnyx: store.listTelnyxOverview(),
          notice: url.searchParams.get('notice') === 'handled' ? 'Message marked as handled.'
            : url.searchParams.get('notice') === 'fulfilled' ? 'Sale marked as fulfilled.'
            : url.searchParams.get('notice') === 'telnyx-synced' ? 'Telnyx sync finished.'
            : url.searchParams.get('notice') === 'telnyx-error' ? 'Telnyx sync failed. Check that TELNYX_API_KEY is set.'
            : url.searchParams.get('notice') === 'telnyx-not-configured' ? 'Telnyx sync is not configured yet. Set TELNYX_API_KEY in the hosting env vars.'
            : '',
        }));
      }
      return h.html(res, 200, views.dashboardPage({ businessName: me.client.business_name, csrf }));
    }
    // /app/data: the client id comes from the session, never from the request.
    if (me.user.role !== 'client' || !me.client) return h.json(res, 403, { error: 'Not a client account' });
    const agent = store.getTelnyxAgent(me.client.id);
    return h.json(res, 200, {
      business_name: me.client.business_name,
      services: store.listServiceCards(me.client.id),
      activity: store.listActivity(me.client.id, 30),
      billing: store.getBilling(me.client.id),
      telnyx_agent: agent,
      calls: store.listCalls(me.client.id, 50),
      calls_usage: store.getCallsUsage(me.client.id),
      agent_settings: agent ? store.getAgentSettings(agent.id) : null,
    });
  }

  // --- AI Agent settings (client accounts; JSON, CSRF checked) ---
  // GET /app/agent-settings returns the settings to show in the form: the
  // saved settings when they exist, otherwise a live pre-fill from Telnyx.
  // POST saves them: the prompt is built, PATCHed to Telnyx, and only then
  // stored locally. The client id comes from the session, never the request,
  // so a client can only ever touch their own agent.
  if (pathname === '/app/agent-settings') {
    const me = currentUser(req);
    if (!me) return h.json(res, 401, { error: 'Not signed in' });
    if (me.user.role !== 'client' || !me.client) return h.json(res, 403, { error: 'Not a client account' });
    if (method === 'GET') {
      const effective = await agentSettings.getEffectiveSettings(me.client.id);
      if (!effective) return h.json(res, 404, { error: 'No Front Desk agent yet. Once AE sets one up for you, its settings will appear here.' });
      return h.json(res, 200, { ok: true, agent: effective.agent, settings: effective.settings, from_telnyx: effective.fromTelnyx });
    }
    if (method !== 'POST') return h.json(res, 405, { error: 'Use POST' });
    const body = await h.readBody(req, 64 * 1024);
    if (!h.checkCsrf(req, body)) return h.json(res, 400, { error: 'Your session expired. Please refresh the page and try again.' });
    const rl = agentSettingsLimiter.hit(me.user.id);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      return h.json(res, 429, { error: 'You have saved several times in the last hour. Please try again later.' });
    }
    const result = await agentSettings.saveAgentSettings({
      clientId: me.client.id,
      fields: { ...body, business_name: me.client.business_name },
    });
    if (!result.ok && result.error === 'no-agent') return h.json(res, 404, { error: 'No Front Desk agent yet.' });
    if (!result.ok && result.error === 'no-subscription') return h.json(res, 403, { error: 'Your Front Desk subscription is not active.' });
    if (!result.ok) return h.json(res, 502, { error: result.error });
    return h.json(res, 200, { ok: true, settings: result.settings });
  }

  // --- Business profile (client accounts; JSON, CSRF checked) ---
  // GET /app/profile returns the client's business info and whether they
  // have a logo. POST saves the form: business name, contact, email, phone,
  // website, address, description, services and hours. The client id comes
  // from the session, never the request, so a client can only ever touch
  // their own profile. AE staff may pass ?client_id= on GET to read a
  // client's profile (read-only).
  // The logo filename is never sent to the browser; the logo is reached
  // through its own route instead.
  const publicProfile = (p, clientId, admin) => {
    const { logo_filename, ...rest } = p;
    const logoUrl = !p.has_logo ? null
      : admin ? `/app/profile/logo?client_id=${encodeURIComponent(clientId)}` : '/app/profile/logo';
    return { ...rest, has_logo: p.has_logo, logo_url: logoUrl };
  };
  if (pathname === '/app/profile') {
    const me = currentUser(req);
    if (!me) return h.json(res, 401, { error: 'Not signed in' });
    const admin = isAdmin(me);
    const clientId = admin
      ? String(url.searchParams.get('client_id') || '')
      : (me.user.role === 'client' && me.client ? me.client.id : '');
    if (!clientId) return h.json(res, 403, { error: 'Not a client account' });
    if (method === 'GET') {
      const p = profile.getProfile(clientId);
      if (!p) return h.json(res, 404, { error: 'Client not found.' });
      return h.json(res, 200, { ok: true, profile: publicProfile(p, clientId, admin) });
    }
    if (method !== 'POST') return h.json(res, 405, { error: 'Use POST' });
    if (admin) return h.json(res, 403, { error: 'Staff cannot change a client profile from here.' });
    const body = await h.readBody(req, 64 * 1024);
    if (!h.checkCsrf(req, body)) return h.json(res, 400, { error: 'Your session expired. Please refresh the page and try again.' });
    const rl = profileLimiter.hit(me.user.id);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      return h.json(res, 429, { error: 'You have saved several times in the last hour. Please try again later.' });
    }
    const result = profile.saveProfile(me.client.id, body);
    if (!result.ok) return h.json(res, 400, { error: result.error });
    return h.json(res, 200, { ok: true, profile: publicProfile(result.profile, me.client.id, false) });
  }

  // --- Logo upload (multipart form, CSRF checked) ---
  // POST /app/profile/logo accepts one image file (PNG, JPG, WebP or GIF,
  // under 2 MB, checked by magic bytes). The file is stored under
  // DATA_DIR/logos/ with a generated name; replacing a logo removes the old
  // file. POST /app/profile/logo/remove deletes the file and clears the
  // record. The client id comes from the session, never the request.
  if (pathname === '/app/profile/logo' && method === 'POST') {
    const me = currentUser(req);
    if (!me) return h.json(res, 401, { error: 'Not signed in' });
    if (me.user.role !== 'client' || !me.client) return h.json(res, 403, { error: 'Not a client account' });
    const type = String(req.headers['content-type'] || '');
    if (!type.includes('multipart/form-data')) return h.json(res, 400, { error: 'Please choose an image file to upload.' });
    let parsed;
    try {
      const raw = await h.readRawBody(req, 3 * 1024 * 1024);
      parsed = profile.parseMultipart(raw, type);
    } catch (err) {
      if (err.status === 413) return h.json(res, 413, { error: 'That image is too large. Please use one under 2 MB.' });
      return h.json(res, 400, { error: 'We could not read that upload. Please try again.' });
    }
    if (!h.checkCsrf(req, { _csrf: parsed.fields._csrf })) return h.json(res, 400, { error: 'Your session expired. Please refresh the page and try again.' });
    const rl = profileLimiter.hit(me.user.id);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      return h.json(res, 429, { error: 'You have uploaded several times in the last hour. Please try again later.' });
    }
    const file = parsed.files.logo;
    if (!file) return h.json(res, 400, { error: 'Choose an image file to upload.' });
    const result = profile.saveLogo(me.client.id, file.data);
    if (!result.ok) return h.json(res, 400, { error: result.error });
    return h.json(res, 200, { ok: true, profile: publicProfile(result.profile, me.client.id, false) });
  }

  if (pathname === '/app/profile/logo/remove' && method === 'POST') {
    const me = currentUser(req);
    if (!me) return h.json(res, 401, { error: 'Not signed in' });
    if (me.user.role !== 'client' || !me.client) return h.json(res, 403, { error: 'Not a client account' });
    const body = await h.readBody(req, 16 * 1024);
    if (!h.checkCsrf(req, body)) return h.json(res, 400, { error: 'Your session expired. Please refresh the page and try again.' });
    const rl = profileLimiter.hit(me.user.id);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      return h.json(res, 429, { error: 'You have made several changes in the last hour. Please try again later.' });
    }
    const result = profile.removeLogo(me.client.id);
    if (!result.ok && result.error === 'no-logo') return h.json(res, 404, { error: 'There is no logo to remove.' });
    if (!result.ok) return h.json(res, 400, { error: result.error });
    return h.json(res, 200, { ok: true, profile: publicProfile(result.profile, me.client.id, false) });
  }

  // --- Serve a client's logo (GET, session checked) ---
  // The file is read from DATA_DIR/logos/ by its generated name and sent
  // with the image content type. A client can only ever see their own logo;
  // AE staff may pass ?client_id= to see a client's logo in the admin view.
  if (pathname === '/app/profile/logo' && method === 'GET') {
    const me = currentUser(req);
    if (!me) return h.json(res, 401, { error: 'Not signed in' });
    const admin = isAdmin(me);
    const clientId = admin
      ? String(url.searchParams.get('client_id') || '')
      : (me.user.role === 'client' && me.client ? me.client.id : '');
    if (!clientId) return h.json(res, 403, { error: 'Not a client account' });
    const filename = profile.logoFilename(clientId);
    if (!filename) return h.json(res, 404, { error: 'No logo yet.' });
    const full = profile.logoPath(filename);
    if (!full || !fs.existsSync(full)) return h.json(res, 404, { error: 'No logo yet.' });
    const ext = filename.split('.').pop();
    const mime = profile.LOGO_MIME[ext] || 'application/octet-stream';
    const data = fs.readFileSync(full);
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length });
    res.end(data);
    return true;
  }

  // --- Call-summary text notifications (client accounts; JSON, CSRF checked) ---
  // GET /app/notification-settings returns the client's text settings.
  // POST saves them: whether to text a summary after each call, the number
  // to text, and whether to text every call or urgent calls only. The client
  // id comes from the session, never the request, so a client can only ever
  // touch their own settings. AE staff may pass ?client_id= on GET to read
  // a client's settings (read-only).
  if (pathname === '/app/notification-settings') {
    const me = currentUser(req);
    if (!me) return h.json(res, 401, { error: 'Not signed in' });
    const admin = isAdmin(me);
    const clientId = admin
      ? String(url.searchParams.get('client_id') || '')
      : (me.user.role === 'client' && me.client ? me.client.id : '');
    if (!clientId) return h.json(res, 403, { error: 'Not a client account' });
    if (method === 'GET') {
      const settings = notifications.getNotificationSettings(clientId);
      return h.json(res, 200, { ok: true, settings });
    }
    if (method !== 'POST') return h.json(res, 405, { error: 'Use POST' });
    if (admin) return h.json(res, 403, { error: 'Staff cannot change a client notification setting from here.' });
    const body = await h.readBody(req, 64 * 1024);
    if (!h.checkCsrf(req, body)) return h.json(res, 400, { error: 'Your session expired. Please refresh the page and try again.' });
    const rl = notificationLimiter.hit(me.user.id);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      return h.json(res, 429, { error: 'You have saved several times in the last hour. Please try again later.' });
    }
    const result = notifications.saveNotificationSettings(me.client.id, body);
    if (!result.ok) return h.json(res, 400, { error: result.error });
    return h.json(res, 200, { ok: true, settings: result.settings });
  }

  // --- One call's transcript + recording (client accounts; JSON, GET) ---
  // GET /app/calls/{telnyx_conversation_id} returns the call plus the full
  // transcript (the words actually spoken) and, when Telnyx has a completed
  // recording, a fresh playable audio URL. The recording URL is presigned
  // for 600 seconds, so it is fetched here on every open and never stored;
  // a fetch that fails still returns the transcript with recording: null.
  // The client id comes from the session, never the request, so a client
  // can only ever open their own calls. AE staff may pass ?client_id= to
  // open one of that client's calls.
  const callMatch = /^\/app\/calls\/([A-Za-z0-9-]{10,120})$/.exec(pathname);
  if (callMatch && method === 'GET') {
    const me = currentUser(req);
    if (!me) return h.json(res, 401, { error: 'Not signed in' });
    const admin = isAdmin(me);
    const clientId = admin
      ? String(url.searchParams.get('client_id') || '')
      : (me.user.role === 'client' && me.client ? me.client.id : '');
    if (!clientId) return h.json(res, 403, { error: 'Not a client account' });
    const rl = callDetailLimiter.hit(me.user.id);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      return h.json(res, 429, { error: 'You have opened several calls in the last hour. Please try again later.' });
    }
    const detail = store.getCallDetail(clientId, callMatch[1]);
    if (!detail) return h.json(res, 404, { error: 'Call not found.' });
    let recording = null;
    if (detail.call_control_id) {
      try {
        recording = await transcript.fetchRecordingUrl(detail.call_control_id);
      } catch (err) {
        console.warn('[web] recording lookup failed:', err && err.message ? err.message : err);
        recording = null;
      }
    }
    const { call_control_id, ...call } = detail;
    return h.json(res, 200, { ok: true, call, recording });
  }

  // --- One call's recording audio, proxied through the dashboard (GET) ---
  // GET /app/calls/{telnyx_conversation_id}/audio streams the call's mp3
  // from the dashboard's own origin instead of handing the browser a
  // presigned S3 link. The S3 link would not play in the browser's audio
  // element (verified 2026-11-26: the player stayed at 0:00, "Unable to
  // play media", even though the same link downloads fine with curl), so
  // the server fetches the mp3 and serves it here. Same auth as the call
  // detail: the client id comes from the session, never the request.
  // Supports Range requests so the player can seek. The mp3 is fetched
  // fresh on every request and never stored.
  const audioMatch = /^\/app\/calls\/([A-Za-z0-9-]{10,120})\/audio$/.exec(pathname);
  if (audioMatch && method === 'GET') {
    const me = currentUser(req);
    if (!me) return h.json(res, 401, { error: 'Not signed in' });
    const admin = isAdmin(me);
    const clientId = admin
      ? String(url.searchParams.get('client_id') || '')
      : (me.user.role === 'client' && me.client ? me.client.id : '');
    if (!clientId) return h.json(res, 403, { error: 'Not a client account' });
    const detail = store.getCallDetail(clientId, audioMatch[1]);
    if (!detail || !detail.call_control_id) return h.json(res, 404, { error: 'No recording for this call.' });
    let recording = null;
    try {
      recording = await transcript.fetchRecordingUrl(detail.call_control_id);
    } catch (err) {
      console.warn('[web] recording lookup failed:', err && err.message ? err.message : err);
      return h.json(res, 404, { error: 'No recording for this call.' });
    }
    if (!recording || !recording.url) return h.json(res, 404, { error: 'No recording for this call.' });
    let buf = null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      try {
        const upstream = await fetch(recording.url, { signal: ctrl.signal });
        if (!upstream.ok) throw new Error(`recording download returned ${upstream.status}`);
        buf = Buffer.from(await upstream.arrayBuffer());
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      console.warn('[web] recording download failed:', err && err.message ? err.message : err);
      return h.json(res, 502, { error: 'The recording could not be loaded. Please try again.' });
    }
    if (!buf || !buf.length) return h.json(res, 404, { error: 'No recording for this call.' });
    const total = buf.length;
    const range = String(req.headers.range || '');
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');
    if (m) {
      const start = m[1] === '' ? Math.max(0, total - (Number(m[2]) || 0)) : Math.min(Number(m[1]) || 0, total - 1);
      const end = m[2] === '' ? total - 1 : Math.min(Number(m[2]) || 0, total - 1);
      if (start > end || start >= total) {
        res.setHeader('Content-Range', `bytes */${total}`);
        res.writeHead(416);
        res.end();
        return;
      }
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', String(end - start + 1));
      res.writeHead(206);
      res.end(buf.subarray(start, end + 1));
      return;
    }
    res.setHeader('Content-Length', String(total));
    res.writeHead(200);
    res.end(buf);
    return;
  }

  // --- Message AE support (client accounts; JSON from the dashboard, CSRF checked) ---
  if (pathname === '/app/support') {
    if (method !== 'POST') return h.json(res, 405, { error: 'Use POST' });
    const me = currentUser(req);
    if (!me) return h.json(res, 401, { error: 'Not signed in' });
    if (me.user.role !== 'client' || !me.client) return h.json(res, 403, { error: 'Not a client account' });
    const body = await h.readBody(req, 16 * 1024);
    if (!h.checkCsrf(req, body)) return h.json(res, 400, { error: 'Your session expired. Please refresh the page and try again.' });
    const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) return h.json(res, 400, { error: 'Please write a message.' });
    if (message.length > SUPPORT_MESSAGE_MAX) return h.json(res, 400, { error: `Please keep the message under ${SUPPORT_MESSAGE_MAX} characters.` });
    if (subject.length > SUPPORT_SUBJECT_MAX) return h.json(res, 400, { error: `Please keep the subject under ${SUPPORT_SUBJECT_MAX} characters.` });
    const rl = supportLimiter.hit(me.user.id);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      return h.json(res, 429, { error: 'You have sent several messages in the last hour. Please try again later.' });
    }
    const id = store.addSupportMessage({ clientId: me.client.id, userId: me.user.id, subject, message });
    if (config.supportNotifyEmail) {
      // Best effort notice to AE staff. The message itself stays in the dashboard.
      sendMail({
        to: config.supportNotifyEmail,
        subject: `New dashboard message from ${me.client.business_name}`.replace(/[\r\n]+/g, ' ').slice(0, 150),
        text: `${me.client.business_name} sent a message from the client dashboard.\n\nSign in to read it: ${config.baseUrl}/dashboard`,
      }).catch((e) => console.error('[mail] support notice failed:', e.message));
    }
    return h.json(res, 200, { ok: true, id });
  }

  // --- Admin: mark a support message handled (AE staff only, CSRF checked) ---
  const handledMatch = /^\/admin\/support\/(msg_[0-9a-f]{16})\/handled$/.exec(pathname);
  if (handledMatch && method === 'POST') {
    const me = currentUser(req);
    if (!me) return h.redirect(res, '/login');
    if (!isAdmin(me)) return h.html(res, 403, views.messagePage('Not allowed', 'This page is for AE staff only.'));
    const body = await h.readBody(req);
    if (h.checkCsrf(req, body)) store.markSupportHandled(handledMatch[1], me.user.id);
    return h.redirect(res, '/dashboard?notice=handled');
  }

  // --- Admin: mark a purchase fulfillment handled (AE staff only, CSRF checked) ---
  const fulfilledMatch = /^\/admin\/fulfillment\/(ch_[A-Za-z0-9]+)\/handled$/.exec(pathname);
  if (fulfilledMatch && method === 'POST') {
    const me = currentUser(req);
    if (!me) return h.redirect(res, '/login');
    if (!isAdmin(me)) return h.html(res, 403, views.messagePage('Not allowed', 'This page is for AE staff only.'));
    const body = await h.readBody(req);
    if (h.checkCsrf(req, body)) {
      try { fulfillment.markFulfillmentHandled(fulfilledMatch[1], config.dataDir); } catch { /* already gone */ }
    }
    return h.redirect(res, '/dashboard?notice=fulfilled');
  }

  // --- Admin: run the Telnyx sync now (AE staff only, CSRF checked) ---
  if (pathname === '/admin/telnyx-sync' && method === 'POST') {
    const me = currentUser(req);
    if (!me) return h.redirect(res, '/login');
    if (!isAdmin(me)) return h.html(res, 403, views.messagePage('Not allowed', 'This page is for AE staff only.'));
    const body = await h.readBody(req);
    if (!h.checkCsrf(req, body)) return h.redirect(res, '/dashboard');
    const result = await telnyxSync.syncTelnyx();
    if (!result.ok && result.error === 'telnyx api key not configured') return h.redirect(res, '/dashboard?notice=telnyx-not-configured');
    return h.redirect(res, result.ok ? '/dashboard?notice=telnyx-synced' : '/dashboard?notice=telnyx-error');
  }

  return false; // not a web route
}

module.exports = { handleWeb };
