const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-sig-'));
process.env.DATA_JOBS = 'off';

const sig = require('../lib/hailsig-store');

const CSV = `ZTIME,WSR_ID,CELL_ID,PROB,SEVPROB,MAXSIZE,LAT,LON
2025-06-03T22:04:30Z,KFWS,E3,100,80,2.25,32.900,-97.040
2025-06-03T22:10:00Z,KFWS,E3,100,60,1.50,32.950,-97.000
2025-06-03T13:10:00Z,KFWS,Q1,100,5,0.50,32.900,-97.040
2025-06-03T06:00:00Z,KFWS,Z9,100,90,1.75,32.901,-97.041

summary
count,4
`;

test('parses SWDI CSV and drops weak signatures', () => {
  const { rows, headerSeen } = sig.parseCsv(CSV);
  assert.ok(headerSeen);
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[0], { lat: 32.9, lon: -97.04, sev: 80, size: 2.25, minute: 22 * 60 + 4 });
});

test('fetch, store and query by convective day', async () => {
  const empty = 'ZTIME,WSR_ID,CELL_ID,PROB,SEVPROB,MAXSIZE,LAT,LON\n\nsummary\ncount,0\n';
  const http = { get: async (url, { params }) => ({ data: url.includes('20250603:') && params.bbox.startsWith('-98,') ? CSV : empty }) };
  await sig.fetchUtcDay('2025-06-03', { http, pause: 0 });
  assert.ok(!sig.hasConvectiveDay('2025-06-03'), 'needs both UTC days');
  await sig.fetchUtcDay('2025-06-04', { http, pause: 0 });
  assert.ok(sig.hasConvectiveDay('2025-06-03'));

  // 22Z signatures belong to convective day 06-03; the 06Z one to 06-02.
  const s = sig.nearPoint('2025-06-03', 32.9, -97.04, 10);
  assert.strictEqual(s.maxSevProb, 80);
  assert.strictEqual(s.maxSevProbWithin3mi, 80);
  assert.strictEqual(s.maxSizeIn, 2.25);
  assert.strictEqual(s.count, 2);
  assert.strictEqual(s.nearestSevereMi, 0);

  const strict = sig.nearPoint('2025-06-03', 32.9, -97.04, 10, { minProb: 70 });
  assert.strictEqual(strict.count, 1);

  const hist = sig.historyNear(32.9, -97.04, 10, { sinceDate: '2025-01-01' });
  assert.strictEqual(hist.get('2025-06-02').maxSevProb, 90);
  assert.strictEqual(hist.get('2025-06-03').maxSevProb, 80);

  assert.strictEqual(sig.nearPoint('2025-06-03', 40, -80, 10).count, 0);
  assert.strictEqual(sig.nearPoint('2025-07-01', 32.9, -97.04, 10), null);

  // Refetching a day replaces it instead of duplicating.
  await sig.fetchUtcDay('2025-06-03', { http, pause: 0 });
  assert.strictEqual(sig.nearPoint('2025-06-03', 32.9, -97.04, 10).count, 2);

  const r = sig.prune('2025-06-04');
  assert.strictEqual(r.days, 1);
  assert.ok(!sig.hasConvectiveDay('2025-06-03'));
});
