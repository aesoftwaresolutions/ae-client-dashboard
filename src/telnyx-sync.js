'use strict';
// Telnyx ACTIVE sync (pull). Read-only GETs against api.telnyx.com, run on a
// schedule (Hostinger cron via scripts/telnyx-sync.js, or POST
// /api/v1/admin/telnyx-sync). It fills the dashboard's own tables so the
// admin and client views show live Telnyx data without waiting for a webhook:
//   assistants  -> telnyx_agents (name, model, tools, instructions hash)
//   conversations -> call_summaries (caller, date, duration, transferred)
//   phone numbers -> telnyx_numbers (number, status, routing)
//   balance     -> telnyx_account (single row)
//   transcripts -> call_summaries.transcript_json, backfilled from
//                  GET /v2/ai/conversations/{id}/messages for calls that
//                  have none yet (capped at 25 per sync, never overwrites)
// The sync NEVER writes to Telnyx (GET only) and never touches summary_text:
// the webhook (src/telnyx.js) owns the transcript summary, and it fills in a
// row the sync created earlier. The sync never adds events rows either; the
// webhook adds the activity event when the summary lands. So a call the
// webhook missed still shows in the Calls list, and a call the webhook did
// record is never duplicated.
// Needs TELNYX_API_KEY in the hosting env vars. When empty the sync reports
// "not configured" and does nothing. The key is a full-access Telnyx key, so
// it lives in env vars only, never in a file or the repo, and is never logged.
const crypto = require('node:crypto');
const config = require('./config');
const { db, tx } = require('./db');
const store = require('./store');
const transcript = require('./telnyx-transcript');

const TELNYX_BASE = 'https://api.telnyx.com';

/** GET one Telnyx path. Throws on a non-2xx status or a bad body. */
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

