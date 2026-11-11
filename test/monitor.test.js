const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-mon-'));
process.env.DATA_JOBS = 'off';

const express = require('express');
const http = require('http');
const spc = require('../lib/spc-store');
const mesh = require('../lib/mesh-store');
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
  mesh.ingestGrid('2024-03-14', { ni, nj: 3500, la1, lo1, di: 0.01, dj: 0.01, scanMode: 0, index: [Math.round((la1 - 32.94) / 0.01) * ni + Math.round((-97.13 - lo1) / 0.01)], data: [44.45] });
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
    assert.strictEqual(body.mesh.recent[0].cells, 1);
    assert.strictEqual(body.mesh.recent[0].tiles, undefined);
    assert.ok(body.runs.spc.lastSuccess);
    assert.strictEqual(body.runs.warnings.lastError, 'timeout of 15000ms exceeded');
    assert.strictEqual(body.runs.warnings.lastSuccess, undefined);
    assert.strictEqual(body.runs.mesh.lastError, 'boom');
    assert.strictEqual(body.jobsEnabled, false);
  } finally { s.close(); }
});
