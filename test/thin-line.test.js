/**
 * Thin-line filter: one-cell-thin lines and lone pixels of radar hail are
 * artifacts (e.g. the east-west line near Latham, NY in Oct-Nov 2026) and are
 * left out of maps, summaries and property lookups. Real swaths stay.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-thinline-'));
process.env.DATA_JOBS = 'off';

const mesh = require('../lib/mesh-store');
const stormDays = require('../lib/storm-days');

const ni = 7000, la1 = 54.995, lo1 = -129.995;
const grid = cells => {
  const index = [], data = [];
  for (const [lat, lon, inches] of cells) { index.push(Math.round((la1 - lat) / 0.01) * ni + Math.round((lon - lo1) / 0.01)); data.push(inches * 25.4); }
  return { ni, nj: 3500, la1, lo1, di: 0.01, dj: 0.01, scanMode: 0, index, data };
};

// A real-looking swath near Southlake, TX: 6 rows x 20 columns, 1.75" core.
const swath = [];
for (let a = 0; a < 6; a++) for (let b = 0; b < 20; b++) swath.push([32.905 + a * 0.01, -97.205 + b * 0.01, a === 2 || a === 3 ? 1.75 : 1.0]);
// The artifact: one row of cells near Latham, NY, plus a lone 7" pixel elsewhere.
const line = [];
for (let b = 0; b < 10; b++) line.push([42.745, -73.825 + b * 0.01, b < 3 ? 0.97 : 1.24]);
const lone = [[40.005, -90.005, 5.9]];

test.before(() => {
  mesh.ingestGrid('2026-10-31', grid([...swath, ...line, ...lone]));
});

test('maps keep the swath and drop the thin line and the lone pixel', () => {
  const all = mesh.cellsForDay('2026-10-31', -130, 20, -60, 55);
  assert.strictEqual(all.length, swath.length, 'every swath cell kept, nothing else');
  assert.ok(all.every(c => c[0] < 3300), 'only Texas cells remain');
  assert.strictEqual(mesh._rawCellsForDay('2026-10-31', -130, 20, -60, 55).length, swath.length + line.length + lone.length, 'raw data is untouched');
});

test('cells on the edge of a small map box keep their neighbours', () => {
  // A box whose edge cuts through the middle of the swath.
  const cells = mesh.cellsForDay('2026-10-31', -97.2, 32.93, -97.1, 32.95);
  assert.ok(cells.length > 0);
  // Same box rule as the raw read: cell corners in [s - 0.01, n] x [w - 0.01, e].
  const expected = swath
    .map(([lat, lon]) => [Math.floor(lat * 100 + 1e-6) / 100, Math.floor(lon * 100 + 1e-6) / 100])
    .filter(([lat, lon]) => lat >= 32.92 && lat <= 32.95 && lon >= -97.21 && lon <= -97.1).length;
  assert.strictEqual(cells.length, expected);
});

test('property lookups ignore the artifact and still see real hail', () => {
  const latham = mesh.pointHistory(42.745, -73.8, 3);
  assert.deepStrictEqual(latham, [], 'no hail at a Latham address');
  const southlake = mesh.pointHistory(32.93, -97.15, 3);
  assert.strictEqual(southlake.length, 1);
  assert.strictEqual(southlake[0].atProperty, 1.75);
  const at = mesh.hailAtForDay('2026-10-31');
  assert.strictEqual(at(42.745, -73.8), 0);
  assert.strictEqual(at(32.93, -97.15), 1.75);
});

test('storm summary uses the filtered maximum, not the raw 5.9" pixel', () => {
  const s = stormDays.summarize('2026-10-31');
  assert.strictEqual(s.maxIn, 1.75);
  assert.ok(!s.cities.some(c => c.state === 'NY'), 'Latham is not listed');
});
