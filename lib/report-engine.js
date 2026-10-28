/**
 * Property storm report.
 *
 * Combines three sources for one address:
 *   - Radar:  MRMS MESH estimated hail size at the property (mesh-store)
 *   - NCEI:   official Storm Events records with NWS narratives (ncei-store)
 *   - SPC:    preliminary reports for recent months NCEI hasn't published (spc-store)
 *   - NWS radar hail algorithm: probability of severe hail per storm cell (hailsig-store)
 *
 * Produces the event list the dashboard already renders, plus storm dates with
 * a confidence label, a ranked date-of-loss list and an impact score based on
 * the estimated hail size at the property itself.
 */
const mesh = require('./mesh-store');
const ncei = require('./ncei-store');
const spc = require('./spc-store');
const hailsig = require('./hailsig-store');
const { sizeName, severity } = require('./hail-scale');

const RADIUS_MI = 10;
const round2 = v => Math.round(v * 100) / 100;

function sinceDate(years) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

function dataCoverage() {
  return { radar: mesh.coverage(), ncei: ncei.coverage(), spc: spc.coverage() };
}

function storesReady() {
  const c = dataCoverage();
  return c.radar.count > 0 || !!c.ncei.lastYear || c.spc.days > 30;
}

// Shape a ground event like the original engine's events so existing UI keeps working.
function toLegacyEvent(e) {
  const base = {
    id: e.id, type: e.type, date: e.date, time: e.time || null,
    location: e.loc + (e.state ? `, ${e.state}` : ''),
    distance_miles: e.distance_miles,
    state: e.state || '',
    at_property: e.distance_miles <= 0.5,
    eLat: e.lat, eLon: e.lon,
    comments: e.n || '',
    source: e.id && e.id[0] === 'N' ? 'NCEI Storm Events' : 'SPC Storm Report',
    reportedBy: e.src || null,
    damage: e.dmg || null,
  };
  if (e.type === 'hail') {
    const s = e.mag || 0;
    return { ...base, typeLabel: 'Hail', icon: '🌨️', size_in: round2(s), size_desc: sizeName(s), magnitude_label: `${s.toFixed(2)}"` };
  }
  if (e.type === 'wind') {
    const mph = e.mag ? Math.round(e.mag * 1.151) : null;
    return { ...base, typeLabel: 'High Wind', icon: '💨', size_in: 0, mph, size_desc: mph ? `${mph} mph` : 'High Wind', magnitude_label: mph ? `${mph} mph` : 'Wind Event' };
  }
  const ef = e.ef || 'EF?';
  return { ...base, typeLabel: 'Tornado', icon: '🌪️', size_in: 0, size_desc: ef, magnitude_label: ef, pathLengthMi: e.lenMi || null, pathWidthYd: e.widthYd || null };
}

