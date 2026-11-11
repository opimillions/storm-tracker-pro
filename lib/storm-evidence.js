/**
 * What the data says happened at one address on one storm day, with every
 * number tied to its source and the time span that source actually covers.
 *
 * Sources and the precision each supports:
 *   - Daily radar (NOAA MRMS MESH, 24-hour max): a size, but only "sometime
 *     between 12Z on the storm day and 12Z the next day".
 *   - Hourly radar (MRMS MESH 60-minute max, the playback frames): the size
 *     in each one-hour window, so the hour the hail fell.
 *   - Ground reports (NOAA SPC preliminary reports, or NCEI Storm Events for
 *     older dates): a reported size at a point, to the minute.
 *
 * A radar estimate at the property and a ground report nearby are kept apart:
 * a report two miles away is shown with its distance, never as hail "at" the
 * address.
 */
const mesh = require('./mesh-store');
const spc = require('./spc-store');
const ncei = require('./ncei-store');
const geo = require('./geo');
const places = require('./places');
const { sizeName } = require('./hail-scale');

// The swath drawn on public maps starts at 0.75" (penny); the same threshold
// decides "inside the mapped swath" so the map and the wording always agree.
const SWATH_MIN_IN = 0.75;
const NEAR_REPORT_MI = 10;
const round2 = v => Math.round(v * 100) / 100;

/** The NOAA storm day: 12:00 UTC on `date` to 12:00 UTC the next day. */
function stormDayPeriod(date) {
  const start = new Date(Date.parse(date + 'T12:00:00Z'));
  return { start: start.toISOString(), end: new Date(start.getTime() + 86400000).toISOString() };
}

/** SPC report times are UTC HHMM within the 12Z–12Z storm day. */
function spcTimeUtc(date, hhmm) {
  const t = String(hhmm || '').padStart(4, '0');
  if (!/^\d{4}$/.test(t)) return null;
  const h = +t.slice(0, 2), m = +t.slice(2, 4);
  if (h > 23 || m > 59) return null;
  const day = h >= 12 ? date : new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  return `${day}T${t.slice(0, 2)}:${t.slice(2, 4)}:00Z`;
}

// ── Time zone of a place (for "local time" wording) ─────────────────────────
const STATE_TZ = {
  CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York',
  IN: 'America/Indiana/Indianapolis', KY: 'America/New_York', ME: 'America/New_York', MD: 'America/New_York',
  MA: 'America/New_York', MI: 'America/Detroit', NH: 'America/New_York', NJ: 'America/New_York', NY: 'America/New_York',
  NC: 'America/New_York', OH: 'America/New_York', PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York',
  VT: 'America/New_York', VA: 'America/New_York', WV: 'America/New_York',
  AL: 'America/Chicago', AR: 'America/Chicago', IL: 'America/Chicago', IA: 'America/Chicago', KS: 'America/Chicago',
  LA: 'America/Chicago', MN: 'America/Chicago', MS: 'America/Chicago', MO: 'America/Chicago', NE: 'America/Chicago',
  ND: 'America/Chicago', OK: 'America/Chicago', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago', WI: 'America/Chicago',
  AZ: 'America/Phoenix', CO: 'America/Denver', ID: 'America/Boise', MT: 'America/Denver', NM: 'America/Denver',
  UT: 'America/Denver', WY: 'America/Denver',
  CA: 'America/Los_Angeles', NV: 'America/Los_Angeles', OR: 'America/Los_Angeles', WA: 'America/Los_Angeles',
  AK: 'America/Anchorage', HI: 'Pacific/Honolulu', PR: 'America/Puerto_Rico',
};
// Parts of states that keep a different clock from the rest of the state.
function timeZoneFor(lat, lon, state) {
  if (state === 'TX' && lon < -104.9) return 'America/Denver';        // El Paso, Hudspeth
  if ((state === 'KS' || state === 'NE') && lon < -101.5) return 'America/Denver';
  if ((state === 'ND' || state === 'SD') && lon < -101) return 'America/Denver';
  if (state === 'FL' && lon < -85.2) return 'America/Chicago';         // western panhandle
  if (state === 'OR' && lat < 44.5 && lon > -118) return 'America/Boise';
  return STATE_TZ[state] || 'America/Chicago';
}

