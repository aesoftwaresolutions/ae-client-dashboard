'use strict';
// Mail transport placeholder. The MVP has no SMTP/email provider wired in.
//   MAIL_MODE=console  prints the email to the server log (local development only)
//   MAIL_MODE=none     sends nothing (default in production until a provider is chosen)
// To go live, replace the body of sendMail with a call to the chosen provider
// (Hostinger SMTP, Resend, Postmark, ...). Nothing else in the app needs to change.
const config = require('./config');

async function sendMail({ to, subject, text }) {
  if (config.mailMode === 'console') {
    console.log(`[mail] To: ${to}\n[mail] Subject: ${subject}\n${text}\n`);
    return true;
  }
  // Never log the body here: it contains a reset token.
  console.warn(`[mail] No mail transport configured; email "${subject}" was NOT sent.`);
  return false;
}

module.exports = { sendMail };
