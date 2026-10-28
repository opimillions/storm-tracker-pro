/**
 * NEXRAD hail signatures: the National Weather Service radar hail algorithm
 * (NSSL Hail Detection Algorithm), run on every radar scan for every storm
 * cell. Each signature has a probability of SEVERE hail (1"+) and a maximum
 * expected hail size at the storm cell's location.
 *
 * Source: NOAA NCEI Severe Weather Data Inventory, dataset "nx3hail".
 *   https://www.ncei.noaa.gov/swdiws/csv/nx3hail/YYYYMMDD:YYYYMMDD?bbox=...
 *
 * Fetched per UTC day and stored in 1° tile files so a property lookup reads
 * only the tiles around it. Record (little-endian, 10 bytes):
 *   uint16 day     UTC day, days since 2000-01-01
 *   uint16 minute  minute of the UTC day
 *   uint16 latOff  thousandths of a degree inside the tile (0..999)
 *   uint16 lonOff
 *   uint8  sevProb probability of severe hail, %
 *   uint8  size    max expected size in 0.05" steps
 * Only signatures with severe probability 10%+ or size 0.75"+ are kept.
 *
 * Convective day D (12Z D to 12Z D+1, the same day the radar swath uses)
 * spans two UTC days.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { dataPath, ensureDir } = require('./paths');
const geo = require('./geo');

const BASE = 'https://www.ncei.noaa.gov/swdiws/csv/nx3hail';
const UA = { 'User-Agent': 'StormCheckPro/2.0 (stormcheckpro.thepublicadjustertx.com)' };
const STRIPS = [[-126, -112], [-112, -104], [-104, -98], [-98, -93], [-93, -87], [-87, -80], [-80, -65]].map(([w, e]) => [w, 23, e, 50]);
const FINAL_AFTER_MS = 3 * 86400000; // NCEI's archive can lag; refetch until 3 days after the day ends
const REC = 10;
const EPOCH = Date.UTC(2000, 0, 1);
const DAY_MS = 86400000;

const ROOT = () => ensureDir(dataPath('hailsig', 'tiles'));
const MANIFEST = () => dataPath('hailsig', 'days.json');
const dayNum = d => Math.round((Date.parse(d + 'T00:00:00Z') - EPOCH) / DAY_MS);
const dayStr = n => new Date(EPOCH + n * DAY_MS).toISOString().slice(0, 10);
const nextDay = d => dayStr(dayNum(d) + 1);
const compact = d => d.replace(/-/g, '');

let manifestCache = null;
function manifest() {
  if (!manifestCache) { try { manifestCache = JSON.parse(fs.readFileSync(MANIFEST(), 'utf8')); } catch { manifestCache = {}; } }
  return manifestCache;
}
function saveManifest() {
  ensureDir(dataPath('hailsig'));
  const tmp = MANIFEST() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(manifestCache));
  fs.renameSync(tmp, MANIFEST());
}

// ── Parse ────────────────────────────────────────────────────────────────────
/** SWDI CSV -> [{lat, lon, sev, size, minute}]. Header: ZTIME,WSR_ID,CELL_ID,PROB,SEVPROB,MAXSIZE,LAT,LON */
function parseCsv(text) {
  const rows = [];
  let cols = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue;
    if (!cols) {
      if (/^ZTIME,/i.test(line)) cols = line.split(',').map(s => s.trim().toUpperCase());
      continue;
    }
    if (/^summary/i.test(line)) break;
    const f = line.split(',');
    if (f.length < cols.length) continue;
    const get = k => f[cols.indexOf(k)];
    const sev = parseInt(get('SEVPROB'), 10);
    const size = parseFloat(get('MAXSIZE'));
    const lat = parseFloat(get('LAT')), lon = parseFloat(get('LON'));
    const t = String(get('ZTIME') || '').match(/T(\d{2}):(\d{2})/);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !t) continue;
    const sevP = Number.isFinite(sev) && sev >= 0 ? Math.min(100, sev) : 0;
    const sz = Number.isFinite(size) && size > 0 ? size : 0;
    if (sevP < 10 && sz < 0.75) continue;
    rows.push({ lat, lon, sev: sevP, size: sz, minute: +t[1] * 60 + +t[2] });
  }
  return { rows, headerSeen: !!cols };
}

// ── Tiles ────────────────────────────────────────────────────────────────────
const tileCache = new Map();
function readTile(key) {
  if (tileCache.has(key)) { const t = tileCache.get(key); tileCache.delete(key); tileCache.set(key, t); return t; }
  let buf;
  try { buf = fs.readFileSync(path.join(ROOT(), key + '.bin')); } catch { buf = Buffer.alloc(0); }
  const [tLat, tLon] = key.split('_').map(Number);
  const t = { key, tLat, tLon, buf, n: Math.floor(buf.length / REC) };
  tileCache.set(key, t);
  while (tileCache.size > 64) tileCache.delete(tileCache.keys().next().value);
  return t;
}
function invalidate(keys) { for (const k of keys) tileCache.delete(k); }

