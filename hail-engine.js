/**
 * Hail Engine — shared lookup logic for the web platform
 * Same SPC data source as HAIL-REPORT-GENERATOR.js
 */
const axios = require('axios');

const MIN_HAIL_SIZE = 0.50; // Match HailRecon — include marble size (0.50") and larger

function getSizeDescription(inches) {
  if (inches >= 4.5) return 'Grapefruit';
  if (inches >= 2.75) return 'Baseball';
  if (inches >= 2.5) return 'Tennis Ball';
  if (inches >= 1.75) return 'Golf Ball';
  if (inches >= 1.5) return 'Ping Pong Ball';
  if (inches >= 1.25) return 'Half Dollar';
  if (inches >= 1.0) return 'Quarter';
  if (inches >= 0.88) return 'Nickel';
  if (inches >= 0.75) return 'Penny';
  if (inches >= 0.5) return 'Marble';
  return 'Pea';
}

function getDistanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

const STATE_ABBR = { alabama:'AL',alaska:'AK',arizona:'AZ',arkansas:'AR',california:'CA',colorado:'CO',connecticut:'CT',delaware:'DE','district of columbia':'DC',florida:'FL',georgia:'GA',hawaii:'HI',idaho:'ID',illinois:'IL',indiana:'IN',iowa:'IA',kansas:'KS',kentucky:'KY',louisiana:'LA',maine:'ME',maryland:'MD',massachusetts:'MA',michigan:'MI',minnesota:'MN',mississippi:'MS',missouri:'MO',montana:'MT',nebraska:'NE',nevada:'NV','new hampshire':'NH','new jersey':'NJ','new mexico':'NM','new york':'NY','north carolina':'NC','north dakota':'ND',ohio:'OH',oklahoma:'OK',oregon:'OR',pennsylvania:'PA','rhode island':'RI','south carolina':'SC','south dakota':'SD',tennessee:'TN',texas:'TX',utah:'UT',vermont:'VT',virginia:'VA',washington:'WA','west virginia':'WV',wisconsin:'WI',wyoming:'WY' };

// Census geocoder first (exact rooftop-ish matches); OpenStreetMap as a fallback
// for addresses Census can't match (new builds, odd formatting, missing ZIP).
async function geocodeAddress(address) {
  const q = String(address || '').replace(/\s+/g, ' ').trim();
  if (!q) return null;
  try {
    const response = await axios.get('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress', {
      params: { address: q, benchmark: 'Public_AR_Current', format: 'json' },
      timeout: 10000
    });
    const matches = response.data.result?.addressMatches || [];
    if (matches.length) {
      const m = matches[0];
      return {
        lat: parseFloat(m.coordinates.y),
        lon: parseFloat(m.coordinates.x),
        formattedAddress: m.matchedAddress,
        state: m.addressComponents.state,
        zip: m.addressComponents.zip,
      };
    }
  } catch (err) { /* fall through */ }
  try {
    const r = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { q, format: 'jsonv2', countrycodes: 'us', addressdetails: 1, limit: 1 },
      headers: { 'User-Agent': 'StormCheckPro/2.0 (stormcheckpro.thepublicadjustertx.com)' },
      timeout: 10000
    });
    const m = (r.data || [])[0];
    if (!m) return null;
    const a = m.address || {};
    const state = STATE_ABBR[String(a.state || '').toLowerCase()] || '';
    const line1 = [a.house_number, a.road].filter(Boolean).join(' ');
    const city = a.city || a.town || a.village || a.hamlet || a.suburb || '';
    return {
      lat: parseFloat(m.lat), lon: parseFloat(m.lon),
      formattedAddress: [line1, city, [state, a.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ').toUpperCase() || q,
      state, zip: a.postcode || '',
    };
  } catch (err) {
    return null;
  }
}

// Event types to fetch from SPC
const EVENT_TYPES = {
  hail:    { file: 'hail',    label: 'Hail',          color: '#c0392b', icon: '🌨️' },
  wind:    { file: 'wind',    label: 'High Wind',      color: '#3498db', icon: '💨' },
  tornado: { file: 'torn',   label: 'Tornado',        color: '#8B0000', icon: '🌪️' },
};

