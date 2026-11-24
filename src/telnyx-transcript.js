'use strict';
// Call transcripts for the client dashboard. A transcript is the words actually
// spoken on a call, stored as a normalized JSON array so the client can read
// exactly what was said and catch any miscommunication or mistranscription.
//
// Two sources, both read-only against Telnyx:
//   - the webhook (src/telnyx.js) stores the transcript from
//     call.conversation.ended, whose payload carries messages[].
//   - the sync (src/telnyx-sync.js) backfills transcripts the webhook missed
//     from GET /v2/ai/conversations/{id}/messages (paginated).
// A stored transcript is never overwritten: both writers only fill a row
// whose transcript is still empty. Transcript text is never logged.
//
// Recordings are NOT stored. Telnyx exposes a recording only as a presigned
// S3 download URL (download_urls.mp3) that expires 600 seconds after it is
// issued, so fetchRecordingUrl returns a fresh URL on demand and the client
// plays it immediately. A URL fetched and kept would be dead within 10 minutes.
const config = require('./config');
const { maskPhones } = require('./security');

const TELNYX_BASE = 'https://api.telnyx.com';
const MAX_TURNS = 300;
const MAX_TEXT = 3000;

/**
 * Normalizes raw Telnyx messages to the stored shape:
 * [{ role: 'caller' | 'agent', text, at }].
 * Accepts both the webhook shape ({ role, content }) and the conversations
 * API shape ({ role, text, sent_at | created_at }). Tool/system turns and
 * empty messages are dropped. Phone numbers in the text are masked.
 * Returns [] when there is nothing speakable to store.
 */
function normalizeMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'user' ? 'caller' : m.role === 'assistant' ? 'agent' : null;
    if (!role) continue;
    const raw = typeof m.text === 'string' ? m.text : typeof m.content === 'string' ? m.content : '';
    const text = maskPhones(raw.trim()).slice(0, MAX_TEXT);
    if (!text) continue;
    const at = typeof m.sent_at === 'string' ? m.sent_at : typeof m.created_at === 'string' ? m.created_at : null;
    out.push({ role, text, at });
    if (out.length >= MAX_TURNS) break;
  }
  return out;
}

/** Turns a normalized array into the stored JSON string, or null when empty. */
function transcriptToJson(turns) {
  if (!Array.isArray(turns) || !turns.length) return null;
  try { return JSON.stringify(turns); } catch { return null; }
}

/** Parses stored transcript JSON back to an array. Returns [] on bad/empty input. */
function parseTranscript(json) {
  if (!json) return [];
  try {
    const turns = JSON.parse(String(json));
    if (!Array.isArray(turns)) return [];
    return turns.filter((t) => t && (t.role === 'caller' || t.role === 'agent') && typeof t.text === 'string');
  } catch { return []; }
}

/** One Telnyx GET. Throws on a non-2xx status or a bad body. */
async function telnyxGet(path, fetchFn) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetchFn(`${TELNYX_BASE}${path}`, {
      headers: { authorization: `Bearer ${config.telnyxApiKey}`, accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Telnyx ${path} returned ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches the full transcript for one conversation from
 * GET /v2/ai/conversations/{id}/messages (paginated). Returns the normalized
 * turns, or [] when the conversation has no messages. Throws when Telnyx
 * rejects the call, so the caller can skip it and try again next sync.
 */
async function fetchTranscript(conversationId, fetchFn = fetch) {
  const turns = [];
  let page = 1;
  for (;;) {
    const body = await telnyxGet(`/v2/ai/conversations/${conversationId}/messages?page[number]=${page}&page[size]=100`, fetchFn);
    const rows = Array.isArray(body.data) ? body.data : [];
    turns.push(...normalizeMessages(rows));
    const meta = body.meta || {};
    const totalPages = Number(meta.total_pages) || 1;
    if (page >= totalPages || rows.length === 0) break;
    page += 1;
    if (page > 50) break; // safety valve: never fetch more than 50 pages
    if (turns.length >= MAX_TURNS) break;
  }
  return turns.slice(0, MAX_TURNS);
}

/**
 * Fetches a fresh playable recording URL for one call. Telnyx returns the
 * recording as a presigned S3 mp3 URL that expires 600 seconds after it is
 * issued, so this must be called when the client opens the call, never
 * cached or stored. Returns { url, duration_millis } or null when there is
 * no completed recording. Throws when Telnyx rejects the call.
 */
async function fetchRecordingUrl(callControlId, fetchFn = fetch) {
  if (!callControlId) return null;
  const body = await telnyxGet(`/v2/calls/${encodeURIComponent(callControlId)}/recordings`, fetchFn);
  const rows = Array.isArray(body.data) ? body.data : [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    if (r.status !== 'completed') continue;
    const url = r.download_urls && typeof r.download_urls.mp3 === 'string' ? r.download_urls.mp3 : '';
    if (!url) continue;
    const duration = Number.isFinite(Number(r.duration_millis)) ? Math.round(Number(r.duration_millis)) : null;
    return { url, duration_millis: duration };
  }
  return null;
}

module.exports = { normalizeMessages, transcriptToJson, parseTranscript, fetchTranscript, fetchRecordingUrl };
