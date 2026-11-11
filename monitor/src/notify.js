/** Sends incident and recovery messages to whichever channels are configured. */
const config = require('./config');

async function slack(text) {
  const r = await fetch(config.notify.slackWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`Slack webhook HTTP ${r.status}`);
}

/**
 * Files incidents on Mission Control's task board (command.thepublicadjustertx.com) as urgent
 * StormCheck tasks for Billy Bob, through the same sign-in and task API the dashboard uses.
 */
let mcCookie = null;
async function mcFetch(path, method, data) {
  const n = config.notify, base = n.missionControlUrl.replace(/\/$/, '');
  const go = () => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'x-mc-request': '1', Cookie: mcCookie || '' }, body: JSON.stringify(data), signal: AbortSignal.timeout(10000) });
  let r = mcCookie ? await go() : { status: 401 };
  if (r.status === 401) {
    const l = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: n.missionControlPassword }), signal: AbortSignal.timeout(10000) });
    if (!l.ok) throw new Error(`Mission Control sign-in HTTP ${l.status}`);
    const m = String(l.headers.get('set-cookie') || '').match(/ai_session=[^;]+/);
    if (!m) throw new Error('Mission Control sign-in returned no session');
    mcCookie = m[0];
    r = await go();
  }
  if (!r.ok) throw new Error(`Mission Control ${method} ${path} HTTP ${r.status}`);
  return r.json();
}
async function missionControl(kind, inc) {
  const title = `StormCheck: ${inc.name}`.slice(0, 160);
  const desc = [kind === 'open' ? inc.problem : `Opened: ${inc.problem}`, `Affected: ${inc.feature}.`, inc.link ? `Inspect: ${inc.link}` : null, `Panel: ${config.panelUrl}`,
    kind === 'open' ? 'Reported by the StormCheck monitor. Billy Bob: review and decide the next step.' : `Recovered: ${inc.recovery}`].filter(Boolean).join('\n').slice(0, 2000);
  const task = { title, description: desc, business: 'StormCheck', agent: 'billy', status: kind === 'open' ? 'in_progress' : 'done', priority: 'urgent', due_date: '' };
  if (kind === 'open') { const r = await mcFetch('/api/tasks', 'POST', task); inc.missionControlTaskId = r.id; }
  else if (inc.missionControlTaskId) await mcFetch('/api/tasks/' + encodeURIComponent(inc.missionControlTaskId), 'PATCH', task);
  else await mcFetch('/api/tasks', 'POST', task);
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
  if (config.notify.missionControlPassword && inc) { try { await missionControl(kind === 'open' ? 'open' : 'recover', inc); sent.push('Billy Bob (Mission Control)'); } catch (e) { errors.push(e.message); } }
  if (config.notify.slackWebhook) { try { await slack(text); sent.push('Slack'); } catch (e) { errors.push(e.message); } }
  if (config.notify.smtpHost && config.notify.to) { try { await email(text, kind); sent.push('email'); } catch (e) { errors.push(`email: ${e.message}`); } }
  if (!sent.length && errors.length) throw new Error(errors.join('; '));
  return sent.length ? sent.join(' + ') : 'panel only (no alert channel set)';
}

const channels = () => [config.notify.missionControlPassword && 'Billy Bob (Mission Control)', config.notify.slackWebhook && 'Slack', config.notify.smtpHost && config.notify.to && 'email'].filter(Boolean);

module.exports = { notifier, channels };
