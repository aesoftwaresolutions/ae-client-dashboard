# Handoff Notes — Dashboard + Website Review Implementation (2026-11-21)

Written by waltah for Claude / any agent picking this up. Covers the Gemini/Neon review
doc the user pasted on 2026-11-21 and the implementation done the same night.

## What was audited
- Dashboard repo: aesoftwaresolutions/ae-client-dashboard, branch main. Node.js + built-in
  SQLite (node:sqlite), no dependencies. Entry server.js; src/ has api.js, db.js, store.js,
  security.js, onboarding.js, services.js, mail.js, views.js, web.js, http.js, config.js,
  brand.js. public/ has style.css, app.js. scripts/ has manage.js, seed.js, telnyx-relay.js,
  send-password-reminders.js. Tests: tests/smoke.test.js (11 tests, node:test).
- Website repo: aesoftwaresolutions/AESOFTWARESOLUTIONS.COM, branches master + deploy/theme.
  WordPress theme. Hostinger deploys deploy/theme. Live site aesoftwaresolutions.com.
- Dashboard live at https://dashboard.aesoftwaresolutions.com. DATA_DIR is
  /home/u198003533/dashboard-data (outside the deploy dir, set in hPanel env vars).
  Hostinger Node 22.x, GitHub auto-deploy On.

## What waltah implemented and pushed (all verified, tests pass)
1. Dashboard branding (main be069ebe): white AE mark on login/reset/forgot pages and
   topbar; AE favicons on every page. Assets inlined as base64 data URIs in src/brand.js
   (new file). The standard ae-logo-mark.png is a DARK mark on transparent, invisible on
   the dark dashboard, so a white version was built from ae-logo-icon-dark.png
   (brightness -> alpha, tile black 22 mapped to transparent). Verified live.
2. telnyx_agents + call_summaries tables (main 13222576, src/db.js): phone-to-client
   mapping. telnyx_agents: client_id FK, service_slug CHECK front-desk/always-on-front-desk,
   telnyx_assistant_id UNIQUE, telnyx_phone_number UNIQUE, transfer_phone_number,
   tier_call_limit default 60, status provisioning|qa_pending|active|paused. call_summaries:
   client_id FK, telnyx_agent_id FK, telnyx_conversation_id UNIQUE (idempotency key),
   occurred_at, duration_secs, caller_display (masked/first name ONLY), outcome
   answered|booked|transferred|callback|missed, summary_text, flagged_for_review.
   Verified by test inserts: duplicate conversation rejected, duplicate phone rejected,
   phone lookup resolves to client, FK enforced, test data rolled back.
3. 17-service tracking matrix (main 13222576, src/services.js): was 16 services, added
   Order Desk (slug order-desk, kind orders, events setup_complete, order_received,
   order_pending_approval, order_approved, pricing_report_ready, plan_limit_warning).
   Expanded event types per the review matrix (front-desk gains appointment_booked and
   call_transferred; OPM gains negative_review_flagged; missed-lead-audit gains
   credit_applied and audit_in_progress; launch-package gains setup_started,
   deliverable_ready, setup_complete; etc.). OLD event names kept alongside the new ones
   so existing stored events keep working. All 11 tests pass.
4. Email sender (main f7ee9a59, src/config.js): mailFrom default changed to
   'AE Software Solutions <admin@aesoftwaresolutions.com>'. Business mail (password
   resets, onboarding, support) goes out as admin@; outreach stays on
   anthony@aesoftwaresolutions.com. SMTP env vars set by Anthony in hPanel Nov 21 ~23:49
   (MAIL_MODE=smtp, MAIL_SMTP_HOST=smtp.zoho.com, PORT 587, USER admin@, PASS). Test
   password reset triggered Nov 21 ~23:50 for anthony@aesoftwaresolutions.com (POST
   /forgot 200, "reset link is on its way"). Delivery confirmation depends on Anthony
   seeing the email from admin@ in his inbox; the /forgot page returns the same message
   whether or not SMTP succeeded, by design. Reset link valid 60 min; ignoring it
   changes nothing.

## What the review got wrong (do not re-do)
- SMTP is ALREADY fully wired in src/mail.js (complete SMTP client, STARTTLS + AUTH
  LOGIN, dot-stuffing). It only needed MAIL_MODE=smtp + creds in hPanel env vars.
- security.js already has scrypt passwords, timing-safe compare, RateLimiter, maskPhones
  (PII scrubbing), sanitizeMetadata (rejects sensitive keys, 4 KB max).
- db.js already had hashed API keys (SHA-256), append-only events (triggers), password
  expiry (365 days, password_set_at + must_reset_password), password_onboarding table,
  sessions, password_resets (token_hash), api_access_log.
