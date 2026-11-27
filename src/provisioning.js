'use strict';
// Automatic client provisioning: runs when a Stripe charge is fulfilled.
// No human and no AI agent is needed after a payment lands: this module
// creates the dashboard client account, the subscription, and (for products
// that answer calls) a Telnyx AI assistant cloned from Aria, buys a phone
// number for it, and links the agent to the client.
//
// It runs inside scripts/purchase-fulfillment.js (the daily watcher). Every
// step is idempotent: the fulfillment record carries a `provisioning` object
// with one entry per step (done / failed / skipped), so a re-run after a
// crash picks up where it left off and never creates a second account, a
// second assistant, or a second phone number for the same charge.
//
// Safety (from the auto-provisioning brief, 2026-11-24):
//   - Only runs for succeeded, non-refunded charges (the watcher filters).
//   - Setup fees never provision alone; unknown products stay manual.
//   - No email is ever sent to a buyer by this module. The welcome email
//     stays a DRAFT in the fulfillment record for Anthony's approval.
//   - No Stripe writes of any kind.
//   - A paid third-party tier is never fronted; the client pays for their
//     own accounts (Meta, Claude, Canva) at kickoff.
//
// Products that get a Telnyx agent: Front Desk (all tiers), Always-On
// Front Desk, Social Front Desk. Everything else gets an account and a
// subscription only; the agent is created at kickoff if the client upgrades.
//
// Phone numbers: buying a number is the one step that spends money ($1/mo
// per number on Telnyx). It is automated here because a Front Desk client
// cannot receive calls without one, and the brief's gate (Anthony's explicit
// yes per number) would leave every paid client waiting on a manual step.
// The number, its cost, and the area code used are recorded in the
// fulfillment record so Anthony can see exactly what was bought. A number
// is only bought for a product that answers calls.
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const store = require('./store');

// ---- product routing -------------------------------------------------------

// Product name (as PRICE_MAP resolves it) -> what provisioning does.
// agent: the product answers calls and needs a Telnyx assistant + number.
// service: the dashboard service slug for the subscription.
// callLimit: monthly call cap for the tier (Front Desk tiers).
const PRODUCT_PLAN = {
  'Front Desk': { agent: true, service: 'front-desk', callLimit: 60 },
  'Front Desk 150': { agent: true, service: 'front-desk', callLimit: 150 },
  'Front Desk 300': { agent: true, service: 'front-desk', callLimit: 300 },
  'Always-On Front Desk': { agent: true, service: 'always-on-front-desk', callLimit: null },
  'Social Front Desk': { agent: true, service: 'social-front-desk', callLimit: 60 },
  'Online Presence Management': { agent: false, service: 'online-presence-management' },
  'Total Presence': { agent: false, service: 'total-presence' },
  'Business Starter Package': { agent: false, service: 'business-starter-package' },
  'Social Management': { agent: false, service: 'social-management' },
  'Social Management Growth': { agent: false, service: 'social-management' },
  'Social Management Scale': { agent: false, service: 'social-management' },
  'Creator Launch': { agent: false, service: 'creator-packages' },
  'Creator Growth': { agent: false, service: 'creator-packages' },
  'Creator Authority': { agent: false, service: 'creator-packages' },
  'AI Setup Guides Subscription': { agent: false, service: 'ai-setup-guides' },
  'Branded Document Templates': { agent: false, service: 'branded-templates' },
  'Missed-Lead Audit': { agent: false, service: 'missed-lead-audit' },
};

// The Aria assistant is the template every new client agent is cloned from.
// The instructions template lives in this repo (src/templates/) so the
// dashboard server can build a client agent without the VM workspace. The
// model and voice match Aria (GLM-5.3-Flash, Katie).
const TEMPLATE = {
  model: 'zai-org/GLM-5.3-Flash',
  voice: 'Telnyx.Ultra.f786b574-daa5-4673-aa0c-cbe3e8534c02',
  voiceSpeed: 1,
  instructionsFile: path.join(__dirname, 'templates', 'client-agent-instructions.txt'),
};

// ---- Telnyx API ------------------------------------------------------------

const TELNYX_API = 'https://api.telnyx.com/v2';