/** The place a map view is "near": the closest sizable city, for headings. */
function placeNear(lat, lon) {
  const big = places.citiesNear(lat, lon, 20).filter(c => c.pop >= 20000);
  const best = big.length
    ? big.reduce((m, c) => (geo.distanceMiles(lat, lon, c.lat, c.lon) < geo.distanceMiles(lat, lon, m.lat, m.lon) ? c : m))
    : places.nearestCity(lat, lon);
  if (!best) return null;
  return { name: best.name, state: best.state, slug: best.slug, lat: best.lat, lon: best.lon, tz: timeZoneFor(lat, lon, best.state) };
}

// ── Ground reports ───────────────────────────────────────────────────────────
/** Hail reports for one storm day within `radiusMi` of a point, nearest first. */
function groundHailNear(date, lat, lon, radiusMi = NEAR_REPORT_MI) {
  const day = spc.reportsForDay(date);
  let list = (day.hail || []).map(e => ({
    sizeIn: e.mag, lat: e.lat, lon: e.lon, loc: e.loc, state: e.state,
    time: spcTimeUtc(date, e.hhmm), remarks: e.n || '',
    source: 'NOAA SPC preliminary storm report',
  }));
  if (!list.length) {
    // Older storm days: official NCEI Storm Events (times converted to UTC on ingest).
    list = ncei.eventsNear(lat, lon, radiusMi, { sinceDate: date, untilDate: date })
      .filter(e => e.type === 'hail' && e.date === date)
      .map(e => ({ sizeIn: e.mag, lat: e.lat, lon: e.lon, loc: e.loc, state: e.state, time: e.time || null, remarks: e.n || '', source: 'NOAA NCEI Storm Events' }));
  }
  return list
    .map(r => ({ ...r, distanceMi: Math.round(geo.distanceMiles(lat, lon, r.lat, r.lon) * 10) / 10, bearing: bearing(lat, lon, r.lat, r.lon) }))
    .filter(r => r.distanceMi <= radiusMi && r.sizeIn > 0)
    .sort((a, b) => a.distanceMi - b.distanceMi);
}

function bearing(lat1, lon1, lat2, lon2) {
  const dx = (lon2 - lon1) * Math.cos(lat1 * Math.PI / 180), dy = lat2 - lat1;
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return '';
  const deg = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
}

// ── Hourly radar at a point (from cached playback frames) ───────────────────
/**
 * frames: [{ time, cells: [[latC, lonC, inches], ...] }] where `time` ends a
 * 60-minute window. Returns the window with the largest estimate at the point
 * (same ~0.6 mi neighbourhood as the daily value), or null.
 */
function hourlyPeakAt(frames, lat, lon) {
  if (!frames || !frames.length) return null;
  return hourlyLookup(frames)(lat, lon);
}

/**
 * Index a frame set once, then look up many points (portfolio checks).
 * Returns fn(lat, lon) -> hourly peak (see hourlyPeakAt) or null.
 */
function hourlyLookup(frames) {
  const maps = (frames || []).map(f => {
    const m = new Map();
    for (const x of f.cells) m.set(x[0] * 100000 + x[1], x[2]);
    return { time: f.time, m };
  });
  return (lat, lon) => peakFromMaps(maps, lat, lon);
}

function peakFromMaps(maps, lat, lon) {
  const c = geo.cellOf(lat, lon);
  let best = null;
  const hours = [];
  for (const f of maps) {
    if (!f.m.size) continue;
    let v = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const x = f.m.get((c.latC + a) * 100000 + c.lonC + b);
      if (x > v) v = x;
    }
    if (v >= 0.5) hours.push({ end: f.time, inches: round2(v) });
    if (v > 0 && (!best || v > best.inches)) best = { end: f.time, inches: round2(v) };
  }
  if (!best) return null;
  return {
    inches: best.inches,
    windowStart: new Date(Date.parse(best.end) - 3600000).toISOString(),
    windowEnd: best.end,
    hoursWithHail: hours,
    source: 'NOAA MRMS radar, 60-minute maximum (MESH)',
  };
}

