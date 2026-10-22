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
      const cells = new Array(g.index.length);
      for (let k = 0; k < g.index.length; k++) {
        const j = Math.floor(g.index[k] / g.ni), i = g.index[k] - j * g.ni;
        const latC = Math.floor((g.la1 + (northToSouth ? -j : j) * g.dj) * 100 + 1e-6);
        const lonC = Math.floor((g.lo1 + i * g.di) * 100 + 1e-6);
        cells[k] = [latC, lonC, Math.round(g.data[k] / 0.254) / 100];
      }
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
  const frames = await framesForDay(date);
  const sC = Math.floor(s * 100), nC = Math.ceil(n * 100), wC = Math.floor(w * 100), eC = Math.ceil(e * 100);
  return frames.map(f => ({
    time: f.time,
    cells: f.cells.filter(([la, lo]) => la >= sC && la <= nC && lo >= wC && lo <= eC),
  }));
}

module.exports = { framesForDay, framesInBBox };
