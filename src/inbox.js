'use strict';
// Unified inbox: one conversation per contact per channel (call, sms, social),
// every message in it. This is the Intercom-parity piece AE was missing: the
// dashboard had calls in one place and social in another, but no single view
// of every conversation with a customer.
//
// Data sources today: calls land here from call_summaries (lazy sync on
// every read, so no webhook change is needed). SMS and social DMs land here
// when those channels are wired in; the schema already accepts them.
//
// Privacy: contact_display is masked (never a full number) and the raw
// caller number is used only as the grouping key, never shown.
const { db, tx } = require('./db');
const { maskPhones } = require('./security');
const { nowIso } = require('./store');

const newId = (prefix) => `${prefix}_${require('node:crypto').randomBytes(8).toString('hex')}`;

/** Find or create the conversation row for one contact on one channel. */
function upsertConversation(clientId, channel, contactKey, contactDisplay, at) {
  const existing = db.prepare(
    'SELECT id FROM inbox_conversations WHERE client_id = ? AND channel = ? AND contact_key = ?'
  ).get(clientId, channel, contactKey);
  if (existing) return existing.id;
  const id = newId('conv');
  db.prepare(`INSERT INTO inbox_conversations
    (id, client_id, channel, contact_key, contact_display, last_message_at, last_message_text, status, unread_count, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?, 'open', 0, ?, ?)`)
    .run(id, clientId, channel, contactKey, contactDisplay, at, '', at, at);
  return id;
}

/**
 * Lazy sync: pull every call_summary for this client that has no inbox
 * message yet into the inbox. Runs inside listConversations/getConversation,
 * so the inbox is always current without a webhook change.
 *
 * The first sync for a client (no inbox rows at all) imports everything as
 * read, because the client has already seen those calls on the dashboard.
 * Later syncs (new calls arriving) mark the new messages unread.
 */
function syncCallsToInbox(clientId) {
  const isFirstSync = !db.prepare('SELECT 1 FROM inbox_conversations WHERE client_id = ? LIMIT 1').get(clientId);
  const calls = db.prepare(`
    SELECT telnyx_conversation_id, occurred_at, duration_secs, caller_display, caller_number, outcome, summary_text,
      (transcript_json IS NOT NULL) AS has_transcript
    FROM call_summaries WHERE client_id = ?
      AND telnyx_conversation_id NOT IN (SELECT source_id FROM inbox_messages WHERE client_id = ? AND channel = 'call' AND source_id IS NOT NULL)
    ORDER BY occurred_at ASC`).all(clientId, clientId);
  if (!calls.length) return 0;
  tx(() => {
    for (const c of calls) {
      const contactKey = (c.caller_number && String(c.caller_number).trim()) || String(c.caller_display || 'Unknown caller');
      const contactDisplay = maskPhones(String(c.caller_display || 'Unknown caller'));
      const convId = upsertConversation(clientId, 'call', contactKey, contactDisplay, c.occurred_at);
      db.prepare(`INSERT INTO inbox_messages
        (id, conversation_id, client_id, channel, direction, body, occurred_at, source_id, metadata, created_at)
        VALUES (?,?,?,?, 'inbound', ?, ?, ?, ?, ?)`)
        .run(
          newId('msg'), convId, clientId, 'call',
          maskPhones(String(c.summary_text || '')),
          c.occurred_at, c.telnyx_conversation_id,
          JSON.stringify({ outcome: c.outcome, duration_secs: c.duration_secs || 0, has_transcript: c.has_transcript === 1 }),
          nowIso()
        );
      db.prepare(`UPDATE inbox_conversations SET last_message_at = ?, last_message_text = ?, updated_at = ?,
          unread_count = unread_count + ?
        WHERE id = ?`)
        .run(c.occurred_at, maskPhones(String(c.summary_text || '')), nowIso(), isFirstSync ? 0 : 1, convId);
    }
  });
  return calls.length;
}

/** Every conversation for the client, newest activity first. */
function listConversations(clientId) {
  syncCallsToInbox(clientId);
  return db.prepare(`
    SELECT id, channel, contact_key, contact_display, last_message_at, last_message_text, status, unread_count, created_at, updated_at,
      (SELECT COUNT(*) FROM inbox_messages m WHERE m.conversation_id = inbox_conversations.id) AS message_count
    FROM inbox_conversations WHERE client_id = ? ORDER BY last_message_at DESC`).all(clientId)
    .map((c) => ({ ...c, contact_display: maskPhones(c.contact_display), last_message_text: maskPhones(c.last_message_text || '') }));
}

/** One conversation with its messages, newest first. Opening it marks it read. */
function getConversation(clientId, conversationId) {
  syncCallsToInbox(clientId);
  const conv = db.prepare(`
    SELECT id, channel, contact_key, contact_display, last_message_at, last_message_text, status, unread_count, created_at, updated_at
    FROM inbox_conversations WHERE client_id = ? AND id = ?`).get(clientId, conversationId);
  if (!conv) return null;
  const messages = db.prepare(`
    SELECT id, channel, direction, body, occurred_at, source_id, metadata, created_at
    FROM inbox_messages WHERE client_id = ? AND conversation_id = ? ORDER BY occurred_at DESC, created_at DESC`)
    .all(clientId, conversationId)
    .map((m) => ({
      ...m,
      body: maskPhones(m.body),
      metadata: (() => { try { return JSON.parse(m.metadata || '{}'); } catch { return {}; } })(),
    }));
  // Opening a conversation marks it read.
  db.prepare('UPDATE inbox_conversations SET unread_count = 0, updated_at = ? WHERE id = ?').run(nowIso(), conversationId);
  return {
    ...conv,
    contact_display: maskPhones(conv.contact_display),
    last_message_text: maskPhones(conv.last_message_text || ''),
    messages,
  };
}

/** Mark a conversation resolved (or reopen it). Returns the updated row or null. */
function setConversationStatus(clientId, conversationId, status) {
  if (!['open', 'resolved'].includes(status)) return null;
  const row = db.prepare('SELECT id FROM inbox_conversations WHERE client_id = ? AND id = ?').get(clientId, conversationId);
  if (!row) return null;
  db.prepare("UPDATE inbox_conversations SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), conversationId);
  return db.prepare('SELECT id, channel, contact_display, last_message_at, status, unread_count FROM inbox_conversations WHERE id = ?')
    .get(conversationId);
}

/** Total unread conversations for the badge. */
function getUnreadCount(clientId) {
  syncCallsToInbox(clientId);
  const row = db.prepare('SELECT COALESCE(SUM(unread_count), 0) AS n FROM inbox_conversations WHERE client_id = ? AND status = ?').get(clientId, 'open');
  return row ? row.n : 0;
}

module.exports = { listConversations, getConversation, setConversationStatus, getUnreadCount, syncCallsToInbox };
