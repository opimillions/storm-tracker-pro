/**
 * Runs checks, retries a failure once, opens one incident per check after
 * repeated failures, and posts a recovery when it clears. State lives in a
 * JSON file on the monitor's volume.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const fmt = require('./fmt');

const FILE = () => path.join(config.dataDir, 'state.json');
const now = () => new Date().toISOString();

function load() {
  try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return { checks: {}, incidents: [], startedAt: now(), heartbeat: null, cycles: 0, log: [] }; }
}

class Engine {
  constructor({ notifier, sleep = ms => new Promise(r => setTimeout(r, ms)), clock = () => new Date() } = {}) {
    this.state = load();
    this.notifier = notifier;
    this.sleep = sleep;
    this.clock = clock;
  }
  now() { return this.clock().toISOString(); }
  save() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const tmp = FILE() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    fs.renameSync(tmp, FILE());
  }
  log(msg) {
    const line = `${this.now()} ${msg}`;
    console.log('[monitor]', msg);
    this.state.log = [...(this.state.log || []), line].slice(-200);
  }
  beat(phase) { this.state.heartbeat = this.now(); this.state.phase = phase; this.save(); }

  /** Run one check with a single retry, then update incidents. */
  async run(def, fn) {
    const attempt = async () => {
      try { return await fn(); } catch (e) { return { ...def, status: e.setup ? 'setup' : 'fail', kind: e.setup ? 'setup' : 'error', problem: e.message }; }
    };
    const startedAt = this.now();
    let r = await attempt();
    let retried = false;
    if (r.status === 'fail') {
      this.log(`${def.id} failed, retrying once: ${r.problem}`);
      await this.sleep(config.intervals.retryDelaySec * 1000);
      const r2 = await attempt();
      retried = true;
      if (r2.status !== 'fail') r2.note = 'Passed on retry';
      r = r2;
    }
    return this.record(def, r, { startedAt, retried });
  }

  record(def, r, { startedAt = this.now(), retried = false } = {}) {
    const prev = this.state.checks[def.id] || {};
    const at = this.now();
    const c = {
      ...prev, ...def, ...r,
      id: def.id, lastAttempt: startedAt, finishedAt: at, retried,
      lastSuccess: r.status === 'ok' ? at : prev.lastSuccess || null,
      consecutiveFailures: r.status === 'fail' ? (prev.consecutiveFailures || 0) + 1 : r.status === 'warn' ? 0 : (r.status === 'ok' ? 0 : prev.consecutiveFailures || 0),
    };
    if (r.status === 'fail') { c.lastFailure = { at, problem: r.problem }; if (c.consecutiveFailures === 1) c.failingSince = startedAt; }
    else if (r.status === 'ok') delete c.failingSince;
    if (r.status === 'ok') { delete c.problem; }
    this.state.checks[def.id] = c;

    const open = this.state.incidents.find(i => i.checkId === def.id && !i.closedAt);
    const actions = [];
    if (r.status === 'fail') {
      if (open) { open.lastSeen = at; open.failures = (open.failures || 0) + 1; open.problem = r.problem; }
      else if (c.consecutiveFailures >= config.incidentAfter) {
        const inc = { id: `inc-${Date.now().toString(36)}-${def.id}`, checkId: def.id, name: def.name, feature: def.feature, openedAt: at, failingSince: c.failingSince || at, lastSeen: at, failures: c.consecutiveFailures, problem: r.problem, link: r.link || null, closedAt: null };
        this.state.incidents.push(inc);
        actions.push(['open', inc]);
        this.log(`INCIDENT opened: ${def.id}: ${r.problem}`);
      }
    } else if (r.status === 'ok' && open) {
      open.closedAt = at; open.recovery = r.summary || 'Back to normal.';
      actions.push(['recover', open]);
      this.log(`RECOVERED: ${def.id}`);
    }
    this.state.incidents = this.state.incidents.filter(i => !i.closedAt || Date.parse(at) - Date.parse(i.closedAt) < 14 * 86400000).slice(-100);
    this.save();
    return { check: c, actions };
  }

  async notify(actions) {
    for (const [kind, inc] of actions) {
      const text = kind === 'open' ? incidentText(inc) : recoveryText(inc);
      try { const sent = await this.notifier(text, kind, inc); inc[kind === 'open' ? 'notified' : 'recoveryNotified'] = sent; }
      catch (e) { inc[kind === 'open' ? 'notified' : 'recoveryNotified'] = `failed: ${e.message}`; this.log(`notify failed: ${e.message}`); }
    }
    if (actions.length) this.save();
  }
}

function duration(a, b) {
  const m = Math.round((Date.parse(b) - Date.parse(a)) / 60000);
  return m < 90 ? `${m} min` : `${Math.round(m / 6) / 10} hr`;
}

function incidentText(inc) {
  return [`StormCheck Pro needs attention: ${inc.name}`,
    inc.problem,
    `Affected: ${inc.feature}`,
    inc.link ? `Inspect: ${inc.link}` : null,
    `Failing since ${fmt.time(inc.failingSince || inc.openedAt)} (${inc.failures} checks in a row, each retried once).`,
    `Panel: ${config.panelUrl}`].filter(Boolean).join('\n');
}
function recoveryText(inc) {
  return [`Recovered: ${inc.name}`,
    inc.recovery,
    `Was failing ${duration(inc.failingSince || inc.openedAt, inc.closedAt)} (since ${fmt.time(inc.failingSince || inc.openedAt)}).`,
    `Panel: ${config.panelUrl}`].join('\n');
}

module.exports = { Engine, incidentText, recoveryText };
