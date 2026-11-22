'use strict';
// Server-rendered HTML pages. Everything user-supplied goes through esc().
const { LOGO_MARK, FAVICON_16, FAVICON_32, APPLE_TOUCH } = require('./brand');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout(title, body, { script } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · AE Client Dashboard</title>
<link rel="icon" type="image/png" sizes="32x32" href="${FAVICON_32}">
<link rel="icon" type="image/png" sizes="16x16" href="${FAVICON_16}">
<link rel="apple-touch-icon" href="${APPLE_TOUCH}">
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
${body}
${script ? `<script src="${script}" defer></script>` : ''}
</body>
</html>`;
}

const csrfField = (t) => `<input type="hidden" name="_csrf" value="${esc(t)}">`;

/** Centered glass card used by login / reset pages. */
function authPage(title, inner) {
  return layout(title, `<main class="auth"><div class="glass auth__card">
<img src="${LOGO_MARK}" alt="AE Software Solutions" class="brand__logo" width="48" height="48">
<p class="brand">AE Software Solutions</p>
<h1>${esc(title)}</h1>
${inner}
</div></main>`);
}

const notice = (msg) => (msg ? `<p class="notice" role="status">${esc(msg)}</p>` : '');
const errorBox = (msg) => (msg ? `<p class="error" role="alert">${esc(msg)}</p>` : '');

function loginPage({ csrf, error, info, email }) {
  return authPage('Sign in', `${notice(info)}${errorBox(error)}
<form method="post" action="/login" class="form">
  ${csrfField(csrf)}
  <label>Email<input type="email" name="email" value="${esc(email)}" autocomplete="username" required autofocus></label>
  <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
  <button class="btn" type="submit">Sign in</button>
</form>
<p class="muted"><a href="/forgot">Forgot your password?</a></p>
<p class="muted small">Accounts are created by AE when you purchase a service.</p>`);
}

function forgotPage({ csrf, sent }) {
  return authPage('Reset your password', sent
    ? `<p class="notice" role="status">If that email has an account, a reset link is on its way. The link works for one hour.</p>
<p class="muted"><a href="/login">Back to sign in</a></p>`
    : `<form method="post" action="/forgot" class="form">
  ${csrfField(csrf)}
  <label>Email<input type="email" name="email" autocomplete="username" required autofocus></label>
  <button class="btn" type="submit">Email me a reset link</button>
</form>
<p class="muted"><a href="/login">Back to sign in</a></p>`);
}

function resetPage({ csrf, token, error }) {
  return authPage('Choose a new password', `${errorBox(error)}
<form method="post" action="/reset/${esc(token)}" class="form">
  ${csrfField(csrf)}
  <label>New password<input type="password" name="password" minlength="10" autocomplete="new-password" required autofocus></label>
  <label>Confirm password<input type="password" name="confirm" minlength="10" autocomplete="new-password" required></label>
  <p class="muted small">At least 10 characters.</p>
  <button class="btn" type="submit">Save password</button>
</form>`);
}

function messagePage(title, text) {
  return authPage(title, `<p>${esc(text)}</p><p class="muted"><a href="/login">Back to sign in</a></p>`);
}

/** Header with sign-out (spec 3: log out on every page). */
function header(name, csrf) {
  return `<header class="topbar">
  <div class="topbar__brand"><img src="${LOGO_MARK}" alt="AE Software Solutions" class="topbar__logo" width="30" height="30"><span class="brand">AE Software Solutions</span><span class="topbar__name">${esc(name)}</span></div>
  <form method="post" action="/logout">${csrfField(csrf)}<button class="btn btn--ghost" type="submit">Sign out</button></form>
</header>`;
}

function dashboardPage({ businessName, csrf }) {
  return layout('Dashboard', `${header(businessName, csrf)}
<main class="wrap" id="app" aria-live="polite">
  <noscript><p class="notice">Please turn on JavaScript to see your dashboard.</p></noscript>
  <p class="muted" id="loading">Loading your dashboard…</p>
</main>`, { script: '/static/app.js' });
}

function adminPage({ email, csrf }) {
  return layout('Admin', `${header('AE Admin', csrf)}
<main class="wrap"><div class="glass pad"><h1>Signed in as ${esc(email)}</h1>
<p class="muted">The admin view is not part of this MVP build. Use <code>npm run manage</code> on the server to create clients, keys and subscriptions.</p></div></main>`);
}

module.exports = { loginPage, forgotPage, resetPage, messagePage, dashboardPage, adminPage };
