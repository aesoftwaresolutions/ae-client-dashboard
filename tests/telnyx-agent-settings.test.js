'use strict';
// Client-facing AI Agent settings: saving PATCHes the Telnyx assistant and
// only then stores the settings locally; a client can only touch their own
// agent; a Telnyx failure leaves the local config unchanged. All Telnyx
// calls go through a stub fetch (no network) on a temp database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aedash-agent-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.TELNYX_API_KEY = 'test-key';

const { db } = require(path.join(root, 'src/db'));
const store = require(path.join(root, 'src/store'));
const settings = require(path.join(root, 'src/telnyx-agent-settings'));

const ASSISTANT_ID = 'assistant-test-1';
const NUMBER = '+19729440615';
let clientA;
let clientB;

function makeStub({ patchStatus = 200, patchBody = null } = {}) {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    const json = async () => {
      if ((opts.method || 'GET') === 'GET' && url.includes('/v2/ai/assistants/')) {
        return { data: { id: ASSISTANT_ID, name: 'Aria', greeting: 'Hello, thanks for calling.', instructions: 'Live instructions from Telnyx.', model: 'zai-org/GLM-5.3-Flash',
          voice_settings: { voice: 'Telnyx.Ultra.f786b574-daa5-4673-aa0c-cbe3e8534c02', voice_speed: 1 },
          tools: [{ tool_id: 'tool-1', type: 'transfer', timeout_ms: 5000, shared: false, transfer: { from: NUMBER, targets: [{ name: 'Owner', to: '+17179771021' }] } }] } };
      }
      if (opts.method === 'PATCH' && url.includes('/v2/ai/assistants/')) {
        if (patchStatus !== 200) return { errors: [{ detail: 'assistant not found' }] };
        return { data: { id: ASSISTANT_ID, ...(patchBody || { name: 'Aria', greeting: 'Hi', instructions: 'x' }) } };
      }
      throw new Error(`unexpected call ${opts.method || 'GET'} ${url}`);
    };
    return { ok: patchStatus === 200 || !(opts.method === 'PATCH'), status: patchStatus, json };
  };
  return { fetchFn, calls };
}

const FIELDS = {
  agent_name: 'Rosie',
  greeting: 'Thanks for calling Test Co. How can I help?',
  business_description: 'A family plumbing company in Chambersburg.',
  services_offered: 'Drain cleaning, water heaters, leak repair',
  business_hours: 'Monday to Friday, 8am to 5pm',
  use_custom_instructions: false,
  instructions: '',
};

test.before(() => {
  clientA = store.createClient({ businessName: 'Test Co', contactName: 'Test', email: 'test-a@example.com', phone: '+17175550100' });
  store.addSubscription({ clientId: clientA, service: 'front-desk', plan: 'Front Desk 99', priceCents: 9900, billing: 'monthly' });
  store.addTelnyxAgent({ clientId: clientA, service: 'front-desk', assistantId: ASSISTANT_ID, phone: NUMBER, transferPhone: '+17179771021', callLimit: 60 });
  // A second client with their own agent, to prove the ownership boundary.
  clientB = store.createClient({ businessName: 'Other Co', contactName: 'Other', email: 'test-b@example.com', phone: '+17175550101' });
  store.addSubscription({ clientId: clientB, service: 'front-desk', plan: 'Front Desk 99', priceCents: 9900, billing: 'monthly' });
  store.addTelnyxAgent({ clientId: clientB, service: 'front-desk', assistantId: 'assistant-test-2', phone: '+19729440616', transferPhone: '+17179771022', callLimit: 60 });
});

test.after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

test('saving settings PATCHes Telnyx with the right body, then stores locally', async () => {
  const { fetchFn, calls } = makeStub();
  const result = await settings.saveAgentSettings({ clientId: clientA, fields: FIELDS, fetchFn });
  assert.equal(result.ok, true, JSON.stringify(result));

  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch, 'expected a PATCH call');
  assert.match(patch.url, new RegExp(`/v2/ai/assistants/${ASSISTANT_ID}$`));
  assert.equal(patch.body.name, 'Rosie');
  assert.equal(patch.body.greeting, 'Thanks for calling Test Co. How can I help?');
  // Generated instructions: built from the business fields, in the v3 style.
  assert.match(patch.body.instructions, /Test Co/);
  assert.match(patch.body.instructions, /family plumbing company/);
  assert.match(patch.body.instructions, /Drain cleaning/);
  assert.match(patch.body.instructions, /Monday to Friday, 8am to 5pm/);
  assert.match(patch.body.instructions, /one or two sentences/);
  assert.match(patch.body.instructions, /Do not pitch/);
  assert.match(patch.body.instructions, /Never invent a price/);
  // Only name, greeting and instructions go to Telnyx; never the model or tools.
  assert.deepEqual(Object.keys(patch.body).sort(), ['greeting', 'instructions', 'name']);

  const saved = store.getAgentSettings(store.getTelnyxAgent(clientA).id);
  assert.equal(saved.agent_name, 'Rosie');
  assert.equal(saved.business_description, 'A family plumbing company in Chambersburg.');
  assert.equal(saved.custom_instructions, false);
  assert.match(saved.instructions, /Test Co/);

  const agent = db.prepare('SELECT name, instructions_hash FROM telnyx_agents WHERE telnyx_assistant_id = ?').get(ASSISTANT_ID);
  assert.equal(agent.name, 'Rosie');
  assert.equal(agent.instructions_hash.length, 64);
});

