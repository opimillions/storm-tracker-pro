/**
 * StormCheck Pro monitor: schedules the checks and serves status to Billy Bob.
 *
 *   GET /health        liveness + heartbeat (no auth)
 *   GET /api/status    full status (Authorization: Bearer STATUS_TOKEN)
 *   GET /last-report.pdf  newest PDF from the workflow test (same token)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { Engine } = require('./engine');
const feeds = require('./feeds');
const app = require('./app-client');
const { STEPS, runWorkflow, cachedAddress } = require('./workflow');
const alertTest = require('./alert-test');
const coverage = require('./coverage');
const { notifier, channels } = require('./notify');

const VERSION = '1.0.0';
const engine = new Engine({ notifier });

async function feedCycle() {
  engine.beat('feeds');
  let pipePromise = null;
  const getPipe = () => (pipePromise = pipePromise || app.pipeline());
  const run = feeds.runners(getPipe);
  for (const def of feeds.DEFS) {
    const { actions } = await engine.run(def, async () => { pipePromise = null; return run[def.id](); });
    await engine.notify(actions);
    engine.beat('feeds');
  }
  engine.log('feeds: ' + feeds.DEFS.map(d => `${d.id.slice(5)}=${(engine.state.checks[d.id] || {}).status}`).join(' '));
  engine.state.lastFeedCycle = engine.now();
  engine.state.cycles = (engine.state.cycles || 0) + 1;
  engine.beat('idle');
}

async function workflowCycle() {
  engine.beat('workflow');
  const once = async () => { try { return await runWorkflow(); } catch (e) { return Object.fromEntries(STEPS.map(s => [s.id, { ok: false, problem: `Browser test crashed: ${e.message}` }])); } };
  let res = await once();
  const failedFirst = Object.values(res).some(r => r.ok === false);
  if (failedFirst) {
    engine.log('workflow had a failing step, retrying the whole flow once');
    await engine.sleep(config.intervals.retryDelaySec * 1000);
    const res2 = await once();
    for (const s of STEPS) if (res[s.id] && res[s.id].ok === false && res2[s.id] && res2[s.id].ok) res2[s.id].note = 'Passed on retry';
    res = res2;
  }
  for (const s of STEPS) {
    const r = res[s.id] || { ok: null, problem: 'Not run' };
    const status = r.setup ? 'setup' : r.ok === true ? 'ok' : r.ok === false ? 'fail' : 'skipped';
    const { actions } = engine.record({ ...s, group: 'workflow' }, { status, summary: r.detail, problem: r.problem, link: r.link, measure: r.measure, note: r.note }, { retried: failedFirst });
    await engine.notify(actions);
  }
  engine.log('workflow: ' + STEPS.map(x => `${x.id.slice(3)}=${(engine.state.checks[x.id] || {}).status}${res[x.id] && res[x.id].problem ? ` (${res[x.id].problem.slice(0, 160)})` : ''}`).join(' '));
  engine.state.lastWorkflow = engine.now();
  engine.beat('idle');
}

async function alertCycle() {
  engine.beat('alert-test');
  const { actions } = await engine.run({ ...alertTest.CHECK, group: 'workflow' }, alertTest.runAlertTest);
  await engine.notify(actions);
  engine.state.lastAlertTest = engine.now();
  engine.beat('idle');
}

function status() {
  const s = engine.state;
  const order = [...feeds.DEFS.map(d => d.id), ...STEPS.map(x => x.id), alertTest.CHECK.id];
  const checks = order.map(id => s.checks[id] || { id, status: 'pending', name: [...feeds.DEFS, ...STEPS, alertTest.CHECK].find(d => d.id === id).name });
  return {
    monitor: {
      version: VERSION, startedAt: s.startedAt, heartbeat: s.heartbeat, phase: s.phase, cycles: s.cycles || 0,
      lastFeedCycle: s.lastFeedCycle || null, lastWorkflow: s.lastWorkflow || null, lastAlertTest: s.lastAlertTest || null,
      intervals: config.intervals, app: config.appUrl, alertChannels: channels(),
      expectedEveryMin: config.intervals.feedsMin,
      knownStorm: { ...config.knownStorm, address: config.knownStorm.address || (cachedAddress() || {}).address || 'picked on the next test run' },
    },
    checks: checks.map(c => ({ ...c, measure: c.measure })),
    incidents: s.incidents.slice().reverse(),
    coverage: coverage.map(f => ({ ...f, automated: f.checks.filter(id => id.startsWith('wf.') || id.startsWith('feed.')).length > 0 })),
    log: (s.log || []).slice(-40),
  };
}

function authed(req) {
  if (!config.statusToken) return false;
  const got = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const a = crypto.createHash('sha256').update(got).digest(), b = crypto.createHash('sha256').update(config.statusToken).digest();
  return crypto.timingSafeEqual(a, b);
}

function serve() {
  http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
    if (url.pathname === '/health') return send(200, { ok: true, heartbeat: engine.state.heartbeat, phase: engine.state.phase });
    if (!authed(req)) return send(401, { error: 'Status token required' });
    if (url.pathname === '/api/status') return send(200, status());
    if (url.pathname === '/panel') return send(200, fs.readFileSync(path.join(__dirname, 'panel.html'), 'utf8'), 'text/html; charset=utf-8');
    if (url.pathname === '/last-report.pdf') {
      const f = path.join(config.dataDir, 'last-report.pdf');
      return fs.existsSync(f) ? send(200, fs.readFileSync(f), 'application/pdf') : send(404, { error: 'No PDF yet' });
    }
    send(404, { error: 'Not found' });
  }).listen(config.port, () => console.log(`[monitor] v${VERSION} listening on ${config.port}, watching ${config.appUrl}`));
}

/** Simple scheduler: each loop runs whatever is due; never overlaps itself. */
async function loop() {
  const due = (last, min) => !last || Date.now() - Date.parse(last) >= min * 60000 - 15000;
  for (;;) {
    try {
      if (due(engine.state.lastFeedCycle, config.intervals.feedsMin)) await feedCycle();
      if (due(engine.state.lastWorkflow, config.intervals.workflowMin)) await workflowCycle();
      if (config.intervals.alertTestHours > 0) { if (due(engine.state.lastAlertTest, config.intervals.alertTestHours * 60)) await alertCycle(); }
      else if (!engine.state.checks['wf.alert']) engine.record({ ...alertTest.CHECK, group: 'workflow' }, { status: 'setup', problem: 'Built but turned off until a test inbox is set up (ALERT_TEST_HOURS=0). It needs the test account to use that inbox address and its IMAP login.' });
      engine.beat('idle');
    } catch (e) { engine.log(`cycle error: ${e.stack || e.message}`); }
    await new Promise(r => setTimeout(r, 30000));
  }
}

if (require.main === module) {
  if (!config.statusToken) console.warn('[monitor] STATUS_TOKEN not set: /api/status is closed');
  engine.state.startedAt = engine.now();
  // Close incidents for checks that no longer exist (e.g. feed.iem: the 5-city watch-point monitor was retired).
  const known = new Set([...feeds.DEFS.map(d => d.id), ...STEPS.map(x => x.id), alertTest.CHECK.id]);
  for (const inc of engine.state.incidents) if (!inc.closedAt && !known.has(inc.checkId)) {
    inc.closedAt = engine.now(); inc.recovery = 'Check retired: the feature it watched was removed from StormCheck Pro.';
    delete engine.state.checks[inc.checkId];
  }
  engine.save();
  serve();
  loop();
}

module.exports = { status, engine, feedCycle, workflowCycle, alertCycle };
