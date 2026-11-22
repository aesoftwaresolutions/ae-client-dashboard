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

// Dates for staff pages, written out ("Nov 22, 2026, 1:48 AM") so no ISO dashes show.
const fmtDate = (iso, withTime = false) => {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  });
};

/**
 * AE staff view: every client, their services and statuses, and the support inbox.
 * Server rendered, no script, everything escaped. Only reached when role is admin.
 */
function adminPage({ email, csrf, clients = [], messages = [], notice: info = '' }) {
  const open = messages.filter((m) => m.status === 'open').length;
  const clientRows = clients.length ? clients.map((c) => `
<article class="glass card admin__client">
  <div class="card__head">
    <div><h3 class="card__name">${esc(c.business_name)}</h3>
    <p class="card__plan">${esc(c.contact_name || '')}${c.contact_name ? ' · ' : ''}${esc(c.email)}</p>
    <p class="card__plan">Client ID ${esc(c.id)} · since ${esc(fmtDate(c.created_at))}</p></div>
    <span class="pill pill--${c.status === 'active' ? 'active' : 'paused'}">${esc(c.status === 'active' ? 'Active' : c.status)}</span>
  </div>
  ${c.open_messages ? `<p class="card__update"><strong>${c.open_messages}</strong> open message${c.open_messages === 1 ? '' : 's'}</p>` : ''}
  ${c.services.length ? `<ul class="admin__services">${c.services.map((s) => `
    <li><span>${esc(s.name)}${s.plan ? ` <span class="muted small">${esc(s.plan)}</span>` : ''}</span>
    <span class="pill pill--${esc(s.status)}">${esc(s.status_label)}</span></li>`).join('')}</ul>`
    : '<p class="muted small">No services yet.</p>'}
</article>`).join('') : '<div class="glass empty">No clients yet. Use <code>npm run manage</code> to create one.</div>';

  const messageRows = messages.length ? `<ol class="glass feed">${messages.map((m) => `
  <li>
    <div class="feed__meta"><span>${esc(fmtDate(m.created_at, true))}</span><span class="tag">${m.status === 'open' ? 'Open' : 'Handled'}</span></div>
    <div>
      <p class="feed__title">${esc(m.subject || 'No subject')} <span class="muted small">from ${esc(m.business_name)} · ${esc(m.from_email)}</span></p>
      <p class="feed__detail admin__message">${esc(m.message)}</p>
      ${m.status === 'open'
        ? `<form method="post" action="/admin/support/${esc(m.id)}/handled" class="admin__handled">${csrfField(csrf)}<button class="btn btn--ghost" type="submit">Mark handled</button></form>`
        : `<p class="muted small">Handled ${esc(fmtDate(m.handled_at, true))}</p>`}
    </div>
  </li>`).join('')}</ol>` : '<div class="glass empty">No messages yet.</div>';

  return layout('Admin', `${header('AE Admin', csrf)}
<main class="wrap">
  ${notice(info)}
  <p class="muted small">Signed in as ${esc(email)} (AE staff)</p>
  <h1>Clients</h1>
  <section class="cards">${clientRows}</section>
  <h2>Support messages${open ? ` (${open} open)` : ''}</h2>
  ${messageRows}
</main>`);
}

module.exports = { loginPage, forgotPage, resetPage, messagePage, dashboardPage, adminPage };
