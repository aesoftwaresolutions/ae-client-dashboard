'use strict';
// Client-facing AI Agent settings. A client with an active Front Desk (or
// Always-On Front Desk) subscription can tailor their Telnyx AI agent to
// their own business: the agent name, greeting, voice, voice speed, transfer
// number, what the business does, the services offered, business hours, and
// the instructions (the AI prompt).
//
// Flow: the client saves the form -> the prompt is built (generated from the
// business fields, or the client's own text verbatim when they choose that)
// -> PATCH /v2/ai/assistants/{id} on Telnyx applies name, greeting,
// instructions, voice_settings (voice + speed, merged into the assistant's
// current voice settings) and tools (the transfer tool retargeted to the new
// number) -> only when Telnyx accepts it do we store the settings in
// telnyx_agent_settings and update the telnyx_agents row (name,
// instructions_hash, last_synced_at, transfer_phone_number) so the read-only
// sync stays consistent. A Telnyx failure saves nothing locally and the error
// is returned plainly. This module never touches call_summaries, balance or
// numbers, and never logs the Telnyx API key.
const crypto = require('node:crypto');
const config = require('./config');
const store = require('./store');

const TELNYX_BASE = 'https://api.telnyx.com';

const LIMITS = {
  agentName: 80,
  greeting: 500,
  businessDescription: 1000,
  servicesOffered: 1000,
  businessHours: 200,
  instructions: 20000,
  voiceSpeedMin: 0.5,
  voiceSpeedMax: 2,
};

/**
 * The voices a client can pick for their agent. A short, receptionist-friendly
 * shortlist of Telnyx Ultra voices (English), each with its full Telnyx voice
 * id. The list is deliberately small: 500+ Ultra voices exist, and a dropdown
 * of all of them is unusable. Katie is the voice Aria uses today.
 */
const VOICES = [
  { id: 'Telnyx.Ultra.f786b574-daa5-4673-aa0c-cbe3e8534c02', name: 'Katie', desc: 'Friendly Fixer', gender: 'Female' },
  { id: 'Telnyx.Ultra.01eaafa9-308a-4276-a017-6ab0cf061b1f', name: 'Clara', desc: 'Instructor', gender: 'Female' },
  { id: 'Telnyx.Ultra.00a77add-48d5-4ef6-8157-71e5437b282d', name: 'Callie', desc: 'Encourager', gender: 'Female' },
  { id: 'Telnyx.Ultra.1242fb95-7ddd-44ac-8a05-9e8a22a6137d', name: 'Cindy', desc: 'Receptionist', gender: 'Female' },
  { id: 'Telnyx.Ultra.10bd4af4-825b-49b8-b8bd-0ca11865536e', name: 'Rachel', desc: 'Polished Presence', gender: 'Female' },
  { id: 'Telnyx.Ultra.0d2162c2-2fe9-40a7-b3c1-43eab576a64b', name: 'Shelly', desc: 'Warm Companion', gender: 'Female' },
  { id: 'Telnyx.Ultra.02a924f6-bb49-4177-8fbb-52238c5056d6', name: 'Maeve', desc: 'Steady Host', gender: 'Female' },
  { id: 'Telnyx.Ultra.045f0292-0731-4a4c-971d-64594fc2c35a', name: 'Quinn', desc: 'Calm Authority', gender: 'Female' },
  { id: 'Telnyx.Ultra.0834f3df-e650-4766-a20c-5a93a43aa6e3', name: 'Leo', desc: 'Genuine Companion', gender: 'Male' },
  { id: 'Telnyx.Ultra.1628cfcd-a161-4e47-98ff-46bffa4ab290', name: 'Graham', desc: 'Assured Helper', gender: 'Male' },
  { id: 'Telnyx.Ultra.da69d796-4603-4419-8a95-293bfc5679eb', name: 'David', desc: 'Greeter', gender: 'Male' },
  { id: 'Telnyx.Ultra.bd9120b6-7761-47a6-a446-77ca49132781', name: 'Owen', desc: 'Tutorial Man', gender: 'Male' },
];
const VOICE_IDS = new Set(VOICES.map((v) => v.id));
const voiceById = (id) => VOICES.find((v) => v.id === id) || null;
/** A phone number the client typed, normalised to E.164 when it is a US number. */
const cleanPhone = (v) => {
  const digits = String(v == null ? '' : v).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
};

