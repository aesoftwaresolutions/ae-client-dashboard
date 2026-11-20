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

      const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
      // Same work and same message whether or not the email exists.
      const ok = user ? await sec.verifyPassword(password, user.password_hash) : (await sec.burnPasswordTime(password), false);
      if (!ok) return h.html(res, 401, views.loginPage({ csrf, error: 'That email and password do not match.', email }));

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
      const hash = await sec.hashPassword(pw);
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, r.user_id);
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
      if (me.user.role === 'admin') return h.html(res, 200, views.adminPage({ email: me.user.email, csrf }));
      return h.html(res, 200, views.dashboardPage({ businessName: me.client.business_name, csrf }));
    }
    // /app/data: the client id comes from the session, never from the request.
    if (me.user.role !== 'client' || !me.client) return h.json(res, 403, { error: 'Not a client account' });
    return h.json(res, 200, {
      business_name: me.client.business_name,
      services: store.listServiceCards(me.client.id),
      activity: store.listActivity(me.client.id, 30),
    });
  }

  return false; // not a web route
}

module.exports = { handleWeb };
