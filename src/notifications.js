'use strict';
// Call-summary text notifications. A client turns on "text me a summary after
// each call" in the dashboard, picks the number to text and whether to text
// every call or urgent calls only. When a call summary is ingested (the relay
// from the AE-site webhook, src/api.js ingestTelnyx), the dashboard texts the
// summary from the client's own Front Desk number via Telnyx SMS.
//
// Urgency is decided here by scanning the summary for the same urgent words
// the site webhook uses, because the relay payload does not carry an urgency
// flag. A text is best-effort: it never throws and never fails the webhook
// that triggered it.
const store = require('./store');
const sms = require('./telnyx-sms');

// Same urgent words as the site webhook (call-summary-webhook.php ae_is_urgent).
const URGENT_WORDS = ['emergency', 'urgent', '911', 'website is down', 'site is down',
  'store is down', "can't take payments", 'cannot take payments',
  'gas smell', 'carbon monoxide', 'fire', 'asap', 'immediately', 'right away'];

/** True when the summary reads urgent (keyword scan, case-insensitive). */
function isUrgentSummary(text) {
  const t = String(text || '').toLowerCase();
  return URGENT_WORDS.some((w) => t.includes(w));
}

const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/**
 * Validates notification settings from a form or JSON body. Returns
 * { ok: true, fields } with cleaned values, or { ok: false, error }.
 * When texting is on, a number is required and must be 7 to 15 digits.
 * When it is off, the number and the urgent-only flag are kept as given
 * (so turning it back on later does not lose them).
 */
function validateNotificationSettings(input) {
  const enabled = input.sms_summary_enabled === true || input.sms_summary_enabled === '1'
    || input.sms_summary_enabled === 1 || input.sms_summary_enabled === 'on';
  const urgentOnly = input.sms_urgent_only === true || input.sms_urgent_only === '1'
    || input.sms_urgent_only === 1 || input.sms_urgent_only === 'on';
  const number = clean(input.sms_number, 40);
  if (enabled) {
    const digits = number.replace(/\D/g, '');
    if (!number || digits.length < 7 || digits.length > 15) {
      return { ok: false, error: 'Please enter the phone number to text the summary to.' };
    }
  }
  return { ok: true, fields: { smsSummaryEnabled: enabled, smsNumber: number, smsUrgentOnly: urgentOnly } };
}

/** The client's saved notification settings (off by default). */
function getNotificationSettings(clientId) {
  return store.getNotificationSettings(clientId);
}

/**
 * Saves validated notification settings for a client. Returns
 * { ok: true, settings } or { ok: false, error }.
 */
function saveNotificationSettings(clientId, input) {
  const validated = validateNotificationSettings(input);
  if (!validated.ok) return validated;
  if (!store.getProfile(clientId)) return { ok: false, error: 'Client not found.' };
  return { ok: true, settings: store.saveNotificationSettings(clientId, validated.fields) };
}

/**
 * Build the text for one call summary. Short enough for a single SMS:
 * who called, what they wanted, outcome and duration.
 */
function buildSummaryText({ callerName, callerNumber, outcome, summary, durationSeconds }) {
  const who = (callerName || '').trim() || (callerNumber || '').trim() || 'Unknown caller';
  const what = (summary || '').trim() || 'No summary captured.';
  const dur = Number.isFinite(durationSeconds) && durationSeconds > 0
    ? ` (${Math.floor(durationSeconds / 60)}:${String(durationSeconds % 60).padStart(2, '0')})` : '';
  const label = outcome === 'missed' ? 'Missed call' : 'Front Desk call';
  return `${label}: ${who}${dur} - ${what}`.slice(0, 1000);
}

/**
 * Text a call summary to a client when their settings say so. Call this
 * after a summary is ingested. `fetchFn` is injectable for tests.
 * Returns { sent: true, id } when a text went out, { sent: false, reason }
 * when the settings said not to, and { sent: false, error } when the send
 * itself failed. Never throws.
 */
async function maybeTextSummary(clientId, call, fetchFn) {
  try {
    const settings = store.getNotificationSettings(clientId);
    if (!settings.sms_summary_enabled) return { sent: false, reason: 'sms summaries off' };
    if (!settings.sms_number) return { sent: false, reason: 'no sms number' };
    const text = buildSummaryText(call);
    if (settings.sms_urgent_only && !isUrgentSummary(call.summary) && call.outcome !== 'missed') {
      return { sent: false, reason: 'not urgent' };
    }
    const from = store.getClientSendingNumber(clientId);
    if (!from) return { sent: false, reason: 'no sending number' };
    const result = await sms.sendSms({ from, to: settings.sms_number, text }, fetchFn);
    if (!result.ok) return { sent: false, error: result.error };
    return { sent: true, id: result.id };
  } catch (err) {
    return { sent: false, error: err.message || 'send failed' };
  }
}

module.exports = {
  URGENT_WORDS, isUrgentSummary, validateNotificationSettings,
  getNotificationSettings, saveNotificationSettings, buildSummaryText, maybeTextSummary,
};
