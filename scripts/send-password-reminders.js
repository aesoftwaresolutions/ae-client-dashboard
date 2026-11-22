'use strict';
// Daily password-onboarding reminders.
//   node scripts/send-password-reminders.js
// Sends the day-3 and day-6 set-password reminders to members still on a
// temporary password. Safe to run daily (it skips anyone already reminded
// for that milestone, and anyone past the first week). Exit 0 on success,
// exit 1 if any reminder failed to send. Run it from a cron (Hostinger cron
// or any scheduler) once a day. Needs mail configured (MAIL_MODE=smtp plus
// the MAIL_SMTP_* env vars) or the emails are logged as unsent.
const { runReminders } = require('../src/onboarding');

(async () => {
  try {
    const result = await runReminders();
    console.log(JSON.stringify(result));
    process.exit(result.errors.length ? 1 : 0);
  } catch (err) {
    console.error('[reminders] failed:', err);
    process.exit(1);
  }
})();
