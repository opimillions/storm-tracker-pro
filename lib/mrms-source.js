/**
 * Downloads MRMS MESH files.
 *
 * Primary:  NOAA Open Data on AWS (noaa-mrms-pds), available from Oct 2020.
 * Fallback: Iowa Environmental Mesonet MTArchive, back to Oct 2014.
 *
 * Convective day D runs 12Z on D to 12Z on D+1, so its daily maximum is the
 * MESH_Max_1440min file stamped 12:00Z on D+1.
 */
const axios = require('axios');

const AWS = 'https://noaa-mrms-pds.s3.amazonaws.com';
const IEM = 'https://mtarchive.geol.iastate.edu';
const UA = { 'User-Agent': 'StormCheckPro/2.0 (stormcheckpro.thepublicadjustertx.com)' };

const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const addDays = (dateStr, n) => new Date(Date.parse(dateStr + 'T00:00:00Z') + n * 86400000);

async function listAws(prefix) {
  const keys = [];
  let token = null;
  do {
    const params = { 'list-type': 2, prefix, 'max-keys': 1000 };
    if (token) params['continuation-token'] = token;
    const r = await axios.get(`${AWS}/`, { params, timeout: 20000, headers: UA, responseType: 'text' });
    for (const m of r.data.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
    const t = r.data.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    token = t ? t[1] : null;
  } while (token);
  return keys;
}

const timeOfKey = key => {
  const m = key.match(/_(\d{8})-(\d{6})\.grib2/);
  return m ? m[1] + m[2] : null;
};

// Key in `keys` whose timestamp is closest to target 'YYYYMMDDHHMMSS', within maxMin minutes.
function closestKey(keys, target, maxMin = 10) {
  const toMs = s => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14));
  const want = toMs(target);
  let best = null, bestDiff = Infinity;
  for (const k of keys) {
    const t = timeOfKey(k);
    if (!t) continue;
    const diff = Math.abs(toMs(t) - want);
    if (diff < bestDiff) { best = k; bestDiff = diff; }
  }
  return bestDiff <= maxMin * 60000 ? best : null;
}

async function download(url) {
  const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000, headers: UA, maxContentLength: 200e6 });
  return Buffer.from(r.data);
}

/** Daily max MESH for convective day `dateStr` (YYYY-MM-DD). */
async function fetchDailyMesh(dateStr) {
  const next = ymd(addDays(dateStr, 1));
  const product = 'MESH_Max_1440min_00.50';
  const errors = [];
  try {
    const keys = await listAws(`CONUS/${product}/${next}/`);
    const key = closestKey(keys, `${next}120000`);
    if (key) return { buffer: await download(`${AWS}/${key}`), source: 'aws', key };
    errors.push('aws: no 12Z file');
  } catch (e) { errors.push('aws: ' + e.message); }

  try {
    const y = next.slice(0, 4), m = next.slice(4, 6), d = next.slice(6, 8);
    const url = `${IEM}/${y}/${m}/${d}/mrms/ncep/MESH_Max_1440min/MESH_Max_1440min_00.50_${next}-120000.grib2.gz`;
    return { buffer: await download(url), source: 'iem', key: url };
  } catch (e) { errors.push('iem: ' + e.message); }

  throw new Error(`MESH not available for ${dateStr} (${errors.join('; ')})`);
}

/**
 * Hourly MESH_Max_60min files covering convective day `dateStr`
 * (24 frames, 13Z on D through 12Z on D+1). Returns [{ time, url }].
 */
async function listHourlyFrames(dateStr) {
  const d0 = ymd(addDays(dateStr, 0)), d1 = ymd(addDays(dateStr, 1));
  const product = 'MESH_Max_60min_00.50';
  const keys = [
    ...(await listAws(`CONUS/${product}/${d0}/`).catch(() => [])),
    ...(await listAws(`CONUS/${product}/${d1}/`).catch(() => [])),
  ];
  const frames = [];
  for (let h = 13; h <= 36; h++) {
    const day = h < 24 ? d0 : d1;
    const hh = String(h % 24).padStart(2, '0');
    const key = closestKey(keys, `${day}${hh}0000`, 6);
    if (key) frames.push({ time: `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${hh}:00:00Z`, url: `${AWS}/${key}` });
  }
  return frames;
}

module.exports = { fetchDailyMesh, listHourlyFrames, download, _closestKey: closestKey };
