const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-mon-'));
process.env.DATA_JOBS = 'off';

const express = require('express');
const http = require('http');
const spc = require('../lib/spc-store');
const mesh = require('../lib/mesh-store');
// A 3x3 patch of hail around a point: real swaths are wider than one cell
// (single cells are dropped as artifacts by the thin-line filter).
const patch = (lat, lon, mm) => {
  const ni = 7000, la1 = 54.995, lo1 = -129.995, index = [], data = [];
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
    index.push(Math.round((la1 - lat - a * 0.01) / 0.01) * ni + Math.round((lon + b * 0.01 - lo1) / 0.01));
    data.push(mm);
  }
  return { index, data };
};
const dataJobs = require('../lib/data-jobs');
const monitorRoutes = require('../monitor-routes');

function serve() {
  const app = express();
  monitorRoutes(app);
  return new Promise(res => { const s = http.createServer(app).listen(0, () => res(s)); });
}
function get(server, headers = {}) {
  return new Promise((res, rej) => {
    http.get({ port: server.address().port, path: '/api/monitor/pipeline', headers }, r => {
      let b = ''; r.on('data', c => (b += c)); r.on('end', () => res({ status: r.statusCode, body: b ? JSON.parse(b) : null }));
    }).on('error', rej);
  });
}

test('pipeline endpoint is hidden without MONITOR_TOKEN and rejects bad tokens', async () => {
  delete process.env.MONITOR_TOKEN;
  const s = await serve();
  try {
    assert.strictEqual((await get(s)).status, 404);
    process.env.MONITOR_TOKEN = 'x'.repeat(32);
    assert.strictEqual((await get(s)).status, 401);
    assert.strictEqual((await get(s, { 'x-monitor-token': 'y'.repeat(32) })).status, 401);
  } finally { s.close(); }
});

test('pipeline endpoint reports imported SPC days, radar days and job runs', async () => {
  process.env.MONITOR_TOKEN = 'k'.repeat(40);
  const today = spc.today();
  spc.saveDay(today, { hail: [{ lat: 33, lon: -97, mag: 1.5 }], wind: [], tornado: [] });
  const ni = 7000, la1 = 54.995, lo1 = -129.995;
  mesh.ingestGrid('2024-03-14', { ni, nj: 3500, la1, lo1, di: 0.01, dj: 0.01, scanMode: 0, ...patch(32.94, -97.13, 44.45) });
  await dataJobs._track('spc', async () => ({ done: 3, failed: 0 }));
  await dataJobs._track('warnings', async () => ({ ok: false, error: 'timeout of 15000ms exceeded' }));
  await assert.rejects(dataJobs._track('mesh', async () => { throw new Error('boom'); }));

  const s = await serve();
  try {
    const { status, body } = await get(s, { 'x-monitor-token': 'k'.repeat(40) });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.spc.days[today].hail, 1);
    assert.ok(body.spc.days[today].fetchedAt);
    assert.strictEqual(body.mesh.coverage.last, '2024-03-14');
    assert.strictEqual(body.mesh.recent[0].cells, 9);
    assert.strictEqual(body.mesh.recent[0].tiles, undefined);
    assert.ok(body.runs.spc.lastSuccess);
    assert.strictEqual(body.runs.warnings.lastError, 'timeout of 15000ms exceeded');
    assert.strictEqual(body.runs.warnings.lastSuccess, undefined);
    assert.strictEqual(body.runs.mesh.lastError, 'boom');
    assert.strictEqual(body.jobsEnabled, false);
  } finally { s.close(); }
});

test('portfolio-match dry run flags a hit property and not a calm day; sends nothing', async () => {
  process.env.MONITOR_TOKEN = 'k'.repeat(40);
  const ni = 7000, la1 = 54.995, lo1 = -129.995;
  mesh.ingestGrid('2024-03-15', { ni, nj: 3500, la1, lo1, di: 0.01, dj: 0.01, scanMode: 0, ...patch(32.94, -97.13, 44.45) });
  const s = await serve();
  const q = (path) => new Promise((res, rej) => http.get({ port: s.address().port, path, headers: { 'x-monitor-token': 'k'.repeat(40) } }, r => { let b = ''; r.on('data', c => (b += c)); r.on('end', () => res({ status: r.statusCode, body: JSON.parse(b) })); }).on('error', rej));
  try {
    const hit = await q('/api/monitor/portfolio-match?date=2024-03-15&lat=32.94&lon=-97.13&min=1');
    assert.strictEqual(hit.status, 200); assert.strictEqual(hit.body.hit, true); assert.strictEqual(hit.body.radarIn, 1.75);
    const calm = await q('/api/monitor/portfolio-match?date=2024-01-10&lat=32.94&lon=-97.13&min=1');
    assert.strictEqual(calm.body.hit, false);
    assert.strictEqual((await q('/api/monitor/portfolio-match?date=bad&lat=1&lon=1')).status, 400);
  } finally { s.close(); }
});

test('checkPortfolio uses the shared rule and the run is recorded for the monitor', async () => {
  const sentTo = [];
  const db = {
    watchlistOps: { getAllWithCoords: async () => [{ _id: 'p1', userId: 'u1', name: 'Hit', lat: 32.94, lon: -97.13 }, { _id: 'p2', userId: 'u1', name: 'Miss', lat: 40, lon: -100 }], markAlerted: async () => {}, updateContact: async () => {} },
    userOps: { findById: async () => ({ email: 'x@example.com' }) },
    alertSettingsOps: { get: async () => ({ minHailSize: 1, alertEmail: false }) },
  };
  dataJobs._setCtx({ db });
  const r = await dataJobs._runPortfolio('2024-03-15', 'radar');
  assert.strictEqual(r.checked, 2); assert.strictEqual(r.hits, 1); assert.strictEqual(r.emails, 0);
  const run = dataJobs.getPortfolioRuns()['2024-03-15'];
  assert.strictEqual(run.hits, 1); assert.ok(run.radarRunAt); assert.strictEqual(run.error, null);
});
