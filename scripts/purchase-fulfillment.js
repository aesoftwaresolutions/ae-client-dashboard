'use strict';
// Purchase fulfillment watcher, hosted on the dashboard server.
// Port of the VM Python script (~/workspace/goals/100k-in-gross-sales-by-end-of-2027/
// hidden_files/purchase-fulfillment.py). Same spec, same watermark, same price map.
// The VM script is superseded by this file; do not run both, or sales get
// fulfilled twice (separate watermarks, same charges).
//
// What it does, daily from a Hostinger cron (same pattern as
// scripts/send-password-reminders.js):
//   1. Reads the watermark (epoch seconds of last processed purchase) from
//      <DATA_DIR>/purchase_watermark.txt.
//   2. Lists Stripe livemode charges created since the watermark.
//   3. For each new succeeded, non-refunded charge, identifies the product
//      by price ID and writes a fulfillment record to
//      <DATA_DIR>/fulfillment/<charge_id>.json.
//   4. Advances the watermark to the highest created timestamp processed.
//   5. Prints a JSON summary on stdout for the cron log.
//
// What it NEVER does:
//   - No Stripe writes: no charges, refunds, invoices, or payment links.
//   - No email or message to any buyer. Every buyer-facing draft lives in
//     the fulfillment record as DRAFT for Anthony's approval. The branch (g)
//     Muse setup welcome email is sent only by a person, never by this script.
//   - It does not write the VM workspace files (client folders, onboarding
//     .md files), run audit research, log to Sheets, or write goal entries.
//     Those stay agent follow-ups, listed in each record's needs_anthony.
//     The dashboard admin view lists pending records so they are visible.
//
// Stripe access: a restricted read-only API key in the hosting env vars
// (STRIPE_API_KEY; permissions: read charges, customers, invoices, coupons).
// Never in a file or the repo. Without it the script exits 2.
//
// Usage:
//   node scripts/purchase-fulfillment.js [--check | --fixture FILE | --set-watermark EPOCH]
//   --check            verify paths, watermark, and key presence; exit 0/2.
//   --fixture FILE     dry run with a fake charge JSON (no Stripe call, no
//                      watermark change unless --commit-watermark is given).
//   --set-watermark N  write N as the watermark and exit. First run on the
//                      server needs this (1792707816, Oct 22 2026) or the
//                      first real run writes "now" and skips the backlog.
//   (no flag)          the real daily check.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dataDir = path.resolve(root, process.env.DATA_DIR || 'data');
const watermarkPath = path.join(dataDir, 'purchase_watermark.txt');
const fulfillDir = path.join(dataDir, 'fulfillment');
const STRIPE_ACCOUNT = 'acct_1TOO79Epan91NQaR';
const STRIPE_API = 'https://api.stripe.com/v1';