- DATA_DIR already set outside the deploy dir.
- Business hours already aligned: website Mon-Fri 9am-10pm, matches GBP (pushed Nov 21,
  master e2b9b78b / deploy/theme ef37f47d). The review's "website shows 9am-5pm" is stale.

## Still pending / blocked (needs Anthony or counsel)
- Zoho SMTP: env vars are set; only delivery confirmation is outstanding (Anthony checks
  inbox for the test reset email from admin@).
- Ed25519 webhook verification: needs the Telnyx public key from the Telnyx portal.
  The PHP webhook (telnyx-call-summary.php on the WordPress site) receives the raw Telnyx
  webhook and currently auths by ?key= secret (works). Add Ed25519 check there (PHP
  sodium_crypto_sign_verify_detached, raw body bytes, reject replays > 5 min), and/or a
  direct Node receiver POST /api/v1/webhooks/telnyx with the same check. Do NOT break the
  live PHP webhook while doing this; it is live and working (last push Nov 21, master
  18ac769e / deploy/theme 18e4152b, verified 403 without key, homepage 200).
- Counsel review of Front Desk terms/privacy policy BEFORE building the intake form and
  src/telnyx-provisioner.js. The provisioner must: assign a Telnyx number from a pool,
  create a Telnyx AI assistant (POST https://api.telnyx.com/v2/ai/assistants) with a
  guardrailed prompt (client business name, never read URLs aloud, never promise install
  dates, sell only approved offers, transfer/callback instead of guessing), attach the
  insights webhook to the dashboard, persist mapping into telnyx_agents, leave the card
  in Setting up until an admin approves (QA test call), then emit setup_complete.
- Pricing page (page-pricing.php): call-volume estimator slider (20-400+ calls, tiers
  $99/$179/$309 + overage), Monthly/Annual toggle, feature comparison table, "What Happens
  After You Buy" timeline (no fixed install dates), pricing FAQ, per-tier "Best For" labels.
- Retiring telnyx-call-summary.php in favor of the Node webhook: RISKY migration, do not
  do it in the same pass as other changes. The PHP webhook is live and working.
- Billing module (read-only Stripe view), Admin view (all clients), "Message AE" support
  form, OPM card details. These are assigned to Gemini Neon (see below).

## Gemini Neon task (in progress, browser)
- Gemini 4 Neon, High thinking, signed in as anthony.aesoftwaresolutions@gmail.com (Pro).
- Saved chat: https://gemini.google.com/app/7450d215363c8ee5
- Brief submitted Nov 21 ~23:52. Priorities: (1) Ed25519, Billing, Admin view, Message AE,
  OPM card; (2) telnyx-provisioner.js + gated intake form; (3) pricing page work + font
  confirmation. Rules given: no pushing to GitHub, no .github/workflows changes, no price
  or term changes, no invented offers, zero hyphens/dashes in public copy, "we" voice,
  only Invoca 2026 / BrightLocal 2026 stats. Gemini was told to include detailed HANDOFF
  NOTES for another agent at the end of its response.
- Usage: user warned "be careful of usage restrictions." Keep Gemini turns bounded; do not
  let it loop. The browser task id is browser-task:8607a65a-d2fd-5e62-b16e-a5b2d920e890.
- Repos were made temporarily public by Anthony so Gemini can read them. They should be
  made private again when the work is done (Anthony's call).

## Standing rules that apply to this work
- Website pushes go through Claude Code CLI by default; Anthony overrode to direct gh
  pushes Nov 20-21 and all recent pushes used direct pushes with his approval taps.
  Default back to the Claude Code CLI rule unless he overrides again.
- Pre-push gate (AGENTS.md): lint PHP (~/scratch-phprender/lint.mjs) + render preview
  before any theme PHP push; verify binary uploads exist on the target branch AND format
  matches extension; check connectivity before diagnosing a connector/grant error; have
  rollback ready; verify live 200 + changed behavior within minutes.
- Never push .dashboard-key.txt / .dashboard-client.txt (live dashboard API key + client
  id, local only, in ~/workspace/telnyx-workflows/).
- Approved lineup only; never invent offers, prices, discounts. Front Desk $99/$179/$309,
  $45 per extra 50 over 300, $75 setup. Always-On $250/mo. OPM $199/mo. Total Presence
  $229/mo. Order Desk $149/$299/$549 + $25 per extra 50, setup $150/$295/$495, Pricing
  Agent add-on $99/$199.
- Telnyx agent is named Aria (assistant-ef4f6079-9bd0-4279-8679-0b306fb7b22f). The old Aria
  chatbot is deprecated; the name now belongs to the Telnyx voice agent.
- Dashboard repo: ae-client-dashboard, branch main. Website repo: AESOFTWARESOLUTIONS.COM,
  branches master + deploy/theme (Hostinger deploys deploy/theme).
