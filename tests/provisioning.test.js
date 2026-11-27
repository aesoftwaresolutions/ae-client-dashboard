'use strict';
// Auto-provisioning: a fulfilled charge creates the dashboard client, login
// user, and subscription automatically, and for call-answering products a
// Telnyx assistant (cloned from the Aria template) plus a phone number,
// linked to the client. No human or AI is needed after payment. Every step
// is idempotent: re-running the same record creates nothing twice. All
// Telnyx calls go through a stub fetch (no network) on a temp database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aedash-prov-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.TELNYX_API_KEY = 'test-key';

const { db } = require(path.join(root, 'src/db'));
const store = require(path.join(root, 'src/store'));
const provisioning = require(path.join(root, 'src/provisioning'));

// Shared across stubs so every number search in the whole file returns a
// fresh number (the DB is shared across tests; a repeated number would trip
// the telnyx_agents phone UNIQUE constraint, as in production).
let agentSeq = 1;
let numberSeq = 100;

function makeTelnyxStub() {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ url, method, body: opts.body ? JSON.parse(opts.body) : undefined });
    const json = async () => {
      if (method === 'POST' && url.includes('/ai/assistants')) {
        return { id: `assistant-mock-${String(agentSeq++).padStart(4, '0')}`, name: 'Mock Agent' };
      }
      if (method === 'GET' && url.includes('/phone_numbers/search')) {
        // Each search returns a fresh number so two agents never collide on
        // the telnyx_agents phone UNIQUE constraint (as in production).
        const n = `+1717555${String(numberSeq++).padStart(4, '0')}`;
        return { data: [{ phone_number: n }, { phone_number: '+17175550999' }] };
      }
      if (method === 'POST' && url.includes('/phone_numbers')) {
        // Echo the number the caller asked to buy (the search result), so
        // each purchase gets the fresh number from its own search.
        const requested = (opts.body && JSON.parse(opts.body).phone_number) || '+17175550100';
        return { data: { id: 'phone-mock-0001', phone_number: requested } };
      }
      throw new Error(`unexpected Telnyx call ${method} ${url}`);
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(await json()) };
  };
  return { fetchFn, calls };
}

function frontDeskRecord(overrides = {}) {
  return {
    charge_id: 'ch_test_frontdesk',
    amount: 179,
    buyer: { name: 'Test Owner', email: 'owner@testco.com', business: 'Test Co', phone: '+17175550199' },
    price_id: 'price_test_fd179',
    product: 'Front Desk',
    kind: 'subscription',
    status: 'pending',
    ...overrides,
  };
}

test('a Front Desk charge provisions client, user, subscription, agent, number, and link', async () => {
  const { fetchFn, calls } = makeTelnyxStub();
  const rec = frontDeskRecord();
  const prov = await provisioning.provisionCharge(rec, { fetchFn, telnyxApiKey: 'test-key', store });
  assert.equal(prov.done, true);
  // Client + user + subscription exist in the dashboard DB.
  const client = store.getClientByEmail('owner@testco.com');
  assert.ok(client, 'client created');
  assert.equal(client.business_name, 'Test Co');
  const user = db.prepare('SELECT * FROM users WHERE client_id = ?').get(client.id);
  assert.ok(user, 'login user created');
  assert.equal(user.email, 'owner@testco.com');
  assert.equal(user.must_reset_password, 1, 'temporary password triggers set-password onboarding');
  const sub = db.prepare('SELECT * FROM subscriptions WHERE client_id = ?').get(client.id);
  assert.ok(sub, 'subscription created');
  assert.equal(sub.service, 'front-desk');
  // Telnyx assistant created from the Aria template, number bought, linked.
  const agentCall = calls.find((c) => c.method === 'POST' && c.url.includes('/ai/assistants'));
  assert.ok(agentCall, 'assistant creation called');
  assert.equal(agentCall.body.model, 'zai-org/GLM-5.3-Flash');
  assert.equal(agentCall.body.voice_settings.voice, 'Telnyx.Ultra.f786b574-daa5-4673-aa0c-cbe3e8534c02');
  assert.match(agentCall.body.greeting, /Test Co/);
  assert.match(agentCall.body.instructions, /Test Co/);
  assert.doesNotMatch(agentCall.body.instructions, /\{\{BUSINESS_NAME\}\}/, 'no unfilled placeholders');
  const numberCall = calls.find((c) => c.method === 'POST' && c.url.includes('/phone_numbers'));
  assert.ok(numberCall, 'number purchase called');
  const agent = store.getTelnyxAgent(client.id);
  assert.ok(agent, 'agent linked to client');
  assert.match(agent.telnyx_assistant_id, /^assistant-mock-/);
  assert.equal(agent.telnyx_phone_number, '+17175550100');
  assert.equal(agent.transfer_phone_number, '+17175550199');
  // The record carries the full provisioning state.
  assert.equal(prov.steps.client.status, 'done');
  assert.equal(prov.steps.agent.status, 'done');
  assert.equal(prov.steps.number.status, 'done');
  assert.equal(prov.steps.number.detail.phone_number, '+17175550100');
  assert.equal(prov.steps.number.detail.cost, '$1/mo');
});

