'use strict';
// Central configuration. Reads an optional .env file (tiny parser, no dependency)
// and falls back to safe defaults.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    // Real environment variables win over the file.
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadEnvFile(path.join(root, '.env'));

const env = process.env;
const isProd = env.NODE_ENV === 'production';

module.exports = {
  root,
  isProd,
  port: Number(env.PORT) || 3000,
  baseUrl: (env.BASE_URL || `http://localhost:${Number(env.PORT) || 3000}`).replace(/\/$/, ''),
  dataDir: path.resolve(root, env.DATA_DIR || 'data'),
  trustProxy: env.TRUST_PROXY === '1',
  mailMode: env.MAIL_MODE || (isProd ? 'none' : 'console'),
  eventRateLimitPerHour: Number(env.EVENT_RATE_LIMIT_PER_HOUR) || 600,
  sessionDays: 7,
  resetTokenMinutes: 60,
  quietDays: 14, // spec 5.3: no events in 14 days shows "No recent activity"
  // One-time admin bootstrap secret for POST /api/v1/admin/bootstrap.
  // Set BOOTSTRAP_SECRET in the hosting env vars (never in a file or the repo).
  // When empty the bootstrap route is disabled (404). Remove/rotate it after use.
  bootstrapSecret: env.BOOTSTRAP_SECRET || '',
};
