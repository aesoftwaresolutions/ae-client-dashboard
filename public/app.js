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

  /** Date only, written out. A plain YYYY-MM-DD is treated as a calendar day, not UTC midnight. */
  function formatDay(value) {
    if (!value) return '';
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    var d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
    if (isNaN(d)) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function money(cents) {
    if (typeof cents !== 'number') return '';
    return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }

  var LABELS = {
    active: 'Active', past_due: 'Past due', canceled: 'Canceled', cancelled: 'Canceled', ended: 'Ended',
    paused: 'Paused', trialing: 'Trial', unpaid: 'Unpaid', paid: 'Paid', open: 'Due', draft: 'Draft',
    void: 'Void', uncollectible: 'Unpaid', refunded: 'Refunded'
  };
  function label(v) {
    if (LABELS[v]) return LABELS[v];
    var t = String(v || '').replace(/[_-]+/g, ' ').trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
  }

  /** Online Presence Management details (profile, reviews, listings, last check). */
  function renderPresence(p) {
    var listings = p.listings
      ? p.listings.accurate + ' of ' + p.listings.checked + ' accurate (' + p.listings.percent + '%)'
      : (p.last_check_at ? 'No accuracy data in the last check' : 'Not checked yet');
    var rows = [
      ['Profile status', p.profile_updated_at ? 'Updated ' + formatDay(p.profile_updated_at) : 'No profile updates yet'],
      ['Listings accuracy', listings],
      ['Listings fixed this month', String(p.listings_fixed_this_month)],
      ['Last check', p.last_check_at ? formatDay(p.last_check_at) : 'Not checked yet']
    ];
    if (p.flagged_this_month) rows.push(['Reviews we flagged this month', String(p.flagged_this_month)]);
    return el('div', { class: 'presence' },
      el('ul', { class: 'stats' },
        el('li', {}, el('strong', {}, String(p.reviews_this_month)), el('span', {}, 'New reviews this month')),
        el('li', {}, el('strong', {}, String(p.replies_this_month)), el('span', {}, 'Replies this month'))),
      el.apply(null, ['dl', { class: 'details' }].concat(rows.map(function (r) {
        return el('div', {}, el('dt', {}, r[0]), el('dd', {}, r[1]));
      }))));
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
    return el('article', { class: 'glass card', 'data-reveal': '' },
      el('div', { class: 'card__head' },
        el('div', {}, el('h3', { class: 'card__name' }, c.name), c.plan && el('p', { class: 'card__plan' }, c.plan)),
        el('span', { class: 'pill pill--' + c.status }, c.status_label)),
      c.progress_note && el('p', { class: 'card__update muted' }, c.progress_note),
      update, stats, c.presence ? renderPresence(c.presence) : null, calls);
  }

  /** Read only billing: subscriptions, next payment, card last 4, invoices. */
  function renderBilling(b) {
    if (!b) return null;
    var subs = b.subscriptions || [];
    var invoices = b.invoices || [];
    var next = b.next_payment
      ? el('p', { class: 'card__update' }, 'Next payment: ',
          el('strong', {}, (b.next_payment.amount_cents != null ? money(b.next_payment.amount_cents) + ' on ' : '') + formatDay(b.next_payment.date)),
          el('span', { class: 'card__when' }, 'For ' + b.next_payment.services.join(', ')))
      : el('p', { class: 'card__update muted' }, 'No upcoming payment on file.');
    var card = b.card
      ? el('p', { class: 'card__update' }, 'Card on file: ' + (b.card.brand ? b.card.brand + ' ' : '') + 'ending in ' + b.card.last4 +
          (b.card.exp_month && b.card.exp_year ? ' (expires ' + String(b.card.exp_month).padStart(2, '0') + '/' + b.card.exp_year + ')' : ''))
      : el('p', { class: 'card__update muted' }, 'No card on file with us yet.');
    function subRow(r) {
      var price = typeof r.price_cents === 'number'
        ? money(r.price_cents) + (r.billing === 'monthly' ? ' a month' : ' one time')
        : (r.billing === 'monthly' ? 'Monthly' : 'One time');
      return el('li', {},
        el('div', {}, el('p', { class: 'feed__title' }, r.service_name),
          el('p', { class: 'feed__detail' }, (r.plan ? r.plan + ' · ' : '') + price +
            (r.active && r.next_billing_at ? ' · next payment ' + formatDay(r.next_billing_at) : '') +
            (!r.active && r.started_at ? ' · started ' + formatDay(r.started_at) : ''))),
        el('span', { class: 'pill pill--' + (r.active ? 'active' : 'ended') }, label(r.status)));
    }
    var active = subs.filter(function (r) { return r.active; });
    var past = subs.filter(function (r) { return !r.active; });
    var invoiceList = invoices.length
      ? el.apply(null, ['ul', { class: 'billing__list' }].concat(invoices.map(function (i) {
          return el('li', {},
            el('div', {}, el('p', { class: 'feed__title' }, money(i.amount_cents)),
              el('p', { class: 'feed__detail' }, formatDay(i.issued_at || i.paid_at) + (i.paid_at ? ' · paid ' + formatDay(i.paid_at) : ''))),
            el('div', { class: 'billing__right' },
              el('span', { class: 'tag' }, label(i.status)),
              i.pdf_url ? el('a', { href: i.pdf_url, target: '_blank', rel: 'noopener noreferrer' }, 'View PDF') : null));
        })))
      : el('p', { class: 'muted' }, 'No invoices yet.');
    return el('div', { class: 'glass pad billing', 'data-reveal': '' },
      next, card,
      el('h3', { class: 'billing__head' }, 'Active subscriptions'),
      active.length ? el.apply(null, ['ul', { class: 'billing__list' }].concat(active.map(subRow))) : el('p', { class: 'muted' }, 'No active subscriptions.'),
      past.length ? el('h3', { class: 'billing__head' }, 'Past subscriptions') : null,
      past.length ? el.apply(null, ['ul', { class: 'billing__list' }].concat(past.map(subRow))) : null,
      el('h3', { class: 'billing__head' }, 'Invoices'),
      invoiceList,
      el('p', { class: 'muted small' }, 'This page is read only. To change a plan or your card, ',
        el('button', { class: 'linklike', type: 'button', 'data-open-support': '' }, 'send us a message'), '.'));
  }

  function renderFeed(items) {
    if (!items.length) return el('div', { class: 'glass empty', 'data-reveal': '' }, 'Nothing yet. Updates from your services will show up here.');
    return el('ol', { class: 'glass feed', 'data-reveal': '' }, ...items.map(function (e) {
      return el('li', {},
        el('div', { class: 'feed__meta' }, el('span', {}, formatWhen(e.occurred_at)), el('span', { class: 'tag' }, e.service_name)),
        el('div', {}, el('p', { class: 'feed__title' }, e.title), e.detail && el('p', { class: 'feed__detail' }, e.detail)));
    }));
  }

  // The live part (cards, feed, billing) is redrawn every minute. The support form lives
  // in the popup outside it, so a half typed message is never wiped by the refresh.
  var live = el('div', {});
  var firstRender = true;

  function render(data) {
    live.replaceChildren(
      el('section', { id: 'services', class: 'section', 'aria-labelledby': 'services-title' },
        el('h1', { id: 'services-title' }, 'Your services'),
        data.services.length
          ? el('div', { class: 'cards', 'data-stagger': '' }, ...data.services.map(renderCard))
          : el('div', { class: 'glass empty', 'data-reveal': '' }, 'No services yet. Once AE sets one up for you, it will appear here.')),
      el('section', { id: 'activity', class: 'section', 'aria-labelledby': 'activity-title' },
        el('h2', { id: 'activity-title' }, 'Recent activity'),
        renderFeed(data.activity)),
      data.billing ? el('section', { id: 'billing', class: 'section', 'aria-labelledby': 'billing-title' },
        el('h2', { id: 'billing-title' }, 'Billing'),
        renderBilling(data.billing)) : null);
    // Fade in on the first draw only; the minute refresh just swaps the data.
    if (window.AEMotion) {
      window.AEMotion.observe(live, firstRender);
      window.AEMotion.relayout();
    } else {
      live.querySelectorAll('[data-reveal]').forEach(function (n) { n.classList.add('is-revealed'); });
    }
    firstRender = false;
  }

  function csrfToken() {
    var input = document.querySelector('input[name="_csrf"]');
    return input ? input.value : '';
  }

  /**
   * Message AE support, in the same glass card popup the website uses for contact.
   * Desktop: centred card. Phones: bottom sheet. Escape, the close button or a click on
   * the dimmed page closes it; focus stays inside while open and returns afterwards.
   * Posts JSON to /app/support with the page CSRF token.
   */
  function buildSupport() {
    var status = el('p', { class: 'muted small pop__status', role: 'status', 'aria-live': 'polite' }, '');
    var subject = el('input', { type: 'text', name: 'subject', maxlength: '120', autocomplete: 'off' });
    var message = el('textarea', { name: 'message', rows: '5', maxlength: '2000', required: 'required' });
    var button = el('button', { class: 'btn', type: 'submit' }, 'Send message');
    var form = el('form', { class: 'form support', novalidate: 'novalidate' },
      el('label', {}, 'Subject (optional)', subject),
      el('label', {}, 'Message', message),
      button, status);
    var closeBtn = el('button', { class: 'pop__close', type: 'button', 'aria-label': 'Close' }, '×');
    var card = el('div', { class: 'pop__card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'support-title', tabindex: '-1' },
      closeBtn,
      el('p', { class: 'brand pop__eyebrow' }, 'AE support'),
      el('h2', { id: 'support-title', class: 'pop__title' }, 'Message AE'),
      el('p', { class: 'pop__lead' }, 'Have a question about a service or your bill? Send us a message here and our team will see it.'),
      form);
    var pop = el('div', { class: 'pop', id: 'support-pop', hidden: 'hidden' }, card);
    var lastFocus = null;
    var closeTimer = 0;
    var calm = !!(window.AEMotion && window.AEMotion.calm);

    function isOpen() { return !pop.hidden && pop.classList.contains('is-open'); }
    function open(from) {
      clearTimeout(closeTimer);
      lastFocus = from || document.activeElement;
      pop.hidden = false;
      document.documentElement.classList.add('ae-pop-lock');
      void pop.offsetWidth; // commit display before the transition
      pop.classList.add('is-open');
      setTimeout(function () { (message.value ? message : subject).focus(); }, calm ? 0 : 60);
    }
    function close() {
      if (pop.hidden) return;
      pop.classList.remove('is-open');
      document.documentElement.classList.remove('ae-pop-lock');
      closeTimer = setTimeout(function () { pop.hidden = true; }, calm ? 0 : 220);
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
    closeBtn.addEventListener('click', close);
    pop.addEventListener('click', function (ev) { if (ev.target === pop) close(); });
    document.addEventListener('keydown', function (ev) {
      if (!isOpen()) return;
      if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
      if (ev.key !== 'Tab') return;
      var items = Array.prototype.filter.call(card.querySelectorAll('button, input, textarea, a[href]'), function (n) { return !n.disabled; });
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
      else if (!card.contains(document.activeElement)) { ev.preventDefault(); first.focus(); }
    });
    // Any [data-open-support] control opens it (header button, billing note).
    document.addEventListener('click', function (ev) {
      var t = ev.target.closest && ev.target.closest('[data-open-support]');
      if (t) { ev.preventDefault(); open(t); }
    });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var text = message.value.trim();
      if (!text) { status.className = 'error pop__status'; status.textContent = 'Please write a message.'; message.focus(); return; }
      button.disabled = true;
      status.className = 'muted small pop__status';
      status.textContent = 'Sending…';
      fetch('/app/support', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ _csrf: csrfToken(), subject: subject.value.trim(), message: text })
      })
        .then(function (r) {
          if (r.status === 401) { location.href = '/login'; return null; }
          return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, data: d }; });
        })
        .then(function (res) {
          if (!res) return;
          if (!res.ok) throw new Error((res.data && res.data.error) || 'We could not send that. Please try again.');
          subject.value = ''; message.value = '';
          status.className = 'notice pop__status';
          status.textContent = 'Thanks. Your message is with our team and we will reply by email.';
        })
        .catch(function (err) {
          status.className = 'error pop__status';
          status.textContent = err.message || 'We could not send that. Please try again.';
        })
        .then(function () { button.disabled = false; });
    });
    document.body.appendChild(pop);
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
        live.replaceChildren(el('p', { class: 'error', role: 'alert' }, 'We could not load your dashboard. Please refresh in a moment.'));
      });
  }

  app.replaceChildren(live);
  live.replaceChildren(el('p', { class: 'muted', id: 'loading' }, 'Loading your dashboard…'));
  buildSupport();
  load();
  setInterval(load, 60000); // keep the feed fresh without a reload
})();
