/**
 * Daily storm summaries built from radar hail cells: max size, area, and the
 * states, cities and ZIP codes hit. They power the public storm pages, the
 * homepage feed and post-storm lead areas.
 */
const fs = require('fs');
const path = require('path');
const { dataPath, ensureDir } = require('./paths');
const mesh = require('./mesh-store');
const spc = require('./spc-store');
const places = require('./places');
const { severity, sizeName } = require('./hail-scale');

const DIR = () => ensureDir(dataPath('storm-days'));
const INDEX = () => dataPath('storm-days', '_index.json');

let indexCache = null;
function index() {
  if (!indexCache) { try { indexCache = JSON.parse(fs.readFileSync(INDEX(), 'utf8')); } catch { indexCache = {}; } }
  return indexCache;
}
function saveIndex() { fs.writeFileSync(INDEX(), JSON.stringify(indexCache)); }

const CONUS = [-130, 20, -60, 55];

function summarize(date) {
  const info = mesh.dayInfo(date);
  if (!info) return null;
  const cells = info.cells ? mesh.cellsForDay(date, ...CONUS) : [];
  const { cities, zips } = places.affectedBy(cells);

  // Area with >= 1" hail, in square miles (0.01° cell ≈ 0.69 mi × 0.69·cos(lat) mi).
  let area1 = 0, area075 = 0;
  for (const [latC, , inches] of cells) {
    const a = 0.69 * 0.69 * Math.cos((latC / 100) * Math.PI / 180);
    if (inches >= 0.75) area075 += a;
    if (inches >= 1) area1 += a;
  }

  const states = new Map();
  for (const c of cities) {
    const s = states.get(c.state) || { state: c.state, name: places.STATE_NAMES[c.state], maxIn: 0, cities: 0 };
    s.maxIn = Math.max(s.maxIn, c.maxIn); s.cities++;
    states.set(c.state, s);
  }
  const reports = spc.reportsForDay(date);
  for (const r of reports.hail) {
    const s = states.get(r.state);
    if (s) s.reports = (s.reports || 0) + 1;
  }

  const maxIn = info.maxIn || 0;
  const summary = {
    date,
    maxIn,
    maxSizeName: maxIn ? sizeName(maxIn) : null,
    severity: severity(maxIn).level,
    areaSqMi1in: Math.round(area1),
    areaSqMi075in: Math.round(area075),
    states: [...states.values()].sort((a, b) => b.maxIn - a.maxIn || b.cities - a.cities),
    cities: cities.slice(0, 400),
    zips,
    groundReports: { hail: reports.hail.length, wind: reports.wind.length, tornado: reports.tornado.length },
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(DIR(), date + '.json'), JSON.stringify(summary));
  index()[date] = {
    maxIn, severity: summary.severity, areaSqMi1in: summary.areaSqMi1in,
    states: summary.states.slice(0, 6).map(s => s.state),
    topCities: summary.cities.slice(0, 3).map(c => `${c.name}, ${c.state}`),
    cityCount: cities.length,
  };
  saveIndex();
  return summary;
}

function get(date) {
  try { return JSON.parse(fs.readFileSync(path.join(DIR(), date + '.json'), 'utf8')); } catch { return null; }
}

/** Recent notable storm days, newest first. */
function recent({ limit = 12, minIn = 1, state = null } = {}) {
  return Object.entries(index())
    .filter(([, v]) => v.maxIn >= minIn && v.cityCount > 0 && (!state || v.states.includes(state)))
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, limit)
    .map(([date, v]) => ({ date, ...v }));
}

function allDates() { return Object.keys(index()).sort().reverse(); }

function _resetCache() { indexCache = null; }

module.exports = { summarize, get, recent, allDates, _resetCache };
