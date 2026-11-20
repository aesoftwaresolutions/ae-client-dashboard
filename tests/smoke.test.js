'use strict';
// End-to-end smoke test: starts a real server on a temp database, seeds the demo client,
// then checks login, dashboard data, the event API, phone masking, tenant isolation and rate limits.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aedash-'));
const port = 3900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), NODE_ENV: 'test', MAIL_MODE: 'console', EVENT_RATE_LIMIT_PER_HOUR: '30', BASE_URL: base };

let server; let serverLog = ''; let demo;

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
const api = (key, method, p, body) => fetch(`${base}${p}`, {
  method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body),
});

test.before(async () => {
  const seed = run('scripts/seed.js');
  assert.equal(seed.status, 0, seed.stderr);
  const grab = (k) => new RegExp(`^${k}: (.+)$`, 'm').exec(seed.stdout)[1];
  demo = { clientId: grab('CLIENT ID'), email: grab('EMAIL'), password: grab('PASSWORD'), key: grab('API KEY') };
  server = spawn(process.execPath, [path.join(root, 'server.js')], { env });
  server.stdout.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 50 && !serverLog.includes('listening'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(serverLog.includes('listening'), 'server did not start');
});
test.after(() => { server.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('unauthenticated access is refused', async () => {
  const r = await fetch(`${base}/dashboard`, { redirect: 'manual' });
  assert.equal(r.status, 303);
  assert.equal((await fetch(`${base}/app/data`)).status, 401);
  assert.equal((await fetch(`${base}/api/v1/clients/${demo.clientId}/services`)).status, 401);
  assert.equal((await api('aek_wrong', 'GET', `/api/v1/clients/${demo.clientId}/services`)).status, 401);
});

test('login rejects a wrong password and accepts the right one', async () => {
  assert.equal((await login(demo.email, 'not-the-password')).res.status, 401);
  const { res, session } = await login(demo.email, demo.password);
  assert.equal(res.status, 303);
  assert.ok(session);
  const page = await fetch(`${base}/dashboard`, { headers: { cookie: `ae_session=${session}` } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Riverside Plumbing/);
});

test('POST without a CSRF token is rejected', async () => {
  const r = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ email: demo.email, password: demo.password }) });
  assert.equal(r.status, 400);
});

test('dashboard data shows only subscribed cards and seeded events', async () => {
  const { session } = await login(demo.email, demo.password);
  const data = await (await fetch(`${base}/app/data`, { headers: { cookie: `ae_session=${session}` } })).json();
  assert.deepEqual(data.services.map((s) => s.service), ['front-desk']); // other 15 are hidden
  const fd = data.services[0];
  assert.equal(fd.status, 'active'); // setup_complete moved it from Setting up
  assert.equal(fd.stats[0].value, 3);
  assert.equal(data.activity.length, 6);
  assert.ok(!JSON.stringify(data).includes('240-555-0142'), 'full phone number leaked');
});

test('API stores an event, derives status, and it appears in the feed', async () => {
  const body = { client_id: demo.clientId, service: 'front-desk', event_type: 'call_answered',
    title: 'Front Desk answered a call', detail: 'Caller Sam asked about pricing, call back at +1 (240) 555-0199.',
    occurred_at: new Date().toISOString(), metadata: { duration: 41, caller_phone: '+12405550199', note: 'from 240-555-0123' } };
  const r = await api(demo.key, 'POST', '/api/v1/front-desk/events', body);
  assert.equal(r.status, 200);
  const { ok, event_id } = await r.json();
  assert.ok(ok && event_id);
  const feed = await (await api(demo.key, 'GET', `/api/v1/clients/${demo.clientId}/activity?limit=3`)).json();
  assert.equal(feed.activity[0].id, event_id);
  assert.match(feed.activity[0].detail, /\*\*\*-\*\*\*-0199/);
  assert.ok(!feed.activity[0].detail.includes('555-0199'));
  const raw = spawnSync(process.execPath, ['-e', `const {db}=require(${JSON.stringify(path.join(root, 'src/db'))});console.log(db.prepare('select metadata from events where id=?').get(${JSON.stringify(event_id)}).metadata)`], { env, encoding: 'utf8' });
  assert.ok(!raw.stdout.includes('5550199') && !raw.stdout.includes('240-555-0123'), 'metadata kept a phone number');

  const warn = await api(demo.key, 'POST', '/api/v1/front-desk/events', { ...body, event_type: 'plan_limit_warning', title: 'Nearing plan limit', detail: null, metadata: {} });
  assert.equal(warn.status, 200);
  const svc = await (await api(demo.key, 'GET', `/api/v1/clients/${demo.clientId}/services`)).json();
  assert.equal(svc.services[0].status, 'attention');
});

