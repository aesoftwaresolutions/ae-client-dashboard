'use strict';
// Multi-user concurrency: the dashboard must serve several clients at once
// without mixing their data. Three clients sign in at the same time, read
// their own dashboard data and save different notification settings at the
// same time; each one must see only their own business, calls and settings.
// Runs against a real server on a temp database (no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aedash-conc-'));
const port = 3900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), NODE_ENV: 'test', MAIL_MODE: 'console', BASE_URL: base };

let server; let serverLog = '';
const run = (script, ...a) => spawnSync(process.execPath, [path.join(root, script), ...a], { env, encoding: 'utf8' });
const cookieOf = (res, name) => (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) || '').split(';')[0].split('=')[1];

async function login(email, password) {
  const page = await fetch(`${base}/login`);
  const csrf = cookieOf(page, 'ae_csrf');
  const res = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `ae_csrf=${csrf}` },
    body: new URLSearchParams({ _csrf: csrf, email, password }),
  });
  return { res, session: cookieOf(res, 'ae_session') };
}

// Three clients with distinct businesses, numbers and settings.
const CLIENTS = [
  { business: 'Alpha Plumbing', contact: 'Amy Alpha', email: 'alpha@example.com', phone: '+17175550101', password: 'alpha-pass-123456', sms: '+17175550101', urgent: false },
  { business: 'Beta Electric', contact: 'Ben Beta', email: 'beta@example.com', phone: '+17175550102', password: 'beta-pass-123456', sms: '+17175550102', urgent: true },
  { business: 'Gamma Roofing', contact: 'Gus Gamma', email: 'gamma@example.com', phone: '+17175550103', password: 'gamma-pass-123456', sms: '+17175550103', urgent: false },
];
const sessions = {};

test.before(async () => {
  const seed = run('scripts/seed.js');
  assert.equal(seed.status, 0, seed.stderr);
  for (const c of CLIENTS) {
    const r = run('scripts/manage.js', 'create-client', '--business', c.business, '--contact', c.contact,
      '--email', c.email, '--phone', c.phone, '--password', c.password);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const m = /Client ID: (\S+)/.exec(r.stdout);
    assert.ok(m, r.stdout);
    c.id = m[1];
    // Give each client a Front Desk subscription so /app/data has a service card.
    assert.equal(run('scripts/manage.js', 'add-subscription', '--client', c.id, '--service', 'front-desk',
      '--plan', 'Front Desk 99', '--price-cents', '9900', '--billing', 'monthly').status, 0);
  }
  server = spawn(process.execPath, [path.join(root, 'server.js')], { env });
  server.stdout.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 50 && !serverLog.includes('listening'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(serverLog.includes('listening'), 'server did not start');
});
test.after(() => { server.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('three clients sign in at the same time and each sees only their own data', async () => {
  const logins = await Promise.all(CLIENTS.map((c) => login(c.email, c.password)));
  logins.forEach((l, i) => {
    assert.equal(l.res.status, 303, `${CLIENTS[i].email} could not sign in`);
    assert.ok(l.session, `${CLIENTS[i].email} got no session`);
    sessions[CLIENTS[i].email] = l.session;
  });
  // All three read their dashboard data at the same moment.
  const datas = await Promise.all(CLIENTS.map(async (c) => {
    const r = await fetch(`${base}/app/data`, { headers: { cookie: `ae_session=${sessions[c.email]}` } });
    assert.equal(r.status, 200);
    return r.json();
  }));
  datas.forEach((d, i) => {
    assert.equal(d.business_name, CLIENTS[i].business, `client ${i} saw the wrong business`);
    assert.equal(d.services[0].service, 'front-desk');
    // No other client's business, email or phone appears in this client's data.
    for (const other of CLIENTS) {
      if (other === CLIENTS[i]) continue;
      assert.ok(!JSON.stringify(d).includes(other.business), `${CLIENTS[i].business} data leaked ${other.business}`);
      assert.ok(!JSON.stringify(d).includes(other.email), `${CLIENTS[i].business} data leaked ${other.email}`);
    }
  });
});

test('three clients save different notification settings at the same time without mixing them up', async () => {
  const csrf = 'y'.repeat(24);
  const save = (c) => fetch(`${base}/app/notification-settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `ae_session=${sessions[c.email]}; ae_csrf=${csrf}` },
    body: JSON.stringify({ _csrf: csrf, sms_summary_enabled: true, sms_number: c.sms, sms_urgent_only: c.urgent }),
  });
  // All three save at once.
  const results = await Promise.all(CLIENTS.map(save));
  results.forEach((r, i) => assert.equal(r.status, 200, `save for ${CLIENTS[i].email} returned ${r.status}`));
  // Each client's saved settings are exactly their own, read back at once.
  const reads = await Promise.all(CLIENTS.map(async (c) => {
    const r = await fetch(`${base}/app/notification-settings`, { headers: { cookie: `ae_session=${sessions[c.email]}` } });
    assert.equal(r.status, 200);
    return r.json();
  }));
  reads.forEach((d, i) => {
    assert.equal(d.settings.sms_number, CLIENTS[i].sms, `client ${i} got the wrong number`);
    assert.equal(d.settings.sms_urgent_only, CLIENTS[i].urgent, `client ${i} got the wrong urgent-only flag`);
    assert.equal(d.settings.sms_summary_enabled, true);
  });
});

test('a client session cannot reach another client through ?client_id=', async () => {
  const a = CLIENTS[0]; const b = CLIENTS[1];
  const cookie = `ae_session=${sessions[a.email]}`;
  // A client passing ?client_id= for someone else is ignored: the session's
  // own client is used, so the settings come back as their own, not the other's.
  const r = await fetch(`${base}/app/notification-settings?client_id=${b.id}`, { headers: { cookie } });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.settings.sms_number, a.sms, 'client A read client B settings through ?client_id=');
  // Same for the call detail and the data endpoint: no cross-client reads.
  assert.equal((await fetch(`${base}/app/calls/conv-does-not-exist-123`, { headers: { cookie } })).status, 404);
  const data = await (await fetch(`${base}/app/data?client_id=${b.id}`, { headers: { cookie } })).json();
  assert.equal(data.business_name, a.business);
});

test('a burst of concurrent requests all succeed with the right data', async () => {
  const burst = [];
  for (let i = 0; i < 10; i++) {
    for (const c of CLIENTS) {
      burst.push(fetch(`${base}/app/data`, { headers: { cookie: `ae_session=${sessions[c.email]}` } })
        .then(async (r) => ({ email: c.email, status: r.status, data: await r.json() })));
    }
  }
  const results = await Promise.all(burst);
  assert.equal(results.length, 30);
  for (const r of results) {
    assert.equal(r.status, 200, `${r.email} got ${r.status} in the burst`);
    const want = CLIENTS.find((c) => c.email === r.email);
    assert.equal(r.data.business_name, want.business, `${r.email} saw the wrong business in the burst`);
  }
});
