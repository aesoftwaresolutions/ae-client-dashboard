'use strict';
// SQLite via Node's built-in node:sqlite (no native build step, no npm packages).
// Schema follows spec section 6, plus sessions, password_resets and api_access_log.
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
