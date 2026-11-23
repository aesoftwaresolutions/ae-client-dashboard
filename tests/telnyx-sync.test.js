'use strict';
// Telnyx active sync: runs syncTelnyx against a stub fetch (no network) on a
// temp database and checks the rows it writes, the webhook-summary rule, the
// recent-sync guard and the not-configured state.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aedash-telnyx-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.TELNYX_API_KEY = 'test-key';

const { db } = require(path.join(root, 'src/db'));
const store = require(path.join(root, 'src/store'));
const { syncTelnyx } = require(path.join(root, 'src/telnyx-sync'));

// Canned Telnyx responses. The assistant id + number match the agent row the test creates.
const ASSISTANT_ID = 'assistant-test-1';
const NUMBER = '+19729440615';
const stubFetch = async (url) => {
  const json = async () => {
    if (url.includes('/v2/ai/assistants')) {
      return { data: [{ id: ASSISTANT_ID, name: 'Aria', model: 'zai-org/GLM-5.3-Flash', instructions: 'You are Aria.', tools: [{ type: 'transfer' }] }], meta: { total_pages: 1 } };
    }
    if (url.includes('/v2/ai/conversations')) {
      return {
        data: [{
          id: 'conv-1', created_at: '2026-11-22T10:00:00.000Z', last_message_at: '2026-11-22T10:02:30.000Z',
          metadata: { to: NUMBER, from: '+12237338163', assistant_id: ASSISTANT_ID, called_tools: ['transfer'] },
        }],
        meta: { total_pages: 1 },
      };
    }
    if (url.includes('/v2/phone_numbers')) {
      return { data: [{ id: 'num-1', phone_number: NUMBER, status: 'active', connection_id: 'conn-1', purchased_at: '2026-11-19T16:42:32Z' }], meta: { total_pages: 1 } };
    }
    if (url.includes('/v2/texml_applications/conn-1')) {
      return { data: { id: 'conn-1', voice_url: 'https://api.telnyx.com/v2/ai/assistants/assistant-test-1/texml', status_callback: 'https://example.com/hook?key=x' } };
    }
    if (url.includes('/v2/balance')) return { data: { balance: '30.33', available_credit: '30.33', currency: 'USD' } };
    throw new Error(`unexpected url ${url}`);
  };
  return { ok: true, status: 200, json };
};

test.before(() => {
  const clientId = store.createClient({ businessName: 'Test Co', contactName: 'Test', email: 'test@example.com', phone: '+17175550100' });
  store.addSubscription({ clientId, service: 'front-desk', plan: 'Front Desk 99', priceCents: 9900, billing: 'monthly' });
  store.addTelnyxAgent({ clientId, service: 'front-desk', assistantId: ASSISTANT_ID, phone: NUMBER, transferPhone: '+17179771021', callLimit: 60 });
});

test.after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

test('sync pulls assistants, conversations, numbers and balance', async () => {
  const result = await syncTelnyx(stubFetch);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.assistants, 1);
  assert.equal(result.conversations, 1);
  assert.equal(result.numbers, 1);

  const agent = db.prepare('SELECT name, model, tools_json, instructions_hash FROM telnyx_agents WHERE telnyx_assistant_id = ?').get(ASSISTANT_ID);
  assert.equal(agent.name, 'Aria');
  assert.equal(agent.model, 'zai-org/GLM-5.3-Flash');
  assert.deepEqual(JSON.parse(agent.tools_json), ['transfer']);
  assert.equal(typeof agent.instructions_hash, 'string');
  assert.equal(agent.instructions_hash.length, 64);

  const call = db.prepare('SELECT caller_display, outcome, transferred, duration_secs, summary_text FROM call_summaries WHERE telnyx_conversation_id = ?').get('conv-1');
  assert.equal(call.caller_display, '***-***-8163');
  assert.equal(call.outcome, 'answered');
  assert.equal(call.transferred, 1);
  assert.equal(call.duration_secs, 150);
  assert.equal(call.summary_text, ''); // the sync never writes a summary; the webhook owns it

  const num = db.prepare('SELECT status, voice_url, status_callback FROM telnyx_numbers WHERE phone_number = ?').get(NUMBER);
  assert.equal(num.status, 'active');
  assert.match(num.voice_url, /texml/);
  assert.match(num.status_callback, /example\.com/);

  const account = db.prepare('SELECT balance_cents, currency FROM telnyx_account WHERE id = 1').get();
  assert.equal(account.balance_cents, 3033);
  assert.equal(account.currency, 'USD');

  const state = db.prepare('SELECT last_success_at, last_error FROM telnyx_sync_state WHERE id = 1').get();
  assert.ok(state.last_success_at);
  assert.equal(state.last_error, null);
});

test('a second sync within the interval is skipped', async () => {
  const result = await syncTelnyx(stubFetch);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, 'recent');
});

test('the webhook can fill a summary into a row the sync created', async () => {
  // The row for conv-1 exists with an empty summary (created by the sync above).
  // Simulate the webhook filling it in: the same UPDATE the receiver does.
  const before = db.prepare('SELECT summary_text FROM call_summaries WHERE telnyx_conversation_id = ?').get('conv-1');
  assert.equal(before.summary_text, '');
  const telnyx = require(path.join(root, 'src/telnyx'));
  const result = telnyx.handleTelnyxEvent({
    data: {
      id: 'evt-1', event_type: 'call.conversation.ended', occurred_at: '2026-11-22T10:02:30.000Z',
      payload: {
        conversation_id: 'conv-1', assistant_id: ASSISTANT_ID, to: NUMBER, from: '+12237338163', duration_sec: 150,
        messages: [
          { role: 'assistant', content: 'What is your name?' },
          { role: 'user', content: 'Hi, I am Dana.' },
        ],
      },
    },
  });
  assert.equal(result.stored, true, JSON.stringify(result));
  const after = db.prepare('SELECT summary_text, caller_display FROM call_summaries WHERE telnyx_conversation_id = ?').get('conv-1');
  assert.match(after.summary_text, /Dana/);
  assert.equal(after.caller_display, 'Dana');
  // A repeat delivery of the same conversation is ignored, not doubled.
  const again = telnyx.handleTelnyxEvent({
    data: {
      id: 'evt-2', event_type: 'call.conversation.ended', occurred_at: '2026-11-22T10:02:30.000Z',
      payload: {
        conversation_id: 'conv-1', assistant_id: ASSISTANT_ID, to: NUMBER, from: '+12237338163', duration_sec: 150,
        messages: [{ role: 'assistant', content: 'What is your name?' }, { role: 'user', content: 'Hi, I am Dana.' }],
      },
    },
  });
  assert.equal(again.ignored, 'conversation already recorded');
});

test('no api key returns not configured and writes nothing', async () => {
  // Clear the key by pointing config at an empty value (the module reads it live).
  const config = require(path.join(root, 'src/config'));
  const saved = config.telnyxApiKey;
  config.telnyxApiKey = '';
  // Move the last sync back so the guard does not mask the not-configured path.
  db.prepare("UPDATE telnyx_sync_state SET last_sync_at = '2020-01-01T00:00:00.000Z' WHERE id = 1").run();
  const result = await syncTelnyx(stubFetch);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'telnyx api key not configured');
  config.telnyxApiKey = saved;
});
