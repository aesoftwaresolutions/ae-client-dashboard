'use strict';
// Purchase fulfillment watcher: fixture-driven checks of the Node port plus
// the admin view that surfaces pending sales. No live Stripe calls here;
// the fixture path exercises the same branch dispatch as the live run.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const script = path.join(root, 'scripts/purchase-fulfillment.js');

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aeff-'));
}

function runFulfill(dataDir, args, extraEnv = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, DATA_DIR: dataDir, ...extraEnv },
    encoding: 'utf8',
  });
}

function fixtureFile(dataDir, charges) {
  const p = path.join(dataDir, 'fixture.json');
  fs.writeFileSync(p, JSON.stringify({
    customer_id: 'cus_TEST123',
    receipt_email: 'testowner@example.com',
    buyer_name: 'Test Owner',
    business: 'Test Bakery LLC',
    charges,
  }));
  return p;
}

const SFD = { id: 'ch_TESTSFD001', price_id: 'price_1USi2XEpan91NQaRcRj7fJdr', amount: 19900, created: 1795339000, status: 'succeeded', refunded: false };
const AUDIT = { id: 'ch_TESTAUD001', price_id: 'price_1UOimzEpan91NQaRyCECCUwA', amount: 25000, created: 1795339001, status: 'succeeded', refunded: false };
const FEE = { id: 'ch_TESTFEE001', price_id: 'price_1USi2YEpan91NQaRj9ZueK39', amount: 7500, created: 1795339002, status: 'succeeded', refunded: false };
const UNKNOWN = { id: 'ch_TESTUNK001', price_id: 'price_1ZZZUNKNOWN', amount: 1000, created: 1795339003, status: 'succeeded', refunded: false };