async function fetchSPCEvents(lat, lon, date, eventType = 'hail') {
  const d = new Date(date);
  const yr2 = String(d.getFullYear()).slice(2);
  const mo  = String(d.getMonth() + 1).padStart(2, '0');
  const dy  = String(d.getDate()).padStart(2, '0');
  const fullDate = `${d.getFullYear()}-${mo}-${dy}`;
  const typeDef = EVENT_TYPES[eventType];
  const url = `https://www.spc.noaa.gov/climo/reports/${yr2}${mo}${dy}_rpts_${typeDef.file}.csv`;
  const events = [];

  try {
    const res = await axios.get(url, {
      timeout: 6000,
      headers: { 'User-Agent': 'HailCheckPro/1.0 (hailcheck.thepublicadjustertx.com)' }
    });
    for (const line of res.data.split('\n').slice(1)) {
      if (!line.trim()) continue;
      const p = line.split(',');
      if (p.length < 7) continue;
      const eLat = parseFloat(p[5]), eLon = parseFloat(p[6]);
      if (isNaN(eLat) || isNaN(eLon)) continue;

      // For hail: size in hundredths of inches. For wind: speed in knots. For tornado: F/EF scale.
      const magnitude = parseFloat(p[1]);
      const dist = getDistanceMiles(lat, lon, eLat, eLon);
      if (dist > 30) continue;

      if (eventType === 'hail') {
        const size_in = magnitude / 100;
        if (size_in < MIN_HAIL_SIZE) continue;
        events.push({
          type: 'hail',
          typeLabel: 'Hail',
          icon: '🌨️',
          date: fullDate,
          size_in: Math.round(size_in * 100) / 100,
          size_desc: getSizeDescription(size_in),
          magnitude_label: `${(magnitude/100).toFixed(2)}"`,
          location: [p[2]?.trim(), p[3]?.trim(), p[4]?.trim()].filter(Boolean).join(', '),
          distance_miles: Math.round(dist * 10) / 10,
          state: p[4]?.trim() || '',
          at_property: dist <= 0.5, // only flag as 'at property' if within 0.5 miles
          eLat, eLon,
        });
      } else if (eventType === 'wind') {
        // SPC wind: magnitude in knots (0 = unknown)
        const mph = magnitude > 0 ? Math.round(magnitude * 1.151) : null;
        events.push({
          type: 'wind',
          typeLabel: 'High Wind',
          icon: '💨',
          date: fullDate,
          size_in: 0,
          size_desc: mph ? `${mph} mph` : 'High Wind',
          magnitude_label: mph ? `${mph} mph` : 'Wind Event',
          location: [p[2]?.trim(), p[3]?.trim(), p[4]?.trim()].filter(Boolean).join(', '),
          distance_miles: Math.round(dist * 10) / 10,
          state: p[4]?.trim() || '',
          at_property: dist <= 0.5, // only flag as 'at property' if within 0.5 miles
          comments: p[7]?.trim() || '',
          eLat, eLon,
        });
      } else if (eventType === 'tornado') {
        const fScale = magnitude >= 0 ? `EF${magnitude}` : 'EF?';
        events.push({
          type: 'tornado',
          typeLabel: 'Tornado',
          icon: '🌪️',
          date: fullDate,
          size_in: 0,
          size_desc: fScale,
          magnitude_label: fScale,
          location: [p[2]?.trim(), p[3]?.trim(), p[4]?.trim()].filter(Boolean).join(', '),
          distance_miles: Math.round(dist * 10) / 10,
          state: p[4]?.trim() || '',
          at_property: dist <= 0.5, // only flag as 'at property' if within 0.5 miles
          comments: p[7]?.trim() || '',
          eLat, eLon,
        });
      }
    }
  } catch (e) { /* no events this day */ }
  return events;
}

async function fetchStormHistory(lat, lon, yearsBack = 7, eventTypes = ['hail', 'wind', 'tornado']) {
  const allEvents = [];
  const today = new Date();
  const CONCURRENCY = 30; // fetch 30 dates in parallel at a time

  // Build full list of dates to check:
  // - Last 180 days: check EVERY day (catches recent storms like 4/27)
  // - Older history: check every 3 days (balances coverage vs. speed)
  const dates = [];
  const RECENT_DAYS = 180;
  for (let daysBack = 1; daysBack <= 365 * yearsBack; daysBack++) {
    if (daysBack <= RECENT_DAYS || daysBack % 3 === 0) {
      dates.push(new Date(today.getTime() - daysBack * 86400000));
    }
  }

  // Process in parallel batches
  for (let i = 0; i < dates.length; i += CONCURRENCY) {
    const batch = dates.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.flatMap(checkDate =>
        eventTypes.map(t => fetchSPCEvents(lat, lon, checkDate, t))
      )
    );
    batchResults.flat().forEach(e => allEvents.push(e));
  }

  return allEvents.sort((a, b) => new Date(b.date) - new Date(a.date));
}