function removeUtcDay(utcDay) {
  const info = manifest()[utcDay];
  if (!info) return;
  const d = dayNum(utcDay);
  for (const key of info.tiles || []) {
    const file = path.join(ROOT(), key + '.bin');
    let buf;
    try { buf = fs.readFileSync(file); } catch { continue; }
    const keep = [];
    for (let o = 0; o + REC <= buf.length; o += REC) if (buf.readUInt16LE(o) !== d) keep.push(buf.subarray(o, o + REC));
    fs.writeFileSync(file, Buffer.concat(keep));
  }
  invalidate(info.tiles || []);
  delete manifest()[utcDay];
}

function storeUtcDay(utcDay, rows, final) {
  removeUtcDay(utcDay);
  const d = dayNum(utcDay);
  const byTile = new Map();
  for (const r of rows) {
    const tLat = Math.floor(r.lat), tLon = Math.floor(r.lon);
    const key = `${tLat}_${tLon}`;
    let arr = byTile.get(key);
    if (!arr) { arr = []; byTile.set(key, arr); }
    arr.push(r, tLat, tLon);
  }
  for (const [key, arr] of byTile) {
    const n = arr.length / 3;
    const buf = Buffer.alloc(n * REC);
    for (let k = 0; k < n; k++) {
      const r = arr[k * 3], tLat = arr[k * 3 + 1], tLon = arr[k * 3 + 2];
      const o = k * REC;
      buf.writeUInt16LE(d, o);
      buf.writeUInt16LE(r.minute, o + 2);
      buf.writeUInt16LE(Math.min(999, Math.max(0, Math.round((r.lat - tLat) * 1000))), o + 4);
      buf.writeUInt16LE(Math.min(999, Math.max(0, Math.round((r.lon - tLon) * 1000))), o + 6);
      buf.writeUInt8(r.sev, o + 8);
      buf.writeUInt8(Math.min(255, Math.round(r.size * 20)), o + 9);
    }
    fs.appendFileSync(path.join(ROOT(), key + '.bin'), buf);
  }
  invalidate(byTile.keys());
  manifest()[utcDay] = { fetchedAt: new Date().toISOString(), final, rows: rows.length, tiles: [...byTile.keys()] };
  saveManifest();
}

// ── Fetch ────────────────────────────────────────────────────────────────────
async function fetchUtcDay(utcDay, { http = axios, pause = 400 } = {}) {
  const rows = [];
  for (const [w, s, e, n] of STRIPS) {
    const r = await http.get(`${BASE}/${compact(utcDay)}:${compact(nextDay(utcDay))}`, {
      params: { bbox: `${w},${s},${e},${n}`, limit: 1000000 },
      timeout: 90000, headers: UA, responseType: 'text', transformResponse: x => x,
    });
    const parsed = parseCsv(r.data);
    if (!parsed.headerSeen && !/count,\s*0/.test(String(r.data))) throw new Error('unexpected response from NCEI');
    for (const row of parsed.rows) rows.push(row);
    if (pause) await new Promise(res => setTimeout(res, pause));
  }
  const final = Date.now() - Date.parse(nextDay(utcDay) + 'T00:00:00Z') > FINAL_AFTER_MS;
  storeUtcDay(utcDay, rows, final);
  return { utcDay, rows: rows.length, final };
}

const hasUtcDay = d => !!manifest()[d];
const hasConvectiveDay = d => hasUtcDay(d) && hasUtcDay(nextDay(d));

/** Make sure both UTC days of convective day `date` are stored (refetches days that aren't final yet). */
async function ensureConvectiveDay(date, opts = {}) {
  const out = [];
  for (const d of [date, nextDay(date)]) {
    const info = manifest()[d];
    if (info && info.final && !opts.force) continue;
    if (info && Date.now() - Date.parse(info.fetchedAt) < 6 * 3600000 && !opts.force) continue;
    if (Date.parse(d + 'T00:00:00Z') > Date.now()) continue;
    out.push(await fetchUtcDay(d, opts));
  }
  return out;
}

// ── Queries ──────────────────────────────────────────────────────────────────
/** Convective day (YYYY-MM-DD) a record belongs to. */
function convDayOf(utcDayNum, minute) { return minute >= 720 ? utcDayNum : utcDayNum - 1; }

/** Visit records in a bbox: fn(convDayNum, lat, lon, sevProb, sizeIn). */
function scan(w, s, e, n, fn, { fromDay = 0, toDay = 65535 } = {}) {
  for (const key of geo.tilesInBBox(w, s, e, n)) {
    const t = readTile(key);
    const b = t.buf;
    for (let o = 0; o + REC <= b.length; o += REC) {
      const d = b.readUInt16LE(o);
      if (d < fromDay || d > toDay) continue;
      const lat = t.tLat + b.readUInt16LE(o + 4) / 1000;
      const lon = t.tLon + b.readUInt16LE(o + 6) / 1000;
      if (lat < s || lat > n || lon < w || lon > e) continue;
      fn(convDayOf(d, b.readUInt16LE(o + 2)), lat, lon, b[o + 8], b[o + 9] / 20);
    }
  }
}

