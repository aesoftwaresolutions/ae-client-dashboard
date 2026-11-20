'use strict';
// Creates ONE demo client with a Front Desk subscription, a login, an API key and sample events,
// so the dashboard can be viewed end to end. Local/demo use only.
//   node scripts/seed.js            (refuses to run when NODE_ENV=production unless --force)
const crypto = require('node:crypto');
const config = require('../src/config');
const store = require('../src/store');
const { db } = require('../src/db');

if (config.isProd && !process.argv.includes('--force')) {
  console.error('Refusing to seed demo data in production. Pass --force if you really mean it.');
  process.exit(1);
}

const DEMO_EMAIL = 'demo@example.com';
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

(async () => {
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(DEMO_EMAIL)) {
    console.log(`Demo data already exists (${DEMO_EMAIL}). Delete the data folder to start over.`);
    return;
  }
  // The password is random per run (or set SEED_DEMO_PASSWORD); nothing guessable is ever baked in.
  const password = process.env.SEED_DEMO_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const clientId = store.createClient({
    businessName: 'Riverside Plumbing (Demo)', contactName: 'Dana Rivers', email: DEMO_EMAIL, phone: '+12405550100',
  });
  await store.createUser({ clientId, email: DEMO_EMAIL, password, role: 'client' });
  store.addSubscription({ clientId, service: 'front-desk', plan: 'Front Desk 179', priceCents: 17900, billing: 'monthly' });
  const { key } = store.createApiKey({ clientId, label: 'demo front-desk agent' });

  // Sample events go through the same path as the API, so masking and status rules are exercised.
  // Fake caller numbers below are masked by addEvent before they are stored.
  const sample = [
    { h: 72, eventType: 'setup_complete', title: 'Front Desk is set up and answering calls', detail: 'Your number is forwarding to Front Desk.' },
    { h: 30, eventType: 'call_answered', title: 'Front Desk answered a call from Maria',
      detail: 'Asked about a water heater quote. Left a callback number ending 0142 (240-555-0142).' },
    { h: 26, eventType: 'call_missed', title: 'Missed a call from a caller ending in 0177', detail: 'Caller hung up before the greeting finished.' },
    { h: 5, eventType: 'call_answered', title: 'Front Desk answered a call from Tom', detail: 'Reported a leaking kitchen faucet. Booked for tomorrow morning.' },
    { h: 2, eventType: 'call_summary', title: 'Call summary ready', detail: 'Tom needs a faucet repair. Appointment confirmed for 9 AM.' },
    { h: 1, eventType: 'call_answered', title: 'Front Desk answered a call from Priya', detail: 'Asked about weekend availability. Told her we are open Saturday.' },
  ];
  for (const e of sample) store.addEvent({ clientId, service: 'front-desk', occurredAt: hoursAgo(e.h), ...e });

  console.log(`Demo data created.
CLIENT ID: ${clientId}
EMAIL: ${DEMO_EMAIL}
PASSWORD: ${password}
API KEY: ${key}
(The password and API key are shown once; the key is stored only as a hash.)`);
})();
