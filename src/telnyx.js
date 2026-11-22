'use strict';
// Telnyx webhook signature verification (Ed25519) and the direct receiver for
// POST /api/v1/webhooks/telnyx. Built-in node:crypto only, no dependencies.
//
// Telnyx signing spec: each webhook carries two headers,
//   telnyx-signature-ed25519  base64 Ed25519 signature (64 bytes)
//   telnyx-timestamp          unix time in seconds, as a string
// The signed message is the bytes of `${timestamp}|${rawBody}`, verified against
// the account public key (base64, 32 raw bytes) from Telnyx Mission Control
// (Keys and Credentials, Public Key). The key goes in the TELNYX_PUBLIC_KEY env var.
const crypto = require('node:crypto');
const config = require('./config');
const { db, tx } = require('./db');
const store = require('./store');
const { maskPhones } = require('./security');

// DER prefix that turns 32 raw Ed25519 key bytes into an SPKI public key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

let cachedKey = { b64: null, key: null };
/** Parses the base64 public key once. Returns a KeyObject or null when unset or invalid. */
function publicKeyFrom(b64) {
  const clean = String(b64 || '').replace(/\s+/g, '');
  if (!clean) return null;
  if (cachedKey.b64 === clean) return cachedKey.key;
  let key = null;
  try {
    const raw = Buffer.from(clean, 'base64');
    if (raw.length === 32) {
      key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    }
  } catch { key = null; }
  cachedKey = { b64: clean, key };
  return key;
}

/**
 * Verifies one webhook. Fails closed: any missing piece is a rejection.
 * Returns { ok: true, timestamp } or { ok: false, status, reason }.
 *   rawBody   Buffer of the exact request body bytes
 *   headers   Node request headers (lowercase keys)
 */
