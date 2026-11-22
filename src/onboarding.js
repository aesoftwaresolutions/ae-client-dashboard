'use strict';
// New-member password onboarding + 1-year password expiry workflow.
//   - A user created with a temporary password gets a set-password email with a
//     7-day link, plus reminders on day 3 and day 6 until they set a real one.
//   - Every password expires 1 year after it is set (see store.passwordExpired);
//     an expired password cannot sign in and gets a fresh reset link instead.
//   - runReminders() is the daily job: call it from scripts/send-password-reminders.js
//     (Hostinger cron) or POST /api/v1/admin/send-password-reminders (REMINDER_SECRET).
const config = require('./config');
const { db } = require('./db');
const sec = require('./security');
const store = require('./store');
const { sendMail } = require('./mail');

const DAY_MS = 86_400_000;

/** Creates a password-reset token valid for the onboarding link window (7 days). Returns the plain token. */
function issueResetToken(userId, daysValid = config.onboardingLinkDays) {
  const token = sec.newToken(32);
  db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?,?,?)')
    .run(sec.sha256(token), userId, new Date(Date.now() + daysValid * DAY_MS).toISOString());
  return token;
}

function resetUrl(token) {
  return `${config.baseUrl}/reset/${token}`;
}

/**
 * Emails a set-password / reset link to a user. Returns true when the mail was sent.
 * reason: 'welcome' (new member), 'reminder' (day 3 / day 6), 'expired' (password past 1 year).
 * A fresh 7-day token is issued each time; older unused tokens for that user are left
 * to expire on their own (the reset page only accepts an unused, unexpired one).
 */
async function sendPasswordResetEmail(user, { reason = 'welcome' } = {}) {
  const token = issueResetToken(user.id);
  const link = resetUrl(token);
  const subjects = {
    welcome: 'Set your AE dashboard password',
    reminder: 'Reminder: set your AE dashboard password',
    expired: 'Your AE dashboard password has expired',
  };
  const intros = {
    welcome: 'Welcome to the AE client dashboard. Your account was created with a temporary password. Please set your own password within the next week using the link below. The link is valid for 7 days.',
    reminder: 'A quick reminder: you have not set your own AE dashboard password yet. Please set one using the link below. The link is valid for 7 days.',
    expired: 'Your AE dashboard password has expired (passwords expire after one year). Please set a new one using the link below. The link is valid for 7 days.',
  };
  return sendMail({
    to: user.email,
    subject: subjects[reason] || subjects.welcome,
    text: `${intros[reason] || intros.welcome}\n\n${link}\n\nIf you did not expect this, you can ignore it and keep using your current password (unless it has expired). Passwords expire one year after they are set.`,
  });
}

/**
 * Daily reminder job. For each user still on a temporary password, sends the
 * day-3 reminder once they cross day 3 and the day-6 reminder once they cross
 * day 6 (config.onboardingReminderDays). Nothing is sent after the week is up.
 * Returns { checked, sent, skipped, errors }.
 */
async function runReminders() {
  const pending = store.listOnboardingPending();
  const result = { checked: pending.length, sent: 0, skipped: 0, errors: [] };
  const now = Date.now();
  for (const u of pending) {
    try {
      const days = Math.floor((now - new Date(u.temp_created_at).getTime()) / DAY_MS);
      const milestones = config.onboardingReminderDays;
      // Which reminder is due: the first milestone not yet sent that the user has crossed.
      const dueIndex = milestones.findIndex((d, i) => days >= d && u.reminder_count <= i);
      if (dueIndex === -1) { result.skipped += 1; continue; }
      // Do not send twice in one day if the job runs more than once.
      if (u.last_reminder_at && (now - new Date(u.last_reminder_at).getTime()) < DAY_MS) { result.skipped += 1; continue; }
      const sent = await sendPasswordResetEmail({ id: u.id, email: u.email }, { reason: 'reminder' });
      if (!sent) { result.errors.push(`${u.email}: mail not sent`); continue; }
      store.recordOnboardingReminder(u.id);
      result.sent += 1;
    } catch (err) {
      result.errors.push(`${u.email}: ${err.message}`);
    }
  }
  return result;
}

module.exports = { issueResetToken, resetUrl, sendPasswordResetEmail, runReminders };
