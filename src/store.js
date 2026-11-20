'use strict';
// All data access. Every read takes a client id and only returns that client's rows.
const { db, tx } = require('./db');
const config = require('./config');
const { newId, newToken, sha256, hashPassword, maskPhones, sanitizeMetadata } = require('./security');
const { SERVICES, BY_SLUG, STATUS_LABELS, STATUS_EVENTS, DERIVABLE_FROM } = require('./services');

const nowIso = () => new Date().toISOString();

// ---- Account management (used by scripts/manage.js and scripts/seed.js) ----
function createClient({ businessName, contactName, email, phone }) {
  const id = newId('cl');
  db.prepare('INSERT INTO clients (id, business_name, contact_name, email, phone, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, businessName, contactName || null, email, phone || null, nowIso());
  return id;
}

async function createUser({ clientId, email, password, role }) {
  const id = newId('usr');
  const hash = await hashPassword(password);
  db.prepare('INSERT INTO users (id, client_id, email, password_hash, role, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, clientId || null, email, hash, role, nowIso());
  return id;
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
function addEvent({ clientId, service, eventType, title, detail, occurredAt, metadata }) {
  const id = newId('ev');
  const when = new Date(occurredAt || Date.now()).toISOString();
  const meta = sanitizeMetadata(metadata);
  tx(() => {
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
  });
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
    cards.push(card);
  }
  return cards;
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

module.exports = {
  createClient, createUser, addSubscription, setServiceStatus, createApiKey, revokeApiKey,
  addEvent, listServiceCards, listActivity, hasSubscription, nowIso,
};