function verifyTelnyxSignature({ rawBody, headers, publicKeyB64 = config.telnyxPublicKey, now = Date.now(), toleranceSec = config.telnyxToleranceSec }) {
  const key = publicKeyFrom(publicKeyB64);
  if (!key) return { ok: false, status: 503, reason: 'webhook not configured' };

  const sigB64 = String(headers['telnyx-signature-ed25519'] || '').trim();
  const tsStr = String(headers['telnyx-timestamp'] || '').trim();
  if (!sigB64 || !tsStr) return { ok: false, status: 401, reason: 'missing signature headers' };
  if (!/^\d{1,12}$/.test(tsStr)) return { ok: false, status: 401, reason: 'bad timestamp' };

  // Replay window: reject anything more than toleranceSec away from our clock.
  const ts = Number(tsStr);
  if (Math.abs(Math.floor(now / 1000) - ts) > toleranceSec) return { ok: false, status: 401, reason: 'timestamp outside window' };

  const sig = Buffer.from(sigB64, 'base64');
  if (sig.length !== 64) return { ok: false, status: 401, reason: 'bad signature' };

  const message = Buffer.concat([Buffer.from(`${tsStr}|`, 'utf8'), Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8')]);
  let valid = false;
  try { valid = crypto.verify(null, message, key, sig); } catch { valid = false; }
  if (!valid) return { ok: false, status: 401, reason: 'bad signature' };
  return { ok: true, timestamp: ts };
}

// ---- Payload helpers (mirror telnyx-call-summary.php so both paths agree) ----

/** First name only, from the caller turn right after the assistant asks for a name. */
function extractFirstName(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] || {};
    if (m.role === 'assistant' && /name/i.test(String(m.content || ''))) {
      for (let j = i + 1; j < messages.length; j++) {
        if ((messages[j] || {}).role !== 'user') continue;
        const said = String(messages[j].content || '').trim()
          .replace(/^(hi|hello|hey)[,!.\s]+/i, '')
          .replace(/^(my name is|my name's|this is|it's|it is|i'm|i am|im)\s+/i, '');
        const word = (said.split(/\s+/)[0] || '').replace(/[^A-Za-z'À-ɏ]/g, '');
        return word ? (word[0].toUpperCase() + word.slice(1)).slice(0, 40) : '';
      }
      return '';
    }
  }
  return '';
}

function callOutcome(messages, durationSec) {
  const list = Array.isArray(messages) ? messages : [];
  const hasUser = list.some((m) => m && m.role === 'user');
  const hasAsst = list.some((m) => m && m.role === 'assistant');
  return hasUser || (hasAsst && durationSec > 0) ? 'answered' : 'missed';
}

function callerSummary(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return list.filter((m) => m && m.role === 'user').map((m) => String(m.content || '').trim()).filter(Boolean).join(' ');
}

/** Resolves the tenant: assistant id first, then the dialled Telnyx number. Never guesses. */
function findAgent(payload) {
  const assistantId = typeof payload.assistant_id === 'string' ? payload.assistant_id : '';
  if (assistantId) {
    const row = db.prepare('SELECT * FROM telnyx_agents WHERE telnyx_assistant_id = ?').get(assistantId);
    if (row) return row;
  }
  const to = typeof payload.to === 'string' ? payload.to.trim() : '';
  if (to) {
    const row = db.prepare('SELECT * FROM telnyx_agents WHERE telnyx_phone_number = ?').get(to);
    if (row) return row;
  }
  return null;
}

/**
 * Handles one verified, parsed Telnyx webhook body. Returns a small result object;
 * the caller always answers 200 for anything it chose to ignore, so Telnyx does not retry it.
 */
function handleTelnyxEvent(body) {
  const data = body && typeof body === 'object' ? body.data : null;
  if (!data || typeof data !== 'object') return { ignored: 'malformed body' };
  const eventId = typeof data.id === 'string' ? data.id.slice(0, 120) : '';
  const eventType = typeof data.event_type === 'string' ? data.event_type.slice(0, 120) : '';
  const payload = data.payload && typeof data.payload === 'object' ? data.payload : null;
  if (!eventId || !eventType || !payload) return { ignored: 'missing id, event_type or payload' };

  // Everything runs in one transaction: if anything throws, the de-duplication row is
  // rolled back too, so Telnyx's retry is processed instead of being dropped.
  return tx(() => {
    // Delivery de-duplication on the Telnyx event id (retries and replays inside the window).
    const seen = db.prepare('INSERT OR IGNORE INTO telnyx_webhook_events (event_id, event_type, received_at) VALUES (?,?,?)')
      .run(eventId, eventType, store.nowIso());
    if (!seen.changes) return { ignored: 'duplicate delivery' };

    if (eventType !== 'call.conversation.ended') {
      // call.conversation_insights.generated has no conversation_id; merging it is still
      // done by the PHP endpoint. Acknowledge so Telnyx stops retrying.
      return { ignored: `event_type ${eventType} not handled here` };
    }

    const conversationId = typeof payload.conversation_id === 'string' ? payload.conversation_id.slice(0, 120) : '';
    if (!conversationId) return { ignored: 'no conversation_id' };
    const agent = findAgent(payload);
    if (!agent) return { ignored: 'no telnyx_agents row for this assistant or number' };
    if (!store.hasSubscription(agent.client_id, agent.service_slug)) return { ignored: 'client has no subscription for this agent service' };

    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const duration = Number.isFinite(Number(payload.duration_sec)) ? Math.max(0, Math.round(Number(payload.duration_sec))) : 0;
    const outcome = callOutcome(messages, duration);
    const firstName = extractFirstName(messages);
    const last4 = String(payload.from || '').replace(/\D/g, '').slice(-4);
    const who = firstName || (last4.length === 4 ? `a caller ending in ${last4}` : 'a caller');
    const display = firstName || (last4.length === 4 ? `***-***-${last4}` : 'Unknown caller');
    const summary = maskPhones(callerSummary(messages)).slice(0, 500) || (outcome === 'missed' ? 'No summary available.' : 'No summary captured.');
    const occurred = new Date(typeof data.occurred_at === 'string' ? data.occurred_at : Date.now());
    const occurredAt = Number.isNaN(occurred.getTime()) ? new Date() : occurred;

    const ins = db.prepare(`INSERT OR IGNORE INTO call_summaries
      (client_id, telnyx_agent_id, telnyx_conversation_id, occurred_at, duration_secs, caller_display, outcome, summary_text)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(agent.client_id, agent.id, conversationId, occurredAt.toISOString(), duration, display, outcome, summary);
    if (!ins.changes) return { ignored: 'conversation already recorded' };
    const answered = outcome === 'answered';
    const storedId = store.addEventInTx({
      clientId: agent.client_id,
      service: agent.service_slug,
      eventType: answered ? 'call_answered' : 'call_missed',
      title: answered ? `Front Desk answered a call from ${who}` : `Missed a call from ${who}`,
      detail: summary,
      occurredAt,
      metadata: { source: 'telnyx-direct', duration_seconds: duration, last4: last4.length === 4 ? last4 : null },
    });
    return { stored: true, event_id: storedId };
  });
}

module.exports = { verifyTelnyxSignature, handleTelnyxEvent, extractFirstName, callOutcome, publicKeyFrom };
