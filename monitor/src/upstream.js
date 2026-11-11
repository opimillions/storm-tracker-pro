/**
 * What NOAA has published right now, read straight from the same sources the
 * StormCheck Pro importers use.
 */
const UA = 'StormCheckMonitor/1.0 (stormcheckpro.thepublicadjustertx.com)';
const AWS = 'https://noaa-mrms-pds.s3.amazonaws.com';

const SOURCES = {
  spc: 'https://www.spc.noaa.gov/climo/reports/',
  mrmsDaily: `${AWS}/index.html#CONUS/MESH_Max_1440min_00.50/`,
  mrmsHourly: `${AWS}/index.html#CONUS/MESH_Max_60min_00.50/`,
  ncei: 'https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/',
  swdi: 'https://www.ncei.noaa.gov/swdiws/csv/nx3hail',
  nws: 'https://api.weather.gov/alerts/active',
  iem: 'https://mesonet.agron.iastate.edu/json/mrms_rx.py',
};

async function get(url, { timeout = 20000, accept, allow404 = false } = {}) {
  const ctl = AbortSignal.timeout(timeout);
  const r = await fetch(url, { signal: ctl, headers: { 'User-Agent': UA, ...(accept ? { Accept: accept } : {}) } });
  if (r.status === 404 && allow404) return { status: 404, text: '', headers: r.headers };
  if (!r.ok) throw new Error(`${new URL(url).host} answered HTTP ${r.status}`);
  return { status: r.status, text: await r.text(), headers: r.headers };
}

