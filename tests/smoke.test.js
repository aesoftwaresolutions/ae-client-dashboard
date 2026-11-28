'use strict';
// End-to-end smoke test: starts a real server on a temp database, seeds the demo client,
// then checks login, dashboard data, the event API, phone masking, tenant isolation and rate limits,
// plus the signed Telnyx receiver, billing view, admin view, support messages and the OPM card.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aedash-'));
const port = 3900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
// Throwaway Ed25519 key pair standing in for the Telnyx account key.
const telnyxKeys = crypto.generateKeyPairSync('ed25519');
const telnyxPublicB64 = telnyxKeys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), NODE_ENV: 'test', MAIL_MODE: 'console', EVENT_RATE_LIMIT_PER_HOUR: '30', BASE_URL: base, TELNYX_PUBLIC_KEY: telnyxPublicB64 };

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

test('the Settings page is its own page, for signed-in clients only', async () => {
  const anon = await fetch(`${base}/settings`, { redirect: 'manual' });
  assert.equal(anon.status, 303);
  const { session } = await login(demo.email, demo.password);
  const settings = await fetch(`${base}/settings`, { headers: { cookie: `ae_session=${session}` } });
  assert.equal(settings.status, 200);
  const html = await settings.text();
  assert.match(html, /data-page="settings"/);
  assert.match(html, /<a class="topbar__link" href="\/settings" aria-current="page">Settings<\/a>/);
  const dash = await (await fetch(`${base}/dashboard`, { headers: { cookie: `ae_session=${session}` } })).text();
  assert.match(dash, /data-page="dashboard"/);
  assert.match(dash, /href="\/dashboard" aria-current="page"/);
});

test('the Billing page is its own page, for signed-in clients only', async () => {
  const anon = await fetch(`${base}/billing`, { redirect: 'manual' });
  assert.equal(anon.status, 303);
  const { session } = await login(demo.email, demo.password);
  const billing = await fetch(`${base}/billing`, { headers: { cookie: `ae_session=${session}` } });
  assert.equal(billing.status, 200);
  const html = await billing.text();
  assert.match(html, /data-page="billing"/);
  assert.match(html, /<a class="topbar__link" href="\/billing" aria-current="page">Billing<\/a>/);
  // All three client pages carry the same three-link nav.
  for (const p of ['/dashboard', '/settings', '/billing']) {
    const page = await (await fetch(`${base}${p}`, { headers: { cookie: `ae_session=${session}` } })).text();
    for (const href of ['/dashboard', '/settings', '/billing']) assert.ok(page.includes(`href="${href}"`), `${p} is missing the ${href} link`);
  }
  // Billing data still comes from /app/data, unchanged.
  const data = await (await fetch(`${base}/app/data`, { headers: { cookie: `ae_session=${session}` } })).json();
  assert.ok(data.billing && Array.isArray(data.billing.subscriptions));
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

// ---- Telnyx direct receiver (Ed25519) -----------------------------------------------
const signedPost = (bodyStr, { ts = Math.floor(Date.now() / 1000), key = telnyxKeys.privateKey, sigOverride } = {}) => {
  const sig = sigOverride ?? crypto.sign(null, Buffer.from(`${ts}|${bodyStr}`), key).toString('base64');
  return fetch(`${base}/api/v1/webhooks/telnyx`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'telnyx-signature-ed25519': sig, 'telnyx-timestamp': String(ts) }, body: bodyStr });
};
const endedEvent = (id, conv, to = '+17175550100') => JSON.stringify({ data: {
  id, event_type: 'call.conversation.ended', occurred_at: new Date().toISOString(),
  payload: { call_control_id: `cc_${conv}`, conversation_id: conv, to, from: '+12405550123', duration_sec: 75,
    messages: [{ role: 'assistant', content: 'Thanks for calling. May I have your name?' },
      { role: 'user', content: "Hi, it's Jordan Smith" },
      { role: 'user', content: 'My sink is leaking, call me at 240-555-0123.' }] } } });

