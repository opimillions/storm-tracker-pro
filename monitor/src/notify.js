/** Sends incident and recovery messages to whichever channels are configured. */
const config = require('./config');

async function slack(text) {
  const r = await fetch(config.notify.slackWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`Slack webhook HTTP ${r.status}`);
}

async function email(text, kind) {
  const nodemailer = require('nodemailer');
  const n = config.notify;
  const t = nodemailer.createTransport({ host: n.smtpHost, port: n.smtpPort, secure: n.smtpPort === 465, auth: n.smtpUser ? { user: n.smtpUser, pass: n.smtpPass } : undefined });
  const [subject, ...rest] = text.split('\n');
  await t.sendMail({ from: n.smtpFrom || n.smtpUser, to: n.to, subject: (kind === 'open' ? '🔴 ' : '✅ ') + subject, text: rest.join('\n') });
}

/** Returns a short description of where it went, or 'panel only'. */
async function notifier(text, kind) {
  const sent = [];
  const errors = [];
  if (config.notify.slackWebhook) { try { await slack(text); sent.push('Slack'); } catch (e) { errors.push(e.message); } }
  if (config.notify.smtpHost && config.notify.to) { try { await email(text, kind); sent.push('email'); } catch (e) { errors.push(`email: ${e.message}`); } }
  if (!sent.length && errors.length) throw new Error(errors.join('; '));
  return sent.length ? sent.join(' + ') : 'panel only (no alert channel set)';
}

const channels = () => [config.notify.slackWebhook && 'Slack', config.notify.smtpHost && config.notify.to && 'email'].filter(Boolean);

module.exports = { notifier, channels };
