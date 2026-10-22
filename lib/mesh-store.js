/**
 * Radar hail store — NOAA MRMS MESH (Maximum Estimated Size of Hail).
 *
 * One record per 0.01° grid cell per convective day where radar estimated
 * hail >= 0.5". Records live in 1° tile files so an address lookup only
 * reads the few tiles around it.
 *
 * Tile file format (little-endian, 6 bytes per record):
 *   uint16 day      days since 2000-01-01 (convective day: 12Z..12Z)
 *   uint16 offset   (latC % 100) * 100 + (lonC % 100) within the tile
 *   uint16 mm10     estimated max hail diameter in tenths of a millimetre
 */
const fs = require('fs');
const path = require('path');
const { dataPath, ensureDir } = require('./paths');
const geo = require('./geo');

const MIN_MM = 12.7; // 0.5 inch
const REC = 6;
const EPOCH = Date.UTC(2000, 0, 1);
const DAY_MS = 86400000;

const ROOT = () => ensureDir(dataPath('mesh', 'tiles'));
const MANIFEST = () => dataPath('mesh', 'days.json');

function dayNum(dateStr) { return Math.round((Date.parse(dateStr + 'T00:00:00Z') - EPOCH) / DAY_MS); }
function dayStr(n) { return new Date(EPOCH + n * DAY_MS).toISOString().slice(0, 10); }

let manifestCache = null;
function manifest() {
  if (!manifestCache) {
    try { manifestCache = JSON.parse(fs.readFileSync(MANIFEST(), 'utf8')); } catch { manifestCache = {}; }
  }
  return manifestCache;
}
function saveManifest() {
  const tmp = MANIFEST() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(manifestCache));
  fs.renameSync(tmp, MANIFEST());
}

// ── Tile cache (LRU, byte budget) ────────────────────────────────────────────
// Each tile also gets an index from cell offset -> its records, so a point
// query touches only the handful of cells around an address instead of
// scanning every record ever stored in the tile.
const tileCache = new Map();
const CACHE_BYTES = parseInt(process.env.MESH_CACHE_MB || '120', 10) * 1e6;
let cacheBytes = 0;
function readTile(key) {
  if (tileCache.has(key)) {
    const t = tileCache.get(key);
    tileCache.delete(key); tileCache.set(key, t);
    return t;
  }
  const file = path.join(ROOT(), key + '.bin');
  let buf;
  try { buf = fs.readFileSync(file); } catch { buf = Buffer.alloc(0); }
  const n = Math.floor(buf.length / REC);
  const days = new Uint16Array(n), offs = new Uint16Array(n), vals = new Uint16Array(n);
  const start = new Int32Array(10001);
  for (let i = 0; i < n; i++) {
    const o = i * REC;
    days[i] = buf[o] | (buf[o + 1] << 8);
    const off = buf[o + 2] | (buf[o + 3] << 8);
    offs[i] = off;
    vals[i] = buf[o + 4] | (buf[o + 5] << 8);
    if (off < 10000) start[off + 1]++;
  }
  for (let k = 0; k < 10000; k++) start[k + 1] += start[k];
  const fill = start.slice(0, 10000);
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) { const off = offs[i]; if (off < 10000) order[fill[off]++] = i; }
  const [tLat, tLon] = key.split('_').map(Number);
  const t = { key, tLat, tLon, n, days, offs, vals, start, order, bytes: n * 10 + 40004 };
  tileCache.set(key, t);
  cacheBytes += t.bytes;
  while (cacheBytes > CACHE_BYTES && tileCache.size > 1) {
    const oldKey = tileCache.keys().next().value;
    cacheBytes -= tileCache.get(oldKey).bytes;
    tileCache.delete(oldKey);
  }
  return t;
}
function invalidate(keys) { for (const k of keys) { const t = tileCache.get(k); if (t) { cacheBytes -= t.bytes; tileCache.delete(k); } } dayMapCache = null; }

// ── Ingest ───────────────────────────────────────────────────────────────────
function hasDay(dateStr) { return !!manifest()[dateStr]; }
function ingestedDays() { return Object.keys(manifest()).sort(); }
function dayInfo(dateStr) { return manifest()[dateStr] || null; }

/**
 * Store one convective day's decoded MESH grid (from lib/grib2).
 */