const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const dash = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const addDays = (dateStr, n) => new Date(Date.parse(dateStr + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

// ── SPC preliminary storm reports ───────────────────────────────────────────
function splitCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Rows the app keeps: 7+ columns, numeric lat/lon, not a header line. Mirrors spc-store.parseDay. */
function parseSpc(text, type) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const p = splitCsvLine(line);
    if (p[0] === 'Time' || p.length < 7) continue;
    const lat = parseFloat(p[5]), lon = parseFloat(p[6]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const mag = parseFloat(p[1]);
    rows.push({ type, mag: Number.isFinite(mag) ? mag : null, state: (p[4] || '').trim() });
  }
  return rows;
}

/** One convective day of SPC reports, counted the way /api/storms filters them. */
async function spcDay(date) {
  const yymmdd = date.slice(2).replace(/-/g, '');
  const files = { hail: 'hail', wind: 'wind', tornado: 'torn' };
  const raw = {}, filtered = {};
  let lastModified = null;
  for (const [type, f] of Object.entries(files)) {
    const r = await get(`${SOURCES.spc}${yymmdd}_rpts_${f}.csv`, { allow404: true });
    const rows = r.status === 404 ? [] : parseSpc(r.text, type);
    const lm = r.headers.get('last-modified');
    if (lm && (!lastModified || Date.parse(lm) > Date.parse(lastModified))) lastModified = new Date(lm).toISOString();
    raw[type] = rows.length;
    if (type === 'hail') filtered.hail = rows.filter(x => x.mag != null && x.mag / 100 >= 0.75).length;
    else if (type === 'wind') filtered.wind = rows.filter(x => x.mag > 0 && Math.round(x.mag * 1.151) >= 58).length;
    else filtered.tornado = rows.length;
  }
  return { date, raw, filtered, lastModified };
}

// ── MRMS MESH on NOAA Open Data (AWS) ───────────────────────────────────────
async function listAws(prefix) {
  const keys = [];
  let token = null;
  do {
    const u = new URL(`${AWS}/`);
    u.searchParams.set('list-type', '2'); u.searchParams.set('prefix', prefix); u.searchParams.set('max-keys', '1000');
    if (token) u.searchParams.set('continuation-token', token);
    const { text } = await get(u.toString());
    for (const m of text.matchAll(/<Key>([^<]+)<\/Key>(?:.|\n)*?<LastModified>([^<]+)<\/LastModified>/g)) keys.push({ key: m[1], modified: m[2] });
    const t = text.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    token = t ? t[1] : null;
  } while (token);
  return keys;
}
const keyTime = k => { const m = k.match(/_(\d{8})-(\d{6})\.grib2/); return m ? `${dash(m[1])}T${m[2].slice(0, 2)}:${m[2].slice(2, 4)}:${m[2].slice(4, 6)}Z` : null; };

/**
 * Newest complete daily hail swath: convective day D is the MESH_Max_1440min
 * file stamped 12:00Z on D+1 (same rule as the app's importer).
 */
async function mrmsDaily(now = new Date()) {
  for (let back = 0; back < 3; back++) {
    const fileDay = new Date(now.getTime() - back * 86400000).toISOString().slice(0, 10);
    const keys = await listAws(`CONUS/MESH_Max_1440min_00.50/${ymd(new Date(fileDay + 'T00:00:00Z'))}/`);
    const target = Date.parse(fileDay + 'T12:00:00Z');
    const hit = keys.map(k => ({ ...k, t: keyTime(k.key) })).filter(k => k.t && Math.abs(Date.parse(k.t) - target) <= 10 * 60000)
      .sort((a, b) => Math.abs(Date.parse(a.t) - target) - Math.abs(Date.parse(b.t) - target))[0];
    if (hit) return { convectiveDay: addDays(fileDay, -1), key: hit.key, publishedAt: new Date(hit.modified).toISOString() };
  }
  throw new Error('No 12Z daily hail file found on NOAA Open Data for the last 3 days');
}

/** Newest hourly MESH frame on NOAA Open Data. */
async function mrmsHourly(now = new Date()) {
  for (let back = 0; back < 2; back++) {
    const day = ymd(new Date(now.getTime() - back * 86400000));
    const keys = await listAws(`CONUS/MESH_Max_60min_00.50/${day}/`);
    if (!keys.length) continue;
    const newest = keys.map(k => ({ ...k, t: keyTime(k.key) })).filter(k => k.t).sort((a, b) => (a.t < b.t ? 1 : -1))[0];
    return { validTime: newest.t, publishedAt: new Date(newest.modified).toISOString(), key: newest.key, framesToday: back === 0 ? keys.length : 0 };
  }
  throw new Error('No hourly hail frames on NOAA Open Data today or yesterday');
}

/** Hourly frames present on NOAA for convective day D (13Z D .. 12Z D+1). */
async function mrmsHourlyCount(date) {
  const d0 = ymd(new Date(date + 'T00:00:00Z')), d1 = ymd(new Date(addDays(date, 1) + 'T00:00:00Z'));
  const keys = [...await listAws(`CONUS/MESH_Max_60min_00.50/${d0}/`), ...await listAws(`CONUS/MESH_Max_60min_00.50/${d1}/`)];
  const times = keys.map(k => keyTime(k.key)).filter(Boolean).map(t => Date.parse(t));
  let n = 0;
  for (let h = 13; h <= 36; h++) { // same 24 targets and ±6 min window as the app's listHourlyFrames
    const target = Date.parse(date + 'T00:00:00Z') + h * 3600000;
    if (times.some(t => Math.abs(t - target) <= 6 * 60000)) n++;
  }
  return n;
}

// ── NCEI Storm Events yearly files ──────────────────────────────────────────
async function nceiFiles() {
  const { text } = await get(SOURCES.ncei, { timeout: 30000 });
  const years = {};
  const re = /StormEvents_details-ftp_v1\.0_d(\d{4})_c(\d{8})\.csv\.gz<\/a>\s*([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2})?/g;
  for (const m of text.matchAll(re)) {
    const [, year, revision, modified] = m;
    if (!years[year] || years[year].revision < revision) {
      years[year] = { file: `StormEvents_details-ftp_v1.0_d${year}_c${revision}.csv.gz`, revision, publishedAt: modified ? new Date(modified.replace(' ', 'T') + ':00Z').toISOString() : null };
    }
  }
  return years;
}

// ── NEXRAD hail signatures (SWDI nx3hail) ───────────────────────────────────
async function swdiReachable(date) {
  const day = date.replace(/-/g, '');
  const { text } = await get(`${SOURCES.swdi}/${day}?bbox=-98,23,-93,50&limit=1`, { timeout: 60000 });
  if (!/ZTIME/i.test(text) && !/summary/i.test(text)) throw new Error('SWDI answered without the expected CSV header');
  return true;
}

// ── NWS active warnings ─────────────────────────────────────────────────────
async function nwsWarnings() {
  const u = `${SOURCES.nws}?event=${encodeURIComponent('Severe Thunderstorm Warning,Tornado Warning')}&status=actual`;
  const { text } = await get(u, { accept: 'application/geo+json', timeout: 15000 });
  const j = JSON.parse(text);
  const feats = (j.features || []).filter(f => f.geometry);
  const newest = feats.reduce((m, f) => { const s = f.properties && f.properties.sent; return s && s > m ? s : m; }, null);
  return { active: feats.length, newestSent: newest ? new Date(newest).toISOString() : null, updated: j.updated ? new Date(j.updated).toISOString() : null };
}

async function iemRx() {
  const { text } = await get(`${SOURCES.iem}?lat=32.944&lon=-97.134`, { timeout: 10000 });
  JSON.parse(text);
  return true;
}

module.exports = { SOURCES, spcDay, mrmsDaily, mrmsHourly, mrmsHourlyCount, nceiFiles, swdiReachable, nwsWarnings, iemRx, addDays, _parseSpc: parseSpc };
