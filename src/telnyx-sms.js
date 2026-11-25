'use strict';
// Send a call-summary SMS through the Telnyx Messages API. The dashboard
// already holds TELNYX_API_KEY (used by the active sync), so no new
// credential is needed. The message goes out from the client's own Front
// Desk number (their telnyx_agents row), so the customer recognises it.
//
// Telnyx Messages API: POST https://api.telnyx.com/v2/messages
//   { from: "+19729440615", to: "+17179771021", text: "..." }
// A send is best-effort: it never throws, it returns { ok, id } or
// { ok: false, error } and the caller logs it. A failed text must never
// fail the webhook that triggered it.
const config = require('./config');

const TELNYX_MESSAGES_URL = 'https://api.telnyx.com/v2/messages';
const MAX_TEXT_CHARS = 1000;

/** Normalise a phone number to E.164. US 10-digit numbers get +1. Returns '' when unusable. */
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length >= 7 && digits.length <= 15) return `+${digits}`;
  return '';
}

function isUsablePhone(raw) {
  return normalizePhone(raw) !== '';
}

/**
 * Send one SMS. `fetchFn` is injectable for tests (defaults to global fetch).
 * Returns { ok: true, id } or { ok: false, error }.
 */
async function sendSms({ from, to, text }, fetchFn) {
  const fromNum = normalizePhone(from);
  const toNum = normalizePhone(to);
  const body = String(text || '').trim().slice(0, MAX_TEXT_CHARS);
  if (!fromNum) return { ok: false, error: 'no sending number' };
  if (!toNum) return { ok: false, error: 'no destination number' };
  if (!body) return { ok: false, error: 'empty message' };
  if (!config.telnyxApiKey) return { ok: false, error: 'TELNYX_API_KEY is not set' };
  const doFetch = fetchFn || globalThis.fetch;
  if (typeof doFetch !== 'function') return { ok: false, error: 'no fetch available' };
  let resp;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      resp = await doFetch(TELNYX_MESSAGES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.telnyxApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: fromNum, to: toNum, text: body }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { ok: false, error: `send failed: ${err.message || 'network error'}` };
  }
  let data = null;
  try { data = await resp.json(); } catch { data = null; }
  if (!resp.ok) {
    const detail = data && data.errors ? data.errors.map((e) => e.detail || e.title || '').filter(Boolean).join('; ') : '';
    return { ok: false, error: `Telnyx ${resp.status}${detail ? `: ${detail}` : ''}` };
  }
  const id = data && data.data && typeof data.data.id === 'string' ? data.data.id : '';
  return { ok: true, id };
}

module.exports = { normalizePhone, isUsablePhone, sendSms, TELNYX_MESSAGES_URL, MAX_TEXT_CHARS };
