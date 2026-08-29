/**
 * Outbound email.
 *
 * One transport for the process, created lazily so a deployment with no SMTP
 * never constructs one — and so a misconfigured host fails on first send with a
 * clear message rather than at import time, before the logger exists.
 *
 * ─── Why this is deliberately small ─────────────────────────────────────────
 *
 * The only thing the system emails is a password reset link. That is a security
 * boundary, not a marketing channel: no HTML templating, no attachments, no
 * per-message transport options. Nodemailer's history of header-injection and
 * file-access advisories is almost entirely in the features this does not use.
 */

import { config } from '../config/index.js';
import { moduleLogger } from './logger.js';

const log = moduleLogger('mail');

let transport;

async function getTransport() {
  if (transport) return transport;

  if (!config.mail.host) {
    throw new Error('SMTP is not configured (MAIL_HOST is empty)');
  }

  // Imported here rather than at module load so the dependency is only pulled in
  // by a deployment that actually sends mail. A dynamic import, not require():
  // this is an ES module and require is not defined in one.
  const nodemailer = (await import('nodemailer')).default;

  transport = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    // Implicit TLS on 465; STARTTLS elsewhere. requireTLS makes the upgrade
    // mandatory rather than opportunistic — an on-prem relay that quietly
    // declines STARTTLS would otherwise send credentials in the clear.
    secure: config.mail.secure,
    requireTLS: !config.mail.secure && config.mail.requireTls,
    auth: config.mail.user ? { user: config.mail.user, pass: config.mail.password } : undefined,
    tls: { rejectUnauthorized: config.mail.rejectUnauthorized },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  return transport;
}

/**
 * Rejects anything that could break out of a header.
 *
 * A newline in a subject or an address is how header injection works, and this
 * is the one place user-influenced text reaches a message envelope.
 */
function assertHeaderSafe(value, field) {
  const text = String(value ?? '');
  if (/[\r\n]/.test(text)) throw new Error(`${field} must not contain a newline`);
  return text;
}

/**
 * Sends one plain-text message.
 *
 * @param {{to: string, subject: string, text: string}} message
 */
export async function sendMail({ to, subject, text }) {
  const recipient = assertHeaderSafe(to, 'recipient');
  const line = assertHeaderSafe(subject, 'subject');

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) {
    throw new Error('recipient is not a valid address');
  }

  const transporter = await getTransport();

  const info = await transporter.sendMail({
    from: config.mail.from,
    to: recipient,
    subject: line,
    // Plain text only. An HTML body is a second parser and a second injection
    // surface for a message that is one sentence and a link.
    text,
  });

  log.info({ messageId: info.messageId, accepted: info.accepted?.length ?? 0 }, 'mail sent');
  return info;
}

/** Verifies the SMTP settings without sending anything, for a diagnostics screen. */
export async function verifyMail() {
  if (!config.mail.host) return { configured: false, reason: 'MAIL_HOST is not set' };
  try {
    const transporter = await getTransport();
    await transporter.verify();
    return { configured: true, ok: true, host: config.mail.host, port: config.mail.port };
  } catch (error) {
    return { configured: true, ok: false, host: config.mail.host, error: error.message };
  }
}