test('custom instructions are used verbatim', async () => {
  const { fetchFn, calls } = makeStub();
  const result = await settings.saveAgentSettings({
    clientId: clientA,
    fields: { ...FIELDS, agent_name: 'Rosie', use_custom_instructions: true, instructions: 'Answer the phone and be nice.' },
    fetchFn,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.body.instructions, 'Answer the phone and be nice.');
  const saved = store.getAgentSettings(store.getTelnyxAgent(clientA).id);
  assert.equal(saved.custom_instructions, true);
  assert.equal(saved.instructions, 'Answer the phone and be nice.');
});

test('changing the voice PATCHes voice_settings and stores it locally', async () => {
  const { fetchFn, calls } = makeStub();
  const clara = settings.VOICES.find((v) => v.name === 'Clara').id;
  const result = await settings.saveAgentSettings({
    clientId: clientA,
    fields: { ...FIELDS, voice: clara },
    fetchFn,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch.body.voice_settings, 'expected voice_settings in the PATCH');
  assert.equal(patch.body.voice_settings.voice, clara);
  // The rest of the live voice settings are carried over, not wiped.
  assert.equal(patch.body.voice_settings.voice_speed, 1);
  const saved = store.getAgentSettings(store.getTelnyxAgent(clientA).id);
  assert.equal(saved.voice, clara);
});

test('changing the voice speed PATCHes voice_settings without touching the voice', async () => {
  const { fetchFn, calls } = makeStub();
  const result = await settings.saveAgentSettings({
    clientId: clientA,
    fields: { ...FIELDS, voice_speed: '1.25' },
    fetchFn,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.body.voice_settings.voice_speed, 1.25);
  assert.equal(patch.body.voice_settings.voice, 'Telnyx.Ultra.f786b574-daa5-4673-aa0c-cbe3e8534c02');
  const saved = store.getAgentSettings(store.getTelnyxAgent(clientA).id);
  assert.equal(saved.voice_speed, 1.25);
});

test('changing the transfer number retargets the transfer tool and stores it', async () => {
  const { fetchFn, calls } = makeStub();
  const result = await settings.saveAgentSettings({
    clientId: clientA,
    fields: { ...FIELDS, transfer_phone: '717-555-0199' },
    fetchFn,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch.body.tools, 'expected tools in the PATCH');
  const tool = patch.body.tools.find((t) => t.type === 'transfer');
  assert.ok(tool, 'expected a transfer tool');
  assert.equal(tool.transfer.targets[0].to, '+17175550199');
  // The tool itself is preserved (id, timeout, from number).
  assert.equal(tool.tool_id, 'tool-1');
  assert.equal(tool.transfer.from, NUMBER);
  const saved = store.getAgentSettings(store.getTelnyxAgent(clientA).id);
  assert.equal(saved.transfer_phone, '+17175550199');
  const agent = db.prepare('SELECT transfer_phone_number FROM telnyx_agents WHERE telnyx_assistant_id = ?').get(ASSISTANT_ID);
  assert.equal(agent.transfer_phone_number, '+17175550199');
});

test('an unchanged voice and transfer number are not sent to Telnyx', async () => {
  const { fetchFn, calls } = makeStub();
  // Use the transfer number currently stored for this agent (an earlier test
  // may have changed it), so the number is genuinely unchanged here.
  const currentTransfer = db.prepare('SELECT transfer_phone_number FROM telnyx_agents WHERE telnyx_assistant_id = ?').get(ASSISTANT_ID).transfer_phone_number;
  const result = await settings.saveAgentSettings({
    clientId: clientA,
    fields: { ...FIELDS, voice: 'Telnyx.Ultra.f786b574-daa5-4673-aa0c-cbe3e8534c02', voice_speed: '1', transfer_phone: currentTransfer },
    fetchFn,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.equal('voice_settings' in patch.body, false, 'unchanged voice should not be PATCHed');
  assert.equal('tools' in patch.body, false, 'unchanged transfer number should not be PATCHed');
});

test('an unknown voice, a bad speed and a bad transfer number are rejected before any PATCH', async () => {
  const { fetchFn, calls } = makeStub();
  const badVoice = await settings.saveAgentSettings({ clientId: clientA, fields: { ...FIELDS, voice: 'Telnyx.Ultra.not-a-real-voice' }, fetchFn });
  assert.equal(badVoice.ok, false);
  assert.match(badVoice.error, /voice/);
  const badSpeed = await settings.saveAgentSettings({ clientId: clientA, fields: { ...FIELDS, voice_speed: '3' }, fetchFn });
  assert.equal(badSpeed.ok, false);
  assert.match(badSpeed.error, /speed/);
  const badSpeedText = await settings.saveAgentSettings({ clientId: clientA, fields: { ...FIELDS, voice_speed: 'fast' }, fetchFn });
  assert.equal(badSpeedText.ok, false);
  const badPhone = await settings.saveAgentSettings({ clientId: clientA, fields: { ...FIELDS, transfer_phone: '555' }, fetchFn });
  assert.equal(badPhone.ok, false);
  assert.match(badPhone.error, /phone number/);
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
});

test('a client cannot edit another client\u2019s agent', async () => {
  const { fetchFn } = makeStub();
  // Client A has no agent of its own in this scenario is false (A has one),
  // so instead prove the boundary the other way: a client with no agent at
  // all cannot reach someone else's agent by any client id they do not own.
  const clientC = store.createClient({ businessName: 'No Agent Co', contactName: 'None', email: 'test-c@example.com', phone: '+17175550102' });
  store.addSubscription({ clientId: clientC, service: 'front-desk', plan: 'Front Desk 99', priceCents: 9900, billing: 'monthly' });
  const result = await settings.saveAgentSettings({ clientId: clientC, fields: FIELDS, fetchFn });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no-agent');

  // And saving as client A leaves client B's agent and settings untouched.
  const before = db.prepare('SELECT name, instructions_hash FROM telnyx_agents WHERE telnyx_assistant_id = ?').get('assistant-test-2');
  await settings.saveAgentSettings({ clientId: clientA, fields: { ...FIELDS, agent_name: 'Rosie Again' }, fetchFn });
  const after = db.prepare('SELECT name, instructions_hash FROM telnyx_agents WHERE telnyx_assistant_id = ?').get('assistant-test-2');
  assert.deepEqual(after, before);
  assert.equal(store.getAgentSettings(store.getTelnyxAgent(clientB).id), null);
});

test('a Telnyx failure leaves the local config unchanged', async () => {
  // Establish a known good local config first.
  const good = makeStub();
  const first = await settings.saveAgentSettings({ clientId: clientA, fields: { ...FIELDS, agent_name: 'Good Name' }, fetchFn: good.fetchFn });
  assert.equal(first.ok, true, JSON.stringify(first));
  const before = store.getAgentSettings(store.getTelnyxAgent(clientA).id);
  const beforeAgent = db.prepare('SELECT name, instructions_hash FROM telnyx_agents WHERE telnyx_assistant_id = ?').get(ASSISTANT_ID);

  // Now Telnyx fails.
  const bad = makeStub({ patchStatus: 404 });
  const result = await settings.saveAgentSettings({ clientId: clientA, fields: { ...FIELDS, agent_name: 'Bad Name' }, fetchFn: bad.fetchFn });
  assert.equal(result.ok, false);
  assert.match(result.error, /404/);

  const after = store.getAgentSettings(store.getTelnyxAgent(clientA).id);
  const afterAgent = db.prepare('SELECT name, instructions_hash FROM telnyx_agents WHERE telnyx_assistant_id = ?').get(ASSISTANT_ID);
  assert.deepEqual(after, before);
  assert.deepEqual(afterAgent, beforeAgent);
});

test('without saved settings the form pre-fills from the live assistant', async () => {
  // Client B has an agent but has never saved settings.
  const { fetchFn } = makeStub();
  const effective = await settings.getEffectiveSettings(clientB, fetchFn);
  assert.ok(effective);
  assert.equal(effective.fromTelnyx, true);
  assert.equal(effective.settings.agent_name, 'Aria');
  assert.equal(effective.settings.greeting, 'Hello, thanks for calling.');
  assert.equal(effective.settings.instructions, 'Live instructions from Telnyx.');
  assert.equal(effective.settings.business_description, '');
});

test('buildInstructions is plain and complete from the business fields', () => {
  const text = settings.buildInstructions({
    businessName: 'Test Co',
    agentName: 'Rosie',
    greeting: 'Thanks for calling Test Co.',
    businessDescription: 'A family plumbing company.',
    servicesOffered: 'Drain cleaning, water heaters',
    businessHours: 'Monday to Friday, 8am to 5pm',
    transferPhone: '+17179771021',
  });
  assert.match(text, /AI receptionist for Test Co/);
  assert.match(text, /Thanks for calling Test Co\./);
  assert.match(text, /family plumbing company/);
  assert.match(text, /Services offered: Drain cleaning, water heaters/);
  assert.match(text, /Business hours: Monday to Friday, 8am to 5pm/);
  assert.match(text, /transfer the call to the owner/);
  assert.match(text, /Never take a payment/);
  // Empty sections are left out, not guessed at.
  const bare = settings.buildInstructions({ businessName: 'Bare Co', agentName: 'Bo', greeting: 'Hi.' });
  assert.doesNotMatch(bare, /Services offered/);
  assert.doesNotMatch(bare, /Business hours/);
  assert.match(bare, /AI receptionist for Bare Co/);
});

test('an empty name or greeting is rejected before any Telnyx call', async () => {
  const { fetchFn, calls } = makeStub();
  const noName = await settings.saveAgentSettings({ clientId: clientA, fields: { ...FIELDS, agent_name: '  ' }, fetchFn });
  assert.equal(noName.ok, false);
  const noGreeting = await settings.saveAgentSettings({ clientId: clientA, fields: { ...FIELDS, greeting: '' }, fetchFn });
  assert.equal(noGreeting.ok, false);
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
});

// ---- Route wiring: a real server on its own temp database --------------------
// The seeded demo client has a Front Desk subscription but no Telnyx agent,
// so these routes never reach Telnyx; they prove auth, CSRF and /app/data wiring.
const { spawn, spawnSync } = require('node:child_process');
const routeDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aedash-agent-routes-'));
const routePort = 3900 + Math.floor(Math.random() * 90);
const routeBase = `http://127.0.0.1:${routePort}`;
const routeEnv = { ...process.env, DATA_DIR: routeDataDir, PORT: String(routePort), NODE_ENV: 'test', MAIL_MODE: 'console', BASE_URL: routeBase };
let routeServer; let routeLog = ''; let demo;

const runSeed = (...a) => spawnSync(process.execPath, [path.join(root, 'scripts/seed.js'), ...a], { env: routeEnv, encoding: 'utf8' });
const cookieOf = (res, name) => (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) || '').split(';')[0].split('=')[1];

test.before(async () => {
  const seed = runSeed();
  assert.equal(seed.status, 0, seed.stderr);
  const grab = (k) => new RegExp(`^${k}: (.+)$`, 'm').exec(seed.stdout)[1];
  demo = { email: grab('EMAIL'), password: grab('PASSWORD') };
  routeServer = spawn(process.execPath, [path.join(root, 'server.js')], { env: routeEnv });
  routeServer.stdout.on('data', (d) => { routeLog += d; });
  for (let i = 0; i < 50 && !routeLog.includes('listening'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(routeLog.includes('listening'), 'server did not start');
});
test.after(() => { routeServer.kill(); fs.rmSync(routeDataDir, { recursive: true, force: true }); });

async function routeLogin(email, password) {
  const page = await fetch(`${routeBase}/login`);
  const csrf = cookieOf(page, 'ae_csrf');
  const res = await fetch(`${routeBase}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `ae_csrf=${csrf}` },
    body: new URLSearchParams({ _csrf: csrf, email, password }),
  });
  return { session: cookieOf(res, 'ae_session'), csrf };
}

test('routes: unauthenticated is refused, and a client with no agent gets a plain 404', async () => {
  assert.equal((await fetch(`${routeBase}/app/agent-settings`)).status, 401);
  const { session, csrf } = await routeLogin(demo.email, demo.password);
  assert.ok(session);
  const res = await fetch(`${routeBase}/app/agent-settings`, { headers: { cookie: `ae_session=${session}` } });
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /No Front Desk agent yet/);
  // /app/data carries agent_settings (null until the client saves).
  const data = await (await fetch(`${routeBase}/app/data`, { headers: { cookie: `ae_session=${session}` } })).json();
  assert.ok('agent_settings' in data);
  assert.equal(data.agent_settings, null);
  // POST without a matching CSRF token is refused before any save runs.
  const bad = await fetch(`${routeBase}/app/agent-settings`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `ae_session=${session}` },
    body: JSON.stringify({ _csrf: 'wrong', agent_name: 'X', greeting: 'Hi' }),
  });
  assert.equal(bad.status, 400);
});