// Keep backward compat
async function fetchHailHistory(lat, lon, yearsBack = 7) {
  return fetchStormHistory(lat, lon, yearsBack, ['hail', 'wind', 'tornado']);
}

function getImpactScore(events) {
  if (events.length === 0) return 0;
  let score = 0;
  for (const e of events) {
    const size = e.size_in || 0;
    const dist = e.distance_miles || 30;
    const recency = new Date() - new Date(e.date);
    const yearsFactor = Math.max(0.2, 1 - (recency / (365*24*3600*1000*5)));

    // Distance decay: score drops sharply beyond 1 mile
    // 0-0.5 mi = full credit, 0.5-1 mi = 80%, 1-2 mi = 50%, 2-5 mi = 25%, 5-10 mi = 10%, >10 mi = 5%
    let distFactor;
    if (dist <= 0.5)       distFactor = 1.0;
    else if (dist <= 1.0)  distFactor = 0.8;
    else if (dist <= 2.0)  distFactor = 0.5;
    else if (dist <= 5.0)  distFactor = 0.25;
    else if (dist <= 10.0) distFactor = 0.1;
    else                   distFactor = 0.05;

    score += (size * 25 * distFactor * yearsFactor);
  }
  return Math.min(100, Math.round(score));
}

function getImpactRating(score) {
  // Updated thresholds to match realistic score distribution
  if (score >= 75) return { rating: 'EXTREME', color: '#8B0000', cssClass: 'extreme', desc: 'Direct hit confirmed. Immediate inspection recommended.' };
  if (score >= 50) return { rating: 'HIGH', color: '#c0392b', cssClass: 'high', desc: 'Significant storm activity near property. Inspection strongly recommended.' };
  if (score >= 30) return { rating: 'MODERATE', color: '#e67e22', cssClass: 'moderate', desc: 'Storm activity within 2-5 miles. Inspection may be warranted.' };
  if (score >= 15) return { rating: 'LOW-MODERATE', color: '#f39c12', cssClass: 'low-moderate', desc: 'Some storm activity in the general area.' };
  return { rating: 'LOW', color: '#27ae60', cssClass: 'low', desc: 'Limited storm activity detected near this property.' };
}

/**
 * Street address for a GPS position (phone "use my location").
 * Falls back to the nearest city when no street address is found.
 */
const reverseCache = new Map();
async function reverseGeocode(lat, lon) {
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (reverseCache.has(key)) return reverseCache.get(key);
  let out = null;
  try {
    const r = await axios.get('https://nominatim.openstreetmap.org/reverse', {
      params: { lat, lon, format: 'jsonv2', addressdetails: 1, zoom: 18 },
      headers: { 'User-Agent': 'StormCheckPro/2.0 (stormcheckpro.thepublicadjustertx.com)', 'Accept-Language': 'en-US' },
      timeout: 8000,
    });
    const a = (r.data && r.data.address) || {};
    if (a.country_code && a.country_code !== 'us') return null;
    const state = STATE_ABBR[String(a.state || '').toLowerCase()] || '';
    const line1 = [a.house_number, a.road].filter(Boolean).join(' ');
    const city = a.city || a.town || a.village || a.hamlet || a.suburb || a.county || '';
    const text = [line1, city, [state, a.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ').toUpperCase();
    if (text) out = { address: text, state, zip: a.postcode || '', exact: !!a.house_number };
  } catch (err) { /* fall back below */ }
  if (!out) {
    try {
      const c = require('./lib/places').nearestCity(lat, lon);
      if (c) out = { address: `NEAR ${c.name.toUpperCase()}, ${c.state} (${lat.toFixed(5)}, ${lon.toFixed(5)})`, state: c.state, zip: '', exact: false };
    } catch { /* none */ }
  }
  if (out) { reverseCache.set(key, out); if (reverseCache.size > 5000) reverseCache.clear(); }
  return out;
}

module.exports = { reverseGeocode, geocodeAddress, fetchHailHistory, getImpactScore, getImpactRating, getSizeDescription, getDistanceMiles };