const sha256 = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex');
const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/**
 * Builds the agent prompt from the business fields, in the same style as the
 * AE v3 instructions: short replies, answer only the question asked, one
 * question at a time, no pitching. Sections the client left blank are left
 * out rather than filled with guesses. No prices are ever invented: the
 * prompt says never to state a price it does not know.
 */
function buildInstructions({ businessName, agentName, greeting, businessDescription, servicesOffered, businessHours, transferPhone }) {
  const business = businessName || 'this business';
  const name = agentName || 'Front Desk';
  const open = greeting || `Thanks for calling ${business}. You have reached ${name}, our automated assistant. This call is recorded and transcribed so we can follow up. How can I help?`;
  const parts = [
    `You are the AI receptionist for ${business}. You answer inbound calls in the business name. Speak as ${business}. Your tone is plain and direct. You are an automated assistant. If asked, say so plainly and say the call is recorded. Open every call with: ${open}`,
  ];
  if (businessDescription) parts.push(`About this business: ${businessDescription}`);
  parts.push(
    'How to talk. Talk like a person on the phone, not a brochure. Keep every reply short, one or two sentences at a time, then stop and let the caller respond. Answer only the question the caller asked. Do not add extra information, prices, or offers they did not ask about. Do not list services or prices unless the caller asks. Ask one question at a time and wait for the answer. Let the caller lead the conversation. If they want to know more, they will ask. Do not pitch. Do not explain everything at once.',
    'Collect the caller\u2019s name, best callback number, address or town, what they need, and how urgent it is. Read the callback number back to confirm it.',
  );
  if (servicesOffered) parts.push(`Services offered: ${servicesOffered}`);
  if (businessHours) parts.push(`Business hours: ${businessHours}`);
  parts.push(
    'If the caller asks to speak to a person, or the call is urgent, transfer the call to the owner using the transfer tool. If nobody answers, tell the caller the call has been flagged as urgent and that the owner will call back. Never promise that anyone will come or when.',
    'Never read a web address or link out loud. Never give out a specific link or URL. If a caller asks for a link, offer to have the owner send it to them by text or email, and take their number or email.',
    'Never invent a price, a result, or a timeline. Never promise an arrival time or a feature. Never take a payment or a card number. Words to avoid: revolutionary, cutting-edge, and any hype words; never promise a timeline or a feature that is not confirmed. Never diagnose a problem, confirm warranty coverage, give professional advice, promise an arrival time or a result, take a payment or card number, or say you are a person. This is not an emergency service and no person monitors calls live.',
  );
  if (transferPhone) parts.push(`Urgent calls transfer to ${transferPhone}.`);
  return parts.join(' ');
}

