const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-ret-'));
process.env.DATA_JOBS = 'off';
process.env.RETENTION_YEARS = '5';

const retention = require('../lib/retention');
const mesh = require('../lib/mesh-store');
const ncei = require('../lib/ncei-store');
const D = process.env.DATA_DIR;
const now = new Date('2026-10-22T12:00:00Z');
const dayNum = s => Math.round((Date.parse(s + 'T00:00:00Z') - Date.UTC(2000, 0, 1)) / 86400000);
const w = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };

test('cutoff is five years back and respects off', () => {
  assert.strictEqual(retention.cutoffDate(now), '2021-10-22');
  process.env.RETENTION_YEARS = 'off';
  assert.strictEqual(retention.cutoffDate(now), null);
  process.env.RETENTION_YEARS = '5';
  assert.strictEqual(retention.laterDate('2020-10-15', '2021-10-22'), '2021-10-22');
  assert.strictEqual(retention.laterDate('2020-10-15', null), '2020-10-15');
});

test('prune drops old storm data and keeps recent data and user databases', () => {
  const rec = (date, off, mm10) => { const b = Buffer.alloc(6); b.writeUInt16LE(dayNum(date), 0); b.writeUInt16LE(off, 2); b.writeUInt16LE(mm10, 4); return b; };
  w(path.join(D, 'mesh/tiles/32_-98.bin'), Buffer.concat([rec('2021-03-01', 9484, 300), rec('2024-05-28', 9484, 500), rec('2021-03-01', 1, 300)]));
  w(path.join(D, 'mesh/tiles/40_-105.bin'), rec('2020-11-01', 5, 300));
  w(path.join(D, 'mesh/days.json'), JSON.stringify({ '2020-11-01': { tiles: ['40_-105'] }, '2021-03-01': { tiles: ['32_-98'] }, '2024-05-28': { tiles: ['32_-98'], cells: 1 } }));
  w(path.join(D, 'ncei/tiles/32_-98.json'), JSON.stringify([{ id: 'a', date: '1999-04-01', y: 1999 }, { id: 'b', date: '2021-10-01', y: 2021 }, { id: 'c', date: '2021-11-01', y: 2021 }]));
  w(path.join(D, 'ncei/tiles/33_-98.json'), JSON.stringify([{ id: 'd', date: '2010-01-01', y: 2010 }]));
  w(path.join(D, 'ncei/manifest.json'), JSON.stringify({ years: { 1999: {}, 2010: {}, 2021: {}, 2025: {} } }));
  w(path.join(D, 'storm-days/2021-03-01.json'), '{}');
  w(path.join(D, 'storm-days/2024-05-28.json'), '{}');
  w(path.join(D, 'storm-days/_index.json'), JSON.stringify({ '2021-03-01': {}, '2024-05-28': {} }));
  w(path.join(D, 'frames/2019-06-01.json'), '[]');
  w(path.join(D, 'spc/days/2026-10-01.json'), '{}');
  w(path.join(D, 'users.db'), 'keep me');

  const r = retention.prune({ now, log: () => {} });
  assert.strictEqual(r.cutoff, '2021-10-22');

  const tile = fs.readFileSync(path.join(D, 'mesh/tiles/32_-98.bin'));
  assert.strictEqual(tile.length, 6);
  assert.strictEqual(tile.readUInt16LE(0), dayNum('2024-05-28'));
  assert.ok(!fs.existsSync(path.join(D, 'mesh/tiles/40_-105.bin')));
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(D, 'mesh/days.json')))), ['2024-05-28']);

  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(D, 'ncei/tiles/32_-98.json'))).map(e => e.id), ['c']);
  assert.ok(!fs.existsSync(path.join(D, 'ncei/tiles/33_-98.json')));
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(D, 'ncei/manifest.json'))).years), ['2021', '2025']);

  assert.ok(!fs.existsSync(path.join(D, 'storm-days/2021-03-01.json')));
  assert.ok(fs.existsSync(path.join(D, 'storm-days/2024-05-28.json')));
  assert.ok(!fs.existsSync(path.join(D, 'frames/2019-06-01.json')));
  assert.ok(fs.existsSync(path.join(D, 'spc/days/2026-10-01.json')));
  assert.strictEqual(fs.readFileSync(path.join(D, 'users.db'), 'utf8'), 'keep me');

  // Stores read the pruned data after a cache reset.
  mesh._resetCache(); ncei._resetCache();
  assert.deepStrictEqual(mesh.ingestedDays(), ['2024-05-28']);
  assert.strictEqual(ncei.coverage().firstYear, '2021');

  // Second run is a no-op.
  assert.strictEqual(retention.prune({ now, log: () => {} }).freedMB, 0);
});

test('NCEI ingest skips events before minDate', async () => {
  const { Readable } = require('stream');
  const hdr = 'EVENT_ID,EVENT_TYPE,BEGIN_LAT,BEGIN_LON,BEGIN_YEARMONTH,BEGIN_DAY,BEGIN_TIME,CZ_TIMEZONE,STATE,MAGNITUDE';
  const csv = [hdr, '1,Hail,32.9,-97.1,202103,01,1800,CST-6,TEXAS,1.75', '2,Hail,32.9,-97.1,202111,01,1800,CST-6,TEXAS,1.00'].join('\n') + '\n';
  const r = await ncei.ingestYearStream(2021, Readable.from([csv]), {}, { minDate: '2021-10-22' });
  assert.strictEqual(r.count, 1);
});
