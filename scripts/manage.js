'use strict';
// AE staff command line for the things the admin view will do later (spec 7, step 7 is not built yet).
//   node scripts/manage.js <command> [--flag value ...]
// Run `node scripts/manage.js help` for the list.
const crypto = require('node:crypto');
const store = require('../src/store');
const { db } = require('../src/db');
const { SERVICES } = require('../src/services');
const { sendPasswordResetEmail, runReminders } = require('../src/onboarding');

const [cmd, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i += 2) args[rest[i].replace(/^--/, '')] = rest[i + 1];

const need = (...names) => names.forEach((n) => { if (!args[n]) { console.error(`Missing --${n}`); process.exit(1); } });
const tempPassword = () => crypto.randomBytes(12).toString('base64url');

const commands = {
  async 'create-client'() {
    need('business', 'email');
    const clientId = store.createClient({ businessName: args.business, contactName: args.contact, email: args.email, phone: args.phone });
    const isTemp = !args.password;
    const password = args.password || tempPassword();
    const userId = await store.createUser({ clientId, email: args.email, password, role: 'client', tempPassword: isTemp });
    let emailed = false;
    if (isTemp) {
      // New-member onboarding: email the set-password link (7-day link, reminders day 3 + 6).
      emailed = await sendPasswordResetEmail({ id: userId, email: args.email }, { reason: 'welcome' }).catch(() => false);
    }
    console.log(`Client ID: ${clientId}\nLogin email: ${args.email}\nTemporary password: ${password}\n(Shown once. ${emailed ? 'A set-password email was sent.' : 'No set-password email was sent (mail not configured); ask the client to use "Forgot your password?" to choose their own.'})`);
  },
  async 'create-admin'() {
    need('email');
    const isTemp = !args.password;
    const password = args.password || tempPassword();
    const userId = await store.createUser({ clientId: null, email: args.email, password, role: 'admin', tempPassword: isTemp });
    let emailed = false;
    if (isTemp) {
      emailed = await sendPasswordResetEmail({ id: userId, email: args.email }, { reason: 'welcome' }).catch(() => false);
    }
    console.log(`Admin created: ${args.email}\nTemporary password: ${password}${emailed ? '\nA set-password email was sent.' : ''}`);
  },
  async 'send-reminders'() {
    // Daily job: day-3 and day-6 set-password reminders for members still on a temp password.
    const result = await runReminders();
    console.log(JSON.stringify(result));
    if (result.errors.length) process.exit(1);
  },
  'add-subscription'() {
    need('client', 'service');
    store.addSubscription({
      clientId: args.client, service: args.service, plan: args.plan,
      priceCents: args['price-cents'] ? Number(args['price-cents']) : null, billing: args.billing || 'monthly',
    });
    console.log(`Added ${args.service} for ${args.client} (status: Setting up).`);
  },
  'set-status'() {
    need('client', 'service', 'status');
    store.setServiceStatus({ clientId: args.client, service: args.service, status: args.status, note: args.note });
    console.log('Status updated.');
  },
  'create-key'() {
    need('client', 'label');
    const { id, key } = store.createApiKey({ clientId: args.client, label: args.label });
    console.log(`Key id: ${id}\nAPI key: ${key}\n(Shown once. Only a hash is stored; it cannot be recovered. Revoke and re-create if lost.)`);
  },
  'revoke-key'() {
    need('id');
    console.log(store.revokeApiKey(args.id) ? 'Key revoked.' : 'No active key with that id.');
  },
  'list-clients'() {
    for (const c of db.prepare('SELECT id, business_name, email, status FROM clients ORDER BY created_at').all()) {
      console.log(`${c.id}  ${c.business_name}  <${c.email}>  ${c.status}`);
    }
  },
  help() {
    console.log(`Commands:
  create-client --business "Name" --email e [--contact n] [--phone p] [--password pw]
  create-admin --email e [--password pw]
  add-subscription --client ID --service SLUG [--plan "Front Desk 179"] [--price-cents 17900] [--billing monthly|one-time]
  set-status --client ID --service SLUG --status active|setting_up|attention|paused|ended [--note "text"]
  create-key --client ID --label "front-desk webhook"
  revoke-key --id KEY_ID
  list-clients
  send-reminders  (daily job: day-3 and day-6 set-password reminders for members still on a temp password)
Service slugs: ${SERVICES.map((s) => s.slug).join(', ')}`);
  },
};

if (!commands[cmd]) { commands.help(); process.exit(cmd ? 1 : 0); }
Promise.resolve(commands[cmd]()).catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });
