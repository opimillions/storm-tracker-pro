const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), fs = require('fs'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-'));
process.env.RETRY_DELAY_SEC = '0';
process.env.STORMCHECK_URL = 'https://app.test';

const feeds = require('../src/feeds');
const { _parseSpc } = require('../src/upstream');
const { Engine } = require('../src/engine');

const T = s => Date.parse(s);
const pipe = (over = {}) => ({
  jobsEnabled: true,
  runs: { warnings: { lastSuccess: '2026-11-11T16:20:00Z', lastResult: { active: 0, newest: null } }, mesh: {}, spc: {} },
  spc: { convectiveToday: '2026-11-11', days: {} },
  mesh: { coverage: { last: '2026-11-10' }, recent: [{ date: '2026-11-10', cells: 5321, maxIn: 1.5, ingestedAt: '2026-11-11T13:25:40Z' }] },
  ncei: { coverage: { end: '2026-07-31' }, years: {} },
  hailsig: { coverage: {}, days: {} },
  frames: [],
  ...over,
});
const meshUp = { convectiveDay: '2026-11-10', publishedAt: '2026-11-11T12:08:14Z' };

test('hail swath: all three agree → ok', () => {
  const r = feeds.evalMesh({ up: meshUp, pipe: pipe(), served: { lastDay: '2026-11-10', cells: 5321 }, now: T('2026-11-11T16:30:00Z') });
  assert.strictEqual(r.status, 'ok');
});

test('hail swath: imported but map still serves previous file → fail with plain English', () => {
  const r = feeds.evalMesh({ up: meshUp, pipe: pipe(), served: { lastDay: '2026-11-09', cells: null }, now: T('2026-11-11T16:30:00Z') });
  assert.strictEqual(r.status, 'fail');
  assert.strictEqual(r.kind, 'serve');
  assert.match(r.problem, /NOAA has a newer hail file .* imported it, but the hail map is still serving storm day 11-09-2026/);
  assert.match(r.link, /hailmap\?date=2026-11-10/);
});

test('hail swath: imported cells differ from served cells → fail', () => {
  const r = feeds.evalMesh({ up: meshUp, pipe: pipe(), served: { lastDay: '2026-11-10', cells: 4000 }, now: T('2026-11-11T16:30:00Z') });
  assert.strictEqual(r.status, 'fail');
  assert.match(r.problem, /imported 5,321 hail cells .* serves 4,000/);
});

test('hail swath: quiet day with zero cells passes when imported', () => {
  const p = pipe({ mesh: { coverage: { last: '2026-11-10' }, recent: [{ date: '2026-11-10', cells: 0, maxIn: 0, ingestedAt: '2026-11-11T13:25:40Z' }] } });
  const r = feeds.evalMesh({ up: meshUp, pipe: p, served: { lastDay: '2026-11-10', cells: 0 }, now: T('2026-11-11T16:30:00Z') });
  assert.strictEqual(r.status, 'ok');
  assert.match(r.summary, /No hail .* Checked and imported/);
});

test('hail swath: not imported yet is ok before the deadline, fails after it', () => {
  const p = pipe({ mesh: { coverage: { last: '2026-11-09' }, recent: [{ date: '2026-11-09', cells: 10, ingestedAt: '2026-11-10T13:25:00Z' }] } });
  assert.strictEqual(feeds.meshDeadline('2026-11-10', '2026-11-11T12:08:14Z'), '2026-11-11T13:25:00.000Z'.replace('13:25', '14:25'));
  assert.strictEqual(feeds.evalMesh({ up: meshUp, pipe: p, served: { lastDay: '2026-11-09' }, now: T('2026-11-11T13:00:00Z') }).status, 'ok');
  const late = feeds.evalMesh({ up: meshUp, pipe: p, served: { lastDay: '2026-11-09' }, now: T('2026-11-11T14:30:00Z') });
  assert.strictEqual(late.status, 'fail');
  assert.strictEqual(late.kind, 'import');
});

test('SPC: quiet day with zero reports passes when checked recently', () => {
  const p = pipe(); p.spc.days['2026-11-11'] = { fetchedAt: '2026-11-11T16:15:02Z', hail: 0, wind: 0, tornado: 0 };
  const r = feeds.evalSpc({ up: { date: '2026-11-11', raw: { hail: 0, wind: 0, tornado: 0 }, filtered: { hail: 0, wind: 0, tornado: 0 }, lastModified: null }, pipe: p, served: { byType: { hail: 0, wind: 0, tornado: 0 } }, now: T('2026-11-11T16:30:00Z') });
  assert.strictEqual(r.status, 'ok');
  assert.match(r.summary, /No storm reports yet/);
});

test('SPC: stale import fails; storm list mismatch fails', () => {
  const p = pipe(); p.spc.days['2026-11-11'] = { fetchedAt: '2026-11-11T15:00:00Z', hail: 3, wind: 1, tornado: 0 };
  const up = { date: '2026-11-11', raw: { hail: 3, wind: 1, tornado: 0 }, filtered: { hail: 2, wind: 1, tornado: 0 }, lastModified: '2026-11-11T14:50:00Z' };
  assert.strictEqual(feeds.evalSpc({ up, pipe: p, served: { byType: { hail: 2, wind: 1, tornado: 0 } }, now: T('2026-11-11T16:30:00Z') }).status, 'fail');
  p.spc.days['2026-11-11'].fetchedAt = '2026-11-11T16:15:00Z';
  const r = feeds.evalSpc({ up, pipe: p, served: { byType: { hail: 1, wind: 1, tornado: 0 } }, now: T('2026-11-11T16:30:00Z') });
  assert.strictEqual(r.kind, 'serve');
  assert.match(r.problem, /SPC lists 2 hail .* storm list shows 1 hail/);
});

test('SPC parser mirrors the app (header, short rows, quoted commas)', () => {
  const csv = 'Time,Size,Location,County,State,Lat,Lon,Comments\n2010,175,3 N Keller,Tarrant,TX,32.97,-97.25,"golf ball, roof damage"\nbad,row\n2015,075,Southlake,Tarrant,TX,32.94,-97.13,\n';
  const rows = _parseSpc(csv, 'hail');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].mag, 175);
});