// Price ID -> { name, kind, label }. Kinds: one-time, subscription,
// setup-fee (folds into its subscription, never fulfilled alone).
// Note: the archived spec labeled OPM $49/mo; OPM is $199/mo now. The price
// ID is what identifies the product; the label below uses the current price.
const PRICE_MAP = {
  price_1UOimzEpan91NQaRyCECCUwA: { name: 'Missed-Lead Audit', kind: 'one-time', label: '$250' },
  price_1UOin8Epan91NQaRv83sFT3x: { name: 'Front Desk', kind: 'subscription', label: '$99/mo' },
  price_1UOin8Epan91NQaR3tBlMUrd: { name: 'Always-On Front Desk', kind: 'subscription', label: '$250/mo' },
  price_1UOin8Epan91NQaRcAmwIkR7: { name: 'Online Presence Management', kind: 'subscription', label: '$199/mo' },
  price_1USQSFEpan91NQaRbzEm3AQC: { name: 'AI Setup Guides Subscription', kind: 'subscription', label: '$19/mo' },
  price_1USfJBEpan91NQaRMTmvjJJB: { name: 'Social Management', kind: 'subscription', label: '$799/mo' },
  price_1USfJFEpan91NQaR9fMma2uv: { name: 'Social Management setup fee', kind: 'setup-fee', label: '$300' },
  price_1USi2XEpan91NQaRcRj7fJdr: { name: 'Social Front Desk', kind: 'subscription', label: '$199/mo' },
  price_1USi2YEpan91NQaRj9ZueK39: { name: 'Social Front Desk setup fee', kind: 'setup-fee', label: '$75' },
  price_1UShhNEpan91NQaRmZ4PtmuH: { name: 'Social Management Growth', kind: 'subscription', label: '$1,299/mo' },
  price_1USi2aEpan91NQaRifSw6XE2: { name: 'Social Management Growth setup fee', kind: 'setup-fee', label: '$495' },
  price_1UShhREpan91NQaREsJaYn49: { name: 'Social Management Scale', kind: 'subscription', label: '$1,999/mo' },
  price_1USi2cEpan91NQaRx2UmrYMO: { name: 'Social Management Scale setup fee', kind: 'setup-fee', label: '$750' },
  price_1UShhUEpan91NQaRHSys3l3u: { name: 'Creator Launch', kind: 'subscription', label: '$499/mo' },
  price_1USi2fEpan91NQaRmw80YZM7: { name: 'Creator Launch setup fee', kind: 'setup-fee', label: '$195' },
  price_1UShhXEpan91NQaRilyksQxX: { name: 'Creator Growth', kind: 'subscription', label: '$899/mo' },
  price_1USi2hEpan91NQaRm5wFItmQ: { name: 'Creator Growth setup fee', kind: 'setup-fee', label: '$345' },
  price_1UShhbEpan91NQaRvPwdtYQP: { name: 'Creator Authority', kind: 'subscription', label: '$1,999/mo' },
  price_1USi2jEpan91NQaRGBn8L1PL: { name: 'Creator Authority setup fee', kind: 'setup-fee', label: '$750' },
  price_1UVZtLEpan91NQaRPs5J3iGw: { name: 'Branded Document Templates', kind: 'one-time', label: '$295' },
};

const SOCIAL_FAMILY = {
  'Social Management': { price: '$799/mo', setup: '$300 one-time setup', terms: '3 month minimum, then month to month' },
  'Social Management Growth': { price: '$1,299/mo', setup: '$495 one-time setup', terms: '3 month minimum, then month to month with 30 days notice to cancel' },
  'Social Management Scale': { price: '$1,999/mo', setup: '$750 one-time setup', terms: '3 month minimum, then month to month with 30 days notice to cancel' },
  'Creator Launch': { price: '$499/mo', setup: '$195 one-time setup', terms: '3 month minimum, then month to month with 30 days notice to cancel' },
  'Creator Growth': { price: '$899/mo', setup: '$345 one-time setup', terms: '3 month minimum, then month to month with 30 days notice to cancel' },
  'Creator Authority': { price: '$1,999/mo', setup: '$750 one-time setup', terms: '3 month minimum, then month to month with 30 days notice to cancel' },
};

const SETUP_GUIDE_FILE = {
  'Social Front Desk': 'setup-guide-social-front-desk.md',
  'Social Management': 'setup-guide-social-management.md',
  'Social Management Growth': 'setup-guide-social-management-growth.md',
  'Social Management Scale': 'setup-guide-social-management-scale.md',
  'Creator Launch': 'setup-guide-creator-launch.md',
  'Creator Growth': 'setup-guide-creator-growth.md',
  'Creator Authority': 'setup-guide-creator-authority.md',
};

// Which subscription a setup fee folds into (fee price id -> plan name).
const SETUP_FEE_PLAN = {
  price_1USfJFEpan91NQaR9fMma2uv: 'Social Management',
  price_1USi2YEpan91NQaRj9ZueK39: 'Social Front Desk',
  price_1USi2aEpan91NQaRifSw6XE2: 'Social Management Growth',
  price_1USi2cEpan91NQaRx2UmrYMO: 'Social Management Scale',
  price_1USi2fEpan91NQaRmw80YZM7: 'Creator Launch',
  price_1USi2hEpan91NQaRm5wFItmQ: 'Creator Growth',
  price_1USi2jEpan91NQaRGBn8L1PL: 'Creator Authority',
};

