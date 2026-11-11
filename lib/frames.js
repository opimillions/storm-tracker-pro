/**
 * Hourly radar hail frames for animated storm playback.
 *
 * For a convective day, downloads the 24 hourly MESH_Max_60min files once,
 * keeps only cells >= 0.5", and caches them on disk. Requests crop to a bbox.
 */
const fs = require('fs');
const path = require('path');
const { dataPath, ensureDir } = require('./paths');
const { decodeGrib2 } = require('./grib2');
const mrms = require('./mrms-source');

const DIR = () => ensureDir(dataPath('frames'));
const inflight = new Map();

async function buildDay(date) {
  const list = await mrms.listHourlyFrames(date);
  if (!list.length) throw new Error('No hourly radar frames available for this date');
  const frames = [];
  for (const f of list) {
    try {
      const g = decodeGrib2(await mrms.download(f.url), { minValue: 12.7 });
      const northToSouth = !(g.scanMode & 0x40);
      // Flat [latC, lonC, hundredths-of-inch, ...] keeps memory low.
      const cells = new Array(g.index.length * 3);
      for (let k = 0; k < g.index.length; k++) {
        const j = Math.floor(g.index[k] / g.ni), i = g.index[k] - j * g.ni;
        cells[k * 3] = Math.floor((g.la1 + (northToSouth ? -j : j) * g.dj) * 100 + 1e-6);
        cells[k * 3 + 1] = Math.floor((g.lo1 + i * g.di) * 100 + 1e-6);
        cells[k * 3 + 2] = Math.round(g.data[k] / 0.254);
      }
      await new Promise(r => setImmediate(r));
      frames.push({ time: f.time, cells });
    } catch (e) {
      frames.push({ time: f.time, cells: [], error: e.message });
    }
  }
  fs.writeFileSync(path.join(DIR(), date + '.json'), JSON.stringify(frames));
  return frames;
}

async function framesForDay(date) {
  const file = path.join(DIR(), date + '.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!inflight.has(date)) inflight.set(date, buildDay(date).finally(() => inflight.delete(date)));
  return inflight.get(date);
}

async function framesInBBox(date, w, s, e, n) {
  return crop(await framesForDay(date), w, s, e, n);
}

// ── Cached-only access (never triggers downloads) ───────────────────────────
// Public pages read hourly timing only when the day is already on disk, and
// start a one-time background build otherwise, so a page view never waits on
// 24 radar downloads.
const memo = new Map(); // date -> frames, a few recent days
function isCached(date) { return fs.existsSync(path.join(DIR(), date + '.json')); }
function cachedFrames(date) {
  if (memo.has(date)) return memo.get(date);
  if (!isCached(date)) return null;
  let frames;
  try { frames = JSON.parse(fs.readFileSync(path.join(DIR(), date + '.json'), 'utf8')); } catch { return null; }
  memo.set(date, frames);
  while (memo.size > 3) memo.delete(memo.keys().next().value);
  return frames;
}
function cachedInBBox(date, w, s, e, n) {
  const frames = cachedFrames(date);
  return frames ? crop(frames, w, s, e, n) : null;
}
function warm(date) {
  if (isCached(date) || inflight.has(date) || date < '2020-10-15') return false;
  framesForDay(date).catch(e => console.error(`[frames] ${date}: ${e.message}`));
  return true;
}
function building(date) { return inflight.has(date); }

function crop(frames, w, s, e, n) {
  const sC = Math.floor(s * 100), nC = Math.ceil(n * 100), wC = Math.floor(w * 100), eC = Math.ceil(e * 100);
  return frames.map(f => {
    const out = [];
    const c = f.cells;
    if (c.length && Array.isArray(c[0])) { // older cache format
      for (const x of c) if (x[0] >= sC && x[0] <= nC && x[1] >= wC && x[1] <= eC) out.push(x);
    } else {
      for (let k = 0; k < c.length; k += 3) {
        if (c[k] >= sC && c[k] <= nC && c[k + 1] >= wC && c[k + 1] <= eC) out.push([c[k], c[k + 1], c[k + 2] / 100]);
      }
    }
    return { time: f.time, cells: out };
  });
}

module.exports = { framesForDay, framesInBBox, isCached, cachedFrames, cachedInBBox, warm, building };