test('Telnyx direct webhook: verifies Ed25519, rejects replays, stores once', async () => {
  const add = run('scripts/manage.js', 'add-telnyx-agent', '--client', demo.clientId, '--service', 'front-desk',
    '--assistant-id', 'assistant-test-1', '--phone', '+17175550100', '--transfer', '+17175550101');
  assert.equal(add.status, 0, add.stderr);

  const body = endedEvent('evt_1', 'conv_1');
  const ok = await signedPost(body);
  assert.equal(ok.status, 200);
  const okJson = await ok.json();
  assert.ok(okJson.stored && okJson.event_id, JSON.stringify(okJson));

  assert.equal((await (await signedPost(body)).json()).ignored, 'duplicate delivery');            // retry or replay
  assert.equal((await signedPost(endedEvent('evt_2', 'conv_1'))).status, 200);                   // same conversation, new id
  assert.equal((await signedPost(body, { ts: Math.floor(Date.now() / 1000) - 301 })).status, 401); // older than 300 s
  assert.equal((await signedPost(body, { ts: Math.floor(Date.now() / 1000) + 301 })).status, 401); // too far ahead
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  assert.equal((await signedPost(body, { key: other })).status, 401);                             // wrong key
  const tampered = await fetch(`${base}/api/v1/webhooks/telnyx`, { method: 'POST', headers: {
    'telnyx-signature-ed25519': crypto.sign(null, Buffer.from(`${Math.floor(Date.now() / 1000)}|${body}`), telnyxKeys.privateKey).toString('base64'),
    'telnyx-timestamp': String(Math.floor(Date.now() / 1000)) }, body: body.replace('Jordan', 'Jordon') });
  assert.equal(tampered.status, 401);                                                             // body changed after signing
  assert.equal((await fetch(`${base}/api/v1/webhooks/telnyx`, { method: 'POST', body })).status, 401); // no headers
  const unknown = await (await signedPost(endedEvent('evt_3', 'conv_3', '+19995550000'))).json();
  assert.match(unknown.ignored, /no telnyx_agents row/);

  const feed = await (await api(demo.key, 'GET', `/api/v1/clients/${demo.clientId}/activity?limit=5`)).json();
  const ev = feed.activity.find((e) => e.id === okJson.event_id);
  assert.equal(ev.title, 'Front Desk answered a call from Jordan');
  assert.ok(!JSON.stringify(feed).includes('555-0123'), 'full caller number leaked');
  const rows = spawnSync(process.execPath, ['-e', `const {db}=require(${JSON.stringify(path.join(root, 'src/db'))});console.log(JSON.stringify(db.prepare('select * from call_summaries').all()))`], { env, encoding: 'utf8' });
  const summaries = JSON.parse(rows.stdout);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].caller_display, 'Jordan');
  assert.ok(!rows.stdout.includes('555-0123'), 'call_summaries kept a full number');
});

test('call recording audio is proxied through the dashboard, not linked to S3', async () => {
  // Unauthenticated requests are refused.
  assert.equal((await fetch(`${base}/app/calls/conv-audio-12345/audio`)).status, 401);
  const { session } = await login(demo.email, 'a-brand-new-pass'); // password was reset by the earlier test
  const auth = { headers: { cookie: `ae_session=${session}` } };
  // A conversation that does not belong to this client is not found.
  assert.equal((await fetch(`${base}/app/calls/conv-does-not-exist-123/audio`, auth)).status, 404);
  // A real call with a call_control_id, but the test env has no Telnyx API
  // key, so no recording can be fetched and the endpoint answers 404 rather
  // than crashing. The live streaming path is verified against the real
  // dashboard after deploy.
  const body = endedEvent('evt-audio', 'conv-audio-12345');
  assert.equal((await signedPost(body)).status, 200);
  assert.equal((await fetch(`${base}/app/calls/conv-audio-12345/audio`, auth)).status, 404);
});

test('Telnyx verifier fails closed without TELNYX_PUBLIC_KEY', () => {
  const code = `const t=require(${JSON.stringify(path.join(root, 'src/telnyx'))});
    const r=t.verifyTelnyxSignature({rawBody:Buffer.from('{}'),headers:{'telnyx-signature-ed25519':'x','telnyx-timestamp':String(Math.floor(Date.now()/1000))},publicKeyB64:''});
    const bad=t.verifyTelnyxSignature({rawBody:Buffer.from('{}'),headers:{},publicKeyB64:'bm90LWEta2V5'});
    console.log(JSON.stringify([r,bad]));`;
  const out = spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8' });
  const [r, bad] = JSON.parse(out.stdout);
  assert.deepEqual(r, { ok: false, status: 503, reason: 'webhook not configured' });
  assert.equal(bad.status, 503); // a key that is not 32 bytes is treated as not configured
});

