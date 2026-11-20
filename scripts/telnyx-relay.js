'use strict';
// Sender side of the Front Desk funnel: pushes one normalised call summary
// into the dashboard, exactly the way the future AE-site webhook will.
// The payload shape is the one POST /api/v1/webhooks/telnyx/call-summary
// accepts (see src/api.js ingestTelnyx): outcome, caller_name, caller_number,
// started_at, duration_seconds, summary. The relay adds client_id and the
// per-client Bearer key; it invents nothing about Telnyx's own webhook shape.
//   node scripts/telnyx-relay.js --base http://localhost:3000 --key aek_... \
//     --client-id cl_... --file scripts/sample-call-summary.json [--verify]
//   cat payload.json | node scripts/telnyx-relay.js --base ... --key ... --client-id ... --stdin [--verify]
// Exit code 0 means the dashboard stored the event (and, with --verify,
// that it shows in the client's activity feed). Anything else is a failure.
const fs = require('node:fs');

function arg(flag, argv) {
  const i = argv.indexOf(flag);
  if (i === -1 || i + 1 >= argv.length) return null;
  return argv[i + 1];
}

function readPayload(argv) {
  let raw;
  if (argv.includes('--stdin')) {
    raw = fs.readFileSync(0, 'utf8');
  } else {
    const file = arg('--file', argv);
    if (!file) throw new Error('Give --file <payload.json> or --stdin');
    raw = fs.readFileSync(file, 'utf8');
  }
  const payload = JSON.parse(raw);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Payload must be a JSON object');
  }
  return payload;
}

function validateCall(call) {
  if (!['answered', 'missed'].includes(call.outcome)) {
    throw new Error('outcome must be "answered" or "missed"');
  }
  if (call.service !== undefined && !['front-desk', 'always-on-front-desk'].includes(call.service)) {
    throw new Error('service must be "front-desk" or "always-on-front-desk"');
  }
  if (call.caller_name !== undefined && typeof call.caller_name !== 'string') throw new Error('caller_name must be a string');
  if (call.caller_number !== undefined && typeof call.caller_number !== 'string') throw new Error('caller_number must be a string');
  if (call.summary !== undefined && typeof call.summary !== 'string') throw new Error('summary must be a string');
  if (call.duration_seconds !== undefined && !Number.isFinite(call.duration_seconds)) throw new Error('duration_seconds must be a number');
  if (call.started_at !== undefined && Number.isNaN(new Date(call.started_at).getTime())) throw new Error('started_at must be an ISO 8601 date');
}

/** Pushes one call summary. Returns the event id. Throws on any failure. */
async function relayCall({ base, key, clientId, call }) {
  validateCall(call);
  const body = { client_id: clientId, service: call.service || 'front-desk', ...call };
  const res = await fetch(`${base.replace(/\/$/, '')}/api/v1/webhooks/telnyx/call-summary`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status !== 200 || !data.ok) {
    throw new Error(`Dashboard refused the call summary (${res.status}): ${data.error || 'no detail'}`);
  }
  return data.event_id;
}

/** Confirms the event shows in the client's activity feed. */
async function verifyInFeed({ base, key, clientId, eventId }) {
  const res = await fetch(`${base.replace(/\/$/, '')}/api/v1/clients/${clientId}/activity?limit=50`, {
    headers: { authorization: `Bearer ${key}` },
  });
  if (res.status !== 200) throw new Error(`Feed check failed (${res.status})`);
  const { activity } = await res.json();
  const found = (activity || []).find((e) => e.id === eventId);
  if (!found) throw new Error('Event was stored but does not show in the activity feed');
  return found;
}

async function main(argv) {
  const base = arg('--base', argv) || process.env.DASHBOARD_BASE_URL || 'http://localhost:3000';
  const key = arg('--key', argv) || process.env.DASHBOARD_API_KEY;
  const clientId = arg('--client-id', argv) || process.env.DASHBOARD_CLIENT_ID;
  if (!key) throw new Error('Give --key <api-key> or set DASHBOARD_API_KEY');
  if (!clientId) throw new Error('Give --client-id <client-id> or set DASHBOARD_CLIENT_ID');
  const call = readPayload(argv);
  const eventId = await relayCall({ base, key, clientId, call });
  console.log(`Call summary stored: event ${eventId}`);
  if (argv.includes('--verify')) {
    const shown = await verifyInFeed({ base, key, clientId, eventId });
    console.log(`Verified in feed: "${shown.title}" (${shown.service}, ${shown.occurred_at})`);
  }
  return eventId;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`telnyx-relay: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { relayCall, verifyInFeed, validateCall };