const FOUNDING_COUPON_ID = 'yLOj0ENy';
const FOUNDING_CODE = 'FOUNDING149';

function log(msg) { console.error(msg); }
function todayStr() { return new Date().toISOString().slice(0, 10); }
function dateStr(epoch) { return new Date(epoch * 1000).toISOString().slice(0, 10); }
function isoStr(epoch) { return new Date(epoch * 1000).toISOString(); }
function money(cents) { return `$${(cents / 100).toFixed(2)}`; }
function slugify(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

function readWatermark(dir = dataDir) {
  try {
    const n = parseInt(fs.readFileSync(path.join(dir, 'purchase_watermark.txt'), 'utf8').trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeWatermark(epoch, dir = dataDir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'purchase_watermark.txt'), String(Math.trunc(epoch)));
}

function resolveStripeKey() {
  const key = (process.env.STRIPE_API_KEY || '').trim();
  return key || null;
}

async function stripeGet(key, p, params) {
  const url = STRIPE_API + p + (params ? `?${new URLSearchParams(params)}` : '');
  const res = await fetch(url, {
    headers: {
      authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
      'Stripe-Version': '2024-06-20',
    },
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Stripe ${p} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

function isChargeId(v) { return typeof v === 'string' && /^ch_[A-Za-z0-9]+$/.test(v); }

function recordPath(dir, chargeId) {
  return path.join(dir, 'fulfillment', `${chargeId}.json`);
}

function writeRecord(record, dir = dataDir) {
  fs.mkdirSync(path.join(dir, 'fulfillment'), { recursive: true });
  fs.writeFileSync(recordPath(dir, record.charge_id), `${JSON.stringify(record, null, 2)}\n`);
  return recordPath(dir, record.charge_id);
}

/** Pending + handled fulfillment records, newest first. Bad JSON is skipped. */
function listFulfillments(dir = dataDir) {
  const folder = path.join(dir, 'fulfillment');
  let files = [];
  try { files = fs.readdirSync(folder).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8'));
      if (rec && typeof rec.charge_id === 'string') out.push(rec);
    } catch { /* skip a corrupt record; the next run rewrites it */ }
  }
  out.sort((a, b) => (b.created || 0) - (a.created || 0));
  return out;
}

function markFulfillmentHandled(chargeId, dir = dataDir) {
  if (!isChargeId(chargeId)) throw new Error('Bad charge id');
  const p = recordPath(dir, chargeId);
  const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
  rec.status = 'handled';
  rec.handled_at = new Date().toISOString();
  fs.writeFileSync(p, `${JSON.stringify(rec, null, 2)}\n`);
  return rec;
}

// --- identification ---

async function identifyProduct(key, charge) {
  let priceId = null;
  if (charge.invoice) {
    try {
      const inv = await stripeGet(key, `/invoices/${charge.invoice}`);
      const lines = (inv.lines && inv.lines.data) || [];
      if (lines.length) priceId = (lines[0].price || {}).id || null;
    } catch (e) {
      log(`invoice read failed for ${charge.invoice}: ${e.message}`);
    }
  }
  if (!priceId) {
    const desc = (charge.description || '').trim().toLowerCase();
    for (const [pid, info] of Object.entries(PRICE_MAP)) {
      if (desc && desc.includes(info.name.toLowerCase())) { priceId = pid; break; }
    }
  }
  if (priceId && PRICE_MAP[priceId]) {
    const { name, kind, label } = PRICE_MAP[priceId];
    return { priceId, product: name, kind, label };
  }
  return { priceId, product: null, kind: null, label: null };
}

async function getBuyer(key, charge) {
  const buyer = { customer_id: charge.customer || null, email: charge.receipt_email || null, name: null, business: null };
  if (buyer.customer_id) {
    try {
      const cust = await stripeGet(key, `/customers/${buyer.customer_id}`);
      buyer.email = buyer.email || cust.email || null;
      buyer.name = cust.name || null;
      const meta = cust.metadata || {};
      buyer.business = meta.business_name || meta.business || null;
    } catch (e) {
      log(`customer read failed for ${buyer.customer_id}: ${e.message}`);
    }
  }
  if (!buyer.name && buyer.email) {
    buyer.name = buyer.email.split('@')[0].replace(/[._]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return buyer;
}

async function checkFounding(key, charge) {
  try {
    const hasCoupon = (list) => (list || []).some((d) => d && d.coupon && d.coupon.id === FOUNDING_COUPON_ID);
    let applied = hasCoupon(charge.discounts);
    if (!applied && charge.invoice) {
      const inv = await stripeGet(key, `/invoices/${charge.invoice}`);
      applied = hasCoupon(inv.discounts);
    }
    let remaining = null;
    if (applied) {
      try {
        const coupon = await stripeGet(key, `/coupons/${FOUNDING_COUPON_ID}`);
        if (typeof coupon.max_redemptions === 'number') {
          remaining = coupon.max_redemptions - (coupon.times_redeemed || 0);
        }
      } catch { /* leave remaining unknown */ }
    }
    return { applied, remaining };
  } catch (e) {
    log(`founding check failed: ${e.message}`);
    return { applied: false, remaining: null };
  }
}

// --- fulfillment records (one JSON per charge) ---

function buyerDisplay(buyer) {
  return buyer.name || buyer.email || buyer.customer_id || 'unknown buyer';
}

function draftWelcomeEmail(buyer, product, start, extra) {
  const first = (buyer.name || 'there').split(' ')[0];
  return {
    subject: `Welcome to AE Software Solutions`,
    body: `Hello ${first},\n\nThank you for choosing AE Software Solutions. Your ${product} is confirmed as of ${start}.${extra ? `\n\n${extra}` : ''}\n\nAnthony Pioquinto\nAE Software Solutions LLC`,
  };
}

function baseRecord(charge, buyer, identified) {
  return {
    charge_id: charge.id,
    amount: charge.amount / 100,
    amount_label: money(charge.amount),
    created: charge.created,
    date: isoStr(charge.created),
    buyer: {
      name: buyer.name || null,
      email: buyer.email || null,
      customer_id: buyer.customer_id || null,
      business: buyer.business || buyer.name || null,
    },
    price_id: identified.priceId,
    product: identified.product,
    kind: identified.kind,
    status: 'pending',
    created_at: new Date().toISOString(),
    checklist: [],
    draft_email: null,
    needs_anthony: [],
    muse_setup: null,
    followups: {
      sheets: 'pending (VM agent run)',
      goal_entry: 'pending (VM agent run)',
    },
  };
}

function buildRecord(charge, buyer, identified, founding) {
  const rec = baseRecord(charge, buyer, identified);
  const start = dateStr(charge.created);
  const business = buyer.business || buyer.name || 'unknown business';
  const { product } = identified;

  if (!product) {
    rec.status = 'unknown-product';
    rec.needs_anthony.push(`Unknown product on charge ${charge.id} (price ${identified.priceId || 'unknown'}); identify and fulfill by hand.`);
    return rec;
  }
  if (identified.kind === 'setup-fee') {
    rec.status = 'setup-fee-folded';
    rec.note = `Setup fee for ${SETUP_FEE_PLAN[identified.priceId] || 'unknown plan'}; no separate fulfillment.`;
    return rec;
  }

  if (product === 'Missed-Lead Audit') {
    rec.checklist = [
      'Run the digital Missed-Lead Audit for this business (web presence, Google Business Profile, reviews, website check). No phone mystery shopping, no form submissions without permission.',
      'Write the report and send it to Anthony for approval before it goes to the buyer.',
    ];
    rec.needs_anthony.push(`Run the Missed-Lead Audit research for ${business} and send the report to Anthony for approval.`);
    rec.followups.audit_research = 'pending (VM agent run)';
  } else if (product === 'AI Setup Guides Subscription') {
    rec.checklist = ['Confirm the latest published setup-guide PDF.', 'Send the welcome email (DRAFT) once Anthony approves it.'];
    rec.draft_email = draftWelcomeEmail(buyer, product, start,
      'Your first guide is attached once Anthony approves this email. A new guide lands each month.');
    rec.needs_anthony.push(`Approve and send the AI Setup Guides welcome email to ${buyer.email || 'the buyer'}.`);
  } else if (product === 'Branded Document Templates') {
    rec.checklist = ['Build or approve the template files (invoice, proposal, quote, letterhead, editable and branded).'];
    rec.draft_email = draftWelcomeEmail(buyer, product, start,
      'Your files are being prepared and we will send them to you shortly.');
    rec.needs_anthony.push(`Branded Document Templates for ${buyerDisplay(buyer)}: Anthony must build or approve the template files before delivery; do not promise instant delivery.`);
  } else if (SOCIAL_FAMILY[product]) {
    const fam = SOCIAL_FAMILY[product];
    rec.checklist = [
      `Payment confirmed in Stripe (subscription + setup fee). Terms: ${product} ${fam.price} + ${fam.setup}, ${fam.terms}.`,
      'Kickoff call held; goals and offers confirmed.',
      'Meta account and Business assets created in the client business name (Facebook Page, Instagram).',
      'Claude account created for the business.',
      'Canva account created for the business.',
      'All client socials connected. Any paid third party tier goes on the client own payment method (AE never fronts).',
      'Brand assets received (logo, colors, photos). Voice interview done (30 to 45 min).',
    ];
    rec.draft_email = draftWelcomeEmail(buyer, product, start,
      `Your Setup Guide: ${product} walks through week one. To get started, please send us: a kickoff call time, admin access to your social accounts, brand assets (logo, colors, photos), and a 30 to 45 minute voice interview slot.`);
    rec.needs_anthony.push(`Approve and send the ${product} welcome email to ${buyer.email || 'the buyer'}, and confirm final terms before the kickoff call.`);
    rec.muse_setup = museSetupInfo(buyer, product);
    rec.needs_anthony.push(`Muse setup package for ${business}: render the two package files from the automation templates (agent step), then send only if AUTO-SEND says ARMED.`);
  } else if (product === 'Social Front Desk') {
    const checklists = 'business hours, call-handling instructions, greeting script, phone number provisioning, social account access, brand assets, kickoff call time';
    rec.checklist = [
      `Collect or provision: ${checklists}.`,
      'Set up the Meta account and Business assets, a Claude account, and a Canva account in the client business name; connect all of the client socials.',
      `Setup guide for this plan: ${SETUP_GUIDE_FILE[product]}. It goes to the client with (or right after) the welcome email once Anthony approves both.`,
    ];
    rec.draft_email = draftWelcomeEmail(buyer, product, start,
      `Your Setup Guide: Social Front Desk walks through week one.`);
    if (founding && founding.applied) {
      rec.founding_applied = true;
      rec.founding_remaining = founding.remaining;
      rec.checklist.push(`Founding rate ${FOUNDING_CODE} applied: $149/mo for the first 3 months, then $199/mo. Founding slots remaining: ${founding.remaining === null ? 'unknown' : founding.remaining}.`);
    }
    rec.needs_anthony.push(`Approve and send the Social Front Desk welcome email to ${buyer.email || 'the buyer'}.`);
    rec.muse_setup = museSetupInfo(buyer, product);
    rec.needs_anthony.push(`Muse setup package for ${business}: render the two package files from the automation templates (agent step), then send only if AUTO-SEND says ARMED.`);
  } else {
    // Front Desk, Always-On Front Desk, Online Presence Management.
    const items = {
      'Front Desk': 'business hours, call-handling instructions, greeting script, phone number provisioning',
      'Always-On Front Desk': 'business hours, call-handling instructions, greeting script, phone number provisioning',
      'Online Presence Management': 'Google Business Profile manager access, business details',
    }[product] || 'kickoff call time and service details';
    rec.checklist = [`Collect or provision: ${items}.`];
    rec.draft_email = draftWelcomeEmail(buyer, product, start);
    rec.needs_anthony.push(`Approve and send the ${product} welcome email to ${buyer.email || 'the buyer'}.`);
  }
  return rec;
}

function museSetupInfo(buyer, product) {
  // The two package files are rendered by the agent run (the templates live
  // on the VM); the server records the values so the render needs no lookup.
  return {
    plan: product,
    buyer: {
      business: buyer.business || buyer.name || null,
      owner_name: buyer.name || null,
      owner_email: buyer.email || null,
      business_email: buyer.email || null,
      setup_date: todayStr(),
    },
    renders_pending_agent: true,
    auto_send: 'read AUTO-SEND.md on the VM before sending; this script never sends',
  };
}

// --- charge processing ---

async function processCharge(key, charge, summary) {
  const buyer = await getBuyer(key, charge);
  const identified = await identifyProduct(key, charge);
  let founding = null;
  if (identified.product === 'Social Front Desk') founding = await checkFounding(key, charge);
  const rec = buildRecord(charge, buyer, identified, founding);
  if (rec.status !== 'setup-fee-folded') writeRecord(rec);
  const entry = {
    charge_id: charge.id,
    amount: charge.amount / 100,
    created: charge.created,
    buyer_email: buyer.email,
    buyer_name: buyer.name,
    customer_id: buyer.customer_id,
    price_id: identified.priceId,
    product: identified.product,
    kind: identified.kind,
    status: rec.status,
    needs_anthony: rec.needs_anthony,
  };
  if (founding && founding.applied) {
    entry.founding_applied = true;
    entry.founding_remaining = founding.remaining;
  }
  summary.processed.push(entry);
  return entry;
}

async function fetchNewCharges(key, watermark) {
  const params = new URLSearchParams({ 'created[gte]': String(watermark), limit: '100' });
  const res = await stripeGet(key, '/charges', params);
  const out = [];
  for (const ch of res.data || []) {
    if (ch.status === 'succeeded' && !ch.refunded && ch.created > watermark) out.push(ch);
  }
  out.sort((a, b) => a.created - b.created);
  if (res.has_more) {
    log('WARNING: more than 100 charges since watermark; only the first 100 were fetched. The watermark advances only past what was processed, so the rest will be picked up next run.');
  }
  return out;
}

function processFixtureCharge(charge, buyer, summary) {
  const identified = charge.price_id && PRICE_MAP[charge.price_id]
    ? { priceId: charge.price_id, product: PRICE_MAP[charge.price_id].name, kind: PRICE_MAP[charge.price_id].kind, label: PRICE_MAP[charge.price_id].label }
    : { priceId: charge.price_id || null, product: null, kind: null, label: null };
  const rec = buildRecord(charge, buyer, identified, null);
  if (rec.status !== 'setup-fee-folded') writeRecord(rec);
  summary.processed.push({
    charge_id: charge.id,
    amount: charge.amount / 100,
    created: charge.created,
    buyer_email: buyer.email,
    buyer_name: buyer.name,
    customer_id: buyer.customer_id,
    price_id: identified.priceId,
    product: identified.product,
    kind: identified.kind,
    status: rec.status,
    needs_anthony: rec.needs_anthony,
  });
  return rec;
}

// --- commands ---

function cmdCheck() {
  const problems = [];
  const ok = {
    watermark: readWatermark(),
    key_present: Boolean(resolveStripeKey()),
    data_dir: dataDir,
    paths: {
      fulfillment_dir: fs.existsSync(fulfillDir),
      data_dir: fs.existsSync(dataDir),
    },
  };
  if (ok.watermark === null) problems.push(`watermark file missing or unreadable: ${watermarkPath} (seed it with --set-watermark)`);
  if (!ok.key_present) problems.push('no Stripe key: set STRIPE_API_KEY in the hosting env vars (restricted read-only key)');
  console.log(JSON.stringify(ok, null, 2));
  if (problems.length) {
    for (const p of problems) log(`CHECK FAIL: ${p}`);
    return 2;
  }
  log('CHECK OK: paths, watermark, and Stripe key all present.');
  return 0;
}

async function cmdRun(fixturePath, commitWatermark) {
  const watermark = readWatermark();
  const summary = {
    run_at: new Date().toISOString(),
    mode: fixturePath ? 'fixture' : 'live',
    watermark_before: watermark,
    watermark_after: watermark,
    charges_found: 0,
    processed: [],
    failed: [],
  };
  if (watermark === null) {
    const now = Math.floor(Date.now() / 1000);
    writeWatermark(now);
    summary.watermark_after = now;
    summary.note = 'watermark file was missing; wrote the current time and stopped (no charges processed). Seed it with --set-watermark to catch the backlog instead.';
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }
  if (fixturePath) {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const charges = fixture.charges || [];
    summary.charges_found = charges.length;
    for (const ch of charges) {
      const buyer = {
        customer_id: ch.customer || fixture.customer_id || null,
        email: ch.receipt_email || fixture.receipt_email || null,
        name: fixture.buyer_name || null,
        business: fixture.business || null,
      };
      ch.amount = ch.amount ?? fixture.amount ?? 0;
      ch.created = ch.created ?? fixture.created ?? Math.floor(Date.now() / 1000);
      ch.status = ch.status || 'succeeded';
      ch.refunded = ch.refunded || false;
      try {
        processFixtureCharge(ch, buyer, summary);
      } catch (e) {
        summary.failed.push({ charge_id: ch.id, error: e.message });
      }
    }
    if (commitWatermark && summary.processed.length) {
      const next = Math.max(...summary.processed.map((p) => p.created));
      writeWatermark(next);
      summary.watermark_after = next;
    }
    console.log(JSON.stringify(summary, null, 2));
    return summary.failed.length ? 1 : 0;
  }
  const key = resolveStripeKey();
  if (!key) {
    summary.error = 'No Stripe key configured. Set STRIPE_API_KEY in the hosting env vars (restricted read-only key: read charges, customers, invoices, coupons). No charges were checked; the watermark is unchanged.';
    console.log(JSON.stringify(summary, null, 2));
    return 2;
  }
  let charges;
  try {
    charges = await fetchNewCharges(key, watermark);
  } catch (e) {
    summary.error = `Stripe read failed: ${e.message}`;
    console.log(JSON.stringify(summary, null, 2));
    return 1;
  }
  summary.charges_found = charges.length;
  if (!charges.length) {
    log(`No new charges since watermark ${watermark}.`);
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }
  for (const ch of charges) {
    try {
      await processCharge(key, ch, summary);
    } catch (e) {
      summary.failed.push({ charge_id: ch.id, error: e.message });
      log(`FAILED charge ${ch.id}: ${e.message}`);
    }
  }
  const done = summary.processed.filter((p) => p.status !== 'unknown-product');
  if (done.length) {
    const next = Math.max(...done.map((p) => p.created));
    writeWatermark(next);
    summary.watermark_after = next;
  }
  console.log(JSON.stringify(summary, null, 2));
  return summary.failed.length ? 1 : 0;
}

function arg(flag, argv) {
  const i = argv.indexOf(flag);
  if (i === -1 || i + 1 >= argv.length) return null;
  return argv[i + 1];
}

async function main(argv) {
  fs.mkdirSync(fulfillDir, { recursive: true });
  if (argv.includes('--check')) return cmdCheck();
  const setWm = arg('--set-watermark', argv);
  if (setWm !== null) {
    const n = parseInt(setWm, 10);
    if (!Number.isFinite(n) || n <= 0) { console.error('--set-watermark needs an epoch seconds value'); return 2; }
    writeWatermark(n);
    console.log(JSON.stringify({ watermark: n, path: watermarkPath }));
    return 0;
  }
  const fixture = arg('--fixture', argv);
  if (fixture !== null) return cmdRun(fixture, argv.includes('--commit-watermark'));
  return cmdRun(null, false);
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
    console.error(`purchase-fulfillment: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  PRICE_MAP, SOCIAL_FAMILY, SETUP_FEE_PLAN,
  readWatermark, writeWatermark, resolveStripeKey,
  identifyProduct, getBuyer, checkFounding,
  buildRecord, processFixtureCharge, listFulfillments, markFulfillmentHandled,
  runFulfillment: cmdRun,
};
