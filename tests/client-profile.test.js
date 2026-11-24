'use strict';
// Client business profile + logo: a client can save their business info and
// upload a logo; the logo is checked by magic bytes, stored under
// DATA_DIR/logos/ with a generated name, and served only to its owner. The
// agent settings pre-fill picks up the profile's business fields when the
// client has not set them on the agent yet. Unit tests run on a temp
// database; route tests run a real server on its own temp database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aedash-profile-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.TELNYX_API_KEY = 'test-key';

const { db } = require(path.join(root, 'src/db'));
const store = require(path.join(root, 'src/store'));
const profile = require(path.join(root, 'src/client-profile'));
const settings = require(path.join(root, 'src/telnyx-agent-settings'));

// A real 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const NOT_AN_IMAGE = Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff\x00\x00', 'latin1');

const FIELDS = {
  business_name: 'Test Co',
  contact_name: 'Tess Tester',
  email: 'test@example.com',
  phone: '+17175550100',
  website: 'www.testco.example',
  address_street: '12 Main Street',
  address_city: 'Chambersburg',
  address_state: 'PA',
  address_zip: '17201',
  business_description: 'A family plumbing company in Chambersburg.',
  services_offered: 'Drain cleaning, water heaters, leak repair',
  business_hours: 'Monday to Friday, 8am to 5pm',
};

let clientA;
let clientB;

test.before(() => {
  clientA = store.createClient({ businessName: 'Test Co', contactName: 'Test', email: 'test-a@example.com', phone: '+17175550100' });
  clientB = store.createClient({ businessName: 'Other Co', contactName: 'Other', email: 'test-b@example.com', phone: '+17175550101' });
});

test.after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

test('saving a profile persists every field and updates the client record', () => {
  const result = profile.saveProfile(clientA, FIELDS);
  assert.equal(result.ok, true, JSON.stringify(result));
  const p = result.profile;
  assert.equal(p.business_name, 'Test Co');
  assert.equal(p.contact_name, 'Tess Tester');
  assert.equal(p.email, 'test@example.com');
  assert.equal(p.phone, '+17175550100');
  assert.equal(p.website, 'https://www.testco.example'); // bare domain gets https://
  assert.equal(p.address_street, '12 Main Street');
  assert.equal(p.address_city, 'Chambersburg');
  assert.equal(p.address_state, 'PA');
  assert.equal(p.address_zip, '17201');
  assert.equal(p.business_description, 'A family plumbing company in Chambersburg.');
  assert.equal(p.services_offered, 'Drain cleaning, water heaters, leak repair');
  assert.equal(p.business_hours, 'Monday to Friday, 8am to 5pm');
  assert.equal(p.has_logo, false);
  assert.equal(p.logo_filename, null);

  // The clients row itself is updated, so the dashboard header follows.
  const row = db.prepare('SELECT business_name, contact_name, email, phone FROM clients WHERE id = ?').get(clientA);
  assert.equal(row.business_name, 'Test Co');
  assert.equal(row.contact_name, 'Tess Tester');
  assert.equal(row.email, 'test@example.com');

  // A second save reads back the same values.
  assert.deepEqual(store.getProfile(clientA), p);
});

test('validation rejects a missing business name, a bad email, a bad phone and a bad website', () => {
  assert.equal(profile.saveProfile(clientA, { ...FIELDS, business_name: '   ' }).ok, false);
  assert.match(profile.saveProfile(clientA, { ...FIELDS, business_name: '   ' }).error, /business name/);
  assert.equal(profile.saveProfile(clientA, { ...FIELDS, email: 'not-an-email' }).ok, false);
  assert.match(profile.saveProfile(clientA, { ...FIELDS, email: 'not-an-email' }).error, /email/);
  assert.equal(profile.saveProfile(clientA, { ...FIELDS, phone: '123' }).ok, false);
  assert.equal(profile.saveProfile(clientA, { ...FIELDS, website: 'not a url' }).ok, false);
  // Nothing was stored by the rejected saves.
  assert.equal(store.getProfile(clientA).website, 'https://www.testco.example');
});

