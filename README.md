# AE Client Dashboard (MVP)

Login and dashboard for AE clients: one card per purchased service, a combined activity feed, and a REST API that AE's agents use to push updates. Built from `your_files/client-dashboard/design-spec.md` (MVP steps 1, 2, 3, 5, 8).

**Stack:** Node.js (22.13 or newer) with the built-in `node:sqlite`. **No npm packages to install**, no native builds, no separate database server. Front end is plain HTML, CSS and JavaScript.

## Run it locally

```bash
cd client-dashboard
cp .env.example .env          # optional; defaults work
node scripts/seed.js          # creates the demo client; prints its email, password and API key ONCE
node server.js                # http://localhost:3000
```

Sign in with the seeded `demo@example.com` and the printed password. Password-reset emails print to the server log in local mode (`MAIL_MODE=console`).

Run the tests (starts its own server on a temporary database): `npm test`

## Try the API

```bash
KEY=aek_...     # printed by the seed script
CID=cl_...      # client id printed by the seed script
curl -X POST http://localhost:3000/api/v1/front-desk/events \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"client_id\":\"$CID\",\"service\":\"front-desk\",\"event_type\":\"call_answered\",
       \"title\":\"Front Desk answered a call\",\"detail\":\"Caller asked about pricing.\"}"

curl -H "Authorization: Bearer $KEY" http://localhost:3000/api/v1/clients/$CID/services
curl -H "Authorization: Bearer $KEY" "http://localhost:3000/api/v1/clients/$CID/activity?limit=50"
```

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/{service}/events` | Push an event (spec 5.1). Body: `client_id, service, event_type, title, detail, occurred_at, metadata`. |
| `GET /api/v1/clients/{client_id}/services` | Cards and statuses for that client. |
| `GET /api/v1/clients/{client_id}/activity?limit=50` | Feed, newest first (max 200). |
| `POST /api/v1/webhooks/telnyx/call-summary` | **Stub** for the Telnyx call-summary relay. Body: `client_id, outcome ("answered"/"missed"), caller_name?, caller_number?, started_at?, duration_seconds?, summary?`. Stores only the caller's first name and last 4 digits. |

Errors: `401` bad key, `403` client_id belongs to another client, `404` unknown service, `422` client lacks that service, `429` rate limit (600 per hour per key, `Retry-After` header), `400` bad input.

## Managing clients (until the admin view exists)

```bash
node scripts/manage.js help
node scripts/manage.js create-client --business "Acme Roofing" --email owner@acme.com
node scripts/manage.js add-subscription --client cl_xxx --service front-desk --plan "Front Desk 99" --price-cents 9900
node scripts/manage.js create-key --client cl_xxx --label "front-desk webhook"   # key shown once
node scripts/manage.js revoke-key --id key_xxx
node scripts/manage.js set-status --client cl_xxx --service front-desk --status paused
```

A service card appears for a client only after `add-subscription`; new services start as **Setting up**.

## Deploy to Hostinger (needs Anthony)

Not done yet. Steps, to be confirmed against the actual hPanel plan:

1. **Plan check.** Hostinger's Node.js web app feature is on Business and Cloud plans, not basic shared hosting. Confirm the plan has it, and that the Node version selector offers 22.13+ (needed for `node:sqlite`).
2. **Subdomain.** In hPanel create `dashboard.aesoftwaresolutions.com`, enable free SSL, and force HTTPS. Do not touch the WordPress site or `shop.` subdomain.
3. **Upload** this folder (Git deploy or file upload), excluding `data/` and `.env`. Entry file: `server.js`. No `npm install` is required (no dependencies).
4. **Environment variables** in hPanel: `NODE_ENV=production`, `BASE_URL=https://dashboard.aesoftwaresolutions.com`, `TRUST_PROXY=1`, and `DATA_DIR` set to a folder **outside** the deployed app directory (for example `/home/<user>/dashboard-data`) so redeploys never wipe the database.
5. **Create accounts** over SSH or the hPanel terminal: `node scripts/manage.js create-client ...`. Do **not** run the seed script in production (it refuses unless `--force`).
6. **Email.** Password reset needs a mail provider. Replace the body of `sendMail` in `src/mail.js` (Hostinger SMTP or a transactional service). Until then reset emails are not sent in production.
7. **Backups.** Copy the `DATA_DIR/dashboard.sqlite*` files on a schedule.
8. **Verify:** sign in, post a test event with a key, confirm it appears, then revoke the test key.

## Layout

```
server.js            entry point, routing split between web and api
src/config.js        env + defaults          src/db.js        schema (spec section 6) + tx helper
src/security.js      scrypt, tokens, rate limiter, phone masking
src/services.js     16 services, event types, status rules
src/store.js         all queries             src/api.js       Bearer API + Telnyx stub
src/web.js           login/logout/reset/dashboard   src/views.js   HTML pages
public/              style.css, app.js       scripts/         seed.js, manage.js
tests/smoke.test.js  end-to-end tests
```

## Security notes

- Passwords: scrypt (N=32768) with per-password salt. Plain text is never stored or logged.
- API keys: 256-bit random, only the SHA-256 hash is stored, the key is shown once at creation. Keys can be revoked.
- A key only works for its own `client_id` (checked in the URL and in the body). Dashboard data comes from the session, never from a client-supplied id.
- Sessions: random token, hash stored, HttpOnly + SameSite=Lax cookie (`__Host-` and Secure in production), 7 days; password reset signs out all sessions. CSRF double-submit token on every form.
- Login, reset and bad-key attempts are rate limited. Event POST: 600/hour per key.
- Phone numbers: anything that looks like a phone number in `title`, `detail` or metadata strings is masked to the last four digits **before storage**; metadata keys such as `phone`, `number`, `card`, `password`, `token`, `caller` are dropped.
- API access log (key label, endpoint, status, time; no bodies) is in table `api_access_log`.
- Strict CSP (no inline scripts or styles), no third-party assets.
