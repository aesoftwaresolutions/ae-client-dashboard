'use strict';
// Server-rendered HTML pages. Everything user-supplied goes through esc().
const { LOGO_MARK, FAVICON_16, FAVICON_32, APPLE_TOUCH } = require('./brand');
const { maskPhones } = require('./security');
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
// Client pages get a nav (Dashboard, Inbox, Settings, Billing); the admin header has none.
function clientNav(active) {
  const link = (href, label, key) => `<a class="topbar__link" href="${href}"${active === key ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<nav class="topbar__nav" aria-label="Dashboard pages">${link('/dashboard', 'Dashboard', 'dashboard')}${link('/inbox', 'Inbox', 'inbox')}${link('/settings', 'Settings', 'settings')}${link('/billing', 'Billing', 'billing')}</nav>`;
}

function header(name, csrf, active) {
  return `<header class="topbar">
  <div class="topbar__brand"><img src="${LOGO_MARK}" alt="AE Software Solutions" class="topbar__logo" width="30" height="30"><span class="brand">AE Software Solutions</span><span class="topbar__name">${esc(name)}</span></div>
  ${active ? clientNav(active) : ''}
  <form method="post" action="/logout">${csrfField(csrf)}<button class="btn btn--ghost" type="submit">Sign out</button></form>
</header>`;
}