test('a client saving their profile leaves another client untouched', () => {
  profile.saveProfile(clientA, { ...FIELDS, business_name: 'Test Co Renamed', business_description: 'Changed.' });
  const b = store.getProfile(clientB);
  assert.equal(b.business_name, 'Other Co');
  assert.equal(b.business_description, null);
  assert.equal(b.website, null);
});

test('logo upload accepts a valid PNG by magic bytes and rejects a text file and an oversized file', () => {
  const ok = profile.saveLogo(clientA, PNG);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.profile.has_logo, true);
  const stored = profile.logoFilename(clientA);
  assert.match(stored, new RegExp(`^${clientA}-[A-Za-z0-9_-]+\\.png$`));
  const full = profile.logoPath(stored);
  assert.ok(full && fs.existsSync(full), 'logo file should exist under DATA_DIR/logos');
  assert.ok(full.startsWith(path.join(dataDir, 'logos')));
  assert.deepEqual(fs.readFileSync(full), PNG);

  // A file that is not an image is refused, whatever its name claims.
  const bad = profile.saveLogo(clientA, NOT_AN_IMAGE);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not a supported image/);
  // The good logo is still the one stored.
  assert.equal(profile.logoFilename(clientA), stored);

  // Over 2 MB is refused.
  const huge = Buffer.alloc(profile.MAX_LOGO_BYTES + 1);
  PNG.copy(huge);
  const tooBig = profile.saveLogo(clientA, huge);
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.error, /too large/);
  assert.equal(profile.logoFilename(clientA), stored);
});

test('replacing a logo removes the old file; removing a logo clears the record and deletes the file', () => {
  const first = profile.logoFilename(clientA);
  const firstPath = profile.logoPath(first);
  assert.ok(fs.existsSync(firstPath));
  const replaced = profile.saveLogo(clientA, PNG);
  assert.equal(replaced.ok, true, JSON.stringify(replaced));
  assert.notEqual(profile.logoFilename(clientA), first);
  assert.equal(fs.existsSync(firstPath), false, 'the old logo file should be gone');
  assert.ok(fs.existsSync(profile.logoPath(profile.logoFilename(clientA))));

  const removed = profile.removeLogo(clientA);
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(removed.profile.has_logo, false);
  assert.equal(profile.logoFilename(clientA), null);
  assert.equal(fs.existsSync(profile.logoPath(profile.logoFilename(clientA) || 'none.png')), false);
  // Removing again when there is no logo is a plain error, not a crash.
  assert.equal(profile.removeLogo(clientA).error, 'no-logo');
});

test('the agent settings pre-fill picks up the profile business fields when no agent settings exist', async () => {
  // Client A has a profile but has never saved agent settings.
  profile.saveProfile(clientA, FIELDS);
  store.addSubscription({ clientId: clientA, service: 'front-desk', plan: 'Front Desk 99', priceCents: 9900, billing: 'monthly' });
  store.addTelnyxAgent({ clientId: clientA, service: 'front-desk', assistantId: 'assistant-profile-1', phone: '+19729440615', transferPhone: '+17179771021', callLimit: 60 });
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { id: 'assistant-profile-1', name: 'Aria', greeting: 'Hello, thanks for calling.', instructions: 'Live instructions from Telnyx.' } }),
  });
  const effective = await settings.getEffectiveSettings(clientA, fetchFn);
  assert.ok(effective);
  assert.equal(effective.fromTelnyx, true);
  assert.equal(effective.settings.agent_name, 'Aria');
  assert.equal(effective.settings.greeting, 'Hello, thanks for calling.');
  assert.equal(effective.settings.business_description, 'A family plumbing company in Chambersburg.');
  assert.equal(effective.settings.services_offered, 'Drain cleaning, water heaters, leak repair');
  assert.equal(effective.settings.business_hours, 'Monday to Friday, 8am to 5pm');
});

