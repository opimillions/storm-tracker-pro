/**
 * Census batch geocoder: locates up to BATCH_SIZE addresses per request
 * instead of one request (plus a pause) per address.
 *
 * https://geocoding.geo.census.gov/geocoder/locations/addressbatch
 * Request: multipart form, `addressFile` = CSV rows "id,street,city,state,zip",
 *          `benchmark` = Public_AR_Current.
 * Response: CSV rows "id","input","Match"|"No_Match"|"Tie",
 *           "Exact"|"Non_Exact","matched address","lon,lat","tigerId","side"
 */
const axios = require('axios');
const { parseCsv } = require('./csv');

const URL = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch';
const BATCH_SIZE = 1000;

/** "123 Main St, Fort Worth TX 76110" (or with extra commas) -> parts. */
function splitAddress(address) {
  const s = String(address || '').replace(/\s+/g, ' ').trim();
  const m = s.match(/^(.*?)[,\s]+([A-Za-z]{2})[,\s]+(\d{5})(?:-\d{4})?\s*$/);
  if (!m) return { street: s, city: '', state: '', zip: '' };
  const rest = m[1].replace(/,\s*$/, '');
  const i = rest.lastIndexOf(',');
  if (i === -1) return { street: rest, city: '', state: m[2].toUpperCase(), zip: m[3] };
  return { street: rest.slice(0, i).trim(), city: rest.slice(i + 1).trim(), state: m[2].toUpperCase(), zip: m[3] };
}

const csvCell = v => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v);

/** Census response text -> Map(id -> { lat, lon, formattedAddress, state, zip }) for matches. */
function parseBatchResponse(text) {
  const out = new Map();
  for (const row of parseCsv(String(text || ''))) {
    if (row.length < 6 || row[2] !== 'Match') continue;
    const [lon, lat] = String(row[5]).split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const formattedAddress = row[4];
    const m = formattedAddress.match(/,\s*([A-Z]{2}),\s*(\d{5})\s*$/);
    out.set(String(row[0]).trim(), { lat, lon, formattedAddress, state: m ? m[1] : null, zip: m ? m[2] : '' });
  }
  return out;
}

/**
 * Geocode many addresses. items: [{ id, address }].
 * Returns Map(id -> geo) for the ones Census matched. A failed request
 * leaves its chunk out of the map (callers fall back to single lookups).
 */
async function geocodeBatch(items, { log = () => {}, post = defaultPost } = {}) {
  const found = new Map();
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE);
    const csv = chunk.map(({ id, address }) => {
      const p = splitAddress(address);
      return [id, p.street, p.city, p.state, p.zip].map(csvCell).join(',');
    }).join('\n') + '\n';
    try {
      const text = await post(csv);
      const res = parseBatchResponse(text);
      for (const [id, geo] of res) found.set(id, geo);
      log(`Batch geocode: ${res.size}/${chunk.length} matched`);
    } catch (e) {
      log(`Batch geocode request failed: ${e.message}`);
    }
  }
  return found;
}

async function defaultPost(csv) {
  const form = new FormData();
  form.append('benchmark', 'Public_AR_Current');
  form.append('addressFile', new Blob([csv], { type: 'text/csv' }), 'addresses.csv');
  const r = await axios.post(URL, form, { timeout: 15 * 60 * 1000, responseType: 'text', maxContentLength: 50e6 });
  return r.data;
}

module.exports = { geocodeBatch, splitAddress, parseBatchResponse, BATCH_SIZE };