test('NCEI: newer NOAA revision older than 8 days fails; newer one this week is ok', () => {
  const p = pipe({ ncei: { coverage: { end: '2026-07-31' }, years: { 2026: { revision: '20260819', ingestedAt: '2026-08-23T08:05:00Z' } } } });
  const up = { 2026: { revision: '20261026', publishedAt: '2026-10-26T12:57:00Z' } };
  assert.strictEqual(feeds.evalNcei({ up, pipe: p, now: T('2026-11-11T16:00:00Z') }).status, 'fail');
  assert.strictEqual(feeds.evalNcei({ up, pipe: p, now: T('2026-10-29T16:00:00Z') }).status, 'ok');
});

test('NWS: zero active warnings and a recent poll pass; a stale poll fails', () => {
  const up = { active: 0, newestSent: null, updated: '2026-11-11T16:29:00Z' };
  assert.strictEqual(feeds.evalNws({ up, pipe: pipe(), now: T('2026-11-11T16:30:00Z') }).status, 'ok');
  assert.strictEqual(feeds.evalNws({ up, pipe: pipe(), now: T('2026-11-11T17:30:00Z') }).status, 'fail');
});

test('Playback: day cached before NOAA finished posting frames fails', () => {
  const p = pipe({ frames: [{ date: '2026-11-10', builtAt: '2026-11-10T22:00:00Z', frames: 9, withCells: 4, errors: 0 }] });
  const r = feeds.evalFrames({ up: { validTime: '2026-11-11T16:00:00Z', publishedAt: '2026-11-11T16:04:00Z' }, pipe: p, counts: { '2026-11-10': 24 }, now: T('2026-11-11T16:30:00Z') });
  assert.strictEqual(r.status, 'fail');
  assert.match(r.problem, /only posted 9 of its 24/);
});

test('engine: retry once, incident on 2nd failed run, one incident only, recovery', async () => {
  const sent = [];
  const e = new Engine({ notifier: async (text, kind) => { sent.push([kind, text]); return 'test'; }, sleep: async () => {} });
  const def = { id: 'feed.x', name: 'X feed', feature: 'Hail map' };
  let calls = 0, mode = 'fail';
  const fn = async () => { calls++; return mode === 'fail' ? { status: 'fail', problem: 'broken', link: 'https://app.test/x' } : { status: 'ok', summary: 'fine' }; };

  let out = await e.run(def, fn); await e.notify(out.actions);
  assert.strictEqual(calls, 2, 'retried once');
  assert.strictEqual(e.state.incidents.length, 0, 'no incident after first failed run');
  out = await e.run(def, fn); await e.notify(out.actions);
  assert.strictEqual(e.state.incidents.length, 1);
  out = await e.run(def, fn); await e.notify(out.actions);
  assert.strictEqual(e.state.incidents.length, 1, 'still one incident');
  assert.strictEqual(sent.filter(s => s[0] === 'open').length, 1);
  mode = 'ok';
  out = await e.run(def, fn); await e.notify(out.actions);
  assert.ok(e.state.incidents[0].closedAt);
  assert.strictEqual(sent.filter(s => s[0] === 'recover').length, 1);
  assert.match(sent[0][1], /broken\nAffected: Hail map\nInspect: https:\/\/app.test\/x/);
});

test('engine: a failure that passes on retry never counts toward an incident', async () => {
  const e = new Engine({ notifier: async () => 'x', sleep: async () => {} });
  let n = 0;
  for (let i = 0; i < 3; i++) await e.run({ id: 'feed.flaky', name: 'F', feature: 'f' }, async () => (++n % 2 ? { status: 'fail', problem: 'blip' } : { status: 'ok' }));
  assert.strictEqual(e.state.checks['feed.flaky'].consecutiveFailures, 0);
  assert.strictEqual(e.state.checks['feed.flaky'].note, 'Passed on retry');
  assert.strictEqual(e.state.incidents.filter(i => i.checkId === 'feed.flaky').length, 0);
});