test('parseMultipart round-trips fields and a file part', () => {
  const boundary = '----testboundary1234';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\ntok123\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="logo"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n`),
    PNG,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const parsed = profile.parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
  assert.equal(parsed.fields._csrf, 'tok123');
  assert.equal(parsed.files.logo.filename, 'logo.png');
  assert.equal(parsed.files.logo.contentType, 'image/png');
  assert.deepEqual(parsed.files.logo.data, PNG);
  assert.throws(() => profile.parseMultipart(body, 'multipart/form-data'), /boundary/);
});

test('listClientsOverview carries the profile fields and logo filename for the admin view', () => {
  profile.saveProfile(clientA, FIELDS);
  profile.saveLogo(clientA, PNG);
  const over = store.listClientsOverview().find((c) => c.id === clientA);
  assert.ok(over);
  assert.equal(over.website, 'https://www.testco.example');
  assert.equal(over.address_city, 'Chambersburg');
  assert.equal(over.business_description, 'A family plumbing company in Chambersburg.');
  assert.equal(over.services_offered, 'Drain cleaning, water heaters, leak repair');
  assert.ok(over.logo_filename);
  assert.match(over.logo_filename, /\.png$/);
});

// ---- Route wiring: a real server on its own temp database --------------------
const { spawn, spawnSync } = require('node:child_process');
const routeDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aedash-profile-routes-'));
const routePort = 3900 + Math.floor(Math.random() * 90);
const routeBase = `http://127.0.0.1:${routePort}`;
const routeEnv = { ...process.env, DATA_DIR: routeDataDir, PORT: String(routePort), NODE_ENV: 'test', MAIL_MODE: 'console', BASE_URL: routeBase };
let routeServer; let routeLog = ''; let demo; let other;

const runSeed = (...a) => spawnSync(process.execPath, [path.join(root, 'scripts/seed.js'), ...a], { env: routeEnv, encoding: 'utf8' });
const cookieOf = (res, name) => (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) || '').split(';')[0].split('=')[1];

// A second client (with a logo) in the route database, made by a one-off
// process against the same DATA_DIR, so the route boundary can be proved.
function makeOtherClient() {
  const script = `
    const store = require(${JSON.stringify(path.join(root, 'src/store'))});
    const profile = require(${JSON.stringify(path.join(root, 'src/client-profile'))});
    (async () => {
      const id = store.createClient({ businessName: 'Other Co', contactName: 'Other', email: 'other@example.com', phone: '+17175550101' });
      await store.createUser({ clientId: id, email: 'other@example.com', password: 'test-password-123', role: 'client' });
      profile.saveProfile(id, { business_name: 'Other Co', email: 'other@example.com', business_description: 'The other business.' });
      const r = profile.saveLogo(id, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
      if (!r.ok) { console.error('logo failed', r.error); process.exit(1); }
      console.log('OTHER_CLIENT_ID: ' + id);
    })();`;
  const out = spawnSync(process.execPath, ['-e', script], { env: routeEnv, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return /OTHER_CLIENT_ID: (\S+)/.exec(out.stdout)[1];
}

function multipartBody(boundary, fields, file) {
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="logo"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`),
      file.data,
      Buffer.from('\r\n'),
    ]));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

test.before(async () => {
  const seed = runSeed();
  assert.equal(seed.status, 0, seed.stderr);
  const grab = (k) => new RegExp(`^${k}: (.+)$`, 'm').exec(seed.stdout)[1];
  demo = { email: grab('EMAIL'), password: grab('PASSWORD') };
  other = { id: makeOtherClient(), email: 'other@example.com', password: 'test-password-123' };
  routeServer = spawn(process.execPath, [path.join(root, 'server.js')], { env: routeEnv });
  routeServer.stdout.on('data', (d) => { routeLog += d; });
  for (let i = 0; i < 50 && !routeLog.includes('listening'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(routeLog.includes('listening'), 'server did not start');
});
test.after(() => { routeServer.kill(); fs.rmSync(routeDataDir, { recursive: true, force: true }); });

async function routeLogin(email, password) {
  const page = await fetch(`${routeBase}/login`);
  const csrf = cookieOf(page, 'ae_csrf');
  const res = await fetch(`${routeBase}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `ae_csrf=${csrf}` },
    body: new URLSearchParams({ _csrf: csrf, email, password }),
  });
  return { session: cookieOf(res, 'ae_session'), csrf };
}

