'use strict';
// SQLite via Node's built-in node:sqlite (no native build step, no npm packages).
// Schema follows spec section 6, plus sessions, password_resets, api_access_log,
// telnyx_webhook_events, payment_methods and support_messages.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(config.dataDir, 'dashboard.sqlite'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS clients (
  id            TEXT PRIMARY KEY,
  business_name TEXT NOT NULL,
  contact_name  TEXT,
  email         TEXT NOT NULL,
  phone         TEXT,
  created_at    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  client_id     TEXT REFERENCES clients(id),          -- NULL for AE admins
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,                        -- scrypt, never plain text
  role          TEXT NOT NULL CHECK (role IN ('client','admin')),
  created_at    TEXT NOT NULL,
  last_login_at TEXT,
  password_set_at     TEXT,                           -- when the current password was set; NULL = unknown (backfilled from created_at)
  must_reset_password INTEGER NOT NULL DEFAULT 0      -- 1 while a temporary password is still in use
);

-- New-member onboarding: tracks the set-password email + reminder sequence
-- for users created with a temporary password.
CREATE TABLE IF NOT EXISTS password_onboarding (
  user_id         TEXT PRIMARY KEY REFERENCES users(id),
  temp_created_at TEXT NOT NULL,                      -- when the temp password was issued
  last_reminder_at TEXT,                             -- when the last reminder email was sent
  reminder_count  INTEGER NOT NULL DEFAULT 0,
  completed_at    TEXT                               -- when the user set a real password
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                     TEXT PRIMARY KEY,
  client_id              TEXT NOT NULL REFERENCES clients(id),
  service                TEXT NOT NULL,               -- service slug
  plan                   TEXT,
  price_cents            INTEGER,
  billing                TEXT NOT NULL CHECK (billing IN ('monthly','one-time')),
  stripe_subscription_id TEXT,
  status                 TEXT NOT NULL DEFAULT 'active',
  started_at             TEXT NOT NULL,
  next_billing_at        TEXT,
  UNIQUE (client_id, service)
);

CREATE TABLE IF NOT EXISTS service_status (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id     TEXT NOT NULL REFERENCES clients(id),
  service       TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('active','setting_up','attention','paused','ended')),
  progress_note TEXT,
  updated_at    TEXT NOT NULL,
  UNIQUE (client_id, service)
);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES clients(id),
  service     TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  title       TEXT NOT NULL,
  detail      TEXT,
  metadata    TEXT,                                   -- JSON string, already sanitised
  occurred_at TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_client_time ON events (client_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_client_service ON events (client_id, service, occurred_at DESC);
-- Spec: events are append-only.
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES clients(id),
  key_hash     TEXT NOT NULL UNIQUE,                  -- SHA-256 of the key; the key itself is never stored
  label        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
  id                TEXT PRIMARY KEY,
  client_id         TEXT NOT NULL REFERENCES clients(id),
  stripe_invoice_id TEXT,
  amount_cents      INTEGER NOT NULL,
  status            TEXT NOT NULL,
  paid_at           TEXT,
  pdf_url           TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_at    TEXT
);

-- Spec 10: log key label, endpoint, timestamp, result. Never request bodies.
CREATE TABLE IF NOT EXISTS api_access_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id    TEXT,
  key_label TEXT,
  method    TEXT NOT NULL,
  endpoint  TEXT NOT NULL,
  status    INTEGER NOT NULL,
  at        TEXT NOT NULL
);