test('--check fails closed without a Stripe key', () => {
  const dir = tmpDataDir();
  try {
    const r = runFulfill(dir, ['--check']);
    assert.equal(r.status, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(out.key_present, false);
    assert.equal(out.watermark, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('--set-watermark seeds the watermark file', () => {
  const dir = tmpDataDir();
  try {
    const r = runFulfill(dir, ['--set-watermark', '1792707816']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'purchase_watermark.txt'), 'utf8'), '1792707816');
    const check = runFulfill(dir, ['--check']);
    assert.equal(JSON.parse(check.stdout).watermark, 1792707816);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fixture run writes fulfillment records and leaves the watermark alone', () => {
  const dir = tmpDataDir();
  try {
    runFulfill(dir, ['--set-watermark', '1792707816']);
    const f = fixtureFile(dir, [SFD, AUDIT]);
    const r = runFulfill(dir, ['--fixture', f]);
    assert.equal(r.status, 0, r.stderr);
    const summary = JSON.parse(r.stdout);
    assert.equal(summary.charges_found, 2);
    assert.equal(summary.failed.length, 0);
    assert.equal(summary.watermark_after, 1792707816); // no --commit-watermark

    const sfd = JSON.parse(fs.readFileSync(path.join(dir, 'fulfillment/ch_TESTSFD001.json'), 'utf8'));
    assert.equal(sfd.product, 'Social Front Desk');
    assert.equal(sfd.amount_label, '$199.00');
    assert.equal(sfd.buyer.email, 'testowner@example.com');
    assert.equal(sfd.buyer.business, 'Test Bakery LLC');
    assert.equal(sfd.status, 'pending');
    assert.ok(sfd.muse_setup && sfd.muse_setup.renders_pending_agent);
    assert.ok(sfd.draft_email && sfd.draft_email.subject.includes('Welcome'));
    assert.ok(sfd.needs_anthony.length > 0);

    const audit = JSON.parse(fs.readFileSync(path.join(dir, 'fulfillment/ch_TESTAUD001.json'), 'utf8'));
    assert.equal(audit.product, 'Missed-Lead Audit');
    assert.equal(audit.amount_label, '$250.00');
    assert.match(audit.needs_anthony.join(' '), /Missed-Lead Audit research/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fixture run with --commit-watermark advances the watermark', () => {
  const dir = tmpDataDir();
  try {
    runFulfill(dir, ['--set-watermark', '1792707816']);
    const f = fixtureFile(dir, [SFD, AUDIT]);
    const r = runFulfill(dir, ['--fixture', f, '--commit-watermark']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).watermark_after, 1795339001);
    assert.equal(fs.readFileSync(path.join(dir, 'purchase_watermark.txt'), 'utf8'), '1795339001');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fixture run with --mock-telnyx provisions the client automatically', () => {
  const dir = tmpDataDir();
  try {
    runFulfill(dir, ['--set-watermark', '1792707816']);
    const f = fixtureFile(dir, [SFD]);
    const r = runFulfill(dir, ['--fixture', f, '--mock-telnyx']);
    assert.equal(r.status, 0, r.stderr);
    const summary = JSON.parse(r.stdout);
    assert.equal(summary.failed.length, 0);
    const sfd = JSON.parse(fs.readFileSync(path.join(dir, 'fulfillment/ch_TESTSFD001.json'), 'utf8'));
    assert.equal(sfd.product, 'Social Front Desk');
    assert.ok(sfd.provisioning, 'record carries provisioning state');
    assert.equal(sfd.provisioning.done, true);
    assert.equal(sfd.provisioning.steps.client.status, 'done');
    assert.equal(sfd.provisioning.steps.user.status, 'done');
    assert.equal(sfd.provisioning.steps.subscription.status, 'done');
    assert.equal(sfd.provisioning.steps.agent.status, 'done');
    assert.equal(sfd.provisioning.steps.number.status, 'done');
    assert.equal(sfd.provisioning.steps.number.detail.phone_number, '+17175550100');
    assert.equal(sfd.provisioning.steps.link.status, 'done');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('new Front Desk $179 tier and Total Presence prices are recognized and provision', () => {
  const dir = tmpDataDir();
  try {
    runFulfill(dir, ['--set-watermark', '1792707816']);
    const fd179 = { id: 'ch_TESTFD179', price_id: 'price_1UfAx7Epan91NQaRBLT2tIEk', amount: 25400, created: 1795339005, status: 'succeeded', refunded: false };
    const tp = { id: 'ch_TESTTP001', price_id: 'price_1UfAuSEpan91NQaRyig1Ff7E', amount: 19900, created: 1795339006, status: 'succeeded', refunded: false };
    const f = fixtureFile(dir, [fd179, tp]);
    const r = runFulfill(dir, ['--fixture', f, '--mock-telnyx']);
    assert.equal(r.status, 0, r.stderr);
    const summary = JSON.parse(r.stdout);
    assert.equal(summary.failed.length, 0);
    const fd = JSON.parse(fs.readFileSync(path.join(dir, 'fulfillment/ch_TESTFD179.json'), 'utf8'));
    assert.equal(fd.product, 'Front Desk 150');
    assert.equal(fd.provisioning.done, true);
    assert.equal(fd.provisioning.steps.agent.status, 'done');
    assert.equal(fd.provisioning.steps.link.status, 'done');
    const total = JSON.parse(fs.readFileSync(path.join(dir, 'fulfillment/ch_TESTTP001.json'), 'utf8'));
    assert.equal(total.product, 'Total Presence');
    assert.equal(total.provisioning.done, true);
    assert.equal(total.provisioning.steps.subscription.detail.service, 'total-presence');
    assert.equal(total.provisioning.steps.agent, undefined, 'Total Presence gets no phone agent');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup fee folds into its subscription and unknown prices are flagged', () => {
  const dir = tmpDataDir();
  try {
    runFulfill(dir, ['--set-watermark', '1792707816']);
    const f = fixtureFile(dir, [FEE, UNKNOWN]);
    const r = runFulfill(dir, ['--fixture', f]);
    assert.equal(r.status, 0, r.stderr);
    const summary = JSON.parse(r.stdout);
    assert.equal(summary.processed.find((p) => p.charge_id === 'ch_TESTFEE001').status, 'setup-fee-folded');
    assert.equal(fs.existsSync(path.join(dir, 'fulfillment/ch_TESTFEE001.json')), false);
    assert.equal(summary.processed.find((p) => p.charge_id === 'ch_TESTUNK001').status, 'unknown-product');
    assert.match(summary.processed.find((p) => p.charge_id === 'ch_TESTUNK001').needs_anthony.join(' '), /identify and fulfill by hand/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('listFulfillments and markFulfillmentHandled round trip', () => {
  const dir = tmpDataDir();
  try {
    const { listFulfillments, markFulfillmentHandled, buildRecord } = require(script);
    const rec = buildRecord(
      { id: 'ch_TESTSFD001', amount: 19900, created: 1795339000 },
      { customer_id: 'cus_TEST123', email: 'testowner@example.com', name: 'Test Owner', business: 'Test Bakery LLC' },
      { priceId: 'price_1USi2XEpan91NQaRcRj7fJdr', product: 'Social Front Desk', kind: 'subscription', label: '$199/mo' },
      null,
    );
    assert.equal(rec.product, 'Social Front Desk');
    // Write through a fixture run, then list/mark.
    runFulfill(dir, ['--set-watermark', '1792707816']);
    runFulfill(dir, ['--fixture', fixtureFile(dir, [SFD])]);
    const listed = listFulfillments(dir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].charge_id, 'ch_TESTSFD001');
    const handled = markFulfillmentHandled('ch_TESTSFD001', dir);
    assert.equal(handled.status, 'handled');
    assert.ok(handled.handled_at);
    assert.equal(listFulfillments(dir)[0].status, 'handled');
    assert.throws(() => markFulfillmentHandled('../escape', dir), /Bad charge id/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- Admin view: pending sales show, mark handled works ---------------------------
test('admin dashboard lists a pending sale and marks it fulfilled', async () => {
  const dataDir = tmpDataDir();
  const port = 3800 + Math.floor(Math.random() * 90);
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), NODE_ENV: 'test', MAIL_MODE: 'console', BASE_URL: base };
  const run = (s, ...a) => spawnSync(process.execPath, [path.join(root, s), ...a], { env, encoding: 'utf8' });
  let server; let serverLog = '';
  try {
    const seed = run('scripts/seed.js');
    assert.equal(seed.status, 0, seed.stderr);
    assert.equal(run('scripts/manage.js', 'create-admin', '--email', 'staff@example.com', '--password', 'staff-password-123').status, 0);
    runFulfill(dataDir, ['--set-watermark', '1792707816']);
    runFulfill(dataDir, ['--fixture', fixtureFile(dataDir, [SFD])]);

    server = spawn(process.execPath, [path.join(root, 'server.js')], { env });
    server.stdout.on('data', (d) => { serverLog += d; });
    for (let i = 0; i < 50 && !serverLog.includes('listening'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(serverLog.includes('listening'), 'server did not start');

    const cookieOf = (res, name) => (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) || '').split(';')[0].split('=')[1];
    const loginPage = await fetch(`${base}/login`);
    const csrf = cookieOf(loginPage, 'ae_csrf');
    const loginRes = await fetch(`${base}/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `ae_csrf=${csrf}` },
      body: new URLSearchParams({ _csrf: csrf, email: 'staff@example.com', password: 'staff-password-123' }),
    });
    assert.equal(loginRes.status, 303);
    const session = cookieOf(loginRes, 'ae_session');
    const page = await (await fetch(`${base}/dashboard`, { headers: { cookie: `ae_session=${session}` } })).text();
    assert.match(page, /New sales \(1 pending\)/);
    assert.match(page, /Social Front Desk/);
    assert.match(page, /testowner@example\.com/);
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(page.replace(/<[^>]+>/g, '')), 'ISO date with dashes shown on the admin page');

    const handled = await fetch(`${base}/admin/fulfillment/ch_TESTSFD001/handled`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `ae_session=${session}; ae_csrf=${csrf}` },
      body: new URLSearchParams({ _csrf: csrf }) });
    assert.equal(handled.status, 303);
    const after = await (await fetch(`${base}/dashboard`, { headers: { cookie: `ae_session=${session}` } })).text();
    assert.match(after, /New sales/);
    assert.ok(!after.includes('New sales (1 pending)'));
  } finally {
    if (server) server.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
