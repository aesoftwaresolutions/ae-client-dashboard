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
    return el('article', { class: 'glass card' },
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
    return el('section', { class: 'glass pad billing', 'aria-label': 'Billing' },
      next, card,
      el('h3', { class: 'billing__head' }, 'Active subscriptions'),
      active.length ? el.apply(null, ['ul', { class: 'billing__list' }].concat(active.map(subRow))) : el('p', { class: 'muted' }, 'No active subscriptions.'),
      past.length ? el('h3', { class: 'billing__head' }, 'Past subscriptions') : null,
      past.length ? el.apply(null, ['ul', { class: 'billing__list' }].concat(past.map(subRow))) : null,
      el('h3', { class: 'billing__head' }, 'Invoices'),
      invoiceList,
      el('p', { class: 'muted small' }, 'This page is read only. To change a plan or your card, send us a message below.'));
  }

  function renderFeed(items) {
    if (!items.length) return el('div', { class: 'glass empty' }, 'Nothing yet. Updates from your services will show up here.');
    return el('ol', { class: 'glass feed' }, ...items.map(function (e) {
      return el('li', {},
        el('div', { class: 'feed__meta' }, el('span', {}, formatWhen(e.occurred_at)), el('span', { class: 'tag' }, e.service_name)),
        el('div', {}, el('p', { class: 'feed__title' }, e.title), e.detail && el('p', { class: 'feed__detail' }, e.detail)));
    }));
  }

  /** Front Desk calls: the agent, this cycle's usage, and the call history. */
  function renderCalls(data) {
    var agent = data.telnyx_agent;
    var calls = data.calls || [];
    var usage = data.calls_usage;
    if (!agent && !calls.length) return null;
    var agentLine = agent
      ? el('p', { class: 'card__update' }, 'Answered by ' + (agent.name || 'Front Desk') +
          (agent.model ? ' · ' + agent.model : '') +
          (agent.telnyx_phone_number ? ' · ' + agent.telnyx_phone_number : ''))
      : null;
    var usageLine = usage
      ? el('p', { class: 'card__update muted' }, usage.calls + ' call' + (usage.calls === 1 ? '' : 's') +
          ' · ' + usage.minutes + ' minute' + (usage.minutes === 1 ? '' : 's') + ' this billing cycle')
      : null;
    var list = calls.length
      ? el('ol', { class: 'glass feed' }, ...calls.map(function (c) {
          var dur = c.duration_secs ? Math.round(c.duration_secs / 60) + ' min' : '';
          var tag = c.transferred ? 'Transferred' : label(c.outcome);
          return el('li', {},
            el('div', { class: 'feed__meta' }, el('span', {}, formatWhen(c.occurred_at)), el('span', { class: 'tag' }, tag)),
            el('div', {}, el('p', { class: 'feed__title' }, c.caller_display + (dur ? ' · ' + dur : '')),
              c.summary_text && el('p', { class: 'feed__detail' }, c.summary_text)));
        }))
      : el('div', { class: 'glass empty' }, 'No calls yet.');
    return el('section', { 'aria-label': 'Calls' },
      el('h2', {}, 'Calls'), agentLine, usageLine, list);
  }

  // The live part (cards, feed, billing) is redrawn every minute. The support form
  // lives outside it so a half typed message is never wiped by the refresh.
  var live = el('div', {});

  function render(data) {
    live.replaceChildren(
      el('h1', {}, 'Your services'),
      data.services.length
        ? el('section', { class: 'cards' }, ...data.services.map(renderCard))
        : el('div', { class: 'glass empty' }, 'No services yet. Once AE sets one up for you, it will appear here.'),
      renderCalls(data),
      el('h2', {}, 'Recent activity'),
      renderFeed(data.activity),
      data.billing ? el('h2', {}, 'Billing') : null,
      renderBilling(data.billing));
  }

  function csrfToken() {
    var input = document.querySelector('input[name="_csrf"]');
    return input ? input.value : '';
  }

  /** Message AE support. Posts JSON to /app/support with the page CSRF token. */
  function renderSupport() {
    var status = el('p', { class: 'muted small', role: 'status', 'aria-live': 'polite' }, '');
    var subject = el('input', { type: 'text', name: 'subject', maxlength: '120', autocomplete: 'off' });
    var message = el('textarea', { name: 'message', rows: '5', maxlength: '2000', required: 'required' });
    var button = el('button', { class: 'btn', type: 'submit' }, 'Send message');
    var form = el('form', { class: 'form support', novalidate: 'novalidate' },
      el('label', {}, 'Subject (optional)', subject),
      el('label', {}, 'Message', message),
      button, status);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var text = message.value.trim();
      if (!text) { status.className = 'error'; status.textContent = 'Please write a message.'; return; }
      button.disabled = true;
      status.className = 'muted small';
      status.textContent = 'Sending…';
      fetch('/app/support', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ _csrf: csrfToken(), subject: subject.value.trim(), message: text })
      })
        .then(function (r) {
          if (r.status === 401) { location.href = '/login'; return null; }
          return r.json().then(function (d) { return { ok: r.ok, data: d }; });
        })
        .then(function (res) {
          if (!res) return;
          if (!res.ok) throw new Error((res.data && res.data.error) || 'We could not send that. Please try again.');
          subject.value = ''; message.value = '';
          status.className = 'notice';
          status.textContent = 'Thanks. Your message is with our team and we will reply by email.';
        })
        .catch(function (err) {
          status.className = 'error';
          status.textContent = err.message || 'We could not send that. Please try again.';
        })
        .then(function () { button.disabled = false; });
    });
    return el('section', { class: 'glass pad support__box', 'aria-labelledby': 'support-title' },
      el('h2', { id: 'support-title', class: 'support__title' }, 'Message AE support'),
      el('p', { class: 'muted' }, 'Have a question about a service or your bill? Send us a message here and our team will see it.'),
      form);
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

  app.replaceChildren(live, renderSupport());
  live.replaceChildren(el('p', { class: 'muted', id: 'loading' }, 'Loading your dashboard…'));
  load();
  setInterval(load, 60000); // keep the feed fresh without a reload
})();