test('a non-agent product provisions only account and subscription', async () => {
  const { fetchFn, calls } = makeTelnyxStub();
  const rec = frontDeskRecord({
    charge_id: 'ch_test_opm',
    amount: 199,
    product: 'Online Presence Management',
    buyer: { name: 'OPM Owner', email: 'opm@testco.com', business: 'OPM Co' },
  });
  const prov = await provisioning.provisionCharge(rec, { fetchFn, telnyxApiKey: 'test-key', store });
  assert.equal(prov.done, true);
  const client = store.getClientByEmail('opm@testco.com');
  assert.ok(client, 'client created');
  const sub = db.prepare('SELECT * FROM subscriptions WHERE client_id = ?').get(client.id);
  assert.equal(sub.service, 'online-presence-management');
  assert.equal(calls.length, 0, 'no Telnyx calls for a non-agent product');
  assert.equal(prov.steps.agent, undefined, 'no agent step');
});

test('re-running the same record creates nothing twice (idempotent)', async () => {
  const { fetchFn, calls } = makeTelnyxStub();
  const rec = frontDeskRecord({ charge_id: 'ch_test_idem', buyer: { name: 'Idem Owner', email: 'idem@testco.com', business: 'Idem Co', phone: '+17175550198' } });
  await provisioning.provisionCharge(rec, { fetchFn, telnyxApiKey: 'test-key', store });
  const callsFirst = calls.length;
  const clientsFirst = db.prepare("SELECT COUNT(*) AS n FROM clients WHERE email = 'idem@testco.com'").get().n;
  const usersFirst = db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'idem@testco.com'").get().n;
  const agentsFirst = db.prepare('SELECT COUNT(*) AS n FROM telnyx_agents').get().n;
  // Second run of the same record.
  await provisioning.provisionCharge(rec, { fetchFn, telnyxApiKey: 'test-key', store });
  assert.equal(calls.length, callsFirst, 'no new Telnyx calls on re-run');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM clients WHERE email = 'idem@testco.com'").get().n, clientsFirst, 'no second client');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'idem@testco.com'").get().n, usersFirst, 'no second user');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telnyx_agents').get().n, agentsFirst, 'no second agent');
});

test('a second purchase by the same buyer reuses the client and login', async () => {
  const { fetchFn } = makeTelnyxStub();
  const first = frontDeskRecord({ charge_id: 'ch_test_second1', buyer: { name: 'Repeat Owner', email: 'repeat@testco.com', business: 'Repeat Co', phone: '+17175550196' } });
  const second = frontDeskRecord({
    charge_id: 'ch_test_second2',
    amount: 199,
    product: 'Online Presence Management',
    buyer: { name: 'Repeat Owner', email: 'repeat@testco.com', business: 'Repeat Co' },
  });
  const prov1 = await provisioning.provisionCharge(first, { fetchFn, telnyxApiKey: 'test-key', store });
  assert.equal(prov1.done, true);
  const prov2 = await provisioning.provisionCharge(second, { fetchFn, telnyxApiKey: 'test-key', store });
  assert.equal(prov2.done, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM clients WHERE email = 'repeat@testco.com'").get().n, 1, 'one client');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'repeat@testco.com'").get().n, 1, 'one login');
  const client = store.getClientByEmail('repeat@testco.com');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE client_id = ?').get(client.id).n, 2, 'two subscriptions on the one client');
});

test('an unknown product is skipped for manual setup', async () => {
  const { fetchFn } = makeTelnyxStub();
  const rec = frontDeskRecord({ charge_id: 'ch_test_unknown', product: 'Mystery Product', buyer: { name: 'X', email: 'x@testco.com', business: 'X Co' } });
  const prov = await provisioning.provisionCharge(rec, { fetchFn, telnyxApiKey: 'test-key', store });
  assert.equal(prov.done, false);
  assert.equal(prov.steps.route.status, 'skipped');
  assert.equal(store.getClientByEmail('x@testco.com'), null, 'no client created');
});

test('a setup fee provisions nothing on its own', async () => {
  const { fetchFn } = makeTelnyxStub();
  const rec = frontDeskRecord({ charge_id: 'ch_test_setup', product: 'Front Desk', kind: 'setup-fee', buyer: { name: 'S', email: 's@testco.com', business: 'S Co' } });
  const prov = await provisioning.provisionCharge(rec, { fetchFn, telnyxApiKey: 'test-key', store });
  assert.equal(prov.done, true);
  assert.equal(prov.steps.route.status, 'skipped');
  assert.equal(store.getClientByEmail('s@testco.com'), null, 'no client created');
});

test('a Telnyx failure stops provisioning and records the error', async () => {
  const failingFetch = async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ errors: [{ detail: 'Telnyx is down' }] }) });
  const rec = frontDeskRecord({ charge_id: 'ch_test_fail', buyer: { name: 'F', email: 'fail@testco.com', business: 'F Co', phone: '+17175550197' } });
  const prov = await provisioning.provisionCharge(rec, { fetchFn: failingFetch, telnyxApiKey: 'test-key', store });
  assert.equal(prov.done, false);
  assert.equal(prov.steps.agent.status, 'failed');
  assert.match(prov.steps.agent.error, /Telnyx/);
  // The client and subscription were still created before the agent step.
  assert.ok(store.getClientByEmail('fail@testco.com'), 'client exists even when the agent step fails');
  assert.equal(prov.steps.number, undefined, 'number step never ran');
});