test('validation and tenant isolation', async () => {
  const good = { client_id: demo.clientId, event_type: 'x_y', title: 't' };
  assert.equal((await api(demo.key, 'POST', '/api/v1/front-desk/events', { ...good, client_id: 'cl_other' })).status, 403);
  assert.equal((await api(demo.key, 'GET', '/api/v1/clients/cl_other/services')).status, 403);
  assert.equal((await api(demo.key, 'POST', '/api/v1/websites/events', good)).status, 422); // no such subscription
  assert.equal((await api(demo.key, 'POST', '/api/v1/nonsense/events', good)).status, 404);
  assert.equal((await api(demo.key, 'POST', '/api/v1/front-desk/events', { ...good, event_type: 'Bad Type' })).status, 400);
  assert.equal((await api(demo.key, 'POST', '/api/v1/front-desk/events', { ...good, title: '' })).status, 400);
  const unknown = await api(demo.key, 'POST', '/api/v1/front-desk/events', good); // unknown type is stored
  assert.equal(unknown.status, 200);
});

test('Telnyx webhook stub keeps only last 4 digits and first name', async () => {
  const r = await api(demo.key, 'POST', '/api/v1/webhooks/telnyx/call-summary', {
    client_id: demo.clientId, outcome: 'answered', caller_name: 'Alex Johnson', caller_number: '+12405550111',
    duration_seconds: 90, summary: 'Wants a quote.' });
  assert.equal(r.status, 200);
  const feed = await (await api(demo.key, 'GET', `/api/v1/clients/${demo.clientId}/activity?limit=1`)).json();
  assert.match(feed.activity[0].title, /call from Alex$/);
  assert.ok(!JSON.stringify(feed).includes('5550111'));
});

test('telnyx-relay script pushes a call summary into the feed', async () => {
  // The relay is the sender side of the funnel: same payload and endpoint the
  // future AE-site webhook will use. It verifies the event shows in the feed.
  const relay = spawnSync(process.execPath, [path.join(root, 'scripts/telnyx-relay.js'),
    '--base', base, '--key', demo.key, '--client-id', demo.clientId,
    '--file', path.join(root, 'scripts/sample-call-summary.json'), '--verify'],
    { encoding: 'utf8' });
  assert.equal(relay.status, 0, relay.stderr || relay.stdout);
  assert.match(relay.stdout, /Call summary stored: event ev_/);
  assert.match(relay.stdout, /Verified in feed: "Front Desk answered a call from Sam"/);
  const feed = await (await api(demo.key, 'GET', `/api/v1/clients/${demo.clientId}/activity?limit=1`)).json();
  assert.ok(!JSON.stringify(feed).includes('5550199'), 'full caller number leaked');
});

test('event POST is rate limited per key', async () => {
  // limit is 30/hour in this test run; keep posting until the limiter trips
  let last;
  for (let i = 0; i < 40; i++) {
    last = await api(demo.key, 'POST', '/api/v1/front-desk/events', { client_id: demo.clientId, event_type: 'x', title: 't' });
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('retry-after'));
});

test('password reset flow works end to end', async () => {
  const page = await fetch(`${base}/forgot`);
  const csrf = cookieOf(page, 'ae_csrf');
  const post = (url, form) => fetch(`${base}${url}`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `ae_csrf=${csrf}` }, body: new URLSearchParams({ _csrf: csrf, ...form }) });
  assert.equal((await post('/forgot', { email: 'nobody@example.com' })).status, 200); // same answer for unknown email
  assert.equal((await post('/forgot', { email: demo.email })).status, 200);
  await new Promise((r) => setTimeout(r, 200));
  const token = /\/reset\/([\w-]+)/.exec(serverLog)[1];
  assert.equal((await post(`/reset/${token}`, { password: 'short', confirm: 'short' })).status, 400);
  assert.equal((await post(`/reset/${token}`, { password: 'a-brand-new-pass', confirm: 'a-brand-new-pass' })).status, 303);
  assert.equal((await post(`/reset/${token}`, { password: 'another-new-pass', confirm: 'another-new-pass' })).status, 400); // single use
  assert.equal((await login(demo.email, demo.password)).res.status, 401);
  assert.equal((await login(demo.email, 'a-brand-new-pass')).res.status, 303);
});

test('logout ends the session', async () => {
  const { session } = await login(demo.email, 'a-brand-new-pass');
  const csrf = 'x'.repeat(24);
  const out = await fetch(`${base}/logout`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `ae_session=${session}; ae_csrf=${csrf}` }, body: new URLSearchParams({ _csrf: csrf }) });
  assert.equal(out.status, 303);
  assert.equal((await fetch(`${base}/app/data`, { headers: { cookie: `ae_session=${session}` } })).status, 401);
});