function buildReport(lat, lon, { years = 10 } = {}) {
  const since = sinceDate(years);
  const nceiEnd = ncei.coverageEnd();

  const ground = [
    ...(nceiEnd ? ncei.eventsNear(lat, lon, RADIUS_MI, { sinceDate: since, untilDate: nceiEnd }) : []),
    ...spc.eventsNear(lat, lon, RADIUS_MI, { sinceDate: since, afterDate: nceiEnd || null }),
  ].filter(e => e.type !== 'hail' || (e.mag || 0) >= 0.5);

  const radar = mesh.pointHistory(lat, lon, RADIUS_MI, { sinceDate: since });
  const sigs = hailsig.historyNear(lat, lon, RADIUS_MI, { sinceDate: since });
  const events = ground.map(toLegacyEvent);

  // ── Storm dates ──────────────────────────────────────────────────────────
  const byDate = new Map();
  const get = date => {
    if (!byDate.has(date)) byDate.set(date, { date, radar: null, hail: [], wind: [], tornado: [] });
    return byDate.get(date);
  };
  for (const r of radar) get(r.date).radar = r;
  for (const e of events) get(e.date)[e.type].push(e);

  const stormDates = [...byDate.values()].map(d => {
    const radarAt = d.radar ? d.radar.atProperty : 0;
    const hail1 = d.hail.filter(e => e.distance_miles <= 1);
    const hail3 = d.hail.filter(e => e.distance_miles <= 3);
    const groundAt = hail1.reduce((m, e) => Math.max(m, e.size_in), 0);
    const nearestHail = d.hail.reduce((m, e) => Math.min(m, e.distance_miles), Infinity);
    const maxWindMph = d.wind.filter(e => e.distance_miles <= 3).reduce((m, e) => Math.max(m, e.mph || 0), 0);
    const nearestTornado = d.tornado.reduce((m, e) => Math.min(m, e.distance_miles), Infinity);
    const bestEstimate = Math.max(radarAt, groundAt);

    let confidence = 'Nearby';
    if (radarAt >= 0.75 && hail3.length) confidence = 'Verified';
    else if (radarAt >= 0.75) confidence = 'Radar';
    else if (groundAt >= 0.75) confidence = 'Ground report';

    let dolScore = bestEstimate * 40
      + (confidence === 'Verified' ? 25 : 0)
      + Math.min(hail3.length, 5) * 2
      + (maxWindMph >= 58 ? 10 : 0)
      + (nearestTornado <= 1 ? 40 : 0);
    dolScore = Math.round(dolScore);

    return {
      date: d.date,
      bestEstimateIn: round2(bestEstimate),
      sizeName: bestEstimate ? sizeName(bestEstimate) : null,
      severity: severity(bestEstimate).level,
      confidence,
      verified: confidence === 'Verified',
      radar: d.radar ? {
        atPropertyIn: d.radar.atProperty, within1miIn: d.radar.within1mi,
        within3miIn: d.radar.within3mi, within10miIn: d.radar.withinRadius,
        nearest1inMi: d.radar.nearest1inMi,
      } : null,
      groundReports: {
        hailCount: d.hail.length,
        hailWithin3mi: hail3.length,
        largestHailIn: round2(d.hail.reduce((m, e) => Math.max(m, e.size_in), 0)),
        nearestHailMi: Number.isFinite(nearestHail) ? nearestHail : null,
        maxWindMph: maxWindMph || null,
        nearestTornadoMi: Number.isFinite(nearestTornado) ? nearestTornado : null,
      },
      // NWS radar hail algorithm (null when that day hasn't been loaded yet).
      hailAlgorithm: sigs.has(d.date) || hailsig.hasConvectiveDay(d.date) ? (() => {
        const g = sigs.get(d.date) || { maxSevProb: 0, maxSevProbWithin3mi: 0, maxSizeIn: 0, count: 0, nearestSevereMi: null };
        return { severeProbWithin3mi: g.maxSevProbWithin3mi, severeProbWithin10mi: g.maxSevProb, maxSizeIn: g.maxSizeIn, signatures: g.count, nearestSevereMi: g.nearestSevereMi };
      })() : null,
      dolScore,
    };
  }).sort((a, b) => (a.date < b.date ? 1 : -1));

  const damaging = stormDates.filter(s => s.bestEstimateIn >= 0.75
    || (s.groundReports.nearestTornadoMi != null && s.groundReports.nearestTornadoMi <= 1)
    || (s.groundReports.maxWindMph || 0) >= 58);
  const dateOfLoss = [...damaging].sort((a, b) => b.dolScore - a.dolScore).slice(0, 5);

  const score = impactScore(stormDates);
  const largestAtProperty = stormDates.reduce((m, s) => Math.max(m, s.bestEstimateIn), 0);

  return {
    success: true,
    lat, lon, years, since,
    events,
    stormDates,
    dateOfLoss,
    score,
    stats: {
      total: events.length,
      atProperty: events.filter(e => e.at_property).length,
      largestHail: events.length ? Math.max(...events.map(e => e.size_in || 0)) : 0,
      largestAtPropertyIn: round2(largestAtProperty),
      mostRecent: events.length ? events[0].date : (stormDates[0] ? stormDates[0].date : null),
      radarHailDays: radar.filter(r => r.atProperty >= 0.75).length,
      verifiedDays: stormDates.filter(s => s.verified).length,
    },
    coverage: dataCoverage(),
    sources: [
      { name: 'NOAA MRMS radar (MESH)', note: 'Estimated maximum hail size from multi-radar analysis, 1 km grid.' },
      { name: 'NOAA NCEI Storm Events Database', note: 'Official National Weather Service storm records with narratives.' },
      { name: 'NOAA SPC Storm Reports', note: 'Preliminary spotter and public reports for recent months.' },
      { name: 'NWS radar hail algorithm (NEXRAD, via NOAA NCEI)', note: 'Probability of severe hail (1"+) for each storm cell, from the National Severe Storms Laboratory hail detection algorithm.' },
    ],
  };
}

/**
 * 0–100 based on hail at the property itself (radar or a report within a mile),
 * how often damaging hail has hit, how recently, and tornado proximity.
 */
function impactScore(stormDates) {
  if (!stormDates.length) return 0;
  const sizePts = s => (s >= 2.5 ? 90 : s >= 2 ? 78 : s >= 1.75 ? 68 : s >= 1.5 ? 58 : s >= 1.25 ? 50 : s >= 1 ? 40 : s >= 0.75 ? 25 : s >= 0.5 ? 10 : 0);
  const fiveYearsAgo = sinceDate(5);
  let best = 0;
  for (const s of stormDates) {
    let pts = sizePts(s.bestEstimateIn);
    if (s.verified) pts += 5;
    if (s.date < fiveYearsAgo) pts *= 0.8;
    if (s.groundReports.nearestTornadoMi != null && s.groundReports.nearestTornadoMi <= 0.5) pts = Math.max(pts, 85);
    best = Math.max(best, pts);
  }
  const damagingRecent = stormDates.filter(s => s.bestEstimateIn >= 1 && s.date >= fiveYearsAgo).length;
  const freq = Math.min(15, Math.max(0, damagingRecent - 1) * 5);
  return Math.min(100, Math.round(best + freq));
}

module.exports = { buildReport, impactScore, dataCoverage, storesReady };
