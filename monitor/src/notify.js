/** Sends incident and recovery messages to whichever channels are configured. */
const config = require('./config');

async function slack(text) {
  const r = await fetch(config.notify.slackWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`Slack webhook HTTP ${r.status}`);
}

async function missionControl(kind, inc) {
  const n = config.notify;
  const r = await fetch(n.missionControlUrl.replace(/\/$/, '') + '/api/monitor/incident', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-monitor-secret': n.missionControlSecret },
    body: JSON.stringify({ kind, key: inc.id, title: `StormCheck: ${inc.name}`, details: kind === 'open' ? `${inc.problem} Affected: ${inc.feature}.` : inc.recovery, link: inc.link || config.panelUrl }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Mission Control HTTP ${r.status}`);
}

async function email(text, kind) {
  const nodemailer = require('nodemailer');
  const n = config.notify;
  const t = nodemailer.createTransport({ host: n.smtpHost, port: n.smtpPort, secure: n.smtpPort === 465, auth: n.smtpUser ? { user: n.smtpUser, pass: n.smtpPass } : undefined });
  const [subject, ...rest] = text.split('\n');
  await t.sendMail({ from: n.smtpFrom || n.smtpUser, to: n.to, subject: (kind === 'open' ? '🔴 ' : '✅ ') + subject, text: rest.join('\n') });
}

/** Returns a short description of where it went, or 'panel only'. */
async function notifier(text, kind, inc) {
  const sent = [];
  const errors = [];
  if (config.notify.missionControlSecret && inc) { try { await missionControl(kind === 'open' ? 'open' : 'recover', inc); sent.push('Billy Bob (Mission Control)'); } catch (e) { errors.push(e.message); } }
  if (config.notify.slackWebhook) { try { await slack(text); sent.push('Slack'); } catch (e) { errors.push(e.message); } }
  if (config.notify.smtpHost && config.notify.to) { try { await email(text, kind); sent.push('email'); } catch (e) { errors.push(`email: ${e.message}`); } }
  if (!sent.length && errors.length) throw new Error(errors.join('; '));
  return sent.length ? sent.join(' + ') : 'panel only (no alert channel set)';
}

const channels = () => [config.notify.missionControlSecret && 'Billy Bob (Mission Control)', config.notify.slackWebhook && 'Slack', config.notify.smtpHost && config.notify.to && 'email'].filter(Boolean);

module.exports = { notifier, channels };
