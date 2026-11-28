// Client | Internal mode switch and the Internal-mode views. Plain JavaScript, no framework.
// Client mode is the default and this script then does nothing else: the client pages,
// login, session and the client API calls are untouched. Internal data lives on the AE MacBook and is
// fetched here, in the viewer's browser, over the tailnet. The dashboard server never sees it.
// Text is always set with textContent. The agent key lives in sessionStorage only.
(function () {
  'use strict';
  var sw = document.querySelector('.modeswitch');
  if (!sw) return;
  var BASE = (sw.getAttribute('data-internal-base') || '').replace(/\/$/, '');
  var MODE_KEY = 'ae_portal_mode';      // localStorage: 'client' (default) | 'internal'
  var KEY_NAME = 'ae_internal_agent_key'; // sessionStorage ONLY, never localStorage
  var PROBE_MS = 3000;

  function store(kind) { try { return window[kind]; } catch (e) { return null; } }
  function getMode() { var s = store('localStorage'); try { return s && s.getItem(MODE_KEY) === 'internal' ? 'internal' : 'client'; } catch (e) { return 'client'; } }
  function setMode(m) { var s = store('localStorage'); try { if (s) s.setItem(MODE_KEY, m); } catch (e) { /* private mode: mode just won't persist */ } }
  function getKey() { var s = store('sessionStorage'); try { return (s && s.getItem(KEY_NAME)) || ''; } catch (e) { return ''; } }
  function setKey(k) { var s = store('sessionStorage'); try { if (s) s.setItem(KEY_NAME, k); } catch (e) { /* ignore */ } }
  function clearKey() { var s = store('sessionStorage'); try { if (s) s.removeItem(KEY_NAME); } catch (e) { /* ignore */ } }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    function add(c) {
      if (Array.isArray(c)) { c.forEach(add); return; }
      if (!c && c !== '') return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    for (var i = 2; i < arguments.length; i++) add(arguments[i]);
    return node;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function label(v) {
    var t = String(v || '').replace(/[_-]+/g, ' ').trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
  }
  function pill(text, kind) { return el('span', { 'class': 'pill pill--' + (kind || 'active') }, text); }

  // ---- Page shell: hide the client content while Internal is on ----
  var root = el('main', { 'class': 'wrap', id: 'internal', hidden: '', 'aria-live': 'polite' });
  var host = document.querySelector('main.wrap');
  if (host && host.parentNode) host.parentNode.insertBefore(root, host.nextSibling); else document.body.appendChild(root);
  function clientMains() { return Array.prototype.filter.call(document.querySelectorAll('main.wrap'), function (m) { return m !== root; }); }

  var token = 0; // bumped on every mode change or reload so stale async work is dropped
  var cache = {};
  var tab = 'goals';

  function paintSwitch(mode) {
    Array.prototype.forEach.call(sw.querySelectorAll('.modeswitch__btn'), function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-mode') === mode ? 'true' : 'false');
    });
  }

  var current = 'client';
  function apply(mode) {
    current = mode;
    token++;
    paintSwitch(mode);
    if (mode === 'internal') {
      clientMains().forEach(function (m) { m.hidden = true; });
      root.hidden = false;
      enter();
    } else {
      root.hidden = true;
      clear(root);
      clientMains().forEach(function (m) { m.hidden = false; });
    }
  }

  Array.prototype.forEach.call(sw.querySelectorAll('.modeswitch__btn'), function (b) {
    b.addEventListener('click', function () {
      var m = b.getAttribute('data-mode') === 'internal' ? 'internal' : 'client';
      if (m === current) return;
      setMode(m);
      apply(m);
    });
  });

  // ---- Internal mode flow: probe, key, data ----
  function status(text) { clear(root); root.appendChild(el('p', { 'class': 'muted' }, text)); }

  function enter() {
    var my = token;
    status('Checking tailnet access…');
    probe().then(function (ok) {
      if (my !== token) return;
      if (!ok) { showTailnet(); return; }
      if (!getKey()) { showKeyPrompt(''); return; }
      cache = {};
      showSections();
    });
  }

  /** GET <base>/healthz with a 3 s timeout. Any failure (off the tailnet, blocked, timeout) is "unreachable". */
  function probe() {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, PROBE_MS);
    var race = new Promise(function (resolve) { setTimeout(function () { resolve(false); }, PROBE_MS + 200); });
    var req = fetch(BASE + '/healthz', { cache: 'no-store', credentials: 'omit', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.ok; }, function () { return false; });
    return Promise.race([req, race]).then(function (ok) { clearTimeout(timer); return ok; });
  }

  function retryButton() {
    var b = el('button', { type: 'button', 'class': 'btn' }, 'Try again');
    b.addEventListener('click', enter);
    return b;
  }

  function showTailnet() {
    clear(root);
    root.appendChild(el('div', { 'class': 'glass internal__panel', id: 'internal-tailnet' },
      el('h1', {}, 'Internal mode needs tailnet access'),
      el('p', {}, 'Internal mode shows AE goals, outreach, clients, the gift list and money notes. That data is kept on the AE MacBook, not on this website, and it can only be reached from a device on the AE tailnet. This device could not reach it.'),
      el('p', {}, 'To use Internal mode:'),
      el('ol', {},
        el('li', {}, 'Install Tailscale on this device (tailscale.com/download).'),
        el('li', {}, 'Join the AE tailnet with the team auth key. Ask Anthony if you do not have it.'),
        el('li', {}, 'Reload this page, or press Try again.')),
      el('p', { 'class': 'muted small' }, 'Client mode is unaffected. Switch back to Client at any time.'),
      retryButton()));
  }

  function showKeyPrompt(error) {
    clear(root);
    var input = el('input', { type: 'password', name: 'agent_key', autocomplete: 'off', required: '', autofocus: '' });
    var form = el('form', { 'class': 'form', id: 'internal-key-form' },
      el('label', {}, 'Agent key', input),
      el('button', { 'class': 'btn', type: 'submit' }, 'Unlock Internal mode'));
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var k = input.value.trim();
      if (!k) return;
      setKey(k);
      cache = {};
      token++;
      showSections();
    });
    root.appendChild(el('div', { 'class': 'glass internal__panel', id: 'internal-key' },
      el('h1', {}, 'Agent key needed'),
      error ? el('p', { 'class': 'error', role: 'alert' }, error) : null,
      el('p', {}, 'Enter the shared AE agent key. It is kept for this browser tab only and is never saved to disk.'),
      form));
    input.focus();
  }

  function api(path) {
    return fetch(BASE + path, { headers: { 'X-Agent-Key': getKey() }, credentials: 'omit', cache: 'no-store' }).then(function (r) {
      if (r.status === 401) { var e = new Error('key'); e.unauthorized = true; throw e; }
      if (!r.ok) throw new Error('status ' + r.status);
      return r.json();
    });
  }

  var TABS = [
    ['goals', 'Goals', '/api/goals', renderGoals],
    ['outreach', 'Outreach', '/api/outreach', renderOutreach],
    ['clients', 'Clients', '/api/clients', renderClients],
    ['gifts', 'Gift list', '/api/gifts', renderGifts],
    ['money', 'Money / Admin', '/api/money', renderMoney]
  ];

  function showSections() {
    var my = ++token;
    clear(root);
    var tabs = el('div', { 'class': 'internal__tabs', role: 'group', 'aria-label': 'Internal sections' });
    TABS.forEach(function (t) {
      var b = el('button', { type: 'button', 'class': 'modeswitch__btn', 'data-tab': t[0], 'aria-pressed': t[0] === tab ? 'true' : 'false' }, t[1]);
      b.addEventListener('click', function () { tab = t[0]; showSections(); });
      tabs.appendChild(b);
    });
    var lock = el('button', { type: 'button', 'class': 'btn btn--ghost' }, 'Forget key');
    lock.addEventListener('click', function () { clearKey(); cache = {}; token++; showKeyPrompt(''); });
    var body = el('div', { id: 'internal-body' }, el('p', { 'class': 'muted' }, 'Loading…'));
    root.appendChild(el('div', { 'class': 'internal__bar' }, tabs, lock));
    root.appendChild(body);

    var t = TABS.filter(function (x) { return x[0] === tab; })[0] || TABS[0];
    var got = cache[t[0]] ? Promise.resolve(cache[t[0]]) : api(t[2]).then(function (d) { cache[t[0]] = d; return d; });
    got.then(function (data) {
      if (my !== token) return;
      clear(body);
      t[3](body, data || {});
    }, function (err) {
      if (my !== token) return;
      if (err && err.unauthorized) { clearKey(); cache = {}; showKeyPrompt('That key was not accepted. Check it and try again.'); return; }
      clear(body);
      body.appendChild(el('div', { 'class': 'glass internal__panel' },
        el('p', { 'class': 'error', role: 'alert' }, 'Could not load this section. The MacBook may be asleep or off the tailnet.'),
        retryButton()));
    });
  }

  // ---- Renderers (cards, feed lists and pills, same patterns as the client pages) ----
  function feedRow(title, detail, pillText, pillKind) {
    return el('li', {},
      el('div', {},
        el('p', { 'class': 'feed__title' }, title, pillText ? ' ' : '', pillText ? pill(pillText, pillKind) : null),
        detail ? el('p', { 'class': 'feed__detail' }, detail) : null));
  }
  function emptyBox(text) { return el('div', { 'class': 'glass empty' }, text); }
  function heading(text) { return el('h2', {}, text); }

  function renderGoals(body, d) {
    var goals = Array.isArray(d.goals) ? d.goals : [];
    if (!goals.length) { body.appendChild(emptyBox('No goals yet.')); return; }
    var active = goals.filter(function (g) { return g.status === 'active'; });
    var rest = goals.filter(function (g) { return g.status !== 'active'; });
    function list(arr) {
      return el('ol', { 'class': 'glass feed internal__list' }, arr.map(function (g) {
        return feedRow(g.title || g.slug || 'Untitled', g.current_state || g.description || '', label(g.status), g.status === 'active' ? 'active' : 'paused');
      }));
    }
    body.appendChild(heading('Active (' + active.length + ')'));
    body.appendChild(active.length ? list(active) : emptyBox('Nothing active.'));
    if (rest.length) { body.appendChild(heading('Other (' + rest.length + ')')); body.appendChild(list(rest)); }
  }

  function renderOutreach(body, d) {
    var s = d.summary || {};
    var by = s.by_status || {};
    var pills = el('div', { 'class': 'internal__pills' }, pill('Total ' + (s.total || 0), 'attention'));
    Object.keys(by).sort().forEach(function (k) { pills.appendChild(pill(label(k) + ' ' + by[k], 'active')); });
    body.appendChild(pills);
    if (s.note) body.appendChild(el('p', { 'class': 'muted small' }, s.note));
    var due = Array.isArray(s.next_due) ? s.next_due : [];
    if (due.length) {
      body.appendChild(heading('Next touches due'));
      body.appendChild(el('ol', { 'class': 'glass feed internal__list' }, due.map(function (x) {
        var nt = x.next_touch || {};
        return feedRow(x.business || '', [x.town, nt.due ? 'due ' + nt.due : ''].filter(Boolean).join(' · '), label(x.status), 'active');
      })));
    }
    var pros = Array.isArray(d.prospects) ? d.prospects : [];
    body.appendChild(heading('Prospects (' + pros.length + ')'));
    body.appendChild(pros.length ? el('ol', { 'class': 'glass feed internal__list' }, pros.map(function (p) {
      var touches = Array.isArray(p.touches) ? p.touches.length : 0;
      return feedRow(p.business_name || '', [p.category, p.town, touches ? touches + ' touch' + (touches === 1 ? '' : 'es') : ''].filter(Boolean).join(' · '), label(p.status), 'active');
    })) : emptyBox('No prospects yet.'));
  }

  function renderClients(body, d) {
    var cs = Array.isArray(d.clients) ? d.clients : [];
    if (!cs.length) { body.appendChild(emptyBox('No clients yet.')); return; }
    body.appendChild(el('section', { 'class': 'cards' }, cs.map(function (c) {
      return el('article', { 'class': 'glass card' },
        el('div', { 'class': 'card__head' },
          el('div', {}, el('h3', { 'class': 'card__name' }, c.name || ''),
            el('p', { 'class': 'card__plan' }, [c.owner, c.type, c.town].filter(Boolean).join(' · '))),
          c.status ? pill(label(c.status), 'active') : null),
        c.notes ? el('p', { 'class': 'card__plan' }, c.notes) : null);
    })));
  }

  function renderGifts(body, d) {
    if (d.status === 'pending') { body.appendChild(emptyBox(d.note || 'Gift list sync pending.')); return; }
    var persons = Array.isArray(d.persons) ? d.persons : [];
    var items = (Array.isArray(d.items) ? d.items : []).filter(function (i) { return !i.removed; });
    if (!items.length) { body.appendChild(emptyBox('No gift items yet.')); return; }
    persons.slice().sort(function (a, b) { return (a.sortOrder || 0) - (b.sortOrder || 0); }).forEach(function (p) {
      var mine = items.filter(function (i) { return i.personSlug === p.slug; });
      if (!mine.length) return;
      body.appendChild(heading((p.name || p.slug) + ' (' + mine.length + ')'));
      if (p.subtitle) body.appendChild(el('p', { 'class': 'muted small' }, p.subtitle));
      body.appendChild(el('ol', { 'class': 'glass feed internal__list' }, mine.map(function (i) {
        return feedRow(i.title || 'Item', i.priceLabel || '', i.isPrimary ? 'Top pick' : '', 'active');
      })));
    });
  }

  function renderMoney(body, d) {
    if (d.primary_goal) body.appendChild(el('div', { 'class': 'glass internal__panel' }, el('p', {}, d.primary_goal)));
    [['household', 'Household'], ['taxes', 'Taxes'], ['grants', 'Grants'], ['stripe', 'Stripe']].forEach(function (s) {
      var rows = Array.isArray(d[s[0]]) ? d[s[0]] : [];
      if (!rows.length) return;
      body.appendChild(heading(s[1]));
      body.appendChild(el('ol', { 'class': 'glass feed internal__list' }, rows.map(function (r) { return feedRow(String(r), ''); })));
    });
  }

  // Initial state: Client unless the viewer last chose Internal.
  if (getMode() === 'internal') apply('internal');
})();
