/**
 * NOAA Storm Prediction Center preliminary storm reports (spotter / public /
 * law-enforcement reports). Near real time, so they cover the months NCEI has
 * not published yet, and they drive the live storm feed.
 *
 * Each convective day is cached as one JSON file; the last two years are held
 * in memory, indexed by 1° tile.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { dataPath, ensureDir } = require('./paths');
const { parseCsv } = require('./csv');
const geo = require('./geo');

const UA = { 'User-Agent': 'StormCheckPro/2.0 (stormcheckpro.thepublicadjustertx.com)' };
const DIR = () => ensureDir(dataPath('spc', 'days'));
const KEEP_DAYS = 730;
const FILES = { hail: 'hail', wind: 'wind', tornado: 'torn' };

const days = new Map();   // date -> { hail, wind, tornado, complete }
let tileIndex = null;     // tileKey -> [events]

const ds = d => d.toISOString().slice(0, 10);
const today = () => ds(new Date(Date.now() - 12 * 3600000)); // current convective day

function parseDay(date, type, text) {
  const rows = parseCsv(text);
  const out = [];
  // Each file can contain one header line; SPC files sometimes repeat headers.
  for (const p of rows) {
    if (p[0] === 'Time' || p.length < 7) continue;
    const lat = parseFloat(p[5]), lon = parseFloat(p[6]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const mag = parseFloat(p[1]);
    const ev = {
      id: `S${date.replace(/-/g, '')}${type[0]}${out.length}`,
      type, date, hhmm: p[0], lat, lon,
      loc: [p[2], p[3]].filter(Boolean).join(', '),
      county: (p[3] || '').trim(), state: (p[4] || '').trim(),
      n: p.slice(7).join(',').trim().slice(0, 400), // comments may contain unquoted commas
    };
    if (type === 'hail') ev.mag = Number.isFinite(mag) ? mag / 100 : null;           // hundredths of an inch
    else if (type === 'wind') ev.mag = Number.isFinite(mag) && mag > 0 ? mag : null;  // knots
    else ev.ef = Number.isFinite(mag) && mag >= 0 ? `EF${mag}` : 'EFU';
    out.push(ev);
  }
  return out;
}

async function fetchDay(date) {
  const yymmdd = date.slice(2).replace(/-/g, '');
  const result = { hail: [], wind: [], tornado: [] };
  for (const [type, f] of Object.entries(FILES)) {
    const url = `https://www.spc.noaa.gov/climo/reports/${yymmdd}_rpts_${f}.csv`;
    try {
      const r = await axios.get(url, { timeout: 15000, headers: UA, responseType: 'text' });
      result[type] = parseDay(date, type, r.data);
    } catch (e) {
      if (e.response && e.response.status === 404) continue; // no reports that day
      throw e;
    }
  }
  return result;
}

function saveDay(date, data) {
  const complete = date < ds(new Date(Date.now() - 3 * 86400000));
  const rec = { ...data, complete, fetchedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(DIR(), date + '.json'), JSON.stringify(rec));
  days.set(date, rec);
  tileIndex = null;
}

function loadFromDisk() {
  const cutoff = ds(new Date(Date.now() - KEEP_DAYS * 86400000));
  for (const f of fs.readdirSync(DIR())) {
    const date = f.replace('.json', '');
    if (date < cutoff) continue;
    try { days.set(date, JSON.parse(fs.readFileSync(path.join(DIR(), f), 'utf8'))); } catch { /* skip */ }
  }
  tileIndex = null;
}

function index() {
  if (tileIndex) return tileIndex;
  tileIndex = new Map();
  for (const rec of days.values()) {
    for (const type of ['hail', 'wind', 'tornado']) {
      for (const e of rec[type] || []) {
        const k = geo.tileKey(e.lat, e.lon);
        if (!tileIndex.has(k)) tileIndex.set(k, []);
        tileIndex.get(k).push(e);
      }
    }
  }
  return tileIndex;
}

/** Fill in missing days (and refresh recent ones). */
async function sync({ backDays = KEEP_DAYS, concurrency = 4, log = () => {} } = {}) {
  const todo = [];
  for (let i = 0; i <= backDays; i++) {
    const date = ds(new Date(Date.parse(today() + 'T00:00:00Z') - i * 86400000));
    const have = days.get(date);
    if (!have || !have.complete) todo.push(date);
  }
  let done = 0, failed = 0;
  async function worker() {
    while (todo.length) {
      const date = todo.shift();
      try { saveDay(date, await fetchDay(date)); done++; }
      catch (e) { failed++; log(`SPC ${date}: ${e.message}`); }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { done, failed };
}

function eventsNear(lat, lon, radiusMi = 10, { sinceDate = null, afterDate = null } = {}) {
  const idx = index();
  const out = [];
  for (const k of geo.tilesAround(lat, lon, radiusMi)) {
    for (const e of idx.get(k) || []) {
      if (sinceDate && e.date < sinceDate) continue;
      if (afterDate && e.date <= afterDate) continue;
      const d = geo.distanceMiles(lat, lon, e.lat, e.lon);
      if (d <= radiusMi) out.push({ ...e, distance_miles: Math.round(d * 10) / 10 });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.distance_miles - b.distance_miles));
}

/** All reports for one convective day (optionally filtered by state list). */
function reportsForDay(date, states = null) {
  const rec = days.get(date);
  if (!rec) return { hail: [], wind: [], tornado: [] };
  const f = arr => (states ? arr.filter(e => states.includes(e.state)) : arr);
  return { hail: f(rec.hail || []), wind: f(rec.wind || []), tornado: f(rec.tornado || []) };
}

function recentDays(n = 7) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(ds(new Date(Date.parse(today() + 'T00:00:00Z') - i * 86400000)));
  return out;
}

function coverage() {
  const ks = [...days.keys()].sort();
  return { first: ks[0] || null, last: ks[ks.length - 1] || null, days: ks.length };
}

module.exports = { loadFromDisk, sync, fetchDay, saveDay, eventsNear, reportsForDay, recentDays, today, coverage, _parseDay: parseDay };
