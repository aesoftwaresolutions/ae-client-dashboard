'use strict';
// All data access. Every read takes a client id and only returns that client's rows.
const { db, tx } = require('./db');
const config = require('./config');
const { newId, newToken, sha256, hashPassword, maskPhones, sanitizeMetadata } = require('./security');
const { SERVICES, BY_SLUG, STATUS_LABELS, STATUS_EVENTS, DERIVABLE_FROM } = require('./services');
const transcript = require('./telnyx-transcript');

const nowIso = () => new Date().toISOString();

// ---- Account management (used by scripts/manage.js and scripts/seed.js) ----
function createClient({ businessName, contactName, email, phone }) {
  const id = newId('cl');
  db.prepare('INSERT INTO clients (id, business_name, contact_name, email, phone, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, businessName, contactName || null, email, phone || null, nowIso());
  return id;
}

async function createUser({ clientId, email, password, role, tempPassword = false }) {
  const id = newId('usr');
  const hash = await hashPassword(password);
  const t = nowIso();
  tx(() => {
    db.prepare('INSERT INTO users (id, client_id, email, password_hash, role, created_at, password_set_at, must_reset_password) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, clientId || null, email, hash, role, t, t, tempPassword ? 1 : 0);
    if (tempPassword) {
      db.prepare('INSERT INTO password_onboarding (user_id, temp_created_at, reminder_count) VALUES (?,?,0)')
        .run(id, t);
    }
  });
  return id;
}

/** Sets a new password (reset flow or admin change). Restarts the 1-year expiry and clears the temp-password flag. */
async function setPassword(userId, password) {
  const hash = await hashPassword(password);
  const t = nowIso();
  tx(() => {
    db.prepare('UPDATE users SET password_hash=?, password_set_at=?, must_reset_password=0 WHERE id=?')
      .run(hash, t, userId);
    db.prepare('UPDATE password_onboarding SET completed_at=? WHERE user_id=? AND completed_at IS NULL')
      .run(t, userId);
  });
}

/** True when the user's current password is older than the 1-year expiry. */
function passwordExpired(user) {
  if (!user.password_set_at) return false; // unknown set time: do not lock anyone out
  const ageMs = Date.now() - new Date(user.password_set_at).getTime();
  return ageMs > config.passwordExpiryDays * 86_400_000;
}

/** Users still on a temporary password, with their onboarding state, for the reminder job. */
function listOnboardingPending() {
  return db.prepare(`
    SELECT u.id, u.email, u.client_id, o.temp_created_at, o.last_reminder_at, o.reminder_count
    FROM users u JOIN password_onboarding o ON o.user_id = u.id
    WHERE u.must_reset_password = 1 AND o.completed_at IS NULL`).all();
}

function recordOnboardingReminder(userId) {
  const t = nowIso();
  db.prepare('UPDATE password_onboarding SET last_reminder_at=?, reminder_count=reminder_count+1 WHERE user_id=?')
    .run(t, userId);
}

function addSubscription({ clientId, service, plan, priceCents, billing }) {
  if (!BY_SLUG.has(service)) throw new Error(`Unknown service: ${service}`);
  const t = nowIso();
  tx(() => {
    db.prepare('INSERT INTO subscriptions (id, client_id, service, plan, price_cents, billing, status, started_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(newId('sub'), clientId, service, plan || null, priceCents ?? null, billing || 'monthly', 'active', t);
    // Every new service starts as "Setting up"; events then move it (spec 5.3).
    db.prepare('INSERT OR IGNORE INTO service_status (client_id, service, status, progress_note, updated_at) VALUES (?,?,?,?,?)')
      .run(clientId, service, 'setting_up', null, t);
  });
}

function setServiceStatus({ clientId, service, status, note }) {
  if (!STATUS_LABELS[status]) throw new Error(`Unknown status: ${status}`);
  const r = db.prepare('UPDATE service_status SET status=?, progress_note=COALESCE(?, progress_note), updated_at=? WHERE client_id=? AND service=?')
    .run(status, note ?? null, nowIso(), clientId, service);
  if (!r.changes) throw new Error('That client has no such service');
}

/** Creates an API key. The plain key is returned ONCE here and never stored (only its SHA-256 hash). */
function createApiKey({ clientId, label }) {
  const key = `aek_${newToken(32)}`;
  const id = newId('key');
  db.prepare('INSERT INTO api_keys (id, client_id, key_hash, label, created_at) VALUES (?,?,?,?,?)')
    .run(id, clientId, sha256(key), label, nowIso());
  return { id, key };
}

function revokeApiKey(id) {
  return db.prepare('UPDATE api_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(nowIso(), id).changes > 0;
}

// ---- Events ----------------------------------------------------------------
/**
 * Appends an event and updates the card status per spec 5.3.
 * title/detail/metadata are masked here, so a full phone number is never stored.
 */
function addEvent(args) {
  return tx(() => addEventInTx(args));
}

/** Same as addEvent, for callers that already hold a transaction (the Telnyx receiver). */
function addEventInTx({ clientId, service, eventType, title, detail, occurredAt, metadata }) {
  const id = newId('ev');
  const when = new Date(occurredAt || Date.now()).toISOString();
  const meta = sanitizeMetadata(metadata);
  db.prepare('INSERT INTO events (id, client_id, service, event_type, title, detail, metadata, occurred_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, clientId, service, eventType, maskPhones(title), detail ? maskPhones(detail) : null, JSON.stringify(meta), when, nowIso());
  const next = STATUS_EVENTS[eventType];
  if (next) {
    const row = db.prepare('SELECT status FROM service_status WHERE client_id=? AND service=?').get(clientId, service);
    if (row && DERIVABLE_FROM.has(row.status) && row.status !== next) {
      db.prepare('UPDATE service_status SET status=?, updated_at=? WHERE client_id=? AND service=?')
        .run(next, nowIso(), clientId, service);
    }
  }
  return id;
}

// ---- Reads -------------------------------------------------------------------
function monthStartIso() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

/** One card per service the client has a subscription for. Services they lack are simply absent. */
function listServiceCards(clientId) {
  const subs = db.prepare(`
    SELECT s.service, s.plan, ss.status, ss.progress_note
    FROM subscriptions s
    LEFT JOIN service_status ss ON ss.client_id = s.client_id AND ss.service = s.service
    WHERE s.client_id = ?`).all(clientId);
  const bySlug = new Map(subs.map((s) => [s.service, s]));
  const monthStart = monthStartIso();
  const quietBefore = new Date(Date.now() - config.quietDays * 86_400_000).toISOString();

  const cards = [];
  for (const svc of SERVICES) {               // SERVICES order keeps the layout stable
    const sub = bySlug.get(svc.slug);
    if (!sub) continue;
    const status = sub.status || 'setting_up';
    const last = db.prepare('SELECT title, occurred_at FROM events WHERE client_id=? AND service=? ORDER BY occurred_at DESC, created_at DESC LIMIT 1')
      .get(clientId, svc.slug);
    const card = {
      service: svc.slug,
      name: svc.name,
      plan: sub.plan || null,
      status,
      status_label: STATUS_LABELS[status],
      progress_note: sub.progress_note || null,
      last_update: last ? { title: last.title, occurred_at: last.occurred_at } : null,
      // Spec 5.3: quiet for 14 days shows "No recent activity" but never changes the status.
      quiet: !last || last.occurred_at < quietBefore,
      stats: [],
      recent_calls: [],
    };
    if (svc.kind === 'calls') {
      const counts = Object.fromEntries(db.prepare(
        'SELECT event_type, COUNT(*) AS c FROM events WHERE client_id=? AND service=? AND occurred_at>=? GROUP BY event_type')
        .all(clientId, svc.slug, monthStart).map((r) => [r.event_type, r.c]));
      card.stats.push({ label: 'Calls answered this month', value: counts.call_answered || 0 });
      card.stats.push({ label: 'Calls missed this month', value: counts.call_missed || 0 });
      if (svc.slug === 'always-on-front-desk') card.stats.push({ label: 'After-hours calls this month', value: counts.after_hours_call || 0 });
      // Short plain-language summaries only (spec 8 / decision 4).
      card.recent_calls = db.prepare(`
        SELECT title, detail, occurred_at FROM events
        WHERE client_id=? AND service=? AND event_type IN ('call_answered','call_missed','call_summary','after_hours_call')
          AND detail IS NOT NULL AND detail <> ''
        ORDER BY occurred_at DESC, created_at DESC LIMIT 3`).all(clientId, svc.slug);
    }
    if (svc.kind === 'presence') card.presence = presenceDetails(clientId, svc.slug, monthStart);
    cards.push(card);
  }
  return cards;
}

/**
 * Online Presence Management card details, built only from the OPM event types in
 * src/services.js. Listings accuracy comes from the newest check_completed event's
 * metadata { listings_checked, listings_accurate } when the agent sends it.
 */
function presenceDetails(clientId, service, monthStart) {
  const counts = Object.fromEntries(db.prepare(
    'SELECT event_type, COUNT(*) AS c FROM events WHERE client_id=? AND service=? AND occurred_at>=? GROUP BY event_type')
    .all(clientId, service, monthStart).map((r) => [r.event_type, r.c]));
  const latest = (type) => db.prepare(
    'SELECT occurred_at, metadata FROM events WHERE client_id=? AND service=? AND event_type=? ORDER BY occurred_at DESC, created_at DESC LIMIT 1')
    .get(clientId, service, type) || null;
  const profile = latest('profile_updated');
  const check = latest('check_completed');
  let listings = null;
  if (check) {
    let meta = {};
    try { meta = JSON.parse(check.metadata || '{}') || {}; } catch { meta = {}; }
    const checked = Number(meta.listings_checked);
    const accurate = Number(meta.listings_accurate);
    if (Number.isInteger(checked) && Number.isInteger(accurate) && checked > 0 && accurate >= 0 && accurate <= checked) {
      listings = { checked, accurate, percent: Math.round((accurate / checked) * 100) };
    }
  }
  return {
    profile_updated_at: profile ? profile.occurred_at : null,
    reviews_this_month: counts.review_received || 0,
    replies_this_month: counts.review_replied || 0,
    flagged_this_month: counts.negative_review_flagged || 0,
    listings_fixed_this_month: counts.listing_fixed || 0,
    listings,
    last_check_at: check ? check.occurred_at : null,
  };
}

// ---- Billing (read only; built from subscriptions, invoices, payment_methods) ----
// There is no Stripe client in this app. These rows are written by AE staff with
// scripts/manage.js (or a future Stripe sync). Nothing here can charge anyone.
const safeHttpsUrl = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : null);

function getBilling(clientId) {
  const subscriptions = db.prepare(`
    SELECT service, plan, price_cents, billing, status, started_at, next_billing_at
    FROM subscriptions WHERE client_id = ? ORDER BY started_at DESC`).all(clientId)
    .map((r) => ({ ...r, service_name: BY_SLUG.get(r.service)?.name || r.service, active: r.status === 'active' }));
  const now = nowIso();
  const upcoming = subscriptions
    .filter((r) => r.active && r.billing === 'monthly' && r.next_billing_at && r.next_billing_at >= now.slice(0, 10))
    .sort((a, b) => (a.next_billing_at < b.next_billing_at ? -1 : 1));
  let nextPayment = null;
  if (upcoming.length) {
    const date = upcoming[0].next_billing_at;
    const sameDay = upcoming.filter((r) => r.next_billing_at === date);
    const known = sameDay.filter((r) => Number.isInteger(r.price_cents));
    nextPayment = {
      date,
      amount_cents: known.length === sameDay.length ? known.reduce((t, r) => t + r.price_cents, 0) : null,
      services: sameDay.map((r) => r.service_name),
    };
  }
  const invoices = db.prepare(`
    SELECT id, amount_cents, status, issued_at, paid_at, pdf_url FROM invoices
    WHERE client_id = ? ORDER BY COALESCE(issued_at, paid_at) DESC LIMIT 24`).all(clientId)
    .map((r) => ({ ...r, pdf_url: safeHttpsUrl(r.pdf_url) }));
  const card = db.prepare('SELECT brand, last4, exp_month, exp_year FROM payment_methods WHERE client_id = ?').get(clientId) || null;
  return { source: 'dashboard', subscriptions, next_payment: nextPayment, invoices, card };
}

function setCard({ clientId, brand, last4, expMonth, expYear }) {
  if (!/^\d{4}$/.test(String(last4 || ''))) throw new Error('last4 must be exactly 4 digits (never the full card number)');
  db.prepare(`INSERT INTO payment_methods (client_id, brand, last4, exp_month, exp_year, updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(client_id) DO UPDATE SET brand=excluded.brand, last4=excluded.last4, exp_month=excluded.exp_month,
      exp_year=excluded.exp_year, updated_at=excluded.updated_at`)
    .run(clientId, brand ? String(brand).slice(0, 30) : null, String(last4), expMonth ?? null, expYear ?? null, nowIso());
}

function addInvoice({ clientId, amountCents, status, issuedAt, paidAt, pdfUrl, stripeInvoiceId }) {
  if (!Number.isInteger(amountCents) || amountCents < 0) throw new Error('amount-cents must be a whole number of cents');
  if (pdfUrl && !safeHttpsUrl(pdfUrl)) throw new Error('pdf-url must be an https URL');
  const id = newId('inv');
  db.prepare('INSERT INTO invoices (id, client_id, stripe_invoice_id, amount_cents, status, issued_at, paid_at, pdf_url) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, clientId, stripeInvoiceId || null, amountCents, status, issuedAt || nowIso(), paidAt || null, pdfUrl || null);
  return id;
}

function updateSubscription({ clientId, service, status, nextBillingAt }) {
  const r = db.prepare('UPDATE subscriptions SET status=COALESCE(?, status), next_billing_at=COALESCE(?, next_billing_at) WHERE client_id=? AND service=?')
    .run(status ?? null, nextBillingAt ?? null, clientId, service);
  if (!r.changes) throw new Error('That client has no such subscription');
}

// ---- Support messages ------------------------------------------------------------
function addSupportMessage({ clientId, userId, subject, message }) {
  const id = newId('msg');
  db.prepare('INSERT INTO support_messages (id, client_id, user_id, subject, message, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, clientId, userId, subject || null, message, nowIso());
  return id;
}

function listSupportMessages({ limit = 100 } = {}) {
  return db.prepare(`
    SELECT m.id, m.subject, m.message, m.status, m.created_at, m.handled_at,
           c.business_name, c.id AS client_id, u.email AS from_email
    FROM support_messages m JOIN clients c ON c.id = m.client_id JOIN users u ON u.id = m.user_id
    ORDER BY (m.status = 'open') DESC, m.created_at DESC LIMIT ?`).all(limit);
}

function markSupportHandled(id, adminUserId) {
  return db.prepare("UPDATE support_messages SET status='handled', handled_at=?, handled_by=? WHERE id=? AND status='open'")
    .run(nowIso(), adminUserId, id).changes > 0;
}

// ---- Admin overview (AE staff only; callers must check role first) --------------
function listClientsOverview() {
  const clients = db.prepare(`
    SELECT c.id, c.business_name, c.contact_name, c.email, c.status, c.created_at,
      p.website, p.address_street, p.address_city, p.address_state, p.address_zip,
      p.business_description, p.services_offered, p.business_hours, p.logo_filename
    FROM clients c LEFT JOIN client_profiles p ON p.client_id = c.id
    ORDER BY c.business_name COLLATE NOCASE`).all();
  const services = db.prepare(`
    SELECT s.client_id, s.service, s.plan, s.status AS billing_status, ss.status, ss.updated_at
    FROM subscriptions s LEFT JOIN service_status ss ON ss.client_id = s.client_id AND ss.service = s.service`).all();
  const open = Object.fromEntries(db.prepare("SELECT client_id, COUNT(*) AS c FROM support_messages WHERE status='open' GROUP BY client_id").all()
    .map((r) => [r.client_id, r.c]));
  const order = new Map(SERVICES.map((s, i) => [s.slug, i]));
  const byClient = new Map(clients.map((c) => [c.id, []]));
  for (const s of services) {
    const status = s.status || 'setting_up';
    byClient.get(s.client_id)?.push({
      service: s.service, name: BY_SLUG.get(s.service)?.name || s.service, plan: s.plan,
      status, status_label: STATUS_LABELS[status] || status, billing_status: s.billing_status, updated_at: s.updated_at,
    });
  }
  return clients.map((c) => ({
    ...c,
    services: (byClient.get(c.id) || []).sort((a, b) => (order.get(a.service) ?? 99) - (order.get(b.service) ?? 99)),
    open_messages: open[c.id] || 0,
  }));
}

// ---- Telnyx agent mapping (used by scripts/manage.js add-telnyx-agent) ----------
function addTelnyxAgent({ clientId, service, assistantId, phone, transferPhone, callLimit }) {
  if (!['front-desk', 'always-on-front-desk'].includes(service)) throw new Error('service must be front-desk or always-on-front-desk');
  if (!/^\+\d{8,15}$/.test(String(phone || ''))) throw new Error('phone must be E.164, for example +17175550100');
  if (!/^\+\d{8,15}$/.test(String(transferPhone || ''))) throw new Error('transfer phone must be E.164');
  const r = db.prepare(`INSERT INTO telnyx_agents (client_id, service_slug, telnyx_assistant_id, telnyx_phone_number, transfer_phone_number, tier_call_limit)
    VALUES (?,?,?,?,?,?)`).run(clientId, service, assistantId, phone, transferPhone, Number.isInteger(callLimit) ? callLimit : 60);
  return Number(r.lastInsertRowid);
}

/** Newest-first feed across the client's services. Metadata is deliberately not returned. */
function listActivity(clientId, limit = 50) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  return db.prepare(`
    SELECT id, service, event_type, title, detail, occurred_at FROM events
    WHERE client_id = ? AND service IN (SELECT service FROM subscriptions WHERE client_id = ?)
    ORDER BY occurred_at DESC, created_at DESC LIMIT ?`).all(clientId, clientId, n)
    .map((e) => ({ ...e, service_name: BY_SLUG.get(e.service)?.name || e.service }));
}

const hasSubscription = (clientId, service) =>
  !!db.prepare('SELECT 1 FROM subscriptions WHERE client_id=? AND service=?').get(clientId, service);

// ---- Telnyx active sync reads (admin view + client Calls list) -----------------
/** Everything the admin Telnyx section needs. Numbers are AE-owned, so they are shown masked. */
/**
 * AE's own client login: Anthony signs in as a role 'client' user on the AE
 * client (created by the bootstrap in src/api.js), so he sees the client
 * dashboard, not the admin view. This is the one place that says who that is.
 *
 * Keyed on the LOGIN email (users.email: unique, case-insensitive, and not
 * editable from the dashboard), never on clients.email, which any client can
 * change in their business profile. Also requires role 'client' and a client
 * attached, and, when AE_CLIENT_ID is set, that exact client id. Anything
 * missing or unexpected returns false (hide).
 */
const AE_OWNER_EMAIL = 'anthony@aesoftwaresolutions.com';
function isAeOwner(me) {
  if (!me || !me.user || !me.client) return false;
  if (me.user.role !== 'client' || !me.user.client_id || me.user.client_id !== me.client.id) return false;
  if (String(me.user.email || '').trim().toLowerCase() !== AE_OWNER_EMAIL) return false;
  if (config.aeClientId && me.client.id !== config.aeClientId) return false;
  return true;
}

/** The Telnyx account balance for the AE owner's dashboard card: the same row
 * the admin page reads, plus the last successful sync time. Read only. */
function getTelnyxBalance() {
  const account = db.prepare('SELECT balance_cents, currency, updated_at FROM telnyx_account WHERE id = 1').get() || null;
  const sync = db.prepare('SELECT last_success_at FROM telnyx_sync_state WHERE id = 1').get() || null;
  return {
    balance_cents: account && Number.isInteger(account.balance_cents) ? account.balance_cents : null,
    currency: (account && account.currency) || 'USD',
    updated_at: (account && account.updated_at) || null,
    last_success_at: (sync && sync.last_success_at) || null,
  };
}

function listTelnyxOverview() {
  const account = db.prepare('SELECT balance_cents, currency, updated_at FROM telnyx_account WHERE id = 1').get() || null;
  const sync = db.prepare('SELECT last_sync_at, last_success_at, last_error, assistants_synced, conversations_synced, numbers_synced FROM telnyx_sync_state WHERE id = 1').get() || null;
  const numbers = db.prepare('SELECT phone_number, status, connection_id, voice_url, status_callback, purchased_at, last_synced_at FROM telnyx_numbers ORDER BY phone_number').all();
  const agents = db.prepare(`SELECT a.telnyx_assistant_id, a.telnyx_phone_number, a.name, a.model, a.tools_json, a.instructions_hash,
    a.last_synced_at, a.status, c.business_name
    FROM telnyx_agents a LEFT JOIN clients c ON c.id = a.client_id ORDER BY a.telnyx_phone_number`).all()
    .map((a) => ({ ...a, tools: (() => { try { return JSON.parse(a.tools_json || '[]'); } catch { return []; } })() }));
  return { account, sync, numbers, agents };
}

/** The client's Front Desk agent (name, model, number, tools) for the Calls card and the AI Agent settings. */
function getTelnyxAgent(clientId) {
  const row = db.prepare(`SELECT id, service_slug, telnyx_assistant_id, telnyx_phone_number, transfer_phone_number, name, model, tools_json, last_synced_at
    FROM telnyx_agents WHERE client_id = ? AND service_slug IN ('front-desk', 'always-on-front-desk')
    ORDER BY service_slug LIMIT 1`).get(clientId);
  if (!row) return null;
  let tools = [];
  try { tools = JSON.parse(row.tools_json || '[]'); } catch { tools = []; }
  return { ...row, tools };
}

/** The client's call history, newest first. Caller numbers are masked on display. */
function listCalls(clientId, limit = 50) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  return db.prepare(`
    SELECT telnyx_conversation_id, occurred_at, duration_secs, caller_display, outcome, summary_text, transferred,
      (transcript_json IS NOT NULL) AS has_transcript
    FROM call_summaries WHERE client_id = ? ORDER BY occurred_at DESC LIMIT ?`).all(clientId, n)
    .map((c) => ({ ...c, has_transcript: c.has_transcript === 1, caller_display: maskPhones(c.caller_display), summary_text: maskPhones(c.summary_text) }));
}

/**
 * One call's detail for the transcript view: the call itself plus the full
 * transcript (or null when none has arrived yet) and the call control id
 * needed to fetch a fresh recording URL on demand. Returns null when the
 * conversation does not belong to this client. The transcript text is
 * masked again here, so a stored transcript can never leak a full number.
 */
function getCallDetail(clientId, conversationId) {
  const row = db.prepare(`
    SELECT telnyx_conversation_id, occurred_at, duration_secs, caller_display, outcome, summary_text, transferred,
      transcript_json, call_control_id
    FROM call_summaries WHERE client_id = ? AND telnyx_conversation_id = ?`).get(clientId, conversationId);
  if (!row) return null;
  const turns = transcript.parseTranscript(row.transcript_json)
    .map((t) => ({ ...t, text: maskPhones(t.text) }));
  return {
    telnyx_conversation_id: row.telnyx_conversation_id,
    occurred_at: row.occurred_at,
    duration_secs: row.duration_secs,
    caller_display: maskPhones(row.caller_display),
    outcome: row.outcome,
    summary_text: maskPhones(row.summary_text),
    transferred: row.transferred,
    has_transcript: turns.length > 0,
    transcript: turns.length ? turns : null,
    call_control_id: row.call_control_id || null,
  };
}

/**
 * Calls + minutes in the current billing cycle, anchored on the Front Desk
 * subscription's next_billing_at (same anchor the billing view uses). Falls
 * back to the calendar month when no next billing date is set.
 */
function getCallsUsage(clientId) {
  const sub = db.prepare(`SELECT next_billing_at FROM subscriptions
    WHERE client_id = ? AND service IN ('front-desk', 'always-on-front-desk') AND status = 'active'
    ORDER BY next_billing_at DESC LIMIT 1`).get(clientId);
  let cycleStart;
  if (sub && sub.next_billing_at) {
    const next = new Date(sub.next_billing_at);
    cycleStart = Number.isNaN(next.getTime())
      ? monthStartIso()
      : new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() - 1, next.getUTCDate())).toISOString();
  } else {
    cycleStart = monthStartIso();
  }
  const row = db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(duration_secs), 0) AS seconds
    FROM call_summaries WHERE client_id = ? AND occurred_at >= ?`).get(clientId, cycleStart);
  return { calls: row.calls, minutes: Math.round(row.seconds / 60), cycle_start: cycleStart };
}

/** The client's saved AI Agent settings, or null when they have never saved any. */
function getAgentSettings(agentId) {
  const row = db.prepare(`SELECT agent_name, greeting, business_description, services_offered,
    business_hours, instructions, custom_instructions, voice, voice_speed, transfer_phone, updated_at
    FROM telnyx_agent_settings WHERE agent_id = ?`).get(agentId);
  if (!row) return null;
  return { ...row, custom_instructions: row.custom_instructions === 1 };
}

/**
 * Stores the settings only AFTER the Telnyx PATCH succeeded. In the same
 * transaction, updates the agent row so the sync stays consistent: the name
 * the client set, the hash of the instructions that were applied, and the
 * sync time. Never touches call_summaries, balance or numbers.
 */
function saveAgentSettingsLocal(agentId, { agentName, greeting, businessDescription, servicesOffered, businessHours, instructions, customInstructions, voice, voiceSpeed, transferPhone }) {
  const t = nowIso();
  const hash = sha256(instructions || '');
  tx(() => {
    db.prepare(`INSERT INTO telnyx_agent_settings
      (agent_id, agent_name, greeting, business_description, services_offered, business_hours, instructions, custom_instructions, voice, voice_speed, transfer_phone, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(agent_id) DO UPDATE SET
        agent_name = excluded.agent_name, greeting = excluded.greeting,
        business_description = excluded.business_description, services_offered = excluded.services_offered,
        business_hours = excluded.business_hours, instructions = excluded.instructions,
        custom_instructions = excluded.custom_instructions, voice = excluded.voice,
        voice_speed = excluded.voice_speed, transfer_phone = excluded.transfer_phone,
        updated_at = excluded.updated_at`)
      .run(agentId, agentName || null, greeting || null, businessDescription || null, servicesOffered || null,
        businessHours || null, instructions || null, customInstructions ? 1 : 0,
        voice || null, voiceSpeed == null ? null : voiceSpeed, transferPhone || null, t);
    db.prepare(`UPDATE telnyx_agents SET name = ?, instructions_hash = ?, last_synced_at = ?, updated_at = ?
      WHERE id = ?`).run(agentName || null, hash, t, t, agentId);
    if (transferPhone) {
      db.prepare(`UPDATE telnyx_agents SET transfer_phone_number = ? WHERE id = ?`).run(transferPhone, agentId);
    }
  });
  return getAgentSettings(agentId);
}

// ---- Client business profile (src/client-profile.js) --------------------------
// The merged profile: the clients row (name, contact, email, phone) plus the
// client_profiles row (website, address, description, services, hours, logo).
// logo_filename is the generated file name under DATA_DIR/logos/, or null.
function getProfile(clientId) {
  const row = db.prepare(`
    SELECT c.id, c.business_name, c.contact_name, c.email, c.phone, c.status, c.created_at,
      p.website, p.address_street, p.address_city, p.address_state, p.address_zip,
      p.business_description, p.services_offered, p.business_hours, p.logo_filename, p.updated_at
    FROM clients c LEFT JOIN client_profiles p ON p.client_id = c.id
    WHERE c.id = ?`).get(clientId);
  if (!row) return null;
  return {
    ...row,
    has_logo: !!row.logo_filename,
  };
}

/** Writes a validated profile: clients row + client_profiles upsert, one tx. */
function saveProfileLocal(clientId, fields) {
  const t = nowIso();
  tx(() => {
    db.prepare('UPDATE clients SET business_name = ?, contact_name = ?, email = ?, phone = ? WHERE id = ?')
      .run(fields.businessName, fields.contactName || null, fields.email, fields.phone || null, clientId);
    db.prepare(`INSERT INTO client_profiles
      (client_id, website, address_street, address_city, address_state, address_zip,
       business_description, services_offered, business_hours, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(client_id) DO UPDATE SET
        website = excluded.website, address_street = excluded.address_street,
        address_city = excluded.address_city, address_state = excluded.address_state,
        address_zip = excluded.address_zip, business_description = excluded.business_description,
        services_offered = excluded.services_offered, business_hours = excluded.business_hours,
        updated_at = excluded.updated_at`)
      .run(clientId, fields.website || null, fields.addressStreet || null, fields.addressCity || null,
        fields.addressState || null, fields.addressZip || null, fields.businessDescription || null,
        fields.servicesOffered || null, fields.businessHours || null, t);
  });
  return getProfile(clientId);
}

/** Records a new logo filename for a client (creating the profile row when needed). */
function setLogo(clientId, filename) {
  const t = nowIso();
  db.prepare(`INSERT INTO client_profiles (client_id, logo_filename, updated_at) VALUES (?,?,?)
    ON CONFLICT(client_id) DO UPDATE SET logo_filename = excluded.logo_filename, updated_at = excluded.updated_at`)
    .run(clientId, filename, t);
}

/** Clears the logo filename. Returns the filename that was stored, or null. */
function clearLogo(clientId) {
  const row = db.prepare('SELECT logo_filename FROM client_profiles WHERE client_id = ?').get(clientId);
  db.prepare('UPDATE client_profiles SET logo_filename = NULL, updated_at = ? WHERE client_id = ?').run(nowIso(), clientId);
  return row ? row.logo_filename : null;
}

// ---- Call-summary text notifications (src/notifications.js) -------------------
// One row per client. Defaults are off with no number, so nothing is texted
// until the client turns it on in the dashboard and saves a number.
/** The client's saved notification settings, or the off-by-default shape when none exist. */
function getNotificationSettings(clientId) {
  const row = db.prepare(`SELECT sms_summary_enabled, sms_number, sms_urgent_only, updated_at
    FROM client_notification_settings WHERE client_id = ?`).get(clientId);
  if (!row) return { sms_summary_enabled: false, sms_number: '', sms_urgent_only: false, updated_at: null };
  return {
    sms_summary_enabled: row.sms_summary_enabled === 1,
    sms_number: row.sms_number || '',
    sms_urgent_only: row.sms_urgent_only === 1,
    updated_at: row.updated_at,
  };
}

/** Upserts validated notification settings for a client. Returns the saved shape. */
function saveNotificationSettings(clientId, { smsSummaryEnabled, smsNumber, smsUrgentOnly }) {
  const t = nowIso();
  db.prepare(`INSERT INTO client_notification_settings
    (client_id, sms_summary_enabled, sms_number, sms_urgent_only, updated_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(client_id) DO UPDATE SET
      sms_summary_enabled = excluded.sms_summary_enabled, sms_number = excluded.sms_number,
      sms_urgent_only = excluded.sms_urgent_only, updated_at = excluded.updated_at`)
    .run(clientId, smsSummaryEnabled ? 1 : 0, smsNumber || null, smsUrgentOnly ? 1 : 0, t);
  return getNotificationSettings(clientId);
}

/** The client's Front Desk number (their agent's Telnyx number), or null. Used as the SMS sender. */
function getClientSendingNumber(clientId) {
  const row = db.prepare(`SELECT telnyx_phone_number FROM telnyx_agents
    WHERE client_id = ? ORDER BY id LIMIT 1`).get(clientId);
  return row ? row.telnyx_phone_number : null;
}

module.exports = {
  AE_OWNER_EMAIL, isAeOwner, getTelnyxBalance,
  createClient, createUser, setPassword, passwordExpired, listOnboardingPending, recordOnboardingReminder,
  addSubscription, setServiceStatus, createApiKey, revokeApiKey,
  addEvent, addEventInTx, listServiceCards, listActivity, hasSubscription, nowIso,
  getBilling, setCard, addInvoice, updateSubscription,
  addSupportMessage, listSupportMessages, markSupportHandled, listClientsOverview, addTelnyxAgent,
  listTelnyxOverview, getTelnyxAgent, listCalls, getCallsUsage, getCallDetail,
  getAgentSettings, saveAgentSettingsLocal,
  getProfile, saveProfileLocal, setLogo, clearLogo,
  getNotificationSettings, saveNotificationSettings, getClientSendingNumber,
};