// The client app shell. page 'dashboard' (services, calls, activity, profile,
// support), 'inbox' (every conversation in one place), 'settings' (AI Agent
// settings and text call summaries) or 'billing' (subscriptions, next payment,
// card, invoices). app.js reads data-page to decide which sections to draw.
const CLIENT_PAGES = { dashboard: 'Dashboard', inbox: 'Inbox', settings: 'Settings', billing: 'Billing' };
function dashboardPage({ businessName, csrf, page = 'dashboard' }) {
  const key = CLIENT_PAGES[page] ? page : 'dashboard';
  const word = key === 'billing' ? 'billing details' : key === 'inbox' ? 'inbox' : key;
  return layout(CLIENT_PAGES[key], `${header(businessName, csrf, key)}
<main class="wrap" id="app" data-page="${key}" aria-live="polite">
  <noscript><p class="notice">Please turn on JavaScript to see your ${word}.</p></noscript>
  <p class="muted" id="loading">Loading your ${word}…</p>
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
function adminPage({ email, csrf, clients = [], messages = [], fulfillments = [], telnyx = null, notice: info = '' }) {
  const open = messages.filter((m) => m.status === 'open').length;
  const pendingSales = fulfillments.filter((f) => f.status === 'pending' || f.status === 'unknown-product');
  const saleRows = fulfillments.length ? fulfillments.map((f) => `
<article class="glass card admin__client">
  <div class="card__head">
    <div><h3 class="card__name">${esc(f.product || 'Unknown product')} · ${esc(f.amount_label || '')}</h3>
    <p class="card__plan">${esc((f.buyer && f.buyer.name) || '')}${f.buyer && f.buyer.name ? ' · ' : ''}${esc((f.buyer && f.buyer.email) || '')}</p>
    <p class="card__plan">${esc(fmtDate(f.date))} · ${esc(f.charge_id)}</p></div>
    <span class="pill pill--${f.status === 'pending' ? 'active' : 'paused'}">${esc(f.status === 'pending' ? 'Pending' : f.status)}</span>
  </div>
  ${f.needs_anthony && f.needs_anthony.length ? `<ul class="admin__services">${f.needs_anthony.map((n) => `<li><span>${esc(n)}</span></li>`).join('')}</ul>` : ''}
  ${f.status === 'pending' || f.status === 'unknown-product'
    ? `<form method="post" action="/admin/fulfillment/${esc(f.charge_id)}/handled" class="admin__handled">${csrfField(csrf)}<button class="btn btn--ghost" type="submit">Mark fulfilled</button></form>`
    : `<p class="muted small">Handled ${esc(fmtDate(f.handled_at, true))}</p>`}
</article>`).join('') : '<div class="glass empty">No sales yet. The fulfillment watcher writes new purchases here.</div>';
  const clientRows = clients.length ? clients.map((c) => {
  const address = [c.address_street, [c.address_city, c.address_state, c.address_zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const profileLines = [
    c.website ? `Website ${c.website}` : '',
    address ? `Address ${address}` : '',
    c.business_description || '',
    c.services_offered ? `Services: ${c.services_offered}` : '',
    c.business_hours ? `Hours: ${c.business_hours}` : '',
  ].filter(Boolean);
  return `
<article class="glass card admin__client">
  <div class="card__head">
    <div>${c.logo_filename ? `<img src="/app/profile/logo?client_id=${esc(c.id)}" alt="${esc(c.business_name)} logo" class="admin__logo">` : ''}<h3 class="card__name">${esc(c.business_name)}</h3>
    <p class="card__plan">${esc(c.contact_name || '')}${c.contact_name ? ' · ' : ''}${esc(c.email)}</p>
    <p class="card__plan">Client ID ${esc(c.id)} · since ${esc(fmtDate(c.created_at))}</p></div>
    <span class="pill pill--${c.status === 'active' ? 'active' : 'paused'}">${esc(c.status === 'active' ? 'Active' : c.status)}</span>
  </div>
  ${profileLines.length ? `<p class="card__plan">${profileLines.map((l) => esc(l)).join('<br>')}</p>` : ''}
  ${c.open_messages ? `<p class="card__update"><strong>${c.open_messages}</strong> open message${c.open_messages === 1 ? '' : 's'}</p>` : ''}
  ${c.services.length ? `<ul class="admin__services">${c.services.map((s) => `
    <li><span>${esc(s.name)}${s.plan ? ` <span class="muted small">${esc(s.plan)}</span>` : ''}</span>
    <span class="pill pill--${esc(s.status)}">${esc(s.status_label)}</span></li>`).join('')}</ul>`
    : '<p class="muted small">No services yet.</p>'}
</article>`; }).join('') : '<div class="glass empty">No clients yet. Use <code>npm run manage</code> to create one.</div>';

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

  // Telnyx active sync: balance, last sync, numbers, assistants. Numbers are
  // AE-owned but still masked on display. The sync is read-only; nothing here
  // changes Telnyx, it only shows what the last pull found.
  const t = telnyx || {};
  const balanceLabel = t.account && Number.isInteger(t.account.balance_cents)
    ? `$${(t.account.balance_cents / 100).toFixed(2)} ${esc(t.account.currency || 'USD')}` : 'Not synced yet';
  const syncLine = t.sync && t.sync.last_success_at
    ? `Last synced ${esc(fmtDate(t.sync.last_success_at, true))} · ${t.sync.conversations_synced ?? 0} calls, ${t.sync.assistants_synced ?? 0} assistants, ${t.sync.numbers_synced ?? 0} numbers`
    : (t.sync && t.sync.last_error ? `Last sync failed: ${esc(t.sync.last_error)}` : 'No sync has run yet. Set TELNYX_API_KEY in the hosting env vars, then sync.');
  const numberRows = (t.numbers || []).length ? (t.numbers || []).map((n) => `
    <li><span>${esc(maskPhones(n.phone_number))} · ${esc(n.status || 'unknown')}</span>
    <span class="muted small">${esc(n.voice_url ? 'routed' : 'no routing')}</span></li>`).join('')
    : '<li><span class="muted small">No numbers synced yet.</span></li>';
  const agentRows = (t.agents || []).length ? (t.agents || []).map((a) => `
    <li><span>${esc(a.name || a.telnyx_assistant_id)} · ${esc(a.model || '')}</span>
    <span class="muted small">${esc(maskPhones(a.telnyx_phone_number))}${a.tools && a.tools.length ? ` · tools: ${esc(a.tools.join(', '))}` : ''}${a.business_name ? ` · ${esc(a.business_name)}` : ''}</span></li>`).join('')
    : '<li><span class="muted small">No assistants synced yet.</span></li>';
  const telnyxSection = `
  <h1>Telnyx</h1>
  <div class="glass card">
    <div class="card__head"><div><h3 class="card__name">Balance ${balanceLabel}</h3>
    <p class="card__plan">${syncLine}</p></div></div>
    <form method="post" action="/admin/telnyx-sync" class="admin__handled">${csrfField(csrf)}<button class="btn btn--ghost" type="submit">Sync now</button></form>
    <h2>Phone numbers</h2>
    <ul class="admin__services">${numberRows}</ul>
    <h2>AI assistants</h2>
    <ul class="admin__services">${agentRows}</ul>
  </div>`;

  return layout('Admin', `${header('AE Admin', csrf)}
<main class="wrap">
  ${notice(info)}
  <p class="muted small">Signed in as ${esc(email)} (AE staff)</p>
  <h1>New sales${pendingSales.length ? ` (${pendingSales.length} pending)` : ''}</h1>
  <section class="cards">${saleRows}</section>
  <h1>Clients</h1>
  <section class="cards">${clientRows}</section>
  ${telnyxSection}
  <h2>Support messages${open ? ` (${open} open)` : ''}</h2>
  ${messageRows}
</main>`);
}

module.exports = { loginPage, forgotPage, resetPage, messagePage, dashboardPage, adminPage };
