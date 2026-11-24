'use strict';
// Call transcripts: the webhook stores them from call.conversation.ended,
// the sync backfills them from GET /v2/ai/conversations/{id}/messages, the
// client dashboard returns them per call, and a recording URL is fetched
// fresh on demand (never stored). Runs against a stub fetch (no network) on
// a temp database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aedash-transcript-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.TELNYX_API_KEY = 'test-key';

const { db } = require(path.join(root, 'src/db'));
const store = require(path.join(root, 'src/store'));
const transcript = require(path.join(root, 'src/telnyx-transcript'));
const { syncTelnyx } = require(path.join(root, 'src/telnyx-sync'));
const telnyx = require(path.join(root, 'src/telnyx'));

const ASSISTANT_A = 'assistant-a-1';
const ASSISTANT_B = 'assistant-b-1';
const NUMBER_A = '+19729440615';
const NUMBER_B = '+19729440616';
const CC_A = 'v3:call-control-a';
let clientA;
let clientB;

const stubFetch = async (url) => {
  const json = async () => {
    if (url.includes('/messages')) {
      // Backfill source for conv-backfill only; other conversations have none.
      if (url.includes('conv-backfill')) {
        return {
          data: [
            { role: 'assistant', text: 'Hello, how can I help?', sent_at: '2026-11-22T10:00:10.000Z' },
            { role: 'user', text: 'I need a plumber, my sink is leaking.', sent_at: '2026-11-22T10:00:20.000Z' },
          ],
          meta: { total_pages: 1 },
        };
      }
      return { data: [], meta: { total_pages: 1 } };
    }
    if (url.includes('/v2/ai/assistants')) {
      return { data: [{ id: ASSISTANT_A, name: 'Aria', model: 'zai-org/GLM-5.3-Flash', instructions: 'You are Aria.', tools: [] }], meta: { total_pages: 1 } };
    }
    if (url.includes('/v2/ai/conversations')) {
      return {
        data: [{
          id: 'conv-backfill', created_at: '2026-11-22T10:00:00.000Z', last_message_at: '2026-11-22T10:02:00.000Z',
          metadata: { to: NUMBER_A, from: '+12237338163', assistant_id: ASSISTANT_A, call_control_id: CC_A },
        }],
        meta: { total_pages: 1 },
      };
    }
    if (url.includes('/v2/phone_numbers')) {
      return { data: [{ id: 'num-1', phone_number: NUMBER_A, status: 'active', connection_id: 'conn-1', purchased_at: '2026-11-19T16:42:32Z' }], meta: { total_pages: 1 } };
    }
    if (url.includes('/v2/texml_applications/conn-1')) {
      return { data: { id: 'conn-1', voice_url: 'https://example.com/texml', status_callback: 'https://example.com/hook?key=x' } };
    }
    if (url.includes('/v2/balance')) return { data: { balance: '30.33', available_credit: '30.33', currency: 'USD' } };
    if (url.includes('/v2/calls/') && url.includes('/recordings')) {
      return {
        data: [{
          id: 'rec-1', status: 'completed', channels: 'dual', duration_millis: 65000,
          download_urls: { mp3: 'https://example.com/recording.mp3?X-Amz-Expires=600' },
        }],
      };
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { ok: true, status: 200, json };
};

test.before(() => {
  clientA = store.createClient({ businessName: 'Alpha Co', contactName: 'Amy', email: 'a@example.com', phone: '+17175550100' });
  store.addSubscription({ clientId: clientA, service: 'front-desk', plan: 'Front Desk 99', priceCents: 9900, billing: 'monthly' });
  store.addTelnyxAgent({ clientId: clientA, service: 'front-desk', assistantId: ASSISTANT_A, phone: NUMBER_A, transferPhone: '+17179771021', callLimit: 60 });
  clientB = store.createClient({ businessName: 'Beta Co', contactName: 'Ben', email: 'b@example.com', phone: '+17175550101' });
  store.addSubscription({ clientId: clientB, service: 'front-desk', plan: 'Front Desk 99', priceCents: 9900, billing: 'monthly' });
  store.addTelnyxAgent({ clientId: clientB, service: 'front-desk', assistantId: ASSISTANT_B, phone: NUMBER_B, transferPhone: '+17179771022', callLimit: 60 });
});

test.after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

test('normalizeMessages maps roles, drops tool turns, and masks phone numbers', () => {
  const turns = transcript.normalizeMessages([
    { role: 'assistant', content: 'What is your name?' },
    { role: 'user', content: 'Call me back at 717-977-1021 please.' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1' }] },
    { role: 'system', content: 'ignore me' },
    { role: 'user', text: 'My number is 7179771021.', sent_at: '2026-11-22T10:00:20.000Z' },
  ]);
  assert.equal(turns.length, 3);
  assert.equal(turns[0].role, 'agent');
  assert.equal(turns[1].role, 'caller');
  assert.match(turns[1].text, /\*\*\*-\*\*\*-1021/);
  assert.doesNotMatch(turns[1].text, /717-977-1021/);
  assert.equal(turns[2].at, '2026-11-22T10:00:20.000Z');
  assert.deepEqual(transcript.parseTranscript('not json'), []);
  assert.equal(transcript.transcriptToJson([]), null);
});

test('the webhook stores the transcript and it comes back in the calls payload', () => {
  const result = telnyx.handleTelnyxEvent({
    data: {
      id: 'evt-webhook-1', event_type: 'call.conversation.ended', occurred_at: '2026-11-22T11:00:00.000Z',
      payload: {
        conversation_id: 'conv-webhook-1', assistant_id: ASSISTANT_A, to: NUMBER_A, from: '+12237338163',
        duration_sec: 120, call_control_id: CC_A,
        messages: [
          { role: 'assistant', content: 'Thanks for calling Alpha Co, how can I help?' },
          { role: 'user', content: 'Hi, I need a quote for a roof repair.' },
          { role: 'assistant', content: 'Of course. What is the best number to reach you?' },
        ],
      },
    },
  });
  assert.equal(result.stored, true, JSON.stringify(result));

  const row = db.prepare('SELECT transcript_json, call_control_id FROM call_summaries WHERE telnyx_conversation_id = ?').get('conv-webhook-1');
  const turns = transcript.parseTranscript(row.transcript_json);
  assert.equal(turns.length, 3);
  assert.equal(turns[0].role, 'agent');
  assert.equal(turns[1].role, 'caller');
  assert.match(turns[1].text, /roof repair/);
  assert.equal(row.call_control_id, CC_A);

  const calls = store.listCalls(clientA, 50);
  const listed = calls.find((c) => c.telnyx_conversation_id === 'conv-webhook-1');
  assert.ok(listed);
  assert.equal(listed.has_transcript, true);

  const detail = store.getCallDetail(clientA, 'conv-webhook-1');
  assert.ok(detail);
  assert.equal(detail.has_transcript, true);
  assert.equal(detail.transcript.length, 3);
  assert.equal(detail.transcript[1].text, 'Hi, I need a quote for a roof repair.');
});

test('a later webhook delivery never overwrites an existing transcript', () => {
  const before = db.prepare('SELECT transcript_json FROM call_summaries WHERE telnyx_conversation_id = ?').get('conv-webhook-1');
  const result = telnyx.handleTelnyxEvent({
    data: {
      id: 'evt-webhook-2', event_type: 'call.conversation.ended', occurred_at: '2026-11-22T11:00:00.000Z',
      payload: {
        conversation_id: 'conv-webhook-1', assistant_id: ASSISTANT_A, to: NUMBER_A, from: '+12237338163',
        duration_sec: 120,
        messages: [{ role: 'user', content: 'A completely different transcript.' }],
      },
    },
  });
  assert.equal(result.ignored, 'conversation already recorded', JSON.stringify(result));
  const after = db.prepare('SELECT transcript_json FROM call_summaries WHERE telnyx_conversation_id = ?').get('conv-webhook-1');
  assert.equal(after.transcript_json, before.transcript_json);
  assert.doesNotMatch(after.transcript_json, /completely different/);
});

test('the sync backfills a missing transcript from the messages endpoint', async () => {
  // Move the last sync back so the guard does not skip this run.
  db.prepare("UPDATE telnyx_sync_state SET last_sync_at = '2020-01-01T00:00:00.000Z' WHERE id = 1").run();
  const result = await syncTelnyx(stubFetch);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.transcripts_backfilled, 1, JSON.stringify(result));

  const row = db.prepare('SELECT transcript_json, call_control_id FROM call_summaries WHERE telnyx_conversation_id = ?').get('conv-backfill');
  const turns = transcript.parseTranscript(row.transcript_json);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].role, 'agent');
  assert.match(turns[1].text, /plumber/);
  assert.equal(row.call_control_id, CC_A);

  const detail = store.getCallDetail(clientA, 'conv-backfill');
  assert.equal(detail.has_transcript, true);
  assert.equal(detail.transcript[1].role, 'caller');
});