test('routes: unauthenticated is refused, and a client can save their profile and upload, view and remove a logo', async () => {
  assert.equal((await fetch(`${routeBase}/app/profile`)).status, 401);
  assert.equal((await fetch(`${routeBase}/app/profile/logo`)).status, 401);
  const { session, csrf } = await routeLogin(demo.email, demo.password);
  assert.ok(session);
  // A browser sends both cookies with every request; the tests must too.
  const cookies = `ae_session=${session}; ae_csrf=${csrf}`;

  // GET pre-fills from the seeded client record.
  const got = await (await fetch(`${routeBase}/app/profile`, { headers: { cookie: cookies } })).json();
  assert.equal(got.ok, true);
  assert.equal(got.profile.business_name, 'Riverside Plumbing (Demo)');
  assert.equal(got.profile.has_logo, false);
  assert.equal(got.profile.logo_url, null);

  // POST without a matching CSRF token is refused before any save runs.
  const bad = await fetch(`${routeBase}/app/profile`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
    body: JSON.stringify({ _csrf: 'wrong', business_name: 'X' }),
  });
  assert.equal(bad.status, 400);

  // A bad email is refused with a plain message.
  const badEmail = await fetch(`${routeBase}/app/profile`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
    body: JSON.stringify({ _csrf: csrf, ...FIELDS, business_name: 'Riverside Plumbing (Demo)', email: 'nope' }),
  });
  assert.equal(badEmail.status, 400);
  assert.match((await badEmail.json()).error, /email/);

  // A good save persists.
  const saved = await fetch(`${routeBase}/app/profile`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
    body: JSON.stringify({ _csrf: csrf, ...FIELDS, business_name: 'Riverside Plumbing (Demo)' }),
  });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.equal(savedBody.profile.website, 'https://www.testco.example');
  assert.equal(savedBody.profile.business_description, 'A family plumbing company in Chambersburg.');

  // A non-image upload is refused.
  const boundary = '----routeboundary99';
  const badUpload = await fetch(`${routeBase}/app/profile/logo`, {
    method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: cookies },
    body: multipartBody(boundary, { _csrf: csrf }, { filename: 'evil.exe', contentType: 'application/octet-stream', data: NOT_AN_IMAGE }),
  });
  assert.equal(badUpload.status, 400);
  assert.match((await badUpload.json()).error, /not a supported image/);

  // A real PNG uploads, then serves back byte-identical.
  const up = await fetch(`${routeBase}/app/profile/logo`, {
    method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: cookies },
    body: multipartBody(boundary, { _csrf: csrf }, { filename: 'logo.png', contentType: 'image/png', data: PNG }),
  });
  assert.equal(up.status, 200);
  assert.equal((await up.json()).profile.has_logo, true);
  const logo = await fetch(`${routeBase}/app/profile/logo`, { headers: { cookie: cookies } });
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await logo.arrayBuffer()), PNG);

  // Removing it clears the record and the file is gone.
  const removed = await fetch(`${routeBase}/app/profile/logo/remove`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies },
    body: JSON.stringify({ _csrf: csrf }),
  });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).profile.has_logo, false);
  assert.equal((await fetch(`${routeBase}/app/profile/logo`, { headers: { cookie: cookies } })).status, 404);
});

test('routes: a client cannot reach another client logo, even with ?client_id=', async () => {
  const { session, csrf } = await routeLogin(demo.email, demo.password);
  const cookies = `ae_session=${session}; ae_csrf=${csrf}`;
  // The demo client has no logo of their own, and the other client's id in
  // the query is ignored for non-admins: both come back 404.
  assert.equal((await fetch(`${routeBase}/app/profile/logo`, { headers: { cookie: cookies } })).status, 404);
  assert.equal((await fetch(`${routeBase}/app/profile/logo?client_id=${other.id}`, { headers: { cookie: cookies } })).status, 404);
  // The other client can see their own logo.
  const otherLogin = await routeLogin(other.email, other.password);
  const otherCookies = `ae_session=${otherLogin.session}; ae_csrf=${otherLogin.csrf}`;
  const logo = await fetch(`${routeBase}/app/profile/logo`, { headers: { cookie: otherCookies } });
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await logo.arrayBuffer()), PNG);
});