// ---- Billing view ---------------------------------------------------------------------
test('billing view shows subscriptions, next payment, invoices and card last 4 only', async () => {
  assert.notEqual(run('scripts/manage.js', 'set-card', '--client', demo.clientId, '--last4', '4242424242424242').status, 0); // full number refused
  assert.equal(run('scripts/manage.js', 'set-card', '--client', demo.clientId, '--last4', '4242', '--brand', 'Visa', '--exp', '08/2028').status, 0);
  assert.equal(run('scripts/manage.js', 'set-subscription', '--client', demo.clientId, '--service', 'front-desk', '--next-billing', '2099-01-15').status, 0);
  assert.equal(run('scripts/manage.js', 'add-invoice', '--client', demo.clientId, '--amount-cents', '17900', '--status', 'paid',
    '--issued-at', '2026-11-01T12:00:00Z', '--paid-at', '2026-11-01T12:05:00Z', '--pdf-url', 'https://pay.stripe.com/invoice/test/pdf').status, 0);
  assert.notEqual(run('scripts/manage.js', 'add-invoice', '--client', demo.clientId, '--amount-cents', '100', '--status', 'paid', '--pdf-url', 'javascript:alert(1)').status, 0);

  const { session } = await login(demo.email, 'a-brand-new-pass');
  const data = await (await fetch(`${base}/app/data`, { headers: { cookie: `ae_session=${session}` } })).json();
  const b = data.billing;
  assert.equal(b.card.last4, '4242');
  assert.equal(b.card.brand, 'Visa');
  assert.deepEqual(Object.keys(b.card).sort(), ['brand', 'exp_month', 'exp_year', 'last4']);
  assert.deepEqual(b.next_payment, { date: '2099-01-15', amount_cents: 17900, services: ['Front Desk'] });
  assert.equal(b.subscriptions[0].service, 'front-desk');
  assert.equal(b.invoices.length, 1);
  assert.equal(b.invoices[0].pdf_url, 'https://pay.stripe.com/invoice/test/pdf');
  assert.ok(!JSON.stringify(b).includes('stripe_'), 'stripe ids should not reach the client');
});

// ---- OPM card ---------------------------------------------------------------------------
test('Online Presence Management card shows profile, reviews, listings and last check', async () => {
  assert.equal(run('scripts/manage.js', 'add-subscription', '--client', demo.clientId, '--service', 'online-presence-management').status, 0);
  const keyOut = run('scripts/manage.js', 'create-key', '--client', demo.clientId, '--label', 'opm agent');
  const key = /API key: (\S+)/.exec(keyOut.stdout)[1];
  const post = (event_type, extra = {}) => api(key, 'POST', '/api/v1/online-presence-management/events',
    { client_id: demo.clientId, event_type, title: event_type.replace(/_/g, ' '), ...extra });
  for (const t of ['review_received', 'review_received', 'review_replied', 'listing_fixed', 'profile_updated', 'negative_review_flagged']) {
    assert.equal((await post(t)).status, 200);
  }
  assert.equal((await post('check_completed', { metadata: { listings_checked: 20, listings_accurate: 18 } })).status, 200);
  const svc = await (await api(key, 'GET', `/api/v1/clients/${demo.clientId}/services`)).json();
  const opm = svc.services.find((s) => s.service === 'online-presence-management');
  assert.equal(opm.presence.reviews_this_month, 2);
  assert.equal(opm.presence.replies_this_month, 1);
  assert.equal(opm.presence.listings_fixed_this_month, 1);
  assert.equal(opm.presence.flagged_this_month, 1);
  assert.deepEqual(opm.presence.listings, { checked: 20, accurate: 18, percent: 90 });
  assert.ok(opm.presence.last_check_at && opm.presence.profile_updated_at);
  assert.equal(svc.services.find((s) => s.service === 'front-desk').presence, undefined);
});

