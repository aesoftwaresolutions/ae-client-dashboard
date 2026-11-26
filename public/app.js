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
          var btn = el('button', { class: 'btn btn--ghost', type: 'button' },
            c.has_transcript ? 'View transcript' : 'View call');
          btn.addEventListener('click', function () { openCallDetail(c.telnyx_conversation_id, btn); });
          return el('li', {},
            el('div', { class: 'feed__meta' }, el('span', {}, formatWhen(c.occurred_at)), el('span', { class: 'tag' }, tag)),
            el('div', {}, el('p', { class: 'feed__title' }, c.caller_display + (dur ? ' · ' + dur : '')),
              c.summary_text && el('p', { class: 'feed__detail' }, c.summary_text)),
            btn);
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

  /** Business profile. The single home for the client's business info, plus
   * their logo. The form lives outside the live refresh area so a half typed
   * detail is never wiped. Fields are filled once from GET /app/profile;
   * later loads never overwrite what the client has typed. The logo is
   * uploaded as a file (multipart) and shown as a preview when one exists. */
  var profileForm = null;
  var profileDirty = false;
  var profilePopulated = false;
  var profileStatus = null;
  var profileFields = {};
  var profileLogoImg = null;
  var profileLogoNote = null;
  var profileLogoInput = null;
  var profileLogoStatus = null;

  function renderProfile() {
    profileStatus = el('p', { class: 'muted small', role: 'status', 'aria-live': 'polite' }, '');
    function field(name, labelText, input, hint) {
      return el('label', {}, labelText, input, hint ? el('span', { class: 'muted small' }, hint) : null);
    }
    profileFields.business_name = el('input', { type: 'text', name: 'business_name', maxlength: '200', autocomplete: 'organization', required: 'required' });
    profileFields.contact_name = el('input', { type: 'text', name: 'contact_name', maxlength: '120', autocomplete: 'name' });
    profileFields.email = el('input', { type: 'email', name: 'email', maxlength: '254', autocomplete: 'email' });
    profileFields.phone = el('input', { type: 'tel', name: 'phone', maxlength: '40', autocomplete: 'tel' });
    profileFields.website = el('input', { type: 'text', name: 'website', maxlength: '300', autocomplete: 'url', placeholder: 'www.example.com' });
    profileFields.address_street = el('input', { type: 'text', name: 'address_street', maxlength: '200', autocomplete: 'address-line1' });
    profileFields.address_city = el('input', { type: 'text', name: 'address_city', maxlength: '120', autocomplete: 'address-level2' });
    profileFields.address_state = el('input', { type: 'text', name: 'address_state', maxlength: '60', autocomplete: 'address-level1' });
    profileFields.address_zip = el('input', { type: 'text', name: 'address_zip', maxlength: '20', autocomplete: 'postal-code' });
    profileFields.business_description = el('textarea', { name: 'business_description', rows: '3', maxlength: '1000' });
    profileFields.services_offered = el('textarea', { name: 'services_offered', rows: '3', maxlength: '1000' });
    profileFields.business_hours = el('input', { type: 'text', name: 'business_hours', maxlength: '200', autocomplete: 'off' });
    var save = el('button', { class: 'btn', type: 'submit' }, 'Save business profile');
    profileForm = el('form', { class: 'form support', novalidate: 'novalidate' },
      field('business_name', 'Business name', profileFields.business_name),
      field('contact_name', 'Contact name', profileFields.contact_name),
      field('email', 'Email', profileFields.email),
      field('phone', 'Phone', profileFields.phone),
      field('website', 'Website', profileFields.website, 'Your website address, for example www.example.com.'),
      el('div', { class: 'form__row' },
        field('address_street', 'Street address', profileFields.address_street)),
      el('div', { class: 'form__row' },
        field('address_city', 'City', profileFields.address_city),
        field('address_state', 'State', profileFields.address_state),
        field('address_zip', 'ZIP', profileFields.address_zip)),
      field('business_description', 'What your business does', profileFields.business_description, 'A sentence or two, in your own words.'),
      field('services_offered', 'Services you offer', profileFields.services_offered, 'List them separated by commas, or one per line.'),
      field('business_hours', 'Business hours', profileFields.business_hours, 'For example: Monday to Friday, 9am to 5pm.'),
      save, profileStatus);
    profileForm.addEventListener('input', function () { profileDirty = true; });
    profileForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var name = profileFields.business_name.value.trim();
      if (!name) { profileStatus.className = 'error'; profileStatus.textContent = 'Please enter your business name.'; return; }
      save.disabled = true;
      profileStatus.className = 'muted small';
      profileStatus.textContent = 'Saving…';
      var body = { _csrf: csrfToken() };
      Object.keys(profileFields).forEach(function (k) { body[k] = profileFields[k].value.trim(); });
      fetch('/app/profile', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body)
      })
        .then(function (r) {
          if (r.status === 401) { location.href = '/login'; return null; }
          return r.json().then(function (d) { return { ok: r.ok, data: d }; });
        })
        .then(function (res) {
          if (!res) return;
          if (!res.ok) throw new Error((res.data && res.data.error) || 'We could not save that. Please try again.');
          profileDirty = false;
          profilePopulated = true;
          profileStatus.className = 'notice';
          profileStatus.textContent = 'Saved. Your business details are up to date.';
          if (res.data.profile) fillProfileForm(res.data.profile);
        })
        .catch(function (err) {
          profileStatus.className = 'error';
          profileStatus.textContent = err.message || 'We could not save that. Please try again.';
        })
        .then(function () { save.disabled = false; });
    });

    // Logo: a preview when one exists, a file picker, and upload / remove.
    profileLogoImg = el('img', { class: 'profile__logo', alt: 'Your business logo', style: 'display: none' });
    profileLogoNote = el('p', { class: 'muted small' }, 'No logo yet. Upload a PNG, JPG, WebP or GIF under 2 MB.');
    profileLogoInput = el('input', { type: 'file', name: 'logo', accept: 'image/png,image/jpeg,image/webp,image/gif' });
    profileLogoStatus = el('p', { class: 'muted small', role: 'status', 'aria-live': 'polite' }, '');
    var upload = el('button', { class: 'btn btn--ghost', type: 'submit' }, 'Upload logo');
    var remove = el('button', { class: 'btn btn--ghost', type: 'button' }, 'Remove logo');
    var logoForm = el('form', { class: 'form support', novalidate: 'novalidate' },
      profileLogoImg, profileLogoNote, profileLogoInput, upload, remove, profileLogoStatus);
    logoForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var file = profileLogoInput.files && profileLogoInput.files[0];
      if (!file) { profileLogoStatus.className = 'error'; profileLogoStatus.textContent = 'Choose an image file first.'; return; }
      var data = new FormData();
      data.append('_csrf', csrfToken());
      data.append('logo', file);
      upload.disabled = true;
      profileLogoStatus.className = 'muted small';
      profileLogoStatus.textContent = 'Uploading…';
      fetch('/app/profile/logo', { method: 'POST', credentials: 'same-origin', body: data })
        .then(function (r) {
          if (r.status === 401) { location.href = '/login'; return null; }
          return r.json().then(function (d) { return { ok: r.ok, data: d }; });
        })
        .then(function (res) {
          if (!res) return;
          if (!res.ok) throw new Error((res.data && res.data.error) || 'We could not upload that. Please try again.');
          profileLogoInput.value = '';
          profileLogoStatus.className = 'notice';
          profileLogoStatus.textContent = 'Logo uploaded.';
          if (res.data.profile) fillProfileForm(res.data.profile);
        })
        .catch(function (err) {
          profileLogoStatus.className = 'error';
          profileLogoStatus.textContent = err.message || 'We could not upload that. Please try again.';
        })
        .then(function () { upload.disabled = false; });
    });
    remove.addEventListener('click', function () {
      remove.disabled = true;
      profileLogoStatus.className = 'muted small';
      profileLogoStatus.textContent = 'Removing…';
      fetch('/app/profile/logo/remove', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ _csrf: csrfToken() })
      })
        .then(function (r) {
          if (r.status === 401) { location.href = '/login'; return null; }
          return r.json().then(function (d) { return { ok: r.ok, data: d }; });
        })
        .then(function (res) {
          if (!res) return;
          if (!res.ok) throw new Error((res.data && res.data.error) || 'We could not remove that. Please try again.');
          profileLogoStatus.className = 'notice';
          profileLogoStatus.textContent = 'Logo removed.';
          if (res.data.profile) fillProfileForm(res.data.profile);
        })
        .catch(function (err) {
          profileLogoStatus.className = 'error';
          profileLogoStatus.textContent = err.message || 'We could not remove that. Please try again.';
        })
        .then(function () { remove.disabled = false; });
    });

    var section = el('section', { class: 'glass pad support__box', 'aria-labelledby': 'profile-title' },
      el('h2', { id: 'profile-title', class: 'support__title' }, 'Your business profile'),
      el('p', { class: 'muted' }, 'This is the business info your clients and your AI receptionist use. Keep it up to date and it will show up everywhere it is needed.'),
      el('h3', { class: 'card__name' }, 'Logo'),
      logoForm,
      el('h3', { class: 'card__name' }, 'Business details'),
      profileForm);
    section.id = 'business-profile';
    return section;
  }

  function fillProfileForm(p) {
    Object.keys(profileFields).forEach(function (k) { profileFields[k].value = p[k] || ''; });
    if (p.has_logo && p.logo_url) {
      profileLogoImg.src = p.logo_url + (p.updated_at ? '?v=' + encodeURIComponent(p.updated_at) : '');
      profileLogoImg.style.display = '';
      profileLogoNote.textContent = 'Your current logo. Upload a new one to replace it.';
    } else {
      profileLogoImg.style.display = 'none';
      profileLogoImg.removeAttribute('src');
      profileLogoNote.textContent = 'No logo yet. Upload a PNG, JPG, WebP or GIF under 2 MB.';
    }
  }

  function loadProfile() {
    if (profileDirty || profilePopulated) return;
    fetch('/app/profile', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.profile || profileDirty) return;
        fillProfileForm(d.profile);
        profilePopulated = true;
      })
      .catch(function () { /* the form still opens; the client fills it in */ });
  }

  /** Message AE support. Posts JSON to /app/support with the page CSRF token. */
  function renderSupport() {    var status = el('p', { class: 'muted small', role: 'status', 'aria-live': 'polite' }, '');
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

  /** AI Agent settings. The client tailors their Front Desk agent to their
   * business after buying a subscription. The form lives outside the live
   * refresh area so a half typed setting is never wiped. Fields are filled
   * once from /app/data (saved settings) or, when none exist yet, from a live
   * read of the Telnyx assistant; later loads never overwrite what the
   * client has typed. */
  var agentForm = null;
  var agentDirty = false;
  var agentPopulated = false;
  var agentStatus = null;
  var agentFields = {};

  function renderAgentSettings() {
    agentStatus = el('p', { class: 'muted small', role: 'status', 'aria-live': 'polite' }, '');
    function field(name, labelText, input, hint) {
      return el('label', {}, labelText, input, hint ? el('span', { class: 'muted small' }, hint) : null);
    }
    agentFields.name = el('input', { type: 'text', name: 'agent_name', maxlength: '80', autocomplete: 'off', required: 'required' });
    agentFields.greeting = el('input', { type: 'text', name: 'greeting', maxlength: '500', autocomplete: 'off', required: 'required' });
    agentFields.description = el('textarea', { name: 'business_description', rows: '3', maxlength: '1000' });
    agentFields.services = el('textarea', { name: 'services_offered', rows: '3', maxlength: '1000' });
    agentFields.hours = el('input', { type: 'text', name: 'business_hours', maxlength: '200', autocomplete: 'off' });
    agentFields.transfer = el('p', { class: 'card__update' }, '');
    agentFields.instructions = el('textarea', { name: 'instructions', rows: '6', maxlength: '20000' });
    agentFields.useCustom = el('input', { type: 'checkbox', name: 'use_custom_instructions' });
    var save = el('button', { class: 'btn', type: 'submit' }, 'Save agent settings');
    agentForm = el('form', { class: 'form support', novalidate: 'novalidate' },
      field('agent_name', 'Agent name', agentFields.name, 'What callers hear as the agent\u2019s name.'),
      field('greeting', 'Greeting', agentFields.greeting, 'The first thing your agent says when it answers.'),
      field('business_description', 'What your business does', agentFields.description, 'A sentence or two, in your own words.'),
      field('services_offered', 'Services you offer', agentFields.services, 'List them separated by commas, or one per line.'),
      field('business_hours', 'Business hours', agentFields.hours, 'For example: Monday to Friday, 9am to 5pm.'),
      el('label', {}, 'Urgent calls go to', agentFields.transfer, el('span', { class: 'muted small' }, 'To change this number, send us a message below.')),
      field('instructions', 'Agent instructions', agentFields.instructions,
        'Leave this blank and the instructions are built from the details above. Or write your own and tick the box below.'),
      save, agentStatus);
    // The checkbox label sits on its own row.
    var customLabel = el('label', { class: 'muted small' }, agentFields.useCustom, ' Use my instructions exactly as written');
    agentForm.insertBefore(customLabel, save);
    agentForm.addEventListener('input', function () { agentDirty = true; });
    agentForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var name = agentFields.name.value.trim();
      var greeting = agentFields.greeting.value.trim();
      if (!name) { agentStatus.className = 'error'; agentStatus.textContent = 'Give your agent a name.'; return; }
      if (!greeting) { agentStatus.className = 'error'; agentStatus.textContent = 'Write a greeting for your agent.'; return; }
      save.disabled = true;
      agentStatus.className = 'muted small';
      agentStatus.textContent = 'Saving…';
      fetch('/app/agent-settings', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          _csrf: csrfToken(),
          agent_name: name,
          greeting: greeting,
          business_description: agentFields.description.value.trim(),
          services_offered: agentFields.services.value.trim(),
          business_hours: agentFields.hours.value.trim(),
          instructions: agentFields.instructions.value.trim(),
          use_custom_instructions: agentFields.useCustom.checked
        })
      })
        .then(function (r) {
          if (r.status === 401) { location.href = '/login'; return null; }
          return r.json().then(function (d) { return { ok: r.ok, data: d }; });
        })
        .then(function (res) {
          if (!res) return;
          if (!res.ok) throw new Error((res.data && res.data.error) || 'We could not save that. Please try again.');
          agentDirty = false;
          agentPopulated = true;
          agentStatus.className = 'notice';
          agentStatus.textContent = 'Saved. Your agent now answers with these settings.';
          load();
        })
        .catch(function (err) {
          agentStatus.className = 'error';
          agentStatus.textContent = err.message || 'We could not save that. Please try again.';
        })
        .then(function () { save.disabled = false; });
    });
    var section = el('section', { class: 'glass pad support__box', 'aria-labelledby': 'agent-title', style: 'display: none' },
      el('h2', { id: 'agent-title', class: 'support__title' }, 'Your AI receptionist'),
      el('p', { class: 'muted' }, 'This is the agent that answers your calls. Change the details below and it will answer in your business\u2019s voice.'),
      agentForm);
    section.id = 'agent-settings';
    return section;
  }

  function fillAgentForm(s) {
    agentFields.name.value = s.agent_name || '';
    agentFields.greeting.value = s.greeting || '';
    agentFields.description.value = s.business_description || '';
    agentFields.services.value = s.services_offered || '';
    agentFields.hours.value = s.business_hours || '';
    agentFields.instructions.value = s.instructions || '';
    agentFields.useCustom.checked = !!s.custom_instructions;
  }

  function populateAgentSettings(data) {
    var section = document.getElementById('agent-settings');
    if (!section || !data.telnyx_agent) return;
    section.style.display = '';
    agentFields.transfer.textContent = data.telnyx_agent.transfer_phone_number || 'Not set';
    if (agentPopulated || agentDirty) return;
    if (data.agent_settings) {
      fillAgentForm(data.agent_settings);
      agentPopulated = true;
      return;
    }
    // No saved settings yet: pre-fill from the live assistant.
    fetch('/app/agent-settings', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.settings || agentDirty) return;
        fillAgentForm(d.settings);
        agentPopulated = true;
      })
      .catch(function () { /* the form still opens; the client fills it in */ });
  }

  /** Call-summary text notifications. The client chooses whether to get a
   * text after each call, which number to text, and whether to text every
   * call or urgent calls only. The form lives outside the live refresh area
   * so a half typed setting is never wiped. Fields are filled once from
   * GET /app/notification-settings; later loads never overwrite what the
   * client has typed. */
  var notifyForm = null;
  var notifyDirty = false;
  var notifyPopulated = false;
  var notifyStatus = null;
  var notifyFields = {};

  function renderNotifications() {
    notifyStatus = el('p', { class: 'muted small', role: 'status', 'aria-live': 'polite' }, '');
    notifyFields.enabled = el('input', { type: 'checkbox', name: 'sms_summary_enabled' });
    notifyFields.number = el('input', { type: 'tel', name: 'sms_number', maxlength: '40', autocomplete: 'tel' });
    notifyFields.urgentOnly = el('input', { type: 'checkbox', name: 'sms_urgent_only' });
    var save = el('button', { class: 'btn', type: 'submit' }, 'Save notification settings');
    notifyForm = el('form', { class: 'form support', novalidate: 'novalidate' },
      el('label', { class: 'muted small' }, notifyFields.enabled, ' Text me a summary after each call'),
      el('label', {}, 'Number to text', notifyFields.number, el('span', { class: 'muted small' }, 'The mobile number that gets the summary.')),
      el('label', { class: 'muted small' }, notifyFields.urgentOnly, ' Only text me about urgent calls'),
      save, notifyStatus);
    notifyForm.addEventListener('input', function () { notifyDirty = true; });
    notifyForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (notifyFields.enabled.checked && !notifyFields.number.value.trim()) {
        notifyStatus.className = 'error';
        notifyStatus.textContent = 'Please enter the phone number to text the summary to.';
        return;
      }
      save.disabled = true;
      notifyStatus.className = 'muted small';
      notifyStatus.textContent = 'Saving…';
      fetch('/app/notification-settings', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          _csrf: csrfToken(),
          sms_summary_enabled: notifyFields.enabled.checked,
          sms_number: notifyFields.number.value.trim(),
          sms_urgent_only: notifyFields.urgentOnly.checked
        })
      })
        .then(function (r) {
          if (r.status === 401) { location.href = '/login'; return null; }
          return r.json().then(function (d) { return { ok: r.ok, data: d }; });
        })
        .then(function (res) {
          if (!res) return;
          if (!res.ok) throw new Error((res.data && res.data.error) || 'We could not save that. Please try again.');
          notifyDirty = false;
          notifyPopulated = true;
          notifyStatus.className = 'notice';
          notifyStatus.textContent = 'Saved. Call summaries will be texted as you chose.';
        })
        .catch(function (err) {
          notifyStatus.className = 'error';
          notifyStatus.textContent = err.message || 'We could not save that. Please try again.';
        })
        .then(function () { save.disabled = false; });
    });
    var section = el('section', { class: 'glass pad support__box', 'aria-labelledby': 'notify-title' },
      el('h2', { id: 'notify-title', class: 'support__title' }, 'Text me call summaries'),
      el('p', { class: 'muted' }, 'Get a short text after a call ends, with who called and what they wanted. It comes from your Front Desk number.'),
      notifyForm);
    section.id = 'notification-settings';
    return section;
  }

  function fillNotificationForm(s) {
    notifyFields.enabled.checked = !!s.sms_summary_enabled;
    notifyFields.number.value = s.sms_number || '';
    notifyFields.urgentOnly.checked = !!s.sms_urgent_only;
  }

  function loadNotifications() {
    if (notifyPopulated || notifyDirty) return;
    fetch('/app/notification-settings', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.settings || notifyDirty) return;
        fillNotificationForm(d.settings);
        notifyPopulated = true;
      })
      .catch(function () { /* the form still opens; the client fills it in */ });
  }

  /** One call's transcript + recording, in a glass card popup (modal).
   * Lives outside the live refresh area so opening a transcript is never
   * wiped by the 60-second redraw. The transcript is the words actually
   * spoken, caller and agent turns in order, so the customer can check
   * exactly what was said. The recording plays from a fresh Telnyx link
   * each time the call is opened. Closes on the Close button, a click on
   * the backdrop, or Escape. */
  var callDetailBackdrop = null;
  var callDetailBody = null;
  var callDetailOpener = null;

  function renderCallDetailSection() {
    callDetailBody = el('div', {});
    var close = el('button', { class: 'btn btn--ghost modal-card__close', type: 'button', 'aria-label': 'Close call details' }, 'Close');
    close.addEventListener('click', function () { closeCallDetail(); });
    var card = el('section', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'call-title' },
      el('div', { class: 'modal-card__head' },
        el('h2', { id: 'call-title', class: 'support__title' }, 'Call transcript'),
        close),
      callDetailBody);
    card.id = 'call-detail';
    callDetailBackdrop = el('div', { class: 'modal-backdrop', style: 'display: none' }, card);
    callDetailBackdrop.addEventListener('click', function (e) {
      if (e.target === callDetailBackdrop) closeCallDetail();
    });
    return callDetailBackdrop;
  }

  function closeCallDetail() {
    if (callDetailBackdrop) callDetailBackdrop.style.display = 'none';
    if (callDetailBody) callDetailBody.replaceChildren();
    document.body.style.overflow = '';
    if (callDetailOpener && callDetailOpener.focus) callDetailOpener.focus();
    callDetailOpener = null;
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && callDetailBackdrop && callDetailBackdrop.style.display !== 'none') closeCallDetail();
  });

  function openCallDetail(conversationId, opener) {
    if (!callDetailBackdrop || !callDetailBody) return;
    callDetailOpener = opener || null;
    callDetailBackdrop.style.display = '';
    document.body.style.overflow = 'hidden';
    callDetailBody.replaceChildren(el('p', { class: 'muted' }, 'Loading the transcript…'));
    var closeBtn = callDetailBackdrop.querySelector('.modal-card__close');
    if (closeBtn) closeBtn.focus();
    fetch('/app/calls/' + encodeURIComponent(conversationId), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 401) { location.href = '/login'; return null; }
        return r.json().then(function (d) { return { ok: r.ok, data: d }; });
      })
      .then(function (res) {
        if (!res) return;
        if (!res.ok) throw new Error((res.data && res.data.error) || 'We could not open that call. Please try again.');
        renderCallDetail(res.data);
      })
      .catch(function (err) {
        callDetailBody.replaceChildren(el('p', { class: 'error', role: 'alert' }, err.message || 'We could not open that call. Please try again.'));
      });
  }

  function renderCallDetail(data) {
    var c = data.call || {};
    var dur = c.duration_secs ? Math.round(c.duration_secs / 60) + ' min' : '';
    var head = el('div', {},
      el('p', { class: 'card__update' }, c.caller_display + (dur ? ' · ' + dur : '') +
        (c.transferred ? ' · Transferred' : '') + ' · ' + formatWhen(c.occurred_at)),
      c.summary_text && el('p', { class: 'feed__detail' }, c.summary_text));
    var recording = null;
    if (data.recording && data.recording.url && c.telnyx_conversation_id) {
      // The audio streams through the dashboard's own /audio endpoint, not
      // the presigned S3 link. The S3 link would not play in the browser's
      // audio element (it stayed at 0:00, "Unable to play media"), so the
      // server fetches the mp3 and serves it from this origin instead.
      var audio = el('audio', { controls: 'controls', src: '/app/calls/' + encodeURIComponent(c.telnyx_conversation_id) + '/audio', preload: 'metadata' });
      recording = el('div', {},
        el('p', { class: 'card__update' }, 'Hear the call'),
        audio,
        el('p', { class: 'muted small' }, 'The recording plays from a fresh link each time you open the call.'));
    } else {
      recording = el('p', { class: 'muted small' }, 'No recording for this call.');
    }
    var transcript = null;
    if (c.transcript && c.transcript.length) {
      transcript = el('ol', { class: 'feed' }, ...c.transcript.map(function (t) {
        return el('li', {},
          el('div', { class: 'feed__meta' }, el('span', { class: 'tag' }, t.role === 'caller' ? 'Caller' : 'Agent')),
          el('p', { class: 'feed__detail' }, t.text));
      }));
    } else {
      transcript = el('p', { class: 'muted' },
        'No transcript yet for this call. It usually appears a few minutes after the call ends, once the call is processed. Please check back shortly.');
    }
    callDetailBody.replaceChildren(head, recording, transcript);
  }

  function load() {
    fetch('/app/data', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 401) { location.href = '/login'; return null; }
        if (!r.ok) throw new Error('bad status');
        return r.json();
      })
      .then(function (data) { if (data) { render(data); populateAgentSettings(data); loadProfile(); loadNotifications(); } })
      .catch(function () {
        live.replaceChildren(el('p', { class: 'error', role: 'alert' }, 'We could not load your dashboard. Please refresh in a moment.'));
      });
  }

  app.replaceChildren(live, renderProfile(), renderSupport(), renderAgentSettings(), renderNotifications(), renderCallDetailSection());
  live.replaceChildren(el('p', { class: 'muted', id: 'loading' }, 'Loading your dashboard…'));
  load();
  setInterval(load, 60000); // keep the feed fresh without a reload
})();
