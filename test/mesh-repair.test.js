const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-meshrepair-'));
process.env.DATA_JOBS = 'off';

const mesh = require('../lib/mesh-store');
const { dataPath } = require('../lib/paths');

const grid = cells => {
  const ni = 7000, la1 = 54.995, lo1 = -129.995, index = [], data = [];
  for (const [lat, lon, inches] of cells) { index.push(Math.round((la1 - lat) / 0.01) * ni + Math.round((lon - lo1) / 0.01)); data.push(inches * 25.4); }
  return { ni, nj: 3500, la1, lo1, di: 0.01, dj: 0.01, scanMode: 0, index, data };
};
const TILE = () => path.join(dataPath('mesh', 'tiles'), '28_-98.bin');
const row = lat => [[lat, -97.505, 1.0], [lat, -97.405, 1.75], [lat, -97.305, 2.5]];

test('a cut-short write no longer turns later records into "32 inch" hail', () => {
  mesh.ingestGrid('2026-09-18', grid(row(28.505)));
  // Simulate an interrupted append: 2 stray bytes left at the end of the tile.
  fs.appendFileSync(TILE(), Buffer.from([0x11, 0x22]));
  // Older code then appended the next day straight after them (misaligned).
  const before = fs.readFileSync(TILE());
  mesh.ingestGrid('2026-09-19', grid(row(28.605)));
  const after = fs.readFileSync(TILE());
  assert.strictEqual(after.length % 6, 0, 'torn tail trimmed before appending');
  // Rebuild the legacy damaged file by hand: misaligned day-2 records after the stray bytes.
  fs.writeFileSync(TILE(), Buffer.concat([before, after.subarray(before.length - 2)]));
  mesh._resetCache();

  for (const d of ['2026-09-18', '2026-09-19']) {
    const cells = mesh.cellsForDay(d, -98, 28, -97, 29);
    assert.ok(cells.every(c => c[2] <= 6), `${d}: no impossible sizes (${JSON.stringify(cells)})`);
    assert.deepStrictEqual(cells.map(c => c[2]).sort(), [1, 1.75, 2.5], `${d}: all real cells recovered`);
  }
});

test('repairTiles rewrites the damaged tile cleanly', () => {
  const r = mesh.repairTiles();
  assert.deepStrictEqual(r.fixed, ['28_-98']);
  assert.ok(r.bytesRemoved >= 2);
  assert.strictEqual(fs.statSync(TILE()).size % 6, 0);
  mesh._resetCache();
  assert.strictEqual(mesh.cellsForDay('2026-09-19', -98, 28, -97, 29).length, 3);
  assert.deepStrictEqual(mesh.repairTiles().fixed, [], 'second run finds nothing');
});

test('radar values above 6 inches are not stored', () => {
  mesh.ingestGrid('2026-09-20', grid([[28.705, -97.505, 9.04], [28.705, -97.405, 1.5]]));
  const cells = mesh.cellsForDay('2026-09-20', -98, 28, -97, 29);
  assert.deepStrictEqual(cells.map(c => c[2]), [1.5]);
});
