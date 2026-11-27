'use strict';
// Unified inbox: calls from call_summaries land in one conversation per
// caller; opening a conversation marks it read; resolving and reopening
// works. All on a temp database, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aedash-inbox-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.TELNYX_API_KEY = 'test-key';

const { db } = require(path.join(root, 'src/db'));
const store = require(path.join(root, 'src/store'));
const inbox = require(path.join(root, 'src/inbox'));

const CLIENT = 'cl_test_inbox';
const AGENT = 1;

function seedClient() {
  db.prepare('INSERT OR IGNORE INTO clients (id, business_name, contact_name, email, phone, created_at, status) VALUES (?,?,?,?,?,?,?)')
    .run(CLIENT, 'Inbox Test Co', 'Inbox Owner', 'inbox@testco.com', '+17175550100', '2026-11-27T00:00:00.000Z', 'active');
  db.prepare(`INSERT OR IGNORE INTO telnyx_agents (id, client_id, service_slug, telnyx_assistant_id, telnyx_phone_number, transfer_phone_number, tier_call_limit, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(AGENT, CLIENT, 'front-desk', 'assistant-test-inbox', '+19729440615', '+17179771021', 60, 'active', '2026-11-27T00:00:00.000Z', '2026-11-27T00:00:00.000Z');
}

function seedCall({ id, at, caller, number, outcome = 'answered', summary = 'Test call summary' }) {
  db.prepare(`INSERT INTO call_summaries
    (client_id, telnyx_agent_id, telnyx_conversation_id, occurred_at, duration_secs, caller_display, caller_number, outcome, summary_text, transferred, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(CLIENT, AGENT, id, at, 120, caller, number, outcome, summary, 0, '2026-11-27T00:00:00.000Z');
}

test('calls backfill into one conversation per caller', () => {
  seedClient();
  seedCall({ id: 'conv-call-1', at: '2026-11-27T10:00:00.000Z', caller: 'Alice (717) ***-**01', number: '+17175550101', summary: 'Alice asked about pricing.' });
  seedCall({ id: 'conv-call-2', at: '2026-11-27T11:00:00.000Z', caller: 'Alice (717) ***-**01', number: '+17175550101', summary: 'Alice called back to book.' });
  seedCall({ id: 'conv-call-3', at: '2026-11-27T12:00:00.000Z', caller: 'Bob (717) ***-**02', number: '+17175550102', summary: 'Bob missed the call.' });

  const list = inbox.listConversations(CLIENT);
  assert.equal(list.length, 2, 'two callers, two conversations');
  const alice = list.find((c) => c.contact_key === '+17175550101');
  assert.ok(alice, 'Alice conversation exists');
  assert.equal(alice.channel, 'call');
  assert.equal(alice.message_count, 2, 'both Alice calls in one conversation');
  assert.equal(alice.last_message_text, 'Alice called back to book.', 'last message is the newest call');
  const bob = list.find((c) => c.contact_key === '+17175550102');
  assert.equal(bob.message_count, 1);
  // First sync imports as read (the client already saw these calls).
  assert.equal(alice.unread_count, 0);
  assert.equal(bob.unread_count, 0);
});

test('a new call after the first sync arrives unread', () => {
  seedCall({ id: 'conv-call-4', at: '2026-11-27T13:00:00.000Z', caller: 'Alice (717) ***-**01', number: '+17175550101', summary: 'Alice called a third time.' });
  const list = inbox.listConversations(CLIENT);
  const alice = list.find((c) => c.contact_key === '+17175550101');
  assert.equal(alice.message_count, 3);
  assert.equal(alice.unread_count, 1, 'the new call is unread');
  assert.equal(inbox.getUnreadCount(CLIENT), 1);
});

test('opening a conversation returns its messages and marks it read', () => {
  const list = inbox.listConversations(CLIENT);
  const alice = list.find((c) => c.contact_key === '+17175550101');
  const conv = inbox.getConversation(CLIENT, alice.id);
  assert.ok(conv, 'conversation found');
  assert.equal(conv.messages.length, 3);
  assert.equal(conv.messages[0].body, 'Alice called a third time.', 'newest message first');
  assert.equal(conv.messages[0].metadata.outcome, 'answered');
  assert.equal(conv.messages[0].source_id, 'conv-call-4', 'message links back to the call');
  // Marked read on open.
  assert.equal(inbox.getUnreadCount(CLIENT), 0);
  const after = inbox.listConversations(CLIENT).find((c) => c.id === alice.id);
  assert.equal(after.unread_count, 0);
});

test('resolving and reopening a conversation works', () => {
  const list = inbox.listConversations(CLIENT);
  const bob = list.find((c) => c.contact_key === '+17175550102');
  const resolved = inbox.setConversationStatus(CLIENT, bob.id, 'resolved');
  assert.ok(resolved);
  assert.equal(resolved.status, 'resolved');
  const reopened = inbox.setConversationStatus(CLIENT, bob.id, 'open');
  assert.equal(reopened.status, 'open');
  assert.equal(inbox.setConversationStatus(CLIENT, 'conv_doesnotexist', 'resolved'), null);
  assert.equal(inbox.setConversationStatus(CLIENT, bob.id, 'archived'), null, 'only open/resolved are valid');
});

test('a client cannot see another client conversation', () => {
  const list = inbox.listConversations(CLIENT);
  const alice = list.find((c) => c.contact_key === '+17175550101');
  assert.equal(inbox.getConversation('cl_someone_else', alice.id), null);
  assert.equal(inbox.setConversationStatus('cl_someone_else', alice.id, 'resolved'), null);
});

test('the sync is idempotent: re-listing creates nothing twice', () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM inbox_messages WHERE client_id = ?').get(CLIENT).n;
  inbox.listConversations(CLIENT);
  inbox.listConversations(CLIENT);
  const after = db.prepare('SELECT COUNT(*) AS n FROM inbox_messages WHERE client_id = ?').get(CLIENT).n;
  assert.equal(after, before, 'no duplicate messages');
});