-- Phone-to-client mapping for Telnyx Front Desk routing. Every inbound
-- Telnyx webhook resolves telnyx_assistant_id or telnyx_phone_number to a
-- client_id through this table, so calls are never assigned to the wrong tenant.
CREATE TABLE IF NOT EXISTS telnyx_agents (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id             TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  service_slug          TEXT NOT NULL CHECK (service_slug IN ('front-desk', 'always-on-front-desk', 'social-front-desk')),
  telnyx_assistant_id   TEXT UNIQUE NOT NULL,
  telnyx_phone_number   TEXT UNIQUE NOT NULL,
  transfer_phone_number TEXT NOT NULL,
  tier_call_limit       INTEGER NOT NULL DEFAULT 60,
  status                TEXT NOT NULL DEFAULT 'provisioning', -- provisioning | qa_pending | active | paused
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_telnyx_agents_phone ON telnyx_agents (telnyx_phone_number);
CREATE INDEX IF NOT EXISTS idx_telnyx_agents_assistant ON telnyx_agents (telnyx_assistant_id);

-- Per-call summaries, one row per Telnyx conversation. telnyx_conversation_id
-- is the idempotency key so webhook retries never create a duplicate row.
-- caller_display holds a masked phone or first name ONLY, never a full number.
CREATE TABLE IF NOT EXISTS call_summaries (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id              TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  telnyx_agent_id        INTEGER NOT NULL REFERENCES telnyx_agents(id),
  telnyx_conversation_id TEXT UNIQUE NOT NULL,
  occurred_at            TEXT NOT NULL,
  duration_secs          INTEGER DEFAULT 0,
  caller_display         TEXT NOT NULL,
  outcome                TEXT NOT NULL, -- answered | booked | transferred | callback | missed
  summary_text           TEXT NOT NULL,
  flagged_for_review     INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_call_summaries_client_time ON call_summaries (client_id, occurred_at DESC);

-- Direct Telnyx receiver: one row per delivered Telnyx event id, so retries and
-- replays inside the signature window are acknowledged but never processed twice.
CREATE TABLE IF NOT EXISTS telnyx_webhook_events (
  event_id    TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,
  received_at TEXT NOT NULL
);

-- Unified inbox (Intercom parity): one conversation per contact per channel,
-- with every message in it. Calls land here from call_summaries; SMS and
-- social DMs land here when those channels are wired in. A conversation is
-- grouped by (client, channel, contact_key): the caller's E.164 number for
-- call/sms, the social handle for social. contact_display is masked on
-- display, never a full number. status is open until the client marks the
-- conversation resolved.
CREATE TABLE IF NOT EXISTS inbox_conversations (
  id                TEXT PRIMARY KEY,
  client_id         TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  channel           TEXT NOT NULL CHECK (channel IN ('call','sms','social')),
  contact_key       TEXT NOT NULL,
  contact_display   TEXT NOT NULL,
  last_message_at   TEXT NOT NULL,
  last_message_text TEXT,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  unread_count      INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (client_id, channel, contact_key)
);
CREATE INDEX IF NOT EXISTS idx_inbox_conversations_client_time ON inbox_conversations (client_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_conversations_client_status ON inbox_conversations (client_id, status, last_message_at DESC);

CREATE TABLE IF NOT EXISTS inbox_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES inbox_conversations(id) ON DELETE CASCADE,
  client_id       TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL CHECK (channel IN ('call','sms','social')),
  direction       TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  body            TEXT NOT NULL,
  occurred_at     TEXT NOT NULL,
  source_id       TEXT,                                -- telnyx_conversation_id for calls; message id for sms/social
  metadata        TEXT,                                -- JSON: outcome, duration, transcript flag, recording flag
  created_at      TEXT NOT NULL,
  UNIQUE (client_id, channel, source_id)
);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_conversation_time ON inbox_messages (conversation_id, occurred_at DESC);

-- Billing view: the card on file, last 4 digits ONLY. There is no Stripe client in
-- this app; AE staff record this with scripts/manage.js set-card. The CHECK makes it
-- impossible to store anything but exactly four digits.
CREATE TABLE IF NOT EXISTS payment_methods (
  client_id  TEXT PRIMARY KEY REFERENCES clients(id),
  brand      TEXT,
  last4      TEXT NOT NULL CHECK (length(last4) = 4 AND last4 GLOB '[0-9][0-9][0-9][0-9]'),
  exp_month  INTEGER CHECK (exp_month IS NULL OR exp_month BETWEEN 1 AND 12),
  exp_year   INTEGER,
  updated_at TEXT NOT NULL
);

-- Client to AE support messages (dashboard "Message AE" form), shown in the admin view.
CREATE TABLE IF NOT EXISTS support_messages (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES clients(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  subject     TEXT,
  message     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','handled')),
  created_at  TEXT NOT NULL,
  handled_at  TEXT,
  handled_by  TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_support_messages_time ON support_messages (status, created_at DESC);

-- Telnyx active sync (src/telnyx-sync.js). Filled from read-only Telnyx API GETs.
-- Phone numbers here are AE-owned Telnyx numbers, not caller numbers; they are
-- still masked whenever they are shown.
CREATE TABLE IF NOT EXISTS telnyx_numbers (
  id              TEXT,                               -- Telnyx phone number id
  phone_number    TEXT UNIQUE NOT NULL,
  status          TEXT,
  connection_id   TEXT,                               -- TeXML application id
  voice_url       TEXT,                               -- from the TeXML application
  status_callback TEXT,                               -- from the TeXML application
  purchased_at    TEXT,
  last_synced_at  TEXT
);

-- Single row (id = 1): the Telnyx account balance from GET /v2/balance.
CREATE TABLE IF NOT EXISTS telnyx_account (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  balance_cents INTEGER,
  currency      TEXT,
  updated_at    TEXT
);

-- Single row (id = 1): outcome of the most recent Telnyx sync.
CREATE TABLE IF NOT EXISTS telnyx_sync_state (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  last_sync_at         TEXT,
  last_success_at      TEXT,
  last_error           TEXT,
  assistants_synced    INTEGER,
  conversations_synced INTEGER,
  numbers_synced       INTEGER
);

-- Client business profile (src/client-profile.js). One row per client, created
-- the first time they save their profile. business_name, contact_name, email
-- and phone live on clients; everything else about the business lives here,
-- including the logo filename (the file itself lives under DATA_DIR/logos/,
-- never in the database and never in the repo). The AI Agent settings form
-- pre-fills its business description / services / hours from this row when
-- the client has not set them there yet.
CREATE TABLE IF NOT EXISTS client_profiles (
  client_id            TEXT PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  website              TEXT,
  address_street       TEXT,
  address_city         TEXT,
  address_state        TEXT,
  address_zip          TEXT,
  business_description TEXT,
  services_offered     TEXT,
  business_hours       TEXT,
  logo_filename        TEXT,
  updated_at           TEXT NOT NULL
);

-- Client-facing AI agent settings (src/telnyx-agent-settings.js). One row per
-- telnyx_agents row. The client edits these in the dashboard after buying a
-- Front Desk subscription; saving PATCHes the Telnyx assistant (name, greeting,
-- instructions) and only then stores the row here. instructions holds the exact
-- prompt that was applied to Telnyx; custom_instructions is 1 when the client
-- wrote that prompt themselves, 0 when it was built from the business fields.
CREATE TABLE IF NOT EXISTS telnyx_agent_settings (
  agent_id            INTEGER PRIMARY KEY REFERENCES telnyx_agents(id) ON DELETE CASCADE,
  agent_name          TEXT,
  greeting            TEXT,
  business_description TEXT,
  services_offered    TEXT,
  business_hours      TEXT,
  instructions        TEXT,
  custom_instructions INTEGER NOT NULL DEFAULT 0,
  voice               TEXT,
  voice_speed         REAL,
  transfer_phone      TEXT,
  updated_at          TEXT NOT NULL
);

-- Call-summary text notifications (src/notifications.js). One row per client.
-- The client turns on "text me a summary after each call" in the dashboard,
-- picks the number to text and whether to text every call or urgent calls
-- only. sms_number is stored as the digits the client typed; it is
-- normalised to E.164 when a text is sent. Nothing is texted while
-- sms_summary_enabled is 0.
CREATE TABLE IF NOT EXISTS client_notification_settings (
  client_id           TEXT PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  sms_summary_enabled INTEGER NOT NULL DEFAULT 0,
  sms_number          TEXT,
  sms_urgent_only     INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL
);
`);

// ---- Migrations for databases created before a schema change ----------------
// Adds password_set_at / must_reset_password to users when the table predates
// them, and backfills password_set_at from created_at so existing passwords
// get a 1-year expiry from when the account was created.
{
  const cols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  if (!cols.has('password_set_at')) db.exec('ALTER TABLE users ADD COLUMN password_set_at TEXT');
  if (!cols.has('must_reset_password')) db.exec("ALTER TABLE users ADD COLUMN must_reset_password INTEGER NOT NULL DEFAULT 0");
  db.prepare('UPDATE users SET password_set_at = created_at WHERE password_set_at IS NULL').run();
}
// Invoices had no date column; the billing view needs one to sort and display them.
{
  const cols = new Set(db.prepare('PRAGMA table_info(invoices)').all().map((c) => c.name));
  if (!cols.has('issued_at')) db.exec('ALTER TABLE invoices ADD COLUMN issued_at TEXT');
}
// Telnyx active sync: assistant details on telnyx_agents (NULL until the first sync).
{
  const cols = new Set(db.prepare('PRAGMA table_info(telnyx_agents)').all().map((c) => c.name));
  for (const col of ['name', 'model', 'tools_json', 'instructions_hash', 'last_synced_at']) {
    if (!cols.has(col)) db.exec(`ALTER TABLE telnyx_agents ADD COLUMN ${col} TEXT`);
  }
}
// Social Front Desk agents need a telnyx_agents row too. SQLite cannot ALTER
// a CHECK constraint, so an older table (front-desk / always-on only) is
// rebuilt with the wider constraint, preserving every row.
{
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'telnyx_agents'").get();
  if (row && row.sql && !row.sql.includes('social-front-desk')) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE telnyx_agents_new (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id             TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        service_slug          TEXT NOT NULL CHECK (service_slug IN ('front-desk', 'always-on-front-desk', 'social-front-desk')),
        telnyx_assistant_id   TEXT UNIQUE NOT NULL,
        telnyx_phone_number   TEXT UNIQUE NOT NULL,
        transfer_phone_number TEXT NOT NULL,
        tier_call_limit       INTEGER NOT NULL DEFAULT 60,
        status                TEXT NOT NULL DEFAULT 'provisioning',
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
        name                  TEXT,
        model                 TEXT,
        tools_json            TEXT,
        instructions_hash     TEXT,
        last_synced_at        TEXT
      );
      INSERT INTO telnyx_agents_new (id, client_id, service_slug, telnyx_assistant_id, telnyx_phone_number, transfer_phone_number, tier_call_limit, status, created_at, updated_at, name, model, tools_json, instructions_hash, last_synced_at)
        SELECT id, client_id, service_slug, telnyx_assistant_id, telnyx_phone_number, transfer_phone_number, tier_call_limit, status, created_at, updated_at, name, model, tools_json, instructions_hash, last_synced_at FROM telnyx_agents;
      DROP TABLE telnyx_agents;
      ALTER TABLE telnyx_agents_new RENAME TO telnyx_agents;
      CREATE INDEX IF NOT EXISTS idx_telnyx_agents_phone ON telnyx_agents (telnyx_phone_number);
      CREATE INDEX IF NOT EXISTS idx_telnyx_agents_assistant ON telnyx_agents (telnyx_assistant_id);
      PRAGMA foreign_keys = ON;
    `);
  }
}
// Agent settings: voice, voice speed and transfer number are now editable in
// the dashboard and pushed to Telnyx; older databases gain the columns here.
{
  const cols = new Set(db.prepare('PRAGMA table_info(telnyx_agent_settings)').all().map((c) => c.name));
  if (!cols.has('voice')) db.exec('ALTER TABLE telnyx_agent_settings ADD COLUMN voice TEXT');
  if (!cols.has('voice_speed')) db.exec('ALTER TABLE telnyx_agent_settings ADD COLUMN voice_speed REAL');
  if (!cols.has('transfer_phone')) db.exec('ALTER TABLE telnyx_agent_settings ADD COLUMN transfer_phone TEXT');
}
// Telnyx active sync: caller number (masked on display) and the transfer flag on call_summaries.
{
  const cols = new Set(db.prepare('PRAGMA table_info(call_summaries)').all().map((c) => c.name));
  if (!cols.has('caller_number')) db.exec('ALTER TABLE call_summaries ADD COLUMN caller_number TEXT');
  if (!cols.has('transferred')) db.exec('ALTER TABLE call_summaries ADD COLUMN transferred INTEGER NOT NULL DEFAULT 0');
}
// Call transcripts: the words actually spoken, stored as normalized JSON
// (src/telnyx-transcript.js), plus the Telnyx call control id used to fetch
// a fresh recording URL on demand. A transcript is only ever filled when it
// is still empty; it is never overwritten.
{
  const cols = new Set(db.prepare('PRAGMA table_info(call_summaries)').all().map((c) => c.name));
  if (!cols.has('transcript_json')) db.exec('ALTER TABLE call_summaries ADD COLUMN transcript_json TEXT');
  if (!cols.has('call_control_id')) db.exec('ALTER TABLE call_summaries ADD COLUMN call_control_id TEXT');
}

/** Run fn inside a transaction; roll back if it throws. */
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, tx };
