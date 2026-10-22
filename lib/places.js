/**
 * US cities and ZIP code centroids, bucketed by 0.1° for fast "what's near
 * this hail cell" queries. Used for storm summaries, lead areas and city pages.
 */
const geo = require('./geo');

let cities = null, zips = null, cityBuckets = null, zipBuckets = null, citySlugIndex = null;

const STATE_NAMES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };

const slugify = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const bucketKey = (lat, lon) => `${Math.floor(lat * 10)}_${Math.floor(lon * 10)}`;

function load() {
  if (cities) return;
  cities = require('all-the-cities')
    .filter(c => c.country === 'US' && STATE_NAMES[c.adminCode])
    .map(c => ({
      name: c.name, state: c.adminCode, pop: c.population,
      lat: c.loc.coordinates[1], lon: c.loc.coordinates[0],
      slug: slugify(c.name),
    }));
  // Disambiguate duplicate names within a state by keeping the most populous.
  citySlugIndex = new Map();
  for (const c of cities) {
    const k = `${c.state.toLowerCase()}/${c.slug}`;
    const prev = citySlugIndex.get(k);
    if (!prev || prev.pop < c.pop) citySlugIndex.set(k, c);
  }
  cityBuckets = new Map();
  for (const c of cities) {
    const k = bucketKey(c.lat, c.lon);
    if (!cityBuckets.has(k)) cityBuckets.set(k, []);
    cityBuckets.get(k).push(c);
  }
  const z = require('zipcodes');
  zips = Object.values(z.codes)
    .filter(r => r.country === 'US' && STATE_NAMES[r.state] && Number.isFinite(r.latitude))
    .map(r => ({ zip: r.zip, city: r.city, state: r.state, lat: r.latitude, lon: r.longitude }));
  zipBuckets = new Map();
  for (const r of zips) {
    const k = bucketKey(r.lat, r.lon);
    if (!zipBuckets.has(k)) zipBuckets.set(k, []);
    zipBuckets.get(k).push(r);
  }
}

function near(buckets, lat, lon, mi) {
  const out = [];
  const dLat = mi / 69, dLon = mi / (69 * Math.cos(lat * Math.PI / 180));
  for (let a = Math.floor((lat - dLat) * 10); a <= Math.floor((lat + dLat) * 10); a++) {
    for (let b = Math.floor((lon - dLon) * 10); b <= Math.floor((lon + dLon) * 10); b++) {
      for (const p of buckets.get(`${a}_${b}`) || []) {
        const d = geo.distanceMiles(lat, lon, p.lat, p.lon);
        if (d <= mi) out.push({ ...p, distance_miles: Math.round(d * 10) / 10 });
      }
    }
  }
  return out.sort((x, y) => x.distance_miles - y.distance_miles);
}

function citiesNear(lat, lon, mi = 5) { load(); return near(cityBuckets, lat, lon, mi); }
function zipsNear(lat, lon, mi = 3) { load(); return near(zipBuckets, lat, lon, mi); }
function nearestCity(lat, lon) {
  for (const r of [5, 15, 40]) { const c = citiesNear(lat, lon, r); if (c.length) return c[0]; }
  return null;
}
function findCity(state, slug) { load(); return citySlugIndex.get(`${String(state).toLowerCase()}/${slug}`) || null; }
function citiesInState(state, minPop = 0) {
  load();
  return [...citySlugIndex.values()].filter(c => c.state === state.toUpperCase() && c.pop >= minPop).sort((a, b) => b.pop - a.pop);
}
function zipInfo(zip) { load(); return zips.find(z => z.zip === String(zip)) || null; }

/**
 * Which cities and ZIPs a set of hail cells touched.
 * cells: [[latC, lonC, inches], ...]. A place counts if a cell >= minIn lies
 * within `mi` miles of its centre.
 */
function affectedBy(cells, { minIn = 0.75, cityMi = 2, zipMi = 1.5 } = {}) {
  load();
  const cityHits = new Map(), zipHits = new Map();
  // Big storm days have 100k+ cells; checking places per 0.03° block (max size
  // in the block) gives the same answer at a fraction of the work.
  const blocks = new Map();
  for (const [latC, lonC, inches] of cells) {
    if (inches < minIn) continue;
    const k = Math.floor(latC / 3) * 100000 + Math.floor(lonC / 3);
    const b = blocks.get(k);
    if (!b) blocks.set(k, [Math.floor(latC / 3) * 3 + 1, Math.floor(lonC / 3) * 3 + 1, inches, 1]);
    else { if (inches > b[2]) b[2] = inches; b[3]++; }
  }
  for (const [latC, lonC, inches, count] of blocks.values()) {
    const lat = (latC + 0.5) / 100, lon = (lonC + 0.5) / 100;
    for (const c of near(cityBuckets, lat, lon, cityMi)) {
      const k = `${c.state}/${c.slug}`;
      const h = cityHits.get(k);
      if (!h || h.maxIn < inches) cityHits.set(k, { name: c.name, state: c.state, slug: c.slug, pop: c.pop, lat: c.lat, lon: c.lon, maxIn: inches });
    }
    for (const z of near(zipBuckets, lat, lon, zipMi)) {
      const h = zipHits.get(z.zip);
      if (!h) zipHits.set(z.zip, { zip: z.zip, city: z.city, state: z.state, maxIn: inches, cells: count });
      else { h.cells += count; if (h.maxIn < inches) h.maxIn = inches; }
    }
  }
  return {
    cities: [...cityHits.values()].sort((a, b) => b.maxIn - a.maxIn || b.pop - a.pop),
    zips: [...zipHits.values()].sort((a, b) => b.maxIn - a.maxIn || b.cells - a.cells),
  };
}

module.exports = { STATE_NAMES, slugify, citiesNear, zipsNear, nearestCity, findCity, citiesInState, zipInfo, affectedBy };
