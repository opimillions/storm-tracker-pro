/**
 * NOAA NCEI Storm Events Database — the official, quality-controlled record of
 * hail, thunderstorm wind and tornado events (with NWS narratives).
 *
 * Bulk yearly CSVs are ingested into 1° tile files so lookups stay local.
 * NCEI lags real time by a few months; SPC reports fill the gap (spc-store).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const axios = require('axios');
const { dataPath, ensureDir } = require('./paths');
const { CsvParser } = require('./csv');
const geo = require('./geo');

const BASE = 'https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/';
const UA = { 'User-Agent': 'StormCheckPro/2.0 (stormcheckpro.thepublicadjustertx.com)' };
const TYPES = { 'Hail': 'hail', 'Thunderstorm Wind': 'wind', 'Tornado': 'tornado' };
const TZ = { EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7, AKST: -9, AKDT: -8, HST: -10, AST: -4, SST: -11, GST: 10, UTC: 0, GMT: 0 };

const ROOT = () => ensureDir(dataPath('ncei', 'tiles'));
const MANIFEST = () => dataPath('ncei', 'manifest.json');

let manifestCache = null;
function manifest() {
  if (!manifestCache) {
    try { manifestCache = JSON.parse(fs.readFileSync(MANIFEST(), 'utf8')); } catch { manifestCache = { years: {} }; }
  }
  return manifestCache;
}
function saveManifest() {
  fs.writeFileSync(MANIFEST() + '.tmp', JSON.stringify(manifestCache));
  fs.renameSync(MANIFEST() + '.tmp', MANIFEST());
}

const tileCache = new Map();
function readTile(key) {
  if (tileCache.has(key)) return tileCache.get(key);
  let events = [];
  try { events = JSON.parse(fs.readFileSync(path.join(ROOT(), key + '.json'), 'utf8')); } catch { /* empty */ }
  tileCache.set(key, events);
  if (tileCache.size > 40) tileCache.delete(tileCache.keys().next().value);
  return events;
}
function writeTile(key, events) {
  const file = path.join(ROOT(), key + '.json');
  if (!events.length) { try { fs.unlinkSync(file); } catch { /* none */ } }
  else fs.writeFileSync(file, JSON.stringify(events));
  tileCache.delete(key);
}

// Convert a local NCEI timestamp to UTC, then to the SPC-style convective day (12Z–12Z).
function toUtc(yearMonth, day, hhmm, tz) {
  const y = +String(yearMonth).slice(0, 4), m = +String(yearMonth).slice(4, 6);
  const t = String(hhmm).padStart(4, '0');
  const mt = String(tz || '').toUpperCase().match(/^([A-Z]+)(?:-(\d+))?/);
  let offset = -6;
  if (mt) offset = mt[2] ? -Number(mt[2]) : (TZ[mt[1]] ?? -6);
  return new Date(Date.UTC(y, m - 1, +day, +t.slice(0, 2), +t.slice(2, 4)) - offset * 3600000);
}
function convectiveDay(utc) { return new Date(utc.getTime() - 12 * 3600000).toISOString().slice(0, 10); }

function normalize(r, year) {
  const type = TYPES[r.EVENT_TYPE];
  if (!type) return null;
  const lat = parseFloat(r.BEGIN_LAT), lon = parseFloat(r.BEGIN_LON);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat === 0) return null;
  const utc = toUtc(r.BEGIN_YEARMONTH, r.BEGIN_DAY, r.BEGIN_TIME, r.CZ_TIMEZONE);
  const lat2 = parseFloat(r.END_LAT), lon2 = parseFloat(r.END_LON);
  const mag = parseFloat(r.MAGNITUDE);
  const loc = [r.BEGIN_LOCATION, r.CZ_NAME].filter(Boolean).map(s => titleCase(s)).join(', ');
  const ev = {
    id: 'N' + r.EVENT_ID,
    y: year,
    type,
    date: convectiveDay(utc),
    time: utc.toISOString(),
    lat: round4(lat), lon: round4(lon),
    mag: Number.isFinite(mag) ? mag : null,
    state: stateAbbr(r.STATE),
    loc,
  };
  if (type === 'tornado') {
    if (Number.isFinite(lat2) && lat2 !== 0) { ev.lat2 = round4(lat2); ev.lon2 = round4(lon2); }
    ev.ef = r.TOR_F_SCALE || null;
    if (r.TOR_LENGTH) ev.lenMi = parseFloat(r.TOR_LENGTH);
    if (r.TOR_WIDTH) ev.widthYd = parseFloat(r.TOR_WIDTH);
  }
  if (type === 'wind' && r.MAGNITUDE_TYPE) ev.magType = r.MAGNITUDE_TYPE;
  if (r.DAMAGE_PROPERTY && r.DAMAGE_PROPERTY !== '0.00K') ev.dmg = r.DAMAGE_PROPERTY;
  if (r.SOURCE) ev.src = r.SOURCE;
  if (r.EVENT_NARRATIVE) ev.n = r.EVENT_NARRATIVE.slice(0, 600);
  return ev;
}
const round4 = v => Math.round(v * 10000) / 10000;
const titleCase = s => s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());

