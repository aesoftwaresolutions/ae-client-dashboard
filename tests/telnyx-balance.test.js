'use strict';
// AE owner-only Telnyx balance on the client dashboard. Anthony signs in as a
// role 'client' user on the AE client, so the balance is added to /app/data
// only for that login (store.isAeOwner). Every other client must never get the
// key in the JSON. Unit tests cover the gate; route tests run a real server on
// its own temp database with an AE owner login and an ordinary client.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aedash-balance-'));
const port = 3800 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), NODE_ENV: 'test', MAIL_MODE: 'console', BASE_URL: base };
delete env.AE_CLIENT_ID;
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
delete process.env.AE_CLIENT_ID;

const store = require(path.join(root, 'src/store'));
const config = require(path.join(root, 'src/config'));

const BALANCE = 987654; // distinctive, so a leak is easy to spot in a raw body
const AE_PW = 'owner-password-123';
const OTHER_PW = 'client-password-123';

const run = (script, ...a) => spawnSync(process.execPath, [path.join(root, script), ...a], { env, encoding: 'utf8' });
const node = (code) => spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8', cwd: root });
const cookieOf = (res, name) => (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) || '').split(';')[0].split('=')[1];
async function login(email, password) {
  const page = await fetch(`${base}/login`);
  const csrf = cookieOf(page, 'ae_csrf');
  const res = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `ae_csrf=${csrf}` },
    body: new URLSearchParams({ _csrf: csrf, email, password }),
  });
  return cookieOf(res, 'ae_session');
}
const appData = async (session) => {
  const r = await fetch(`${base}/app/data`, { headers: { cookie: `ae_session=${session}` } });
  return { status: r.status, body: await r.text() };
};

// --- The gate itself ---------------------------------------------------------
const me = (o = {}) => ({
  user: { email: store.AE_OWNER_EMAIL, role: 'client', client_id: 'cl_ae', ...o.user },
  client: o.client === null ? null : { id: 'cl_ae', business_name: 'AE', ...o.client },
});

test('isAeOwner: only the AE owner login on its own client passes', () => {
  assert.equal(store.isAeOwner(me()), true);
  assert.equal(store.isAeOwner(me({ user: { email: 'Anthony@AESoftwareSolutions.com' } })), true); // logins are case-insensitive
  assert.equal(store.isAeOwner(me({ user: { email: 'demo@example.com' } })), false);
  assert.equal(store.isAeOwner(me({ user: { role: 'admin' } })), false);
  assert.equal(store.isAeOwner(me({ client: null })), false);
  assert.equal(store.isAeOwner(me({ user: { client_id: 'cl_other' } })), false); // user and client must agree
  assert.equal(store.isAeOwner(null), false);
  assert.equal(store.isAeOwner({}), false);
});

test('isAeOwner: AE_CLIENT_ID, when set, pins the owner to that client', () => {
  const was = config.aeClientId;
  try {
    config.aeClientId = 'cl_ae';
    assert.equal(store.isAeOwner(me()), true);
    config.aeClientId = 'cl_7c6471482e77ce6e';
    assert.equal(store.isAeOwner(me()), false);
  } finally { config.aeClientId = was; }
});

// --- Real server: AE owner vs an ordinary client ----------------------------
let server; let log = '';
test.before(async () => {
  assert.equal(run('scripts/manage.js', 'create-client', '--business', 'AE Software Solutions LLC',
    '--email', store.AE_OWNER_EMAIL, '--password', AE_PW).status, 0);
  assert.equal(run('scripts/manage.js', 'create-client', '--business', 'Other Client Co',
    '--email', 'other@example.com', '--password', OTHER_PW).status, 0);
  // A synced balance, as the Telnyx sync would leave it.
  const seeded = node(`const { db } = require('./src/db');
    db.prepare("INSERT INTO telnyx_account (id, balance_cents, currency, updated_at) VALUES (1, ${BALANCE}, 'USD', '2026-11-25T16:00:00.000Z') ON CONFLICT(id) DO UPDATE SET balance_cents = excluded.balance_cents").run();`);
  assert.equal(seeded.status, 0, seeded.stderr);
  server = spawn(process.execPath, [path.join(root, 'server.js')], { env });
  server.stdout.on('data', (d) => { log += d; });
  for (let i = 0; i < 50 && !log.includes('listening'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(log.includes('listening'), 'server did not start');
});
test.after(() => { if (server) server.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('the AE owner gets the Telnyx balance in /app/data', async () => {
  const { status, body } = await appData(await login(store.AE_OWNER_EMAIL, AE_PW));
  assert.equal(status, 200);
  const data = JSON.parse(body);
  assert.equal(data.telnyx_balance.balance_cents, BALANCE);
  assert.equal(data.telnyx_balance.currency, 'USD');
});

test('an ordinary client never receives the balance, not even a null key', async () => {
  const { status, body } = await appData(await login('other@example.com', OTHER_PW));
  assert.equal(status, 200);
  assert.ok(!('telnyx_balance' in JSON.parse(body)), 'telnyx_balance key present for a non-AE client');
  assert.ok(!body.includes(String(BALANCE)), 'balance value leaked into a non-AE response');
});

test('a client who sets their business email to the AE address still does not get it', async () => {
  // clients.email is editable from the business profile; the gate must not use it.
  const edited = node(`const { db } = require('./src/db');
    db.prepare("UPDATE clients SET email = ? WHERE email = 'other@example.com'").run('${store.AE_OWNER_EMAIL}');`);
  assert.equal(edited.status, 0, edited.stderr);
  const { body } = await appData(await login('other@example.com', OTHER_PW));
  assert.ok(!('telnyx_balance' in JSON.parse(body)));
  assert.ok(!body.includes(String(BALANCE)));
});

test('AE staff (admin role) do not get it through /app/data either', async () => {
  assert.equal(run('scripts/manage.js', 'create-admin', '--email', 'staff@example.com', '--password', 'staff-password-123').status, 0);
  const { status, body } = await appData(await login('staff@example.com', 'staff-password-123'));
  assert.equal(status, 403);
  assert.ok(!body.includes(String(BALANCE)));
});
