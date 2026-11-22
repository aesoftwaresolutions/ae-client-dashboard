'use strict';
// Browser-facing routes: login, logout, password reset, dashboard shell, session JSON.
const config = require('./config');
const { db } = require('./db');
const h = require('./http');
const views = require('./views');
const store = require('./store');
const sec = require('./security');
const { sendMail } = require('./mail');

// Brute-force protection (per IP and per email).
const loginIpLimiter = new sec.RateLimiter(30, 15 * 60_000);
const loginEmailLimiter = new sec.RateLimiter(8, 15 * 60_000);
const forgotLimiter = new sec.RateLimiter(5, 60 * 60_000);
const supportLimiter = new sec.RateLimiter(10, 60 * 60_000); // per user

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
          notice: url.searchParams.get('notice') === 'handled' ? 'Message marked as handled.' : '',
        }));
      }
      return h.html(res, 200, views.dashboardPage({ businessName: me.client.business_name, csrf }));
    }
    // /app/data: the client id comes from the session, never from the request.
    if (me.user.role !== 'client' || !me.client) return h.json(res, 403, { error: 'Not a client account' });
    return h.json(res, 200, {
      business_name: me.client.business_name,
      services: store.listServiceCards(me.client.id),
      activity: store.listActivity(me.client.id, 30),
      billing: store.getBilling(me.client.id),
    });
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

  return false; // not a web route
}

module.exports = { handleWeb };
