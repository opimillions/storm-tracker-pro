/**
 * Shareable storm map.
 *
 *   /storm/:date                     public map of one storm day (?lat=&lon=&z= to frame an area)
 *   /storm/:date/:state/:city        the same, framed on a city ("…/tx/fort-worth"), for social posts
 *
 * Public APIs return only weather data. The signed-in "My properties in this
 * storm" list comes from a separate, per-user API and is never part of a
 * shared link or the page HTML.
 */
const fs = require('fs');
const path = require('path');
const mesh = require('./lib/mesh-store');
const spc = require('./lib/spc-store');
const places = require('./lib/places');
const frames = require('./lib/frames');
const stormDays = require('./lib/storm-days');
const ev = require('./lib/storm-evidence');
const { sizeName } = require('./lib/hail-scale');
const { geocodeAddress } = require('./hail-engine');
const { baseUrl } = require('./lib/mailer');

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, lo, hi) => { const n = parseFloat(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
const fmtDay = (d, tz) => new Date(d + 'T18:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: tz || 'America/Chicago' });

function bbox(q, maxDeg) {
  const w = parseFloat(q.w), s = parseFloat(q.s), e = parseFloat(q.e), n = parseFloat(q.n);
  if (![w, s, e, n].every(Number.isFinite) || w >= e || s >= n || e - w > maxDeg || n - s > maxDeg) return null;
  if (s < 15 || n > 60 || w < -135 || e > -55) return null;
  return [w, s, e, n];
}

// Simple per-IP, per-bucket hourly limiter for the public endpoints.
const hits = new Map();
function limited(req, bucket, max) {
  const key = bucket + '|' + req.ip, now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < 3600000);
  arr.push(now); hits.set(key, arr);
  if (hits.size > 20000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 3600000) hits.delete(k);
  return arr.length > max;
}

/** Where a storm link opens when no area is given: the hardest-hit city. */
function defaultCenter(date) {
  const sd = stormDays.get(date);
  const top = sd && sd.cities && sd.cities[0];
  if (top) return { lat: top.lat, lon: top.lon, z: 10 };
  return { lat: 37.5, lon: -96, z: 5 };
}

function stormPath(date, { lat, lon, z } = {}) {
  if (lat == null) return `/storm/${date}`;
  return `/storm/${date}?lat=${(+lat).toFixed(4)}&lon=${(+lon).toFixed(4)}&z=${z || 11}`;
}

/** Ground reports with UTC times for a bbox. */
function reportsInBox(date, [w, s, e, n]) {
  const day = spc.reportsForDay(date);
  const inBox = r => r.lon >= w && r.lat >= s && r.lon <= e && r.lat <= n;
  return {
    hail: day.hail.filter(inBox).map(r => ({ lat: r.lat, lon: r.lon, sizeIn: r.mag, loc: r.loc, state: r.state, time: ev.spcTimeUtc(date, r.hhmm), remarks: (r.n || '').slice(0, 200) })),
    wind: day.wind.filter(inBox).map(r => ({ lat: r.lat, lon: r.lon, mph: r.mag ? Math.round(r.mag * 1.151) : null, loc: r.loc, state: r.state, time: ev.spcTimeUtc(date, r.hhmm) })),
    tornado: day.tornado.filter(inBox).map(r => ({ lat: r.lat, lon: r.lon, ef: r.ef, loc: r.loc, state: r.state, time: ev.spcTimeUtc(date, r.hhmm) })),
    source: 'NOAA SPC preliminary storm reports',
  };
}

let template = null;
function pageTemplate() {
  if (!template || process.env.NODE_ENV !== 'production') template = fs.readFileSync(path.join(__dirname, 'public', 'storm.html'), 'utf8');
  return template;
}

module.exports = function stormShareRoutes(app, { requireAuth, db }) {
  const { watchlistOps } = db;

  // ── The public storm page ─────────────────────────────────────────────────
  function renderStorm(req, res, center) {
    const date = req.params.date;
    const place = ev.placeNear(center.lat, center.lon);
    const tz = place ? place.tz : 'America/Chicago';
    const hasRadar = mesh.hasDay(date);
    if (hasRadar) frames.warm(date); // hourly timing for this storm, built once in the background

    // Largest radar estimate around the framed area, for the title and preview.
    const d = 0.5;
    const near = hasRadar ? mesh.cellsForDay(date, center.lon - d, center.lat - d, center.lon + d, center.lat + d) : [];
    const maxIn = near.reduce((m, c) => Math.max(m, c[2]), 0);
    const where = place ? `${place.name}, ${place.state}` : 'this area';
    const title = `Hail storm ${fmtDay(date, tz)} near ${where}${maxIn >= 0.75 ? `: up to ${maxIn.toFixed(2)}"` : ''}`;
    const desc = maxIn >= 0.75
      ? `NOAA radar estimated hail up to ${maxIn.toFixed(2)}" (${sizeName(maxIn)}) near ${where}. See the swath, ground reports and check any address.`
      : `Storm map for ${fmtDay(date, tz)} near ${where}: radar hail swath, ground reports and an address check.`;
    const canonical = baseUrl() + stormPath(date, center);
    const b = [center.lon - 0.9, center.lat - 0.6, center.lon + 0.9, center.lat + 0.6].map(v => v.toFixed(2)).join(',');
    const img = hasRadar ? `${baseUrl()}/storm-images/${date}.png?b=${b}&c=${center.lat.toFixed(3)},${center.lon.toFixed(3)}` : `${baseUrl()}/icons/icon-512.png`;
    const boot = {
      date, center, place, tz, hasRadar,
      period: ev.stormDayPeriod(date),
      swathMinIn: ev.SWATH_MIN_IN,
      playbackFrom: '2020-10-15',
    };
    const head = `<title>${esc(title)} | StormCheck Pro</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="StormCheck Pro">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(canonical)}"><meta property="og:image" content="${esc(img)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:image" content="${esc(img)}">`;
    res.set('Cache-Control', 'public, max-age=300');
    res.send(pageTemplate()
      .replace('<!--HEAD-->', head)
      .replace('/*BOOT*/null', JSON.stringify(boot).replace(/</g, '\\u003c')));
  }

  app.get('/storm/:date', (req, res, next) => {
    if (!isDate(req.params.date)) return next();
    const lat = num(req.query.lat, 15, 60), lon = num(req.query.lon, -135, -55);
    const z = Math.round(num(req.query.z, 4, 17) || 11);
    renderStorm(req, res, lat != null && lon != null ? { lat, lon, z } : defaultCenter(req.params.date));
  });

  app.get('/storm/:date/:state/:city', (req, res, next) => {
    if (!isDate(req.params.date)) return next();
    const city = places.findCity(req.params.state, String(req.params.city).toLowerCase());
    if (!city) return res.redirect(302, `/storm/${req.params.date}`);
    renderStorm(req, res, { lat: city.lat, lon: city.lon, z: 11 });
  });

  // ── Public data ───────────────────────────────────────────────────────────
  app.get('/api/public/storm/:date', (req, res) => {
    const date = req.params.date;
    if (!isDate(date)) return res.status(400).json({ error: 'Invalid date' });
    const box = bbox(req.query, 5);
    if (!box) return res.status(400).json({ error: 'Zoom in to load the storm (5° max).' });
    const hasRadar = mesh.hasDay(date);
    const cells = hasRadar ? mesh.cellsForDay(date, ...box).filter(c => c[2] >= ev.SWATH_MIN_IN) : [];
    const reports = reportsInBox(date, box);
    const hourly = hasRadar ? frames.cachedInBBox(date, ...box) : null;
    const timing = (hourly && ev.hailWindow(hourly)) || ev.reportWindow(reports.hail);
    const c = { lat: (box[1] + box[3]) / 2, lon: (box[0] + box[2]) / 2 };
    res.set('Cache-Control', 'public, max-age=600');
    res.json({
      date, hasRadar,
      period: ev.stormDayPeriod(date),
      radarSource: 'NOAA MRMS radar, 24-hour maximum (MESH)',
      cells, maxIn: cells.reduce((m, x) => Math.max(m, x[2]), 0),
      reports, timing,
      hourly: hourly ? 'ready' : (hasRadar && frames.building(date) ? 'building' : (hasRadar && date >= '2020-10-15' ? 'pending' : 'unavailable')),
      place: ev.placeNear(c.lat, c.lon),
    });
  });

  app.get('/api/public/geocode', async (req, res) => {
    if (limited(req, 'geo', 40)) return res.status(429).json({ error: 'Too many searches. Try again in a little while.' });
    const q = String(req.query.q || '').trim().slice(0, 200);
    if (q.length < 3) return res.status(400).json({ error: 'Enter an address.' });
    const g = await geocodeAddress(q).catch(() => null);
    if (!g) return res.status(404).json({ error: /\d{5}/.test(q) ? 'Address not found.' : 'Address not found. Include the city, state and ZIP.' });
    res.json({ lat: g.lat, lon: g.lon, address: g.formattedAddress, state: g.state || null });
  });

  app.get('/api/public/storm/:date/point', (req, res) => {
    const date = req.params.date;
    if (!isDate(date)) return res.status(400).json({ error: 'Invalid date' });
    const lat = num(req.query.lat, 15, 60), lon = num(req.query.lon, -135, -55);
    if (lat == null || lon == null) return res.status(400).json({ error: 'lat and lon required' });
    if (limited(req, 'pt', 120)) return res.status(429).json({ error: 'Too many checks. Try again in a little while.' });
    const d = 0.05;
    const hourly = mesh.hasDay(date) ? frames.cachedInBBox(date, lon - d, lat - d, lon + d, lat + d) : null;
    res.set('Cache-Control', 'public, max-age=600');
    res.json(ev.pointEvidence(date, lat, lon, { frames: hourly }));
  });

  // ── Private: the signed-in user's saved properties in this storm ─────────
  async function myHits(user, date) {
    const contacts = await watchlistOps.getForUser(user._id);
    const located = contacts.filter(c => c.lat != null && c.lon != null);
    const result = { date, total: contacts.length, located: located.length, inside: [], outsideCount: 0, hasRadar: mesh.hasDay(date) };
    if (!result.hasRadar) return result;
    const radarAt = mesh.hailAtForDay(date);
    const all = frames.cachedFrames(date);
    const hourlyAt = all ? ev.hourlyLookup(cropToContacts(all, located)) : null;
    result.hourly = all ? 'ready' : (frames.building(date) ? 'building' : 'pending');
    if (!all) frames.warm(date);
    for (const c of located) {
      const inches = radarAt(c.lat, c.lon);
      if (inches < ev.SWATH_MIN_IN) { result.outsideCount++; continue; }
      const near = ev.groundHailNear(date, c.lat, c.lon, 3)[0] || null;
      result.inside.push({
        id: c._id, name: c.name || '', address: c.formattedAddress || c.address, lat: c.lat, lon: c.lon, phone: c.phone || '',
        inches: Math.round(inches * 100) / 100, sizeName: sizeName(inches),
        hourly: hourlyAt ? hourlyAt(c.lat, c.lon) : null,
        nearestReport: near ? { sizeIn: near.sizeIn, distanceMi: near.distanceMi, bearing: near.bearing, time: near.time, loc: near.loc } : null,
      });
    }
    result.inside.sort((a, b) => b.inches - a.inches || String(a.name).localeCompare(String(b.name)));
    result.period = ev.stormDayPeriod(date);
    return result;
  }

  // Keep only frame cells near the user's properties before indexing.
  function cropToContacts(all, located) {
    if (!located.length) return [];
    const keep = new Set();
    for (const c of located) {
      const cc = { latC: Math.floor(c.lat * 100 + 1e-9), lonC: Math.floor(c.lon * 100 + 1e-9) };
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) keep.add((cc.latC + a) * 100000 + cc.lonC + b);
    }
    return all.map(f => {
      const out = [];
      const x = f.cells;
      if (x.length && Array.isArray(x[0])) { for (const r of x) if (keep.has(r[0] * 100000 + r[1])) out.push(r); }
      else for (let k = 0; k < x.length; k += 3) if (keep.has(x[k] * 100000 + x[k + 1])) out.push([x[k], x[k + 1], x[k + 2] / 100]);
      return { time: f.time, cells: out };
    });
  }

  app.get('/api/storm/:date/my-properties', requireAuth, async (req, res) => {
    if (!isDate(req.params.date)) return res.status(400).json({ error: 'Invalid date' });
    res.set('Cache-Control', 'private, no-store');
    try { res.json(await myHits(req.user, req.params.date)); }
    catch (e) { console.error('[storm] my-properties:', e.message); res.status(500).json({ error: 'Could not check your properties.' }); }
  });

  // Email the list to yourself, using the portfolio alert email.
  const emailed = new Map();
  app.post('/api/storm/:date/my-properties/email', requireAuth, async (req, res) => {
    const date = req.params.date;
    if (!isDate(date)) return res.status(400).json({ error: 'Invalid date' });
    const id = String(req.user._id), now = Date.now();
    const recent = (emailed.get(id) || []).filter(t => now - t < 3600000);
    if (recent.length >= 5) return res.status(429).json({ error: 'You can email this list 5 times an hour.' });
    const r = await myHits(req.user, date);
    if (!r.inside.length) return res.status(400).json({ error: 'None of your saved properties are inside this storm\'s swath.' });
    recent.push(now); emailed.set(id, recent);
    const contacts = await watchlistOps.getForUser(req.user._id);
    const byId = new Map(contacts.map(c => [String(c._id), c]));
    const list = r.inside.map(h => ({ c: byId.get(String(h.id)), best: h.inches, radarIn: h.inches, groundHail: h.nearestReport && h.nearestReport.distanceMi <= 1 ? h.nearestReport.sizeIn : 0, tornado: false })).filter(h => h.c);
    const { portfolioEmail } = require('./lib/alerts');
    const { sendMail } = require('./lib/mailer');
    const msg = portfolioEmail(date, list);
    const ok = await sendMail({ to: req.user.email, subject: msg.subject, html: msg.html });
    if (!ok) return res.status(502).json({ error: 'The email could not be sent.' });
    res.json({ success: true, to: req.user.email, count: list.length });
  });
};

module.exports.stormPath = stormPath;
