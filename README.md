# AE Client Dashboard (MVP)

Login and dashboard for AE clients: one card per purchased service, a combined activity feed, a read only billing view, a "Message AE support" form, an AE staff admin view, and a REST API that AE's agents use to push updates. Built from `your_files/client-dashboard/design-spec.md` (MVP steps 1, 2, 3, 5, 8).

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
| `POST /api/v1/webhooks/telnyx/call-summary` | Relay from the WordPress webhook (`telnyx-call-summary.php`), Bearer key. Body: `client_id, outcome ("answered"/"missed"), caller_name?, caller_number?, started_at?, duration_seconds?, summary?`. Stores only the caller's first name and last 4 digits. |
| `POST /api/v1/webhooks/telnyx` | **Direct** Telnyx receiver. No Bearer key: every request must carry a valid Ed25519 signature (`telnyx-signature-ed25519`, `telnyx-timestamp`, signed over `timestamp|raw body`) checked against `TELNYX_PUBLIC_KEY`; older or newer than 300 s is rejected; no key configured means every request is rejected (503). The client is resolved from `telnyx_agents` (assistant id, then dialled number). Handles `call.conversation.ended` into `call_summaries` + a feed event, de-duplicated by Telnyx event id and conversation id. Insights events are acknowledged, not merged (the PHP endpoint still does that). |

Browser routes added for the dashboard: `POST /app/support` (signed in client, JSON `{_csrf, subject?, message}`) stores a support message; `POST /admin/support/{id}/handled` (admin only, CSRF) marks it handled. `/app/data` now also returns `billing`, and the Online Presence Management card carries a `presence` object.

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

Billing, cards and Telnyx routing (there is **no Stripe connection** in this app; billing is read only and comes from these tables):

```bash
node scripts/manage.js set-subscription --client cl_xxx --service front-desk --next-billing 2026-12-01 [--status canceled]
node scripts/manage.js add-invoice --client cl_xxx --amount-cents 9900 --status paid --paid-at 2026-11-01T12:00:00Z [--pdf-url https://...]
node scripts/manage.js set-card --client cl_xxx --brand Visa --last4 4242 --exp 08/2028   # last 4 only; anything else is refused
node scripts/manage.js add-telnyx-agent --client cl_xxx --service front-desk --assistant-id assistant_... --phone +1717... --transfer +1717...
node scripts/manage.js create-admin --email staff@aesoftwaresolutions.com      # AE staff see the admin view at /dashboard
```

**Admin view.** Users with `role = 'admin'` (and no client) see every client, their services and statuses, and the support inbox at `/dashboard`. No `ADMIN_EMAILS` list is used because the role column already exists.

**Online Presence Management card.** Built from the OPM event types: `profile_updated` (profile status), `review_received` and `review_replied` (counts this month), `listing_fixed`, `negative_review_flagged`, and `check_completed` (last check date). For listings accuracy, send `check_completed` with `metadata: { "listings_checked": 20, "listings_accurate": 18 }`.

## Deploy to Hostinger (needs Anthony)

Not done yet. Steps, to be confirmed against the actual hPanel plan:

1. **Plan check.** Hostinger's Node.js web app feature is on Business and Cloud plans, not basic shared hosting. Confirm the plan has it, and that the Node version selector offers 22.13+ (needed for `node:sqlite`).
2. **Subdomain.** In hPanel create `dashboard.aesoftwaresolutions.com`, enable free SSL, and force HTTPS. Do not touch the WordPress site or `shop.` subdomain.
3. **Upload** this folder (Git deploy or file upload), excluding `data/` and `.env`. Entry file: `server.js`. No `npm install` is required (no dependencies).
4. **Environment variables** in hPanel: `NODE_ENV=production`, `BASE_URL=https://dashboard.aesoftwaresolutions.com`, `TRUST_PROXY=1`, and `DATA_DIR` set to a folder **outside** the deployed app directory (for example `/home/<user>/dashboard-data`) so redeploys never wipe the database.
5. **Create accounts** over SSH or the hPanel terminal: `node scripts/manage.js create-client ...`. Do **not** run the seed script in production (it refuses unless `--force`).
6. **Email.** Set `MAIL_MODE=smtp` plus `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT`, `MAIL_SMTP_USER`, `MAIL_SMTP_PASS` (and `MAIL_SMTP_SECURE=1` for port 465). Until then reset emails are not sent in production. Optional: `SUPPORT_NOTIFY_EMAIL` gets a short notice when a client posts a support message.
6b. **Telnyx.** Set `TELNYX_PUBLIC_KEY` (base64, Mission Control > Keys and Credentials > Public Key) before pointing any Telnyx webhook at `/api/v1/webhooks/telnyx`.
6c. **Purchase fulfillment watcher.** Set `STRIPE_API_KEY` in the hPanel env vars (a restricted read-only Stripe key: read charges, customers, invoices, coupons). Add an hPanel cron job, daily 18:23, running `node <app-dir>/scripts/purchase-fulfillment.js`. First run on the server: `node scripts/purchase-fulfillment.js --set-watermark 1792707816` (Oct 22 2026, the last processed sale) or the first real run writes "now" and skips the backlog. Each run checks Stripe for new succeeded charges, writes a fulfillment record per sale to `DATA_DIR/fulfillment/<charge_id>.json`, and advances the watermark. New sales show in the admin dashboard under "New sales" with what is still needed; mark each fulfilled there. The script never sends email and never writes to Stripe. Audit research, the two Muse setup renders, Sheets logging, and goal entries stay agent follow-ups, listed in each record. Do not run the old VM Python script alongside it.
7. **Backups.** Copy the `DATA_DIR/dashboard.sqlite*` files on a schedule.
8. **Verify:** sign in, post a test event with a key, confirm it appears, then revoke the test key.

## Layout

```
server.js            entry point, routing split between web and api
src/config.js        env + defaults          src/db.js        schema (spec section 6) + tx helper
src/security.js      scrypt, tokens, rate limiter, phone masking
src/services.js      17 services, event types, status rules
src/store.js         all queries             src/api.js       Bearer API + Telnyx stub
src/web.js           login/logout/reset/dashboard/support/admin   src/views.js   HTML pages
src/telnyx.js        Ed25519 verification + direct Telnyx receiver
public/              style.css (glass theme), app.js, motion.js
scripts/             seed.js, manage.js, telnyx-relay.js, send-password-reminders.js, purchase-fulfillment.js
tests/               smoke.test.js, purchase-fulfillment.test.js
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

## Look and motion

Same glass system as aesoftwaresolutions.com (`assets/refresh/ae-v5.css`, `assets/js/ae-motion.js`): slow animated background, frosted glass cards, header that turns to glass after 8px of scroll, a sticky glass jump bar with the gliding pill, hover lift with a pointer spotlight on cards, magnetic buttons, cursor glow, one fade up reveal, and the glass card popup (used for "Message AE": centred card on desktop, bottom sheet on phones). All motion is off for reduced motion (`html.ae-calm`) and nothing depends on it. `public/motion.js` holds the effects; it uses no inline code, so the strict CSP stays as is.
- Telnyx direct webhook: Ed25519 signature over the raw body, 300 s replay window, event id de-duplication, fails closed with no key. Failed signatures are rate limited per IP.
- Billing: only the last 4 card digits can be stored (database CHECK). Stripe ids are never sent to the browser. Invoice PDF links must be https.
- Support messages are stored as typed (they are NOT phone masked, so a client can leave a callback number) and always escaped on output.
