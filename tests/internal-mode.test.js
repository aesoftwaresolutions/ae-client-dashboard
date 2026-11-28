'use strict';
// Behaviour of public/internal.js (Client | Internal toggle) against a tiny fake DOM and a fake
// fetch. No browser, no network. Covers: Client default, tailnet-access state when unreachable,
// key prompt on 401, sections on 200, and that the agent key never touches localStorage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'internal.js'), 'utf8');
const BASE = 'https://anthony-macbookpro14-1.taild6c356.ts.net:8446';

class Node {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.parentNode = null; this.listeners = {}; this._text = ''; this.hidden = false; this.value = ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'hidden') this.hidden = true; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(c) { if (Array.isArray(c) || c === null || typeof c !== 'object') throw new TypeError('not a Node'); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  insertBefore(c, ref) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  get nextSibling() { const p = this.parentNode; return p ? p.children[p.children.indexOf(this) + 1] || null : null; }
  get firstChild() { return this.children[0] || null; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  fire(t, ev = { preventDefault() {} }) { (this.listeners[t] || []).forEach((f) => f(ev)); }
  focus() {}
  get text() { return this._text + this.children.map((c) => (c.text !== undefined ? c.text : '')).join(' '); }
  walk(out = []) { out.push(this); this.children.forEach((c) => c.walk && c.walk(out)); return out; }
  matches(sel) {
    const cls = /^\.([\w-]+)$/.exec(sel); if (cls) return (this.attrs.class || '').split(/\s+/).includes(cls[1]);
    if (sel === 'main.wrap') return this.tag === 'main' && (this.attrs.class || '').split(/\s+/).includes('wrap');
    return false;
  }
  querySelectorAll(sel) { return this.walk().filter((n) => n !== this && n.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
class Text { constructor(t) { this.text = t; } walk(o = []) { return o; } }

function makeStorage() { const m = new Map(); const writes = []; return { writes, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { writes.push([k, String(v)]); m.set(k, String(v)); }, removeItem: (k) => m.delete(k), _m: m }; }

/** Builds the page shell the server renders (toggle + client main) and runs internal.js in it. */
function boot({ mode, fetchImpl, key } = {}) {
  const body = new Node('body');
  const sw = new Node('div'); sw.setAttribute('class', 'modeswitch'); sw.setAttribute('data-internal-base', BASE);
  const btns = ['client', 'internal'].map((m) => { const b = new Node('button'); b.setAttribute('class', 'modeswitch__btn'); b.setAttribute('data-mode', m); b.setAttribute('aria-pressed', m === 'client' ? 'true' : 'false'); sw.appendChild(b); return b; });
  const clientMain = new Node('main'); clientMain.setAttribute('class', 'wrap'); clientMain.setAttribute('id', 'app');
  body.appendChild(sw); body.appendChild(clientMain);
  const document = { body, createElement: (t) => new Node(t), createTextNode: (t) => new Text(t), querySelector: (s) => body.querySelector(s), querySelectorAll: (s) => body.querySelectorAll(s) };
  const localStorage = makeStorage(); const sessionStorage = makeStorage();
  if (mode) localStorage.setItem('ae_portal_mode', mode);
  if (key) sessionStorage.setItem('ae_internal_agent_key', key);
  const calls = [];
  const fetch = (url, opts = {}) => { calls.push({ url, opts }); return fetchImpl(url, opts); };
  const window = { localStorage, sessionStorage };
  const ctx = { window, document, fetch, console, setTimeout, clearTimeout, Promise, AbortController, Array, Object, String, Error };
  vm.runInNewContext(SRC, ctx);
  const root = body.children.find((c) => c.attrs.id === 'internal');
  return { body, root, clientMain, btns, localStorage, sessionStorage, calls };
}
const flush = () => new Promise((r) => setTimeout(r, 20));
const ok = (data, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(data) });
const down = () => Promise.reject(new TypeError('Failed to fetch'));

test('Client is the default: the Client page is shown, nothing is fetched, no key stored', async () => {
  const t = boot({ fetchImpl: down });
  await flush();
  assert.equal(t.root.hidden, true);
  assert.equal(t.clientMain.hidden, false);
  assert.equal(t.calls.length, 0);
  assert.equal(t.btns[0].attrs['aria-pressed'], 'true');
});

test('Internal mode unreachable (off the tailnet): shows the tailnet-access panel, Client content hidden', async () => {
  const t = boot({ fetchImpl: down });
  t.btns[1].fire('click');
  await flush();
  assert.equal(t.localStorage.getItem('ae_portal_mode'), 'internal');
  assert.equal(t.clientMain.hidden, true);
  assert.equal(t.root.hidden, false);
  assert.equal(t.calls[0].url, `${BASE}/healthz`);
  assert.equal(t.calls[0].opts.credentials, 'omit');
  assert.ok(t.calls[0].opts.signal, 'probe must carry a timeout signal');
  assert.match(t.root.text, /Internal mode needs tailnet access/);
  assert.match(t.root.text, /kept on the AE MacBook/);
  assert.match(t.root.text, /Install Tailscale/);
  assert.equal(t.calls.length, 1, 'no data request may be made when the probe fails');
  // Switching back restores Client untouched.
  t.btns[0].fire('click');
  assert.equal(t.clientMain.hidden, false);
  assert.equal(t.root.hidden, true);
  assert.equal(t.localStorage.getItem('ae_portal_mode'), 'client');
});

test('a hanging probe is treated as unreachable after about 3 seconds', async () => {
  const t = boot({ mode: 'internal', fetchImpl: () => new Promise(() => {}) });
  await new Promise((r) => setTimeout(r, 3400));
  assert.match(t.root.text, /needs tailnet access/);
});

test('reachable but no key: prompts for the key; the key goes to sessionStorage only', async () => {
  const t = boot({ mode: 'internal', fetchImpl: (u) => (u.endsWith('/healthz') ? ok({ ok: true }) : ok({ error: 'agent key required' }, 401)) });
  await flush();
  assert.match(t.root.text, /Agent key needed/);
  const form = t.root.walk().find((n) => n.tag === 'form');
  const input = t.root.walk().find((n) => n.tag === 'input');
  input.value = 'secret-key-123';
  form.fire('submit');
  await flush();
  assert.deepEqual(t.sessionStorage.writes, [['ae_internal_agent_key', 'secret-key-123']]);
  for (const [k, v] of t.localStorage.writes) assert.ok(!v.includes('secret-key-123') && k !== 'ae_internal_agent_key', 'key leaked into localStorage');
  // The API call carried it, and the 401 answer sends us back to the prompt and drops the key.
  const dataCall = t.calls.find((c) => c.url === `${BASE}/api/goals`);
  assert.equal(dataCall.opts.headers['X-Agent-Key'], 'secret-key-123');
  assert.match(t.root.text, /That key was not accepted/);
  assert.equal(t.sessionStorage.getItem('ae_internal_agent_key'), null);
});

test('reachable with a valid key: renders the internal sections and data', async () => {
  const data = {
    '/api/goals': { goals: [{ title: 'Grow to $100k', status: 'active', current_state: 'In progress' }, { title: 'Old thing', status: 'completed' }] },
    '/api/outreach': { summary: { total: 1, by_status: { queued: 1 }, next_due: [] }, prospects: [{ business_name: '<img src=x onerror=alert(1)>', status: 'queued', touches: [] }] },
    '/api/clients': { clients: [{ name: 'Falafel Shack', town: 'Chambersburg, PA', status: 'hot prospect' }] },
    '/api/gifts': { persons: [{ slug: 'a', name: 'Aaliyah', sortOrder: 0 }], items: [{ personSlug: 'a', title: 'LED strip', priceLabel: '$9.99' }] },
    '/api/money': { primary_goal: 'Reach 100k', taxes: ['2025 taxes not filed'] },
  };
  const t = boot({ mode: 'internal', key: 'k', fetchImpl: (u) => (u.endsWith('/healthz') ? ok({ ok: true }) : ok(data[u.slice(BASE.length)] || {})) });
  await flush();
  assert.match(t.root.text, /Goals/); assert.match(t.root.text, /Gift list/); assert.match(t.root.text, /Money \/ Admin/);
  assert.match(t.root.text, /Grow to \$100k/);
  assert.equal(t.clientMain.hidden, true);
  const tabBtn = (name) => t.root.walk().find((n) => n.attrs['data-tab'] === name);
  for (const [tab, expect] of [['outreach', /<img src=x onerror=alert\(1\)>/], ['clients', /Falafel Shack/], ['gifts', /LED strip/], ['money', /2025 taxes not filed/]]) {
    tabBtn(tab).fire('click');
    await flush();
    assert.match(t.root.text, expect, tab); // hostile text appears as plain text nodes, never parsed as HTML
  }
});
