'use strict';
// Call-summary text notifications: validation, urgency scan, message text,
// the Telnyx SMS sender (stub fetch, no network) and maybeTextSummary
// against a temp database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aedash-notify-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.TELNYX_API_KEY = 'test-key';

const { db } = require(path.join(root, 'src/db'));
const store = require(path.join(root, 'src/store'));
const notifications = require(path.join(root, 'src/notifications'));
const sms = require(path.join(root, 'src/telnyx-sms'));

const CLIENT_ID = 'cl_test_notify';

// One client + agent so the SMS has a sending number.
const clientId = store.createClient({
  businessName: 'Test Business', contactName: 'Test', email: 'test-notify@example.com', phone: '+17179771021',
});
store.addTelnyxAgent({
  clientId, service: 'front-desk', assistantId: 'assistant-notify-1',
  phone: '+19729440615', transferPhone: '+17179771021', callLimit: 60,
});

test('phone normalisation', () => {
  assert.equal(sms.normalizePhone('7179771021'), '+17179771021');
  assert.equal(sms.normalizePhone('(717) 977-1021'), '+17179771021');
  assert.equal(sms.normalizePhone('+1 717-977-1021'), '+17179771021');
  assert.equal(sms.normalizePhone('abc'), '');
  assert.equal(sms.isUsablePhone('7179771021'), true);
  assert.equal(sms.isUsablePhone('12'), false);
});

test('settings validation: on needs a number, off does not', () => {
  const on = notifications.validateNotificationSettings({ sms_summary_enabled: true, sms_number: '7179771021', sms_urgent_only: false });
  assert.equal(on.ok, true);
  assert.equal(on.fields.smsSummaryEnabled, true);
  assert.equal(on.fields.smsNumber, '7179771021');
  const missing = notifications.validateNotificationSettings({ sms_summary_enabled: true, sms_number: '', sms_urgent_only: false });
  assert.equal(missing.ok, false);
  const off = notifications.validateNotificationSettings({ sms_summary_enabled: false, sms_number: '', sms_urgent_only: false });
  assert.equal(off.ok, true);
  assert.equal(off.fields.smsSummaryEnabled, false);
});

test('urgency scan matches the site webhook word list', () => {
  assert.equal(notifications.isUrgentSummary('The website is down and we cannot take payments'), true);
  assert.equal(notifications.isUrgentSummary('Just checking our opening hours, thanks'), false);
  assert.equal(notifications.isUrgentSummary(''), false);
});

test('summary text is short and readable', () => {
  const text = notifications.buildSummaryText({
    callerName: 'Maria', callerNumber: '+17175551234', outcome: 'answered',
    summary: 'Wants a quote for a new website.', durationSeconds: 185,
  });
  assert.match(text, /Front Desk call: Maria \(3:05\) - Wants a quote for a new website\./);
  const missed = notifications.buildSummaryText({
    callerName: '', callerNumber: '+17175551234', outcome: 'missed', summary: '', durationSeconds: 0,
  });
  assert.match(missed, /Missed call:/);
});

test('sendSms posts to Telnyx with a stub fetch', async () => {
  const seen = [];
  const stubFetch = async (url, opts) => {
    seen.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ data: { id: 'msg_test_1' } }) };
  };
  const result = await sms.sendSms({ from: '+19729440615', to: '7179771021', text: 'Hello' }, stubFetch);
  assert.equal(result.ok, true);
  assert.equal(result.id, 'msg_test_1');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.telnyx.com/v2/messages');
  const sent = JSON.parse(seen[0].opts.body);
  assert.equal(sent.from, '+19729440615');
  assert.equal(sent.to, '+17179771021');
  assert.equal(sent.text, 'Hello');
  assert.match(seen[0].opts.headers.Authorization, /^Bearer /);

  const failed = await sms.sendSms({ from: '+19729440615', to: '7179771021', text: 'Hello' },
    async () => ({ ok: false, status: 400, json: async () => ({ errors: [{ detail: 'bad number' }] }) }));
  assert.equal(failed.ok, false);
  assert.match(failed.error, /400/);
});

test('maybeTextSummary respects the settings', async () => {
  const calls = [];
  const stubFetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ data: { id: 'msg_test_2' } }) };
  };
  const call = {
    callerName: 'Maria', callerNumber: '+17175551234', outcome: 'answered',
    summary: 'Wants a quote for a new website.', durationSeconds: 185,
  };
  // Off by default: nothing is sent.
  let r = await notifications.maybeTextSummary(clientId, call, stubFetch);
  assert.equal(r.sent, false);
  assert.equal(calls.length, 0);

  // On, every call: one text goes out.
  store.saveNotificationSettings(clientId, { smsSummaryEnabled: true, smsNumber: '7179771021', smsUrgentOnly: false });
  r = await notifications.maybeTextSummary(clientId, call, stubFetch);
  assert.equal(r.sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, '+17179771021');
  assert.match(calls[0].text, /Maria/);

  // On, urgent only, routine call: nothing is sent.
  store.saveNotificationSettings(clientId, { smsSummaryEnabled: true, smsNumber: '7179771021', smsUrgentOnly: true });
  r = await notifications.maybeTextSummary(clientId, call, stubFetch);
  assert.equal(r.sent, false);
  assert.equal(calls.length, 1);

  // On, urgent only, urgent call: one text goes out.
  r = await notifications.maybeTextSummary(clientId, {
    ...call, summary: 'Emergency, the website is down and we cannot take payments.',
  }, stubFetch);
  assert.equal(r.sent, true);
  assert.equal(calls.length, 2);
});

// The settings table exists and defaults to off.
test('notification settings round-trip in the store', () => {
  const fresh = store.createClient({
    businessName: 'Fresh Co', contactName: 'F', email: 'fresh-notify@example.com', phone: '',
  });
  const defaults = store.getNotificationSettings(fresh);
  assert.equal(defaults.sms_summary_enabled, false);
  assert.equal(defaults.sms_number, '');
  const saved = store.saveNotificationSettings(fresh, { smsSummaryEnabled: true, smsNumber: '7179771021', smsUrgentOnly: true });
  assert.equal(saved.sms_summary_enabled, true);
  assert.equal(saved.sms_number, '7179771021');
  assert.equal(saved.sms_urgent_only, true);
});