test('a client cannot read another client’s call transcript', () => {
  // Client B's own list never includes client A's calls.
  const callsB = store.listCalls(clientB, 50);
  assert.equal(callsB.some((c) => c.telnyx_conversation_id === 'conv-webhook-1'), false);
  assert.equal(callsB.some((c) => c.telnyx_conversation_id === 'conv-backfill'), false);
  // And the detail lookup for another client's conversation returns null.
  assert.equal(store.getCallDetail(clientB, 'conv-webhook-1'), null);
  assert.equal(store.getCallDetail(clientB, 'conv-backfill'), null);
  // Unknown conversation ids also return null, not an error.
  assert.equal(store.getCallDetail(clientA, 'conv-does-not-exist'), null);
});

test('a call with no transcript shows a clear no-transcript state, not an error', () => {
  // Insert a call row with no transcript (as the sync would before backfill).
  const agent = db.prepare('SELECT id FROM telnyx_agents WHERE telnyx_assistant_id = ?').get(ASSISTANT_A);
  db.prepare(`INSERT INTO call_summaries
    (client_id, telnyx_agent_id, telnyx_conversation_id, occurred_at, duration_secs, caller_display, outcome, summary_text)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(clientA, agent.id, 'conv-no-transcript', '2026-11-22T12:00:00.000Z', 30, '***-***-0000', 'answered', 'Caller asked about hours.');
  const detail = store.getCallDetail(clientA, 'conv-no-transcript');
  assert.ok(detail);
  assert.equal(detail.has_transcript, false);
  assert.equal(detail.transcript, null);
  assert.equal(detail.summary_text, 'Caller asked about hours.');
  const calls = store.listCalls(clientA, 50);
  const listed = calls.find((c) => c.telnyx_conversation_id === 'conv-no-transcript');
  assert.ok(listed);
  assert.equal(listed.has_transcript, false);
});

test('fetchRecordingUrl returns the mp3 link for a completed recording and null when there is none', async () => {
  const found = await transcript.fetchRecordingUrl(CC_A, stubFetch);
  assert.ok(found);
  assert.match(found.url, /recording\.mp3/);
  assert.equal(found.duration_millis, 65000);

  const emptyFetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
  assert.equal(await transcript.fetchRecordingUrl(CC_A, emptyFetch), null);
  // A recording that is not completed yet is not offered.
  const pendingFetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ data: [{ id: 'rec-2', status: 'processing', download_urls: { mp3: 'https://example.com/x.mp3' } }] }),
  });
  assert.equal(await transcript.fetchRecordingUrl(CC_A, pendingFetch), null);
  assert.equal(await transcript.fetchRecordingUrl(null, stubFetch), null);
});
