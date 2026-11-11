/**
 * Stale-feed incident simulation. Runs the real monitor engine and feed checks
 * (src/), with NOAA's and StormCheck Pro's HTTP answers scripted so we can
 * make the hail map serve an old file on purpose and then fix it.
 *
 *   node demo/simulate.js <workflow.json> <out.json>
 *
 * Phases: healthy → map stale (retry fails, no incident yet) → still stale
 * (incident opens, alert sent) → fixed (recovery sent) → monitor silent (overdue).
 */
const fs = require('fs'), path = require('path'), os = require('os');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-sim-'));
process.env.RETRY_DELAY_SEC = '0';
process.env.STORMCHECK_URL = 'https://stormcheckpro.thepublicadjustertx.com';
process.env.MONITOR_TOKEN = 'sim-token-sim-token-sim-token-00';
process.env.TEST_EMAIL = 'monitor-test@example.com';
process.env.TEST_PASSWORD = 'x';

const NOW = Date.now();
const iso = ms => new Date(ms).toISOString();
const ymd = ms => iso(ms).slice(0, 10);
const today = ymd(NOW), D = ymd(NOW - 86400000), Dm1 = ymd(NOW - 2 * 86400000);
const at = (day, hhmm) => `${day}T${hhmm}:00Z`;

const world = {
  servedDay: D,
  pipe: {
    now: iso(NOW), jobsEnabled: true, startedAt: at(Dm1, '03:10'),
    runs: {
      spc: { lastAttempt: iso(NOW - 6 * 60000), lastSuccess: iso(NOW - 6 * 60000), lastError: null, lastResult: { done: 3, failed: 0 } },
      warnings: { lastAttempt: iso(NOW - 2 * 60000), lastSuccess: iso(NOW - 2 * 60000), lastError: null, lastResult: { emails: 0, ok: true, active: 0, newest: null } },
      mesh: { lastAttempt: at(today, '16:25'), lastSuccess: at(today, '16:25'), lastError: null, lastResult: { checkedThrough: D, notReady: null } },
    },
    spc: { convectiveToday: today, coverage: { first: '2024-11-11', last: today, days: 731 }, days: { [today]: { fetchedAt: iso(NOW - 6 * 60000), complete: false, hail: 2, wind: 1, tornado: 0 } } },
    mesh: { expectedThrough: D, coverage: { first: '2021-11-12', last: D, count: 1826 }, recent: [{ date: D, maxIn: 2.25, cells: 48211, cells1in: 9120, cells2in: 310, source: 'aws', ingestedAt: at(today, '13:25:41'.slice(0, 5)) }, { date: Dm1, maxIn: 0, cells: 0, source: 'aws', ingestedAt: at(D, '13:25') }] },
    ncei: { coverage: { firstYear: '2021', lastYear: '2026', end: '2026-07-31' }, years: { 2024: { file: 'x', revision: '20260728', count: 61000, ingestedAt: '2026-08-02T08:04:00Z' }, 2025: { file: 'x', revision: '20260819', count: 59000, ingestedAt: '2026-08-23T08:06:00Z' }, 2026: { file: 'x', revision: '20261026', count: 31000, ingestedAt: '2026-11-01T08:07:00Z' } } },
    hailsig: { coverage: { first: '2021-11-12', last: D, days: 1700 }, days: {} },
    frames: [{ date: '2024-03-14', builtAt: '2026-10-02T15:00:00Z', frames: 24, withCells: 5, errors: 0 }],
  },
};