const STATES = { ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', 'DISTRICT OF COLUMBIA': 'DC', FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY', 'PUERTO RICO': 'PR' };
const stateAbbr = s => STATES[String(s || '').toUpperCase()] || String(s || '').slice(0, 2).toUpperCase();

/** Available yearly detail files: { year: { file, revision } } */
async function listRemoteFiles() {
  const r = await axios.get(BASE, { timeout: 30000, headers: UA, responseType: 'text' });
  const files = {};
  for (const m of r.data.matchAll(/StormEvents_details-ftp_v1\.0_d(\d{4})_c(\d{8})\.csv\.gz/g)) {
    const [file, year, rev] = m;
    if (!files[year] || files[year].revision < rev) files[year] = { file, revision: rev };
  }
  return files;
}

/** Ingest one year from a CSV stream (gz or plain). */
async function ingestYearStream(year, stream, meta = {}, { minDate = null } = {}) {
  const byTile = new Map();
  let count = 0, header = null;
  const parser = new CsvParser(row => {
    if (!header) { header = row; return; }
    const r = {};
    for (let i = 0; i < header.length; i++) r[header[i]] = row[i];
    const ev = normalize(r, +year);
    if (!ev || (minDate && ev.date < minDate)) return;
    const key = geo.tileKey(ev.lat, ev.lon);
    if (!byTile.has(key)) byTile.set(key, []);
    byTile.get(key).push(ev);
    count++;
  });
  await new Promise((resolve, reject) => {
    stream.setEncoding('utf8');
    stream.on('data', c => parser.push(c));
    stream.on('end', () => { parser.end(); resolve(); });
    stream.on('error', reject);
  });

  const prevTiles = new Set((manifest().years[year] || {}).tiles || []);
  const allTiles = new Set([...prevTiles, ...byTile.keys()]);
  for (const key of allTiles) {
    const kept = readTile(key).filter(e => e.y !== +year);
    writeTile(key, kept.concat(byTile.get(key) || []));
    await new Promise(r => setImmediate(r)); // let web requests through between tiles
  }
  manifest().years[year] = { ...meta, count, tiles: [...byTile.keys()], ingestedAt: new Date().toISOString() };
  saveManifest();
  return { year, count, tiles: byTile.size };
}

async function ingestYear(year, remote, opts = {}) {
  const info = remote || (await listRemoteFiles())[year];
  if (!info) throw new Error(`No NCEI file for ${year}`);
  const r = await axios.get(BASE + info.file, { responseType: 'stream', timeout: 600000, headers: UA });
  return ingestYearStream(year, r.data.pipe(zlib.createGunzip()), info, opts);
}

/** Bring every year from `fromYear` up to date (new years and revised files). */
async function syncAll({ fromYear = 1996, minDate = null, log = console.log } = {}) {
  const remote = await listRemoteFiles();
  const done = [];
  for (const year of Object.keys(remote).sort()) {
    if (+year < fromYear) continue;
    const have = manifest().years[year];
    if (have && have.revision === remote[year].revision) continue;
    log(`NCEI: ingesting ${year} (${remote[year].file})`);
    done.push(await ingestYear(year, remote[year], { minDate }));
  }
  return done;
}

/** Latest convective day covered by NCEI (events after it come from SPC). */
function coverageEnd() {
  const years = Object.keys(manifest().years).sort();
  if (!years.length) return null;
  const last = manifest().years[years[years.length - 1]];
  // Revision date cYYYYMMDD roughly marks the data cutoff; NCEI publishes ~75 days behind.
  if (last.revision) {
    const r = last.revision;
    const cutoff = new Date(Date.UTC(+r.slice(0, 4), +r.slice(4, 6) - 1, +r.slice(6, 8)) - 75 * 86400000);
    return cutoff.toISOString().slice(0, 10);
  }
  return `${years[years.length - 1]}-12-31`;
}

function coverage() {
  const years = Object.keys(manifest().years).sort();
  return { firstYear: years[0] || null, lastYear: years[years.length - 1] || null, end: coverageEnd() };
}

/** Events within radiusMi of a point, newest first, with distance_miles. */
function eventsNear(lat, lon, radiusMi = 10, { sinceDate = null, untilDate = null } = {}) {
  const out = [];
  for (const key of geo.tilesAround(lat, lon, radiusMi + 15)) {
    for (const e of readTile(key)) {
      if (sinceDate && e.date < sinceDate) continue;
      if (untilDate && e.date > untilDate) continue;
      const d = e.type === 'tornado'
        ? geo.distanceToSegmentMiles(lat, lon, e.lat, e.lon, e.lat2, e.lon2)
        : geo.distanceMiles(lat, lon, e.lat, e.lon);
      if (d <= radiusMi) out.push({ ...e, distance_miles: Math.round(d * 10) / 10 });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.distance_miles - b.distance_miles));
}

function _resetCache() { manifestCache = null; tileCache.clear(); }

module.exports = { listRemoteFiles, ingestYear, ingestYearStream, syncAll, eventsNear, coverage, coverageEnd, _normalize: normalize, _toUtc: toUtc, _resetCache };