/** First and last hour with hail >= minIn anywhere in a frame set (a map view). */
function hailWindow(frames, minIn = SWATH_MIN_IN) {
  let first = null, last = null, peak = null;
  for (const f of frames || []) {
    let v = 0;
    for (const x of f.cells) if (x[2] > v) v = x[2];
    if (v >= minIn) {
      if (!first) first = f.time;
      last = f.time;
      if (!peak || v > peak.inches) peak = { end: f.time, inches: round2(v) };
    }
  }
  if (!first) return null;
  return { start: new Date(Date.parse(first) - 3600000).toISOString(), end: last, peak, source: 'NOAA MRMS radar, hourly (MESH 60-minute maximum)' };
}

/** Same idea from ground-report times, when hourly radar isn't loaded. */
function reportWindow(reports) {
  const times = reports.map(r => r.time).filter(Boolean).sort();
  if (!times.length) return null;
  return { start: times[0], end: times[times.length - 1], count: times.length, source: 'Ground report times (NOAA SPC)' };
}

// ── The evidence at one address ──────────────────────────────────────────────
/**
 * status:
 *   'in-swath'    radar estimate at the property >= 0.75"
 *   'outside'     radar data exists for the day; the property is outside the mapped swath
 *   'unavailable' no radar data for that day (not loaded, or outside the archive)
 */
function pointEvidence(date, lat, lon, { frames = null } = {}) {
  const period = stormDayPeriod(date);
  const ground = groundHailNear(date, lat, lon);
  const nearestReport = ground[0] || null;
  const reportsWithin1mi = ground.filter(r => r.distanceMi <= 1);
  const out = {
    date, lat, lon,
    swathMinIn: SWATH_MIN_IN,
    status: 'unavailable',
    radar: null,
    hourly: null,
    nearestSwathMi: null,
    groundReports: ground.slice(0, 5),
    nearestReport,
    reportsWithin1mi: reportsWithin1mi.length,
    sources: [],
  };

  if (!mesh.hasDay(date)) {
    out.message = 'Radar hail data is not available for this date.';
    if (nearestReport) out.sources.push(nearestReport.source);
    return out;
  }

  const atIn = mesh.hailAtForDay(date)(lat, lon);
  out.radar = {
    inches: round2(atIn),
    sizeName: atIn >= 0.5 ? sizeName(atIn) : null,
    kind: 'daily-max',
    period,
    source: 'NOAA MRMS radar, 24-hour maximum (MESH)',
  };
  out.sources.push(out.radar.source);
  out.status = atIn >= SWATH_MIN_IN ? 'in-swath' : 'outside';

  if (out.status === 'outside') {
    // Distance to the nearest mapped (>= 0.75") cell, within 10 miles.
    const d = 10, kx = Math.cos(lat * Math.PI / 180);
    const cells = mesh.cellsForDay(date, lon - d / (69 * kx), lat - d / 69, lon + d / (69 * kx), lat + d / 69);
    let best = Infinity, size = 0;
    for (const [la, lo, v] of cells) {
      if (v < SWATH_MIN_IN) continue;
      const dist = geo.distanceMiles(lat, lon, (la + 0.5) / 100, (lo + 0.5) / 100);
      if (dist <= d && dist < best) { best = dist; size = v; }
    }
    if (Number.isFinite(best)) out.nearestSwathMi = { miles: Math.round(best * 10) / 10, inches: round2(size) };
  }

  if (frames) {
    out.hourly = hourlyPeakAt(frames, lat, lon);
    if (out.hourly) out.sources.push(out.hourly.source);
  }
  if (nearestReport) out.sources.push(nearestReport.source);
  out.sources = [...new Set(out.sources)];
  return out;
}

module.exports = {
  SWATH_MIN_IN, stormDayPeriod, spcTimeUtc, timeZoneFor, placeNear,
  groundHailNear, hourlyPeakAt, hourlyLookup, hailWindow, reportWindow, pointEvidence,
};
