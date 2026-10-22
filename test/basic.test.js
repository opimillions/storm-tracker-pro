const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-test-'));
process.env.DATA_JOBS = 'off';

const { parseCsv } = require('../lib/csv');
const geo = require('../lib/geo');
const mesh = require('../lib/mesh-store');
const ncei = require('../lib/ncei-store');
const { _closestKey } = require('../lib/mrms-source');
const { _pointInPolygon } = require('../lib/alerts');
const { impactScore } = require('../lib/report-engine');

test('csv handles quotes, commas and newlines', () => {
  assert.deepStrictEqual(parseCsv('a,"b,c","d ""e""\nf"\n1,2,3\n'), [['a', 'b,c', 'd "e"\nf'], ['1', '2', '3']]);
});

test('cell and tile math', () => {
  const c = geo.cellOf(32.9485, -97.1524);
  assert.deepStrictEqual(c, { latC: 3294, lonC: -9716 });
  const t = geo.tileOfCell(c.latC, c.lonC);
  assert.strictEqual(t.key, '32_-98');
  assert.strictEqual(t.offset, 94 * 100 + 84);
});

test('radar store ingest and point history', () => {
  const ni = 7000, la1 = 54.995, lo1 = -129.995;
  const idx = (lat, lon) => Math.round((la1 - lat) / 0.01) * ni + Math.round((lon - lo1) / 0.01);
  const index = [], data = [];
  for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) { index.push(idx(32.925 + a * 0.01, -97.175 + b * 0.01)); data.push(44.45); }
  mesh.ingestGrid('2024-05-28', { ni, nj: 3500, la1, lo1, di: 0.01, dj: 0.01, scanMode: 0, index, data });
  const h = mesh.pointHistory(32.9485, -97.1524, 5);
  assert.strictEqual(h[0].date, '2024-05-28');
  assert.strictEqual(h[0].atProperty, 1.75);
  assert.strictEqual(mesh.cellsForDay('2024-05-28', -98, 32, -96, 34).length, 25);
});

test('NCEI timestamps convert to convective day', () => {
  const utc = ncei._toUtc(202405, 28, 1830, 'CST-6');
  assert.strictEqual(utc.toISOString(), '2024-05-29T00:30:00.000Z');
});

test('picks the MRMS file closest to 12Z', () => {
  const keys = ['x_20240529-115800.grib2.gz', 'x_20240529-120036.grib2.gz', 'x_20240529-121000.grib2.gz'];
  assert.strictEqual(_closestKey(keys, '20240529120000'), keys[1]);
  assert.strictEqual(_closestKey(['x_20240529-140000.grib2.gz'], '20240529120000'), null);
});

test('point in warning polygon', () => {
  const ring = [[-98, 32], [-96, 32], [-96, 34], [-98, 34], [-98, 32]];
  assert.ok(_pointInPolygon(33, -97, ring));
  assert.ok(!_pointInPolygon(35, -97, ring));
});

test('impact score rewards verified large hail', () => {
  const d = new Date().toISOString().slice(0, 10);
  const s = impactScore([{ date: d, bestEstimateIn: 1.75, verified: true, groundReports: { nearestTornadoMi: null } }]);
  assert.strictEqual(s, 73);
});
