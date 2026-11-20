// Dashboard front end. Plain JavaScript, no framework.
// Loads /app/data (session auth; the server decides which client) and draws cards plus the feed.
// Text is always set with textContent, so nothing from the API can inject HTML.
(function () {
  'use strict';
  var app = document.getElementById('app');

  /** el('div', {class: 'x'}, child, 'text') */
  function el(tag, attrs) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (!c && c !== '') continue; // skip null/false/0 placeholders
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function formatWhen(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function renderCard(c) {
    var update;
    if (c.quiet) {
      update = el('p', { class: 'card__update muted' },
        c.last_update ? 'No recent activity. Last update: ' + c.last_update.title : 'No updates yet. We will post here as soon as there is news.');
    } else {
      update = el('p', { class: 'card__update' }, c.last_update.title,
        el('span', { class: 'card__when' }, formatWhen(c.last_update.occurred_at)));
    }
    var stats = c.stats.length ? el.apply(null, ['ul', { class: 'stats' }].concat(c.stats.map(function (s) {
      return el('li', {}, el('strong', {}, String(s.value)), el('span', {}, s.label));
    }))) : null;
    var calls = c.recent_calls.length ? el.apply(null, ['ul', { class: 'calls', 'aria-label': 'Recent call summaries' }].concat(
      c.recent_calls.map(function (r) {
        return el('li', {}, el('span', { class: 'card__when' }, formatWhen(r.occurred_at)), r.detail);
      }))) : null;
    return el('article', { class: 'glass card' },
      el('div', { class: 'card__head' },
        el('div', {}, el('h3', { class: 'card__name' }, c.name), c.plan && el('p', { class: 'card__plan' }, c.plan)),
        el('span', { class: 'pill pill--' + c.status }, c.status_label)),
      c.progress_note && el('p', { class: 'card__update muted' }, c.progress_note),
      update, stats, calls);
  }

  function renderFeed(items) {
    if (!items.length) return el('div', { class: 'glass empty' }, 'Nothing yet. Updates from your services will show up here.');
    return el('ol', { class: 'glass feed' }, ...items.map(function (e) {
      return el('li', {},
        el('div', { class: 'feed__meta' }, el('span', {}, formatWhen(e.occurred_at)), el('span', { class: 'tag' }, e.service_name)),
        el('div', {}, el('p', { class: 'feed__title' }, e.title), e.detail && el('p', { class: 'feed__detail' }, e.detail)));
    }));
  }

  function render(data) {
    app.replaceChildren(
      el('h1', {}, 'Your services'),
      data.services.length
        ? el('section', { class: 'cards' }, ...data.services.map(renderCard))
        : el('div', { class: 'glass empty' }, 'No services yet. Once AE sets one up for you, it will appear here.'),
      el('h2', {}, 'Recent activity'),
      renderFeed(data.activity));
  }

  function load() {
    fetch('/app/data', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 401) { location.href = '/login'; return null; }
        if (!r.ok) throw new Error('bad status');
        return r.json();
      })
      .then(function (data) { if (data) render(data); })
      .catch(function () {
        app.replaceChildren(el('p', { class: 'error', role: 'alert' }, 'We could not load your dashboard. Please refresh in a moment.'));
      });
  }

  load();
  setInterval(load, 60000); // keep the feed fresh without a reload
})();
