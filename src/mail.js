'use strict';
// Mail transport.
//   MAIL_MODE=console  prints the email to the server log (local development only)
//   MAIL_MODE=none     sends nothing (default in production until a provider is chosen)
//   MAIL_MODE=smtp     sends via SMTP (zero new dependencies; Node net/tls only).
//     MAIL_SMTP_HOST, MAIL_SMTP_PORT (default 587), MAIL_SMTP_USER, MAIL_SMTP_PASS,
//     MAIL_SMTP_SECURE=1 for implicit TLS (port 465), otherwise STARTTLS (port 587),
//     MAIL_FROM (the address mail comes from).
// To go live, set MAIL_MODE=smtp plus the MAIL_SMTP_* env vars in the hosting env
// vars (never in a file or the repo). Nothing else in the app needs to change.
const net = require('node:net');
const tls = require('node:tls');
const config = require('./config');

/** Minimal SMTP client (no dependency). Resolves when the message is accepted, throws otherwise. */
function sendSmtp({ to, subject, text }) {
  return new Promise((resolve, reject) => {
    const host = config.smtpHost;
    const port = config.smtpPort;
    if (!host || !config.smtpUser || !config.smtpPass) {
      return reject(new Error('SMTP is not configured (MAIL_SMTP_HOST/USER/PASS)'));
    }
    const from = config.mailFrom;
    const fromAddr = /<([^>]+)>/.exec(from)?.[1] || from;
    let socket;
    let buf = '';
    let reply = null; // { code, lines } for the reply currently being read
    const timeout = setTimeout(() => fail(new Error('SMTP timed out')), 30_000);
    const fail = (err) => {
      clearTimeout(timeout);
      try { socket?.destroy(); } catch { /* already closed */ }
      reject(err);
    };
    // Reads one full reply (all lines; a reply ends on a line "NNN " with a space).
    // Resolves { code, lines } where lines are the reply text without the "NNN-"/"NNN " prefix.
    const readReply = () => new Promise((res) => { reply = { lines: [], res }; });
    const onLine = (line) => {
      if (!reply) return;
      const m = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!m) return;
      reply.lines.push(m[3]);
      if (m[2] === ' ') {
        const done = reply;
        reply = null;
        const code = Number(m[1]);
        if (code >= 400) return fail(new Error(`SMTP ${line}`));
        done.res({ code, lines: done.lines });
      }
    };
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 2);
      }
    };
    const cmd = async (line) => {
      const p = readReply();
      await new Promise((res, rej) => socket.write(line + '\r\n', (err) => (err ? rej(err) : res())));
      return p;
    };
    const startTls = () => new Promise((res, rej) => {
      const secure = tls.connect({ socket, host, servername: host }, () => res(secure));
      secure.once('error', rej);
      socket.removeAllListeners('data');
      secure.on('data', onData);
      socket = secure;
    });

    const run = async () => {
      socket = config.smtpSecure
        ? tls.connect({ host, port, servername: host })
        : net.connect({ host, port });
      socket.setEncoding('utf8');
      socket.on('data', onData);
      socket.once('error', fail);
      await readReply(); // 220 greeting
      let ehlo = await cmd(`EHLO ${host}`);
      if (!config.smtpSecure) {
        // STARTTLS (port 587) when the server offers it. Refuse plain-text auth otherwise.
        if (!ehlo.lines.some((l) => /STARTTLS/i.test(l))) {
          return fail(new Error('SMTP server does not offer STARTTLS; refusing to send credentials in plain text'));
        }
        await cmd('STARTTLS');
        socket = await startTls();
        ehlo = await cmd(`EHLO ${host}`);
      }
      void ehlo;
      // AUTH LOGIN
      await cmd('AUTH LOGIN');
      await cmd(Buffer.from(config.smtpUser).toString('base64'));
      await cmd(Buffer.from(config.smtpPass).toString('base64'));
      await cmd(`MAIL FROM:<${fromAddr}>`);
      await cmd(`RCPT TO:<${to}>`);
      await cmd('DATA');
      const body = [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        // Every line ends in CRLF (servers reject bare LF), and any line that starts
        // with a dot, including the first, is dot-stuffed (SMTP DATA rule).
        String(text).replace(/\r\n|\r|\n/g, '\n').split('\n').map((l) => (l.startsWith('.') ? `.${l}` : l)).join('\r\n'),
        '',
      ].join('\r\n');
      const queued = readReply();
      socket.write(body + '\r\n.\r\n');
      await queued; // 250 queued
      await cmd('QUIT');
      clearTimeout(timeout);
      try { socket.end(); } catch { /* already closed */ }
      resolve();
    };
    run().catch(fail);
  });
}

async function sendMail({ to, subject, text }) {
  if (config.mailMode === 'console') {
    console.log(`[mail] To: ${to}\n[mail] Subject: ${subject}\n${text}\n`);
    return true;
  }
  if (config.mailMode === 'smtp') {
    try {
      await sendSmtp({ to, subject, text });
      return true;
    } catch (err) {
      // Never log the body here: it contains a reset token.
      console.error(`[mail] SMTP send failed for "${subject}": ${err.message}`);
      return false;
    }
  }
  // Never log the body here: it contains a reset token.
  console.warn(`[mail] No mail transport configured; email "${subject}" was NOT sent.`);
  return false;
}

module.exports = { sendMail };