// ---- Support messages and admin view -----------------------------------------------------
test('client can message AE support; admin sees it and marks it handled', async () => {
  const { session } = await login(demo.email, 'a-brand-new-pass');
  const csrf = 'y'.repeat(24);
  const send = (body, cookie = `ae_session=${session}; ae_csrf=${csrf}`) => fetch(`${base}/app/support`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
  assert.equal((await send({ _csrf: 'wrong'.repeat(5), message: 'hi' })).status, 400);       // CSRF
  assert.equal((await send({ _csrf: csrf, message: '   ' })).status, 400);                    // empty
  assert.equal((await send({ _csrf: csrf, message: 'x'.repeat(2001) })).status, 400);        // too long
  assert.equal((await send({ _csrf: csrf, message: 'hi' }, `ae_csrf=${csrf}`)).status, 401); // not signed in
  const ok = await send({ _csrf: csrf, subject: 'Question about my bill', message: '<b>Can we talk</b> about the invoice?' });
  assert.equal(ok.status, 200);
  const { id } = await ok.json();
  assert.match(id, /^msg_[0-9a-f]{16}$/);

  // A client account cannot reach the admin action.
  const clientTry = await fetch(`${base}/admin/support/${id}/handled`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `ae_session=${session}; ae_csrf=${csrf}` }, body: new URLSearchParams({ _csrf: csrf }) });
  assert.equal(clientTry.status, 403);
  const clientPage = await (await fetch(`${base}/dashboard`, { headers: { cookie: `ae_session=${session}` } })).text();
  assert.ok(!clientPage.includes('Support messages'), 'client saw the admin view');

  assert.equal(run('scripts/manage.js', 'create-admin', '--email', 'staff@example.com', '--password', 'staff-password-123').status, 0);
  const admin = await login('staff@example.com', 'staff-password-123');
  const adminSettings = await fetch(`${base}/settings`, { redirect: 'manual', headers: { cookie: `ae_session=${admin.session}` } });
  assert.equal(adminSettings.status, 303);                                                  // staff have no client settings
  assert.match(adminSettings.headers.get('location') || '', /\/dashboard$/);
  const adminBilling = await fetch(`${base}/billing`, { redirect: 'manual', headers: { cookie: `ae_session=${admin.session}` } });
  assert.equal(adminBilling.status, 303);                                                   // staff have no client billing
  assert.match(adminBilling.headers.get('location') || '', /\/dashboard$/);
  const page = await (await fetch(`${base}/dashboard`, { headers: { cookie: `ae_session=${admin.session}` } })).text();
  assert.match(page, /Riverside Plumbing \(Demo\)/);
  assert.match(page, /Online Presence Management/);
  assert.match(page, /Question about my bill/);
  assert.match(page, /&lt;b&gt;Can we talk&lt;\/b&gt;/);                                      // escaped, not rendered
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(page.replace(/<[^>]+>/g, '')), 'ISO date with dashes shown on the admin page');
  assert.equal((await fetch(`${base}/app/data`, { headers: { cookie: `ae_session=${admin.session}` } })).status, 403);

  const handled = await fetch(`${base}/admin/support/${id}/handled`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `ae_session=${admin.session}; ae_csrf=${csrf}` }, body: new URLSearchParams({ _csrf: csrf }) });
  assert.equal(handled.status, 303);
  const after = await (await fetch(`${base}/dashboard`, { headers: { cookie: `ae_session=${admin.session}` } })).text();
  assert.match(after, /Handled Nov|Handled [A-Z][a-z]{2} \d/);
  assert.ok(!after.includes(`/admin/support/${id}/handled`));
});

test('Client | Internal toggle renders on every signed-in page; Client mode is unchanged', async () => {
  const { session } = await login(demo.email, 'a-brand-new-pass');
  const admin = await login('staff@example.com', 'staff-password-123');
  const get = async (p, s) => (await fetch(`${base}${p}`, { headers: { cookie: `ae_session=${s}` } })).text();
  for (const p of ['/dashboard', '/inbox', '/settings', '/billing']) {
    const html = await get(p, session);
    assert.match(html, /class="modeswitch" role="group" aria-label="Portal mode"/, `${p} has no toggle`);
    assert.match(html, /data-mode="client" aria-pressed="true">Client</);          // Client is the default
    assert.match(html, /data-mode="internal" aria-pressed="false">Internal</);
    assert.ok(html.includes('data-internal-base="https://anthony-macbookpro14-1.taild6c356.ts.net:8446"'));
    // Client wiring is exactly as before: same nav, same app script, loaded before the toggle script.
    for (const href of ['/dashboard', '/inbox', '/settings', '/billing']) assert.ok(html.includes(`href="${href}"`));
    assert.ok(html.indexOf('/static/app.js') > -1 && html.indexOf('/static/app.js') < html.indexOf('/static/internal.js'));
  }
  const adminHtml = await get('/dashboard', admin.session);
  assert.match(adminHtml, /class="modeswitch"/);                                       // staff page too
  assert.ok(adminHtml.includes('/static/internal.js'));
  // Sign-in pages are not part of the portal shell: no toggle, no internal script.
  const loginHtml = await (await fetch(`${base}/login`)).text();
  assert.ok(!loginHtml.includes('modeswitch') && !loginHtml.includes('internal.js'));
  // Client data path unchanged.
  const data = await fetch(`${base}/app/data`, { headers: { cookie: `ae_session=${session}` } });
  assert.equal(data.status, 200);
});

test('Internal mode is browser-only: static module served, CSP allows only the MBP origin, no new server routes', async () => {
  const js = await fetch(`${base}/static/internal.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  const csp = js.headers.get('content-security-policy');
  assert.ok(csp.includes("connect-src 'self' https://anthony-macbookpro14-1.taild6c356.ts.net:8446;"), csp);
  assert.ok(csp.includes("default-src 'self'") && csp.includes("script-src 'self'"));
  const src = await js.text();
  assert.ok(!/localStorage\.setItem\(\s*KEY_NAME/.test(src) && /store\('sessionStorage'\)/.test(src), 'agent key must use sessionStorage only');
  assert.ok(!src.includes('/api/v1/'), 'Internal mode must not touch client API routes');
  for (const p of ['/internal', '/api/internal', '/api/goals', '/api/outreach', '/api/gifts']) {
    const status = (await fetch(`${base}${p}`, { redirect: 'manual' })).status;
    assert.ok([303, 401, 404].includes(status), `${p} should not serve internal data (got ${status})`);
  }
});