/** One Telnyx call. Throws on a non-2xx status; the message carries the Telnyx error text when there is one. */
async function telnyxCall(method, path, body, fetchFn) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetchFn(`${TELNYX_BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${config.telnyxApiKey}`, accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const detail = data && Array.isArray(data.errors) && data.errors[0] && data.errors[0].detail
        ? String(data.errors[0].detail) : '';
      throw new Error(`Telnyx ${method} ${path} returned ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

const telnyxGetAssistant = (assistantId, fetchFn) => telnyxCall('GET', `/v2/ai/assistants/${assistantId}`, undefined, fetchFn);
const telnyxPatchAssistant = (assistantId, body, fetchFn) => telnyxCall('PATCH', `/v2/ai/assistants/${assistantId}`, body, fetchFn);

/** The agent row the client owns (front-desk or always-on), or null. */
function ownAgent(clientId) {
  return store.getTelnyxAgent(clientId);
}

/**
 * The settings to show the client. When they have saved settings, those are
 * returned. When they have not, the current Telnyx assistant is read live so
 * the form is pre-filled with the name, greeting and instructions that are
 * actually live; the business description, services and hours come from the
 * client's business profile when they have filled that in (the live
 * assistant never carries those fields). A failed live read falls back to
 * what the sync already stored (the name), so the form still opens. Returns
 * null when the client has no agent.
 */
async function getEffectiveSettings(clientId, fetchFn = fetch) {
  const agent = ownAgent(clientId);
  if (!agent) return null;
  const saved = store.getAgentSettings(agent.id);
  if (saved) return { agent, settings: saved, fromTelnyx: false };
  let live = null;
  if (config.telnyxApiKey) {
    try {
      const body = await telnyxGetAssistant(agent.telnyx_assistant_id, fetchFn);
      live = body && body.data ? body.data : body;
    } catch (err) {
      console.warn('[agent-settings] live pre-fill failed, using sync data:', err.message);
    }
  }
  // The business profile is the single home for business info: when the
  // client has filled it in, its description, services and hours pre-fill
  // the agent form, so they do not have to type them twice.
  const profile = store.getProfile(clientId);
  return {
    agent,
    settings: {
      agent_name: (live && live.name) || agent.name || '',
      greeting: (live && live.greeting) || '',
      business_description: (profile && profile.business_description) || '',
      services_offered: (profile && profile.services_offered) || '',
      business_hours: (profile && profile.business_hours) || '',
      instructions: (live && live.instructions) || '',
      custom_instructions: false,
      voice: (live && live.voice_settings && live.voice_settings.voice) || '',
      voice_speed: (live && live.voice_settings && typeof live.voice_settings.voice_speed === 'number')
        ? live.voice_settings.voice_speed : 1,
      transfer_phone: agent.transfer_phone_number || '',
      updated_at: null,
    },
    fromTelnyx: true,
  };
}

/**
 * Saves the client's agent settings. Validates ownership (the agent row must
 * belong to this client) and an active subscription, builds the prompt, PATCHes
 * Telnyx, and only on success stores the settings locally. A Telnyx failure
 * leaves the local config unchanged. fetchFn is injected for tests.
 *
 * What goes to Telnyx in the one PATCH: name, greeting and instructions
 * (as before), plus voice_settings (the chosen voice and speed, merged into
 * the assistant's current voice settings so nothing else in there is lost)
 * and tools (the transfer tool with its target set to the new transfer
 * number, the rest of the tool array untouched). Voice, speed and transfer
 * number are only sent when the client actually changed them, so an ordinary
 * name/greeting save never disturbs the voice or the transfer tool.
 * Returns { ok: true, settings } or { ok: false, error }.
 */
async function saveAgentSettings({ clientId, fields, fetchFn = fetch }) {
  const agent = ownAgent(clientId);
  if (!agent) return { ok: false, error: 'no-agent' };
  if (!store.hasSubscription(clientId, agent.service_slug)) return { ok: false, error: 'no-subscription' };
  if (!config.telnyxApiKey) return { ok: false, error: 'telnyx api key not configured' };

  const agentName = clean(fields.agent_name, LIMITS.agentName);
  const greeting = clean(fields.greeting, LIMITS.greeting);
  const businessDescription = clean(fields.business_description, LIMITS.businessDescription);
  const servicesOffered = clean(fields.services_offered, LIMITS.servicesOffered);
  const businessHours = clean(fields.business_hours, LIMITS.businessHours);
  const useCustom = fields.use_custom_instructions === true || fields.use_custom_instructions === 'true' || fields.use_custom_instructions === 1;
  const customText = clean(fields.instructions, LIMITS.instructions);
  if (!agentName) return { ok: false, error: 'Give your agent a name.' };
  if (!greeting) return { ok: false, error: 'Write a greeting for your agent.' };

  // Voice: must be one of the offered voices. An empty choice keeps the
  // assistant's current voice.
  const voice = clean(fields.voice, 200);
  if (voice && !VOICE_IDS.has(voice)) return { ok: false, error: 'Pick a voice from the list.' };
  // Voice speed: a number from 0.5x to 2x. An empty choice keeps the current speed.
  let voiceSpeed = null;
  if (fields.voice_speed !== undefined && fields.voice_speed !== null && String(fields.voice_speed).trim() !== '') {
    voiceSpeed = Number(fields.voice_speed);
    if (!Number.isFinite(voiceSpeed) || voiceSpeed < LIMITS.voiceSpeedMin || voiceSpeed > LIMITS.voiceSpeedMax) {
      return { ok: false, error: 'Voice speed must be between 0.5 and 2.' };
    }
    voiceSpeed = Math.round(voiceSpeed * 100) / 100;
  }
  // Transfer number: a US number the client typed, normalised to E.164.
  // An empty choice keeps the current transfer number.
  const transferPhone = cleanPhone(fields.transfer_phone);
  if (fields.transfer_phone !== undefined && fields.transfer_phone !== null && String(fields.transfer_phone).trim() !== '' && transferPhone.length < 12) {
    return { ok: false, error: 'Enter a full phone number for urgent-call transfers.' };
  }

  // The client's own words win when they chose that; otherwise the prompt is
  // built from the business fields. An empty custom box falls back to generated.
  const customInstructions = useCustom && customText.length > 0;
  const instructions = customInstructions ? customText : buildInstructions({
    businessName: fields.business_name,
    agentName,
    greeting,
    businessDescription,
    servicesOffered,
    businessHours,
    transferPhone: transferPhone || agent.transfer_phone_number,
  });

  // Read the live assistant so the voice settings and the transfer tool can
  // be changed without wiping the rest of either. The PATCH then carries
  // everything in one call, so the assistant gets one new version, not three.
  let live;
  try {
    const body = await telnyxGetAssistant(agent.telnyx_assistant_id, fetchFn);
    live = body && body.data ? body.data : body;
  } catch (err) {
    return { ok: false, error: err.message || 'Could not read the live agent from Telnyx' };
  }
  const patch = { name: agentName, greeting, instructions };
  const currentVoice = live && live.voice_settings && live.voice_settings.voice;
  const currentSpeed = live && live.voice_settings && typeof live.voice_settings.voice_speed === 'number'
    ? live.voice_settings.voice_speed : null;
  if ((voice && voice !== currentVoice) || (voiceSpeed !== null && voiceSpeed !== currentSpeed)) {
    patch.voice_settings = { ...(live.voice_settings || {}) };
    if (voice) patch.voice_settings.voice = voice;
    if (voiceSpeed !== null) patch.voice_settings.voice_speed = voiceSpeed;
  }
  const currentTransfer = agent.transfer_phone_number;
  if (transferPhone && transferPhone !== currentTransfer) {
    const tools = Array.isArray(live.tools) ? live.tools.map((t) => ({ ...t })) : [];
    const tool = tools.find((t) => t && t.type === 'transfer');
    if (tool && tool.transfer && Array.isArray(tool.transfer.targets) && tool.transfer.targets.length > 0) {
      tool.transfer.targets = tool.transfer.targets.map((tg, i) => (i === 0 ? { ...tg, to: transferPhone } : tg));
      patch.tools = tools;
    } else {
      return { ok: false, error: 'This agent has no transfer tool to update. Ask AE support to set it up.' };
    }
  }

  let patched;
  try {
    patched = await telnyxPatchAssistant(agent.telnyx_assistant_id, patch, fetchFn);
  } catch (err) {
    return { ok: false, error: err.message || 'Telnyx update failed' };
  }
  const applied = patched && patched.data ? patched.data : patched;
  if (!applied || typeof applied !== 'object') return { ok: false, error: 'Telnyx update failed' };

  const settings = store.saveAgentSettingsLocal(agent.id, {
    agentName,
    greeting,
    businessDescription,
    servicesOffered,
    businessHours,
    instructions,
    customInstructions,
    voice: voice || currentVoice || null,
    voiceSpeed: voiceSpeed !== null ? voiceSpeed : currentSpeed,
    transferPhone: transferPhone || currentTransfer || null,
  });
  return { ok: true, settings };
}

module.exports = {
  LIMITS,
  VOICES,
  VOICE_IDS,
  voiceById,
  buildInstructions,
  telnyxGetAssistant,
  telnyxPatchAssistant,
  getEffectiveSettings,
  saveAgentSettings,
  sha256,
};
