'use strict';
// Daily Telnyx sync (pull) for a Hostinger cron. Fetches assistants,
// conversations, phone numbers and balance from Telnyx (read-only GETs) and
// stores them in the dashboard DB so the admin and client views stay current
// even when a webhook is missed. Needs TELNYX_API_KEY in the hosting env vars.
//   node scripts/telnyx-sync.js
// Prints a JSON summary. Exit 0 on success (or when the sync is skipped
// because it ran recently, or the key is not configured yet); exit 1 on error.
const { syncTelnyx } = require('../src/telnyx-sync');

async function main() {
  const result = await syncTelnyx();
  console.log(JSON.stringify(result));
  if (!result.ok) {
    // "not configured" is a setup state, not a failure: the cron should not
    // alert on it, it just means TELNYX_API_KEY is not set yet.
    if (result.error === 'telnyx api key not configured') return 0;
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`telnyx-sync: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