function ingestGrid(dateStr, grid, { force = false, source = 'aws' } = {}) {
  if (hasDay(dateStr) && !force) return { skipped: true };
  if (hasDay(dateStr)) removeDay(dateStr);
  const d = dayNum(dateStr);
  const northToSouth = !(grid.scanMode & 0x40);
  const westToEast = !(grid.scanMode & 0x80);
  const byTile = new Map();
  let maxMm = 0, cells = 0, cells1 = 0, cells2 = 0;

  const add = (gridIndex, v) => {
    if (!(v >= MIN_MM)) return;
    const j = Math.floor(gridIndex / grid.ni), i = gridIndex - j * grid.ni;
    const latCenter = grid.la1 + (northToSouth ? -j : j) * grid.dj;
    const lonCenter = grid.lo1 + (westToEast ? i : -i) * grid.di;
    const latC = Math.floor(latCenter * 100 + 1e-6);
    const lonC = Math.floor(lonCenter * 100 + 1e-6);
    const t = geo.tileOfCell(latC, lonC);
    let arr = byTile.get(t.key);
    if (!arr) { arr = []; byTile.set(t.key, arr); }
    arr.push(t.offset, Math.min(65535, Math.round(v * 10)));
    cells++;
    if (v >= 25.4) cells1++;
    if (v >= 50.8) cells2++;
    if (v > maxMm) maxMm = v;
  };
  if (grid.index) {
    for (let k = 0; k < grid.index.length; k++) add(grid.index[k], grid.data[k]);
  } else {
    for (let k = 0; k < grid.values.length; k++) add(k, grid.values[k]);
  }

  for (const [key, arr] of byTile) {
    const n = arr.length / 2;
    const buf = Buffer.alloc(n * REC);
    for (let k = 0; k < n; k++) {
      buf.writeUInt16LE(d, k * REC);
      buf.writeUInt16LE(arr[k * 2], k * REC + 2);
      buf.writeUInt16LE(arr[k * 2 + 1], k * REC + 4);
    }
    fs.appendFileSync(path.join(ROOT(), key + '.bin'), buf);
  }
  invalidate(byTile.keys());

  manifest()[dateStr] = {
    maxIn: geo.mmToIn(maxMm), cells, cells1in: cells1, cells2in: cells2,
    tiles: [...byTile.keys()], source, ingestedAt: new Date().toISOString(),
  };
  saveManifest();
  return { cells, maxIn: geo.mmToIn(maxMm), tiles: byTile.size };
}

function removeDay(dateStr) {
  const info = manifest()[dateStr];
  if (!info) return;
  const d = dayNum(dateStr);
  for (const key of info.tiles || []) {
    const file = path.join(ROOT(), key + '.bin');
    let buf;
    try { buf = fs.readFileSync(file); } catch { continue; }
    const keep = [];
    for (let o = 0; o + REC <= buf.length; o += REC) {
      if (buf.readUInt16LE(o) !== d) keep.push(buf.subarray(o, o + REC));
    }
    fs.writeFileSync(file, Buffer.concat(keep));
  }
  invalidate(info.tiles || []);
  delete manifest()[dateStr];
  saveManifest();
}

// ── Queries ──────────────────────────────────────────────────────────────────
function recordCell(t, i) {
  const off = t.offs[i];
  const latC = t.tLat * 100 + Math.floor(off / 100);
  const lonC = t.tLon * 100 + (off % 100);
  return { latC, lonC };
}

/** All hail cells for one day inside a bbox: [[latC, lonC, inches], ...] */
function cellsForDay(dateStr, w, s, e, n) {
  const d = dayNum(dateStr);
  const info = manifest()[dateStr];
  if (!info || !info.cells) return [];
  const wanted = new Set(geo.tilesInBBox(w, s, e, n));
  const out = [];
  for (const key of info.tiles) {
    if (!wanted.has(key)) continue;
    const t = readTile(key);
    for (let i = 0; i < t.n; i++) {
      if (t.days[i] !== d) continue;
      const { latC, lonC } = recordCell(t, i);
      const lat = latC / 100, lon = lonC / 100;
      if (lat < s - 0.01 || lat > n || lon < w - 0.01 || lon > e) continue;
      out.push([latC, lonC, Math.round(t.vals[i] / 2.54) / 100]);
    }
  }
  return out;
}

/**
 * Radar hail history around a point.
 * Returns [{ date, atProperty, within1mi, within3mi, withinRadius, nearestDistMi }]
 * sizes in inches; atProperty = max over cells within ~0.6 mi of the point
 * (the property's cell and its neighbours, absorbing geocoding error).
 */