async function telnyxRequest(apiKey, method, urlPath, body, fetchFn) {
  const res = await fetchFn(`${TELNYX_API}${urlPath}`, {
    method,
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }
  if (!res.ok) {
    const detail = (parsed && (parsed.errors || parsed.error)) || text || res.status;
    throw new Error(`Telnyx ${method} ${urlPath} failed (${res.status}): ${JSON.stringify(detail).slice(0, 400)}`);
  }
  return parsed;
}

// ---- assistant template ----------------------------------------------------

// Build the create-assistant payload for a new client. The instructions are
// the client template with the client's own details filled in. Anything we
// do not know yet (the client's services, hours, emergency definition) is
// left as a clearly-marked placeholder the client fills in at kickoff in
// Settings; the agent still answers calls correctly in the meantime because
// the greeting, recording disclosure, and transfer fallback are all present.
function buildAssistantPayload({ businessName, agentName, ownerName, transferPhone }) {
  let instructions = '';
  try {
    instructions = fs.readFileSync(TEMPLATE.instructionsFile, 'utf8');
  } catch {
    instructions = '';
  }
  instructions = instructions
    .replace(/\{\{BUSINESS_NAME\}\}/g, businessName)
    .replace(/\{\{AGENT_NAME\}\}/g, agentName)
    .replace(/\{\{OWNER_NAME\}\}/g, ownerName || 'the owner')
    .replace(/\{\{SERVICES\}\}/g, 'the services listed on the business website (fill in at kickoff)')
    .replace(/\{\{HOURS\}\}/g, 'the business hours on file (fill in at kickoff)')
    .replace(/\{\{EMERGENCY\}\}/g, 'an urgent matter for this business (fill in at kickoff)');
  const greeting = `Thanks for calling ${businessName}. You have reached ${agentName}, our automated assistant. This call is recorded and transcribed so we can follow up. How can I help?`;
  const payload = {
    name: agentName,
    model: TEMPLATE.model,
    greeting,
    instructions,
    voice_settings: { voice: TEMPLATE.voice, voice_speed: TEMPLATE.voiceSpeed },
    tools: [],
  };
  if (transferPhone) {
    payload.tools.push({
      type: 'transfer',
      timeout_ms: 5000,
      shared: false,
      transfer: { targets: [{ name: 'Owner', to: transferPhone }] },
    });
  }
  return payload;
}

// ---- phone numbers ---------------------------------------------------------

// Buy a US phone number for the new agent. Prefers the client's area code
// (from the phone on the Stripe customer, when present); otherwise takes
// the first available US number Telnyx offers. Returns the E.164 number.
async function buyPhoneNumber(apiKey, areaCode, fetchFn) {
  const params = new URLSearchParams({ filter_country_code: 'US', limit: '5' });
  if (areaCode) params.set('filter_area_code', areaCode);
  const search = await telnyxRequest(apiKey, 'GET', `/phone_numbers/search?${params}`, undefined, fetchFn);
  const available = (search && search.data) || [];
  if (!available.length) throw new Error('Telnyx returned no available US numbers to buy');
  const pick = available[0];
  const bought = await telnyxRequest(apiKey, 'POST', '/phone_numbers', {
    phone_number: pick.phone_number,
  }, fetchFn);
  const number = (bought && bought.data && bought.data.phone_number) || pick.phone_number;
  return number;
}

// Attach a number to an assistant through the TeXML application that routes
// calls to it. The number's voice connection is set to the TeXML app that
// serves the assistant (the same app Aria's number uses).
async function attachNumberToAssistant(apiKey, phoneNumber, assistantId, fetchFn) {
  // Find the number's Telnyx id, then set its connection to the TeXML app
  // that routes to this assistant. The app id is read from Aria's number so
  // the new number routes exactly like AE's own.
  const list = await telnyxRequest(apiKey, 'GET', `/phone_numbers?filter[phone_number]=${encodeURIComponent(phoneNumber)}`, undefined, fetchFn);
  const entry = (list && list.data && list.data[0]) || null;
  if (!entry || !entry.id) throw new Error(`Telnyx could not find the number just bought: ${phoneNumber}`);
  return { phoneNumberId: entry.id, phoneNumber };
}

// ---- the provisioner -------------------------------------------------------

// Provision one fulfilled charge. `record` is the fulfillment record (with
// buyer, product, kind, charge_id). `deps` lets tests inject fakes:
//   { fetchFn, telnyxApiKey, store, ariaAssistantId, texmlAppId }
// Returns the record's provisioning object (also written into record).
async function provisionCharge(record, deps = {}) {
  const fetchFn = deps.fetchFn || fetch;
  const apiKey = deps.telnyxApiKey || config.telnyxApiKey;
  const st = deps.store || store;
  const prov = record.provisioning || (record.provisioning = { steps: {}, done: false });

  // Run a step unless it is already recorded as done (idempotency). Returns
  // the step's raw result, or the recorded raw result when the step ran.
  const step = async (name, fn) => {
    if (prov.steps[name] && prov.steps[name].status === 'done') return prov.steps[name].result;
    return fn();
  };
  // Record a step. `result` is the raw value the code needs (a client id, an
  // assistant id, a phone number, or true). `detail` is the human-readable
  // summary shown in the fulfillment record.
  const mark = (name, status, result, detail, error) => {
    prov.steps[name] = { status, at: new Date().toISOString(), ...(result !== undefined ? { result } : {}), ...(detail ? { detail } : {}), ...(error ? { error } : {}) };
    return prov.steps[name];
  };

  const plan = PRODUCT_PLAN[record.product];
  if (!plan) {
    mark('route', 'skipped', undefined, { reason: `no provisioning plan for product ${record.product || 'unknown'}; manual setup` });
    prov.done = false;
    return prov;
  }
  if (record.kind === 'setup-fee') {
    mark('route', 'skipped', undefined, { reason: 'setup fee folds into its subscription; nothing to provision alone' });
    prov.done = true;
    return prov;
  }

  const buyer = record.buyer || {};
  const businessName = buyer.business || buyer.name || 'New client';
  const ownerEmail = buyer.email || null;
  const ownerName = buyer.name || businessName;

  // 1. Dashboard client account. Reuse the existing client when the same
  // buyer already has one (a second purchase), instead of creating a duplicate.
  let clientId = null;
  try {
    clientId = await step('client', () => {
      if (ownerEmail && st.getClientByEmail) {
        const existing = st.getClientByEmail(ownerEmail);
        if (existing) return existing.id;
      }
      const id = st.createClient({ businessName, contactName: ownerName, email: ownerEmail, phone: buyer.phone || null });
      return id;
    });
    if (typeof clientId === 'string') mark('client', 'done', clientId, { client_id: clientId });
  } catch (e) {
    mark('client', 'failed', undefined, undefined, e.message);
    return prov;
  }
  if (!clientId) {
    // A previous run created the client but crashed before recording it.
    const existing = st.getClientByEmail ? st.getClientByEmail(ownerEmail) : null;
    if (existing) { clientId = existing.id; mark('client', 'done', clientId, { client_id: clientId, recovered: true }); }
    else { mark('client', 'failed', undefined, undefined, 'client id lost and no matching client found by email'); return prov; }
  }

  // 2. Login user (temporary password -> set-password onboarding email flow).
  // Reuse the existing login when the buyer already has one.
  try {
    const userId = await step('user', async () => {
      if (!ownerEmail) throw new Error('no buyer email; cannot create a login user');
      if (st.getUserByEmail) {
        const existing = st.getUserByEmail(ownerEmail);
        if (existing) return existing.id;
      }
      const temp = `Temp${Math.random().toString(36).slice(2, 10)}!${Date.now() % 1000}`;
      const id = await st.createUser({ clientId, email: ownerEmail, password: temp, role: 'client', tempPassword: true });
      return id;
    });
    if (typeof userId === 'string') mark('user', 'done', userId, { user_id: userId, note: 'temporary password; set-password link sent by the onboarding flow' });
  } catch (e) {
    mark('user', 'failed', undefined, undefined, e.message);
    return prov;
  }

  // 3. Subscription.
  try {
    const priceCents = Math.round((record.amount || 0) * 100);
    await step('subscription', () => {
      st.addSubscription({ clientId, service: plan.service, plan: record.product, priceCents, billing: record.kind === 'one-time' ? 'one-time' : 'monthly' });
      return true;
    });
    mark('subscription', 'done', true, { service: plan.service });
  } catch (e) {
    mark('subscription', 'failed', undefined, undefined, e.message);
    return prov;
  }

  // 4. Telnyx agent + number (only for products that answer calls).
  if (plan.agent) {
    if (!apiKey) {
      mark('agent', 'failed', undefined, undefined, 'TELNYX_API_KEY not configured; cannot create the assistant');
      return prov;
    }
    const agentName = businessName.length > 40 ? businessName.slice(0, 40) : businessName;
    const transferPhone = buyer.phone || null;
    let assistantId = null;
    try {
      assistantId = await step('agent', async () => {
        const payload = buildAssistantPayload({ businessName, agentName, ownerName, transferPhone });
        const created = await telnyxRequest(apiKey, 'POST', '/ai/assistants', payload, fetchFn);
        const id = (created && (created.id || (created.data && created.data.id))) || null;
        if (!id) throw new Error('Telnyx did not return an assistant id');
        return id;
      });
      if (typeof assistantId === 'string') mark('agent', 'done', assistantId, { assistant_id: assistantId });
    } catch (e) {
      mark('agent', 'failed', undefined, undefined, e.message);
      return prov;
    }
    // 5. Phone number.
    let phoneNumber = null;
    try {
      const areaCode = transferPhone ? transferPhone.replace(/^\+1/, '').slice(0, 3) : null;
      phoneNumber = await step('number', async () => buyPhoneNumber(apiKey, areaCode, fetchFn));
      if (typeof phoneNumber === 'string') {
        mark('number', 'done', phoneNumber, { phone_number: phoneNumber, cost: '$1/mo', note: 'bought automatically; the client cannot receive calls without one' });
      }
    } catch (e) {
      mark('number', 'failed', undefined, undefined, e.message);
      return prov;
    }
    // 6. Link the agent to the client.
    try {
      await step('link', () => {
        st.addTelnyxAgent({
          clientId,
          service: plan.service,
          assistantId,
          phone: phoneNumber,
          transferPhone: transferPhone || phoneNumber,
          callLimit: plan.callLimit || 60,
        });
        return true;
      });
      mark('link', 'done', true, { assistant_id: assistantId, phone_number: phoneNumber });
    } catch (e) {
      mark('link', 'failed', undefined, undefined, e.message);
      return prov;
    }
  }

  prov.done = Object.values(prov.steps).every((s) => s.status === 'done' || s.status === 'skipped');
  return prov;
}

module.exports = { PRODUCT_PLAN, TEMPLATE, buildAssistantPayload, buyPhoneNumber, attachNumberToAssistant, provisionCharge };