function emptyStats() { return { count: 0, maxSevProb: 0, maxSevProbWithin3mi: 0, maxSizeIn: 0, nearestMi: Infinity, nearestSevereMi: Infinity }; }
function finishStats(r) {
  const r1 = v => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
  return { ...r, nearestMi: r1(r.nearestMi), nearestSevereMi: r1(r.nearestSevereMi) };
}
function bboxAround(lat, lon, mi) {
  const dLat = mi / 69 + 0.01, dLon = mi / (69 * Math.cos(lat * Math.PI / 180)) + 0.01;
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

/**
 * Signatures around a point for every convective day since `sinceDate`.
 * Returns Map(date -> stats). Days with no stored data are absent; use
 * hasConvectiveDay(date) to tell "no signatures" from "not loaded".
 * stats: { count, maxSevProb, maxSevProbWithin3mi, maxSizeIn, nearestMi, nearestSevereMi }
 * (count / nearestMi consider signatures with sevProb >= minProb).
 */
function historyNear(lat, lon, radiusMi = 10, { sinceDate = null, untilDate = null, minProb = 0 } = {}) {
  const out = new Map();
  const fromConv = sinceDate ? dayNum(sinceDate) : 0;
  const toConv = untilDate ? dayNum(untilDate) : 65534;
  scan(...bboxAround(lat, lon, radiusMi), (cd, la, lo, sev, size) => {
    if (cd < fromConv || cd > toConv) return;
    const d = geo.distanceMiles(lat, lon, la, lo);
    if (d > radiusMi) return;
    let r = out.get(cd);
    if (!r) { r = emptyStats(); out.set(cd, r); }
    if (sev > r.maxSevProb) r.maxSevProb = sev;
    if (d <= 3 && sev > r.maxSevProbWithin3mi) r.maxSevProbWithin3mi = sev;
    if (size > r.maxSizeIn) r.maxSizeIn = size;
    if (sev >= 50 && d < r.nearestSevereMi) r.nearestSevereMi = d;
    if (sev >= minProb) { r.count++; if (d < r.nearestMi) r.nearestMi = d; }
  }, { fromDay: fromConv, toDay: toConv + 1 });
  const res = new Map();
  for (const [cd, r] of out) res.set(dayStr(cd), finishStats(r));
  return res;
}

/** Stats around a point for one convective day; null when that day isn't stored. */
function nearPoint(date, lat, lon, radiusMi = 10, { minProb = 0 } = {}) {
  if (!hasConvectiveDay(date)) return null;
  return historyNear(lat, lon, radiusMi, { sinceDate: date, untilDate: date, minProb }).get(date) || finishStats(emptyStats());
}

/** Highest severe probability within `mi` of each point on one day; null when not stored. */
function maxProbNear(date, points, mi = 5) {
  if (!hasConvectiveDay(date)) return null;
  return points.map(p => (historyNear(p.lat, p.lon, mi, { sinceDate: date, untilDate: date }).get(date) || {}).maxSevProb || 0);
}

function coverage() {
  const days = Object.keys(manifest()).sort();
  return { first: days[0] || null, last: days[days.length - 1] || null, days: days.length };
}

/** Delete UTC days older than `cutoff` (YYYY-MM-DD). Returns { days, bytes }. */
function prune(cutoff) {
  const cut = dayNum(cutoff);
  let bytes = 0;
  const root = dataPath('hailsig', 'tiles');
  let files = [];
  try { files = fs.readdirSync(root).filter(f => f.endsWith('.bin')); } catch { files = []; }
  for (const f of files) {
    const file = path.join(root, f);
    let buf;
    try { buf = fs.readFileSync(file); } catch { continue; }
    const keep = [];
    for (let o = 0; o + REC <= buf.length; o += REC) if (buf.readUInt16LE(o) >= cut) keep.push(buf.subarray(o, o + REC));
    const out = Buffer.concat(keep);
    if (out.length === buf.length) continue;
    bytes += buf.length - out.length;
    if (out.length) fs.writeFileSync(file, out, { flag: 'w' }); else fs.unlinkSync(file);
  }
  let days = 0;
  for (const d of Object.keys(manifest())) if (d < cutoff) { delete manifest()[d]; days++; }
  if (days) saveManifest();
  tileCache.clear();
  return { days, bytes };
}

function _resetCache() { manifestCache = null; tileCache.clear(); }

module.exports = {
  parseCsv, fetchUtcDay, storeUtcDay, ensureConvectiveDay, hasConvectiveDay, hasUtcDay,
  historyNear, nearPoint, maxProbNear, scan, coverage, prune, nextDay, _resetCache,
};
