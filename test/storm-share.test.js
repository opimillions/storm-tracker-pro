const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-storm-'));
process.env.DATA_JOBS = 'off';

const mesh = require('../lib/mesh-store');
const spc = require('../lib/spc-store');
const ev = require('../lib/storm-evidence');
const { dataPath, ensureDir } = require('../lib/paths');

const DATE = '2026-04-25';
// A 1.75" core over west Fort Worth (32.73–32.76, -97.36 to -97.33) with 0.6" around it.
(function seed() {
  const ni = 7000, la1 = 54.995, lo1 = -129.995;
  const idx = (lat, lon) => Math.round((la1 - lat) / 0.01) * ni + Math.round((lon - lo1) / 0.01);
  const index = [], data = [];
  for (let a = -2; a < 6; a++) for (let b = -2; b < 6; b++) {
    const core = a >= 0 && a < 4 && b >= 0 && b < 4;
    index.push(idx(32.73 + a * 0.01, -97.36 + b * 0.01)); data.push(core ? 44.45 : 15.24);
  }
  mesh.ingestGrid(DATE, { ni, nj: 3500, la1, lo1, di: 0.01, dj: 0.01, scanMode: 0, index, data });
  // One spotter report 2 miles north-east, at 23:18 UTC; one after midnight UTC.
  fs.writeFileSync(path.join(ensureDir(dataPath('spc', 'days')), DATE + '.json'), JSON.stringify({ complete: true, hail: [
    { id: 'a', type: 'hail', date: DATE, hhmm: '2318', lat: 32.77, lon: -97.32, loc: 'Fort Worth', state: 'TX', mag: 1.5, n: '' },
    { id: 'b', type: 'hail', date: DATE, hhmm: '0105', lat: 32.95, lon: -97.25, loc: 'Keller', state: 'TX', mag: 1.0, n: '' },
  ], wind: [], tornado: [] }));
  spc.loadFromDisk();
})();

test('SPC report times are UTC within the 12Z–12Z storm day', () => {
  assert.strictEqual(ev.spcTimeUtc(DATE, '2318'), '2026-04-25T23:18:00Z');
  assert.strictEqual(ev.spcTimeUtc(DATE, '0105'), '2026-04-26T01:05:00Z');
  assert.strictEqual(ev.spcTimeUtc(DATE, 'xx'), null);
  assert.deepStrictEqual(ev.stormDayPeriod(DATE), { start: '2026-04-25T12:00:00.000Z', end: '2026-04-26T12:00:00.000Z' });
});

test('local time zone follows the place', () => {
  assert.strictEqual(ev.timeZoneFor(32.75, -97.33, 'TX'), 'America/Chicago');
  assert.strictEqual(ev.timeZoneFor(31.76, -106.49, 'TX'), 'America/Denver');
  assert.strictEqual(ev.timeZoneFor(39.74, -104.99, 'CO'), 'America/Denver');
});

test('inside the swath: radar at the property, and the nearby report kept separate with its distance', () => {
  const r = ev.pointEvidence(DATE, 32.745, -97.345);
  assert.strictEqual(r.status, 'in-swath');
  assert.strictEqual(r.radar.inches, 1.75);
  assert.strictEqual(r.radar.kind, 'daily-max');
  assert.deepStrictEqual(r.radar.period, ev.stormDayPeriod(DATE));
  assert.ok(r.nearestReport.distanceMi > 1.5 && r.nearestReport.distanceMi < 3, 'report distance given');
  assert.strictEqual(r.nearestReport.time, '2026-04-25T23:18:00Z');
  assert.strictEqual(r.reportsWithin1mi, 0);
});

test('outside the swath gives the distance to the mapped hail; a missing day is "unavailable", not "no hail"', () => {
  const out = ev.pointEvidence(DATE, 32.70, -97.45);
  assert.strictEqual(out.status, 'outside');
  assert.ok(out.nearestSwathMi && out.nearestSwathMi.miles > 3 && out.nearestSwathMi.miles <= 10);
  const none = ev.pointEvidence('2026-04-20', 32.745, -97.345);
  assert.strictEqual(none.status, 'unavailable');
  assert.strictEqual(none.radar, null);
});

test('hourly radar gives the hour the hail fell at the property', () => {
  const frames = [
    { time: '2026-04-25T23:00:00Z', cells: [[3274, -9735, 0.8]] },
    { time: '2026-04-26T00:00:00Z', cells: [[3274, -9735, 1.7], [3300, -9700, 2.5]] },
    { time: '2026-04-26T01:00:00Z', cells: [] },
  ];
  const h = ev.hourlyPeakAt(frames, 32.745, -97.345);
  assert.strictEqual(h.inches, 1.7);
  assert.strictEqual(h.windowStart, '2026-04-25T23:00:00.000Z');
  assert.strictEqual(h.windowEnd, '2026-04-26T00:00:00Z');
  assert.strictEqual(h.hoursWithHail.length, 2);
  const w = ev.hailWindow(frames);
  assert.strictEqual(w.start, '2026-04-25T22:00:00.000Z');
  assert.strictEqual(w.end, '2026-04-26T00:00:00Z');
  assert.strictEqual(ev.hourlyPeakAt(frames, 33.5, -96.5), null);
});

test('public storm API carries no customer data; the property list needs a session', async () => {
  const express = require('express');
  const app = express();
  const contacts = [{ _id: 'c1', userId: 'u1', name: 'Secret Customer', address: '1 Test St', formattedAddress: '1 TEST ST', lat: 32.745, lon: -97.345, phone: '555' },
    { _id: 'c2', userId: 'u1', name: 'Outside Customer', address: '2 Test St', lat: 32.60, lon: -97.60 }];
  const requireAuth = (req, res, next) => (req.headers.authorization === 'ok' ? (req.user = { _id: 'u1', email: 'u@x' }, next()) : res.status(401).json({ error: 'auth' }));
  require('../storm-share-routes')(app, { requireAuth, db: { watchlistOps: { getForUser: async () => contacts } } });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const pub = await (await fetch(`${base}/api/public/storm/${DATE}?w=-97.6&s=32.5&e=-97.0&n=33.0`)).text();
    assert.ok(!pub.includes('Secret Customer') && !pub.includes('1 Test St'));
    assert.match(pub, /"hasRadar":true/);
    const page = await (await fetch(`${base}/storm/${DATE}?lat=32.745&lon=-97.345&z=12`)).text();
    assert.ok(!page.includes('Secret Customer'));
    assert.match(page, /og:title" content="Hail storm Sat, Apr 25, 2026 near Fort Worth, TX: up to 1\.75&quot;/);
    assert.strictEqual((await fetch(`${base}/api/storm/${DATE}/my-properties`)).status, 401);
    const mine = await (await fetch(`${base}/api/storm/${DATE}/my-properties`, { headers: { authorization: 'ok' } })).json();
    assert.strictEqual(mine.total, 2);
    assert.strictEqual(mine.inside.length, 1);
    assert.strictEqual(mine.inside[0].name, 'Secret Customer');
    assert.strictEqual(mine.inside[0].inches, 1.75);
    assert.strictEqual(mine.outsideCount, 1);
  } finally { server.close(); }
});