function pointHistory(lat, lon, radiusMi = 10, { sinceDate = null } = {}) {
  const sinceDay = sinceDate ? dayNum(sinceDate) : 0;
  const kx = Math.cos(lat * Math.PI / 180);
  const dLat = radiusMi / 69.0 + 0.01, dLon = radiusMi / (69.0 * kx) + 0.01;
  const byDay = new Map();
  for (let latC = Math.floor((lat - dLat) * 100); latC <= Math.floor((lat + dLat) * 100); latC++) {
    const dy = ((latC + 0.5) / 100 - lat) * 69.0;
    if (Math.abs(dy) > radiusMi + 0.5) continue;
    for (let lonC = Math.floor((lon - dLon) * 100); lonC <= Math.floor((lon + dLon) * 100); lonC++) {
      const dx = ((lonC + 0.5) / 100 - lon) * 69.0 * kx;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > radiusMi) continue;
      const tc = geo.tileOfCell(latC, lonC);
      const t = readTile(tc.key);
      if (!t.n) continue;
      for (let k = t.start[tc.offset]; k < t.start[tc.offset + 1]; k++) {
        const i = t.order[k];
        const d = t.days[i];
        if (d < sinceDay) continue;
        const mm10 = t.vals[i];
        let r = byDay.get(d);
        if (!r) { r = { at: 0, w1: 0, w3: 0, wr: 0, nearest: Infinity }; byDay.set(d, r); }
        if (dist <= 0.6 && mm10 > r.at) r.at = mm10;
        if (dist <= 1 && mm10 > r.w1) r.w1 = mm10;
        if (dist <= 3 && mm10 > r.w3) r.w3 = mm10;
        if (mm10 > r.wr) r.wr = mm10;
        if (mm10 >= 254 && dist < r.nearest) r.nearest = dist;
      }
    }
  }
  const toIn = mm10 => Math.round(mm10 / 2.54) / 100;
  return [...byDay.entries()]
    .map(([d, r]) => ({
      date: dayStr(d),
      atProperty: toIn(r.at),
      within1mi: toIn(r.w1),
      within3mi: toIn(r.w3),
      withinRadius: toIn(r.wr),
      nearest1inMi: Number.isFinite(r.nearest) ? Math.round(r.nearest * 10) / 10 : null,
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/**
 * Fast "hail at this property on this day" for checking many properties at
 * once (portfolio alerts). Builds one lookup of the day's cells, then each
 * property is a few map reads. Returns inches (max within ~0.6 mi).
 */
let dayMapCache = null;
function hailAtForDay(dateStr) {
  if (!dayMapCache || dayMapCache.date !== dateStr) {
    const m = new Map();
    for (const [latC, lonC, inches] of cellsForDay(dateStr, -130, 20, -60, 55)) m.set(latC * 100000 + lonC, inches);
    dayMapCache = { date: dateStr, m };
  }
  const m = dayMapCache.m;
  return (lat, lon) => {
    if (!m.size) return 0;
    const c = geo.cellOf(lat, lon);
    let best = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const v = m.get((c.latC + a) * 100000 + c.lonC + b);
      if (v > best) best = v;
    }
    return best;
  };
}

/** Days with radar hail inside a bbox, newest first: [{date, maxIn}] */
function daysInBBox(w, s, e, n, { limit = 120, minIn = 0.75 } = {}) {
  const wanted = new Set(geo.tilesInBBox(w, s, e, n));
  const days = Object.entries(manifest())
    .filter(([, info]) => info.cells && info.tiles.some(k => wanted.has(k)))
    .map(([date]) => date)
    .sort().reverse();
  const out = [];
  for (const date of days) {
    const cells = cellsForDay(date, w, s, e, n);
    if (!cells.length) continue;
    const maxIn = cells.reduce((m, c) => Math.max(m, c[2]), 0);
    if (maxIn < minIn) continue;
    out.push({ date, maxIn, cells: cells.length });
    if (out.length >= limit) break;
  }
  return out;
}

function coverage() {
  const days = ingestedDays();
  return { first: days[0] || null, last: days[days.length - 1] || null, count: days.length };
}

module.exports = {
  MIN_MM, dayNum, dayStr, hasDay, dayInfo, ingestedDays, ingestGrid, removeDay,
  cellsForDay, pointHistory, hailAtForDay, daysInBBox, coverage, _readTile: readTile,
};