/** Follows Telnyx pagination (page[number]/page[size]) and returns all data rows. */
async function telnyxList(path, fetchFn) {
  const out = [];
  let page = 1;
  for (;;) {
    const sep = path.includes('?') ? '&' : '?';
    const body = await telnyxGet(`${path}${sep}page[number]=${page}&page[size]=100`, fetchFn);
    const rows = Array.isArray(body.data) ? body.data : [];
    out.push(...rows);
    const meta = body.meta || {};
    const totalPages = Number(meta.total_pages) || 1;
    if (page >= totalPages || rows.length === 0) break;
    page += 1;
    if (page > 50) break; // safety valve: never fetch more than 50 pages
  }
  return out;
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex');
const maskNum = (n) => {
  const digits = String(n || '').replace(/\D/g, '');
  return digits.length >= 4 ? `***-***-${digits.slice(-4)}` : 'Unknown caller';
};

/**
 * Runs one sync. Returns a summary; never throws.
 * fetchFn is injected for tests (defaults to global fetch).
 */
async function syncTelnyx(fetchFn = fetch) {
  const startedAt = new Date();
  if (!config.telnyxApiKey) return { ok: false, error: 'telnyx api key not configured' };

  // Do not hammer Telnyx: a sync within the minimum interval is skipped.
  const state = db.prepare('SELECT last_sync_at FROM telnyx_sync_state WHERE id = 1').get();
  if (state && state.last_sync_at) {
    const last = new Date(state.last_sync_at).getTime();
    if (!Number.isNaN(last) && Date.now() - last < config.telnyxSyncMinIntervalSec * 1000) {
      return { ok: true, skipped: 'recent', last_sync_at: state.last_sync_at };
    }
  }

  // Fetch everything first (network only, no DB writes), then store in one transaction.
  let assistants = [];
  let conversations = [];
  let numbers = [];
  let balance = null;
  let texmlByConnection = {};
  try {
    assistants = await telnyxList('/v2/ai/assistants', fetchFn);
    conversations = await telnyxList('/v2/ai/conversations', fetchFn);
    numbers = await telnyxList('/v2/phone_numbers', fetchFn);
    const balBody = await telnyxGet('/v2/balance', fetchFn);
    balance = balBody && balBody.data ? balBody.data : null;
    // Routing per number (voice_url + status_callback). A failure here is not
    // fatal: the number is still stored, just without its routing.
    for (const n of numbers) {
      const cid = n.connection_id;
      if (!cid || texmlByConnection[cid]) continue;
      try {
        const app = await telnyxGet(`/v2/texml_applications/${cid}`, fetchFn);
        texmlByConnection[cid] = app && app.data ? app.data : null;
      } catch { texmlByConnection[cid] = null; }
    }
  } catch (err) {
    const msg = err && err.message ? err.message : 'telnyx fetch failed';
    db.prepare(`INSERT INTO telnyx_sync_state (id, last_sync_at, last_error) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET last_sync_at = excluded.last_sync_at, last_error = excluded.last_error`)
      .run(startedAt.toISOString(), msg.slice(0, 500));
    return { ok: false, error: msg };
  }

  // Store it all in one transaction so a mid-sync failure rolls everything back.
  const counts = { assistants: 0, conversations: 0, numbers: 0 };
  try {
    tx(() => {
      // (a) Assistants: update existing telnyx_agents rows only. A Telnyx
      // assistant with no row is a provisioning gap; log it, do not invent a mapping.
      for (const a of assistants) {
        if (!a || typeof a.id !== 'string') continue;
        const tools = Array.isArray(a.tools) ? a.tools.map((t) => (t && t.type) || (t && t.name) || 'tool').filter(Boolean) : [];
        const changed = db.prepare(`UPDATE telnyx_agents SET name = ?, model = ?, tools_json = ?, instructions_hash = ?, last_synced_at = ?
          WHERE telnyx_assistant_id = ?`)
          .run(a.name || null, a.model || null, JSON.stringify(tools), sha256(a.instructions || ''), startedAt.toISOString(), a.id);
        if (changed.changes) counts.assistants += 1;
        else console.warn(`[telnyx-sync] assistant ${a.id} has no telnyx_agents row; skipped`);
      }

      // (b) Conversations: upsert call_summaries by conversation id. Never
      // touches summary_text (the webhook owns it) or caller_display.
      for (const c of conversations) {
        if (!c || typeof c.id !== 'string') continue;
        const meta = (c.metadata && typeof c.metadata === 'object') ? c.metadata : {};
        const to = typeof meta.to === 'string' ? meta.to : '';
        const from = typeof meta.from === 'string' ? meta.from : '';
        const assistantId = typeof meta.assistant_id === 'string' ? meta.assistant_id : '';
        let agent = null;
        if (to) agent = db.prepare('SELECT * FROM telnyx_agents WHERE telnyx_phone_number = ?').get(to);
        if (!agent && assistantId) agent = db.prepare('SELECT * FROM telnyx_agents WHERE telnyx_assistant_id = ?').get(assistantId);
        if (!agent) continue; // no tenant for this conversation
        if (!store.hasSubscription(agent.client_id, agent.service_slug)) continue;
        const created = new Date(c.created_at || Date.now());
        const lastMsg = new Date(c.last_message_at || c.created_at || Date.now());
        const durSec = Math.max(0, Math.round((lastMsg.getTime() - created.getTime()) / 1000));
        const transferred = Array.isArray(meta.called_tools) && meta.called_tools.includes('transfer') ? 1 : 0;
        const outcome = durSec > 5 ? 'answered' : 'missed';
        const occurredAt = Number.isNaN(created.getTime()) ? startedAt : created;
        // call_control_id is kept so a recording URL can be fetched fresh on
        // demand. It is never overwritten once stored.
        const callControlId = typeof meta.call_control_id === 'string' ? meta.call_control_id.slice(0, 200) : null;
        const ins = db.prepare(`INSERT INTO call_summaries
          (client_id, telnyx_agent_id, telnyx_conversation_id, occurred_at, duration_secs, caller_display, outcome, summary_text, caller_number, transferred, call_control_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(telnyx_conversation_id) DO UPDATE SET
            caller_number = excluded.caller_number,
            transferred = excluded.transferred,
            duration_secs = CASE WHEN excluded.duration_secs > 0 THEN excluded.duration_secs ELSE call_summaries.duration_secs END,
            occurred_at = excluded.occurred_at,
            call_control_id = COALESCE(call_summaries.call_control_id, excluded.call_control_id)`)
          .run(agent.client_id, agent.id, c.id, occurredAt.toISOString(), durSec, maskNum(from), outcome, '', from || null, transferred, callControlId);
        if (ins.changes) counts.conversations += 1;
      }

      // (c) Phone numbers + routing.
      for (const n of numbers) {
        if (!n || typeof n.phone_number !== 'string') continue;
        const app = (n.connection_id && texmlByConnection[n.connection_id]) || null;
        db.prepare(`INSERT INTO telnyx_numbers (id, phone_number, status, connection_id, voice_url, status_callback, purchased_at, last_synced_at)
          VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(phone_number) DO UPDATE SET
            id = excluded.id, status = excluded.status, connection_id = excluded.connection_id,
            voice_url = excluded.voice_url, status_callback = excluded.status_callback,
            purchased_at = excluded.purchased_at, last_synced_at = excluded.last_synced_at`)
          .run(n.id || null, n.phone_number, n.status || null, n.connection_id || null,
            app ? (app.voice_url || null) : null, app ? (app.status_callback || null) : null,
            n.purchased_at || null, startedAt.toISOString());
        counts.numbers += 1;
      }

      // (d) Account balance.
      if (balance && balance.balance != null) {
        const cents = Math.round(Number(balance.balance) * 100);
        if (Number.isFinite(cents)) {
          db.prepare(`INSERT INTO telnyx_account (id, balance_cents, currency, updated_at) VALUES (1, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET balance_cents = excluded.balance_cents, currency = excluded.currency, updated_at = excluded.updated_at`)
            .run(cents, balance.currency || 'USD', startedAt.toISOString());
        }
      }

      // (e) Sync state.
      db.prepare(`INSERT INTO telnyx_sync_state (id, last_sync_at, last_success_at, last_error, assistants_synced, conversations_synced, numbers_synced)
        VALUES (1, ?, ?, NULL, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET last_sync_at = excluded.last_sync_at, last_success_at = excluded.last_success_at,
          last_error = NULL, assistants_synced = excluded.assistants_synced,
          conversations_synced = excluded.conversations_synced, numbers_synced = excluded.numbers_synced`)
        .run(startedAt.toISOString(), startedAt.toISOString(), counts.assistants, counts.conversations, counts.numbers);
    });
  } catch (err) {
    const msg = err && err.message ? err.message : 'telnyx store failed';
    try {
      db.prepare(`INSERT INTO telnyx_sync_state (id, last_sync_at, last_error) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET last_sync_at = excluded.last_sync_at, last_error = excluded.last_error`)
        .run(startedAt.toISOString(), msg.slice(0, 500));
    } catch { /* state table itself failed; nothing more to do */ }
    return { ok: false, error: msg };
  }

  // Backfill transcripts for calls that have none yet (the webhook missed
  // them, or the row predates transcripts). One messages fetch per call,
  // capped so a sync never hammers Telnyx, and only rows still missing a
  // transcript. A fetch that fails is skipped and retried on the next sync;
  // it never fails the sync. Existing transcripts are never overwritten.
  let transcriptsBackfilled = 0;
  const missing = db.prepare(`SELECT telnyx_conversation_id FROM call_summaries
    WHERE transcript_json IS NULL ORDER BY occurred_at DESC LIMIT 25`).all();
  for (const row of missing) {
    const conversationId = row.telnyx_conversation_id;
    if (!conversationId) continue;
    try {
      const turns = await transcript.fetchTranscript(conversationId, fetchFn);
      const json = transcript.transcriptToJson(turns);
      if (!json) continue;
      const changed = db.prepare(`UPDATE call_summaries SET transcript_json = ?
        WHERE telnyx_conversation_id = ? AND transcript_json IS NULL`).run(json, conversationId);
      if (changed.changes) transcriptsBackfilled += 1;
    } catch (err) {
      console.warn(`[telnyx-sync] transcript backfill skipped for ${conversationId}: ${err && err.message ? err.message : err}`);
    }
  }

  return { ok: true, ...counts, transcripts_backfilled: transcriptsBackfilled, balance_cents: balance && balance.balance != null ? Math.round(Number(balance.balance) * 100) : null, last_sync_at: startedAt.toISOString() };
}

module.exports = { syncTelnyx };
