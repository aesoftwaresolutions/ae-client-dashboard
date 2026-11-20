'use strict';
// AE staff command line for the things the admin view will do later (spec 7, step 7 is not built yet).
//   node scripts/manage.js <command> [--flag value ...]
// Run `node scripts/manage.js help` for the list.
const crypto = require('node:crypto');
const store = require('../src/store');
const { db } = require('../src/db');
const { SERVICES } = require('../src/services');

const [cmd, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i += 2) args[rest[i].replace(/^--/, '')] = rest[i + 1];

const need = (...names) => names.forEach((n) => { if (!args[n]) { console.error(`Missing --${n}`); process.exit(1); } });
const tempPassword = () => crypto.randomBytes(12).toString('base64url');

const commands = {
  async 'create-client'() {
    need('business', 'email');
    const clientId = store.createClient({ businessName: args.business, contactName: args.contact, email: args.email, phone: args.phone });
    const password = args.password || tempPassword();
    await store.createUser({ clientId, email: args.email, password, role: 'client' });
    console.log(`Client ID: ${clientId}\nLogin email: ${args.email}\nTemporary password: ${password}\n(Shown once. Ask the client to use "Forgot your password?" to choose their own.)`);
  },
  async 'create-admin'() {
    need('email');
    const password = args.password || tempPassword();
    await store.createUser({ clientId: null, email: args.email, password, role: 'admin' });
    console.log(`Admin created: ${args.email}\nTemporary password: ${password}`);
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
Service slugs: ${SERVICES.map((s) => s.slug).join(', ')}`);
  },
};

if (!commands[cmd]) { commands.help(); process.exit(cmd ? 1 : 0); }
Promise.resolve(commands[cmd]()).catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });
