const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-recap-'));
process.env.DATA_JOBS = 'off';
delete process.env.RESEND_API_KEY; delete process.env.SMTP_HOST; delete process.env.BUSINESS_ADDRESS;

const mesh = require('../lib/mesh-store');
const recaps = require('../lib/recaps');
const stormImage = require('../lib/storm-image');
const { parseCsv } = require('../lib/csv');

const DATE = '2025-06-03';
// A 1.75" hail core over Grapevine/Southlake.
(function seed() {
  const ni = 7000, la1 = 54.995, lo1 = -129.995;
  const idx = (lat, lon) => Math.round((la1 - lat) / 0.01) * ni + Math.round((lon - lo1) / 0.01);
  const index = [], data = [];
  for (let a = 0; a < 12; a++) for (let b = 0; b < 20; b++) { index.push(idx(32.90 + a * 0.01, -97.20 + b * 0.01)); data.push(b < 10 ? 44.45 : 31.75); }
  mesh.ingestGrid(DATE, { ni, nj: 3500, la1, lo1, di: 0.01, dj: 0.01, scanMode: 0, index, data });
})();

test('builds a recap only when the area was hit', () => {
  const r = recaps.buildRecap(DATE, 32.94, -97.13, { label: 'Southlake, TX', radiusMi: 25, minIn: 1, unsubUrl: 'https://x/unsub' });
  assert.ok(r, 'recap built');
  assert.match(r.subject, /^Hail hit .+ Jun 3: up to 1\.75"$/);
  assert.match(r.html, /storm-images\/2025-06-03\.png\?b=/);
  assert.match(r.html, /https:\/\/x\/unsub/);
  assert.match(r.html, /utm_source=storm-recap/);
  assert.match(r.text, /Unsubscribe: https:\/\/x\/unsub/);
  assert.strictEqual(r.summary.maxIn, 1.75);
  assert.ok(r.summary.cities.length > 0);

  assert.strictEqual(recaps.buildRecap(DATE, 30.27, -97.74, { label: 'Austin', radiusMi: 25, minIn: 1, unsubUrl: '#' }), null);
  assert.strictEqual(recaps.buildRecap(DATE, 32.94, -97.13, { label: 'x', radiusMi: 25, minIn: 2, unsubUrl: '#' }), null);
});

test('parses a prospect CSV by ZIP or city/state', () => {
  const rows = parseCsv('Email,Name,Company,ZIP,City,State\nbob@roof.co,Bob Smith,Bob Roofing,76092,,\namy@pa.com,Amy Lee,,,Keller,TX\nbad-email,x,,76092,,\nnoloc@x.com,No Loc,,,,\nBOB@roof.co,dupe,,76092,,\n');
  const { prospects, errors } = recaps.parseProspects(rows);
  assert.strictEqual(prospects.length, 2);
  assert.strictEqual(prospects[0].firstName, 'Bob');
  assert.match(prospects[0].label, /Southlake, TX/);
  assert.match(prospects[1].label, /Keller, TX/);
  assert.strictEqual(errors.length, 2);
});

test('sending requires a mailing address, respects unsubscribes and spacing', async () => {
  const db = require('../db');
  const { prospects } = recaps.parseProspects(parseCsv('email,zip\na@roof.co,76092\nb@roof.co,78701\n'));
  await db.prospectOps.upsertMany(prospects);

  let r = await recaps.sendForDate(DATE, db, { manual: true });
  assert.match(r.skipped, /address/);

  recaps.saveSettings({ address: '123 Main St, Southlake, TX 76092', radiusMi: 25, minIn: 1 });
  r = await recaps.sendForDate(DATE, db, { manual: true, dryRun: true });
  assert.strictEqual(r.inArea, 1, 'only the Southlake prospect is in the hit area');

  r = await recaps.sendForDate(DATE, db, { manual: true });
  // No email provider in tests, so the send "fails" but nothing throws.
  assert.strictEqual(r.inArea, 1);

  const a = (await db.prospectOps.all()).find(p => p.email === 'a@roof.co');
  await db.prospectOps.unsubscribe(a.token);
  r = await recaps.sendForDate(DATE, db, { manual: true, dryRun: true });
  assert.strictEqual(r.inArea, 0, 'unsubscribed prospect is skipped');
  const again = await db.prospectOps.upsertMany(prospects);
  assert.strictEqual(again.skipped, 1, 're-import cannot re-add an unsubscribe');

  // Auto-send is off by default and never runs for old days.
  assert.match((await recaps.autoSend(DATE, db)).skipped, /old day/);
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(!recaps.settings().enabled);
  assert.ok((await recaps.sendForDate(today, db)).skipped);
});

test('renders a swath map image without map tiles', async () => {
  const out = await stormImage.render(DATE, [-97.4, 32.8, -96.9, 33.1], { tiles: false, center: { lat: 32.94, lon: -97.13 } });
  assert.ok(out.png.length > 1000);
  assert.strictEqual(out.png.toString('ascii', 1, 4), 'PNG');
  assert.strictEqual(out.cells, 240);
});