const xml = keys => `<?xml version="1.0"?><ListBucketResult>${keys.map(k => `<Contents><Key>${k.key}</Key><LastModified>${k.mod}</LastModified></Contents>`).join('')}</ListBucketResult>`;
function s3(prefix) {
  const m = prefix.match(/CONUS\/(MESH_Max_1440min_00\.50|MESH_Max_60min_00\.50)\/(\d{8})\//);
  const day = `${m[2].slice(0, 4)}-${m[2].slice(4, 6)}-${m[2].slice(6, 8)}`;
  const keys = [];
  for (let h = 0; h < 24; h++) {
    const t = Date.parse(at(day, String(h).padStart(2, '0') + ':00')) + 8 * 60000;
    if (t > NOW) break;
    keys.push({ key: `CONUS/${m[1]}/${m[2]}/MRMS_${m[1]}_${m[2]}-${String(h).padStart(2, '0')}0000.grib2.gz`, mod: iso(t) });
  }
  return xml(keys);
}
const spcCsv = { hail: 'Time,Size,Location,County,State,Lat,Lon,Comments\n1840,175,2 S Abilene,Taylor,TX,32.42,-99.73,(SJT)\n1902,050,Merkel,Taylor,TX,32.47,-100.01,(SJT)\n', wind: 'Time,Speed,Location,County,State,Lat,Lon,Comments\n1915,55,Tye,Taylor,TX,32.45,-99.87,(SJT) tree down\n', torn: 'Time,F_Scale,Location,County,State,Lat,Lon,Comments\n' };

function respond(url, init = {}) {
  const u = new URL(url);
  const json = (b, extra = {}) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json', ...extra } });
  if (u.host === 'noaa-mrms-pds.s3.amazonaws.com') return new Response(s3(u.searchParams.get('prefix')), { status: 200 });
  if (u.host === 'www.spc.noaa.gov') { const f = u.pathname.match(/_rpts_(\w+)\.csv/)[1]; return new Response(spcCsv[f], { status: 200, headers: { 'last-modified': new Date(NOW - 40 * 60000).toUTCString() } }); }
  if (u.host === 'www.ncei.noaa.gov' && u.pathname.includes('csvfiles')) return new Response(['2024_c20260728 2026-07-27 21:11', '2025_c20260819 2026-08-19 18:22', '2026_c20261026 2026-10-26 12:57'].map(s => { const [f, d, t] = s.split(' '); return `<a href="StormEvents_details-ftp_v1.0_d${f}.csv.gz">StormEvents_details-ftp_v1.0_d${f}.csv.gz</a> ${d} ${t}  12M`; }).join('\n'), { status: 200 });
  if (u.host === 'www.ncei.noaa.gov') return new Response('ZTIME,WSR_ID,CELL_ID,PROB,SEVPROB,MAXSIZE,LAT,LON\nsummary,0', { status: 200 });
  if (u.host === 'api.weather.gov') return json({ updated: iso(NOW - 60000), features: [] });
  if (u.host === 'mesonet.agron.iastate.edu') return json({ mesh: 0 });
  // StormCheck Pro
  if (u.pathname === '/api/monitor/pipeline') return json(world.pipe);
  if (u.pathname === '/api/auth/login') return json({ success: true }, { 'set-cookie': 'token=sim; Path=/; HttpOnly' });
  if (u.pathname === '/api/mesh/days') return json({ days: [], coverage: { first: '2021-11-12', last: world.servedDay, count: 1826 } });
  if (u.pathname === '/api/mesh/swath') {
    const w = +u.searchParams.get('w'), s = +u.searchParams.get('s');
    const n = u.searchParams.get('date') === world.servedDay && w === -107 && s === 32 ? 48211 : 0; // whole swath sits in one box
    return json({ cells: Array.from({ length: n }, (_, i) => [3300 + Math.floor(i / 500), -10000 + (i % 500), 1.25]) });
  }
  if (u.pathname === '/api/storms') return json({ events: [{ type: 'hail', date: today }, { type: 'wind', date: today }] });
  return new Response('not found', { status: 404 });
}
global.fetch = async (url, init) => respond(String(url), init);

const feeds = require('../src/feeds');
const { Engine } = require('../src/engine');
const workflow = require('../src/workflow');
const coverage = require('../src/coverage');
const config = require('../src/config');

const messages = [];
const engine = new Engine({ notifier: async (text, kind) => { messages.push({ kind, text }); return 'Slack + email'; }, sleep: async () => {} });

async function feedCycle() {
  const run = feeds.runners(async () => world.pipe);
  for (const def of feeds.DEFS) { const { actions } = await engine.run(def, run[def.id]); await engine.notify(actions); }
  engine.state.heartbeat = iso(Date.now());
}

function snapshot(label, { heartbeat } = {}) {
  const s = JSON.parse(JSON.stringify(engine.state));
  const ids = [...feeds.DEFS.map(d => d.id), ...workflow.STEPS.map(x => x.id), 'wf.alert'];
  const data = {
    monitor: { heartbeat: heartbeat || s.heartbeat, expectedEveryMin: 10, intervals: config.intervals, knownStorm: config.knownStorm, alertChannels: ['Slack', 'email'] },
    checks: ids.map(id => s.checks[id]).filter(Boolean),
    incidents: s.incidents.slice().reverse(),
    coverage,
  };
  return { label, env: { now: iso(Date.now()), fetchedAt: iso(Date.now()), overdue: false, data } };
}

(async () => {
  const wf = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  for (const st of workflow.STEPS) {
    const r = wf[st.id];
    engine.record({ ...st, group: 'workflow' }, { status: r.ok ? 'ok' : 'fail', summary: r.detail, problem: r.problem, measure: r.measure, link: `${config.appUrl}/dashboard?address=${encodeURIComponent(config.knownStorm.address)}` });
  }
  engine.record({ id: 'wf.alert', name: 'Saved-property alert email', feature: 'Portfolio hail alerts', group: 'workflow' }, { status: 'setup', problem: 'Built. Needs the test inbox login (TEST_INBOX_IMAP_*) to confirm the alert arrives.' });

  const snaps = {};
  const step = async (key, label, mutate) => { mutate && mutate(); await feedCycle(); snaps[key] = snapshot(label); const m = engine.state.checks['feed.mesh']; console.log(`\n== ${label}: hail swath = ${m.status}${m.retried ? ' (after one retry)' : ''}; failures in a row = ${m.consecutiveFailures}; open incidents = ${engine.state.incidents.filter(i => !i.closedAt).length}`); if (m.problem) console.log('   ' + m.problem); };

  await step('healthy', 'Healthy');
  await step('stale1', 'Map stale · 1st run', () => { world.servedDay = Dm1; });
  await step('incident', 'Incident open', null);
  await step('recovered', 'Recovered', () => { world.servedDay = D; });
  snaps.overdue = snapshot('Monitor overdue', { heartbeat: iso(Date.now() - 47 * 60000) });

  console.log('\n== Alerts sent');
  for (const m of messages) console.log(`--- ${m.kind === 'open' ? 'INCIDENT' : 'RECOVERY'} ---\n${m.text}\n`);
  delete snaps.stale1;
  fs.writeFileSync(process.argv[3], JSON.stringify({ snaps, messages }, null, 1));
})();
