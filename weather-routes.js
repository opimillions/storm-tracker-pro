/**
 * Weather ticker routes (logged-in pages).
 * GET  /api/weather/home  -> forecast for the user's home area
 * POST /api/weather/home  -> set the home area by ZIP code { zip }
 */
const weather = require('./lib/weather');

module.exports = function (app, { db, requireAuth }) {
  const { userOps, alertSettingsOps, lookupOps } = db;

  // Home area: a ZIP the user set > first storm-alert area > most recent lookup.
  async function homeArea(user) {
    const h = user.homeArea;
    if (h && Number.isFinite(h.lat) && Number.isFinite(h.lon)) return { ...h, source: 'set' };
    try {
      const s = await alertSettingsOps.get(user._id);
      const r = (s.regions || []).find((x) => Number.isFinite(Number(x.lat)) && Number.isFinite(Number(x.lon)));
      if (r) return { lat: Number(r.lat), lon: Number(r.lon), label: r.name || null, source: 'alerts' };
    } catch (e) { /* fall through */ }
    try {
      const recent = await lookupOps.getForUser(user._id, 5);
      const l = (recent || []).find((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon));
      if (l) return { lat: l.lat, lon: l.lon, label: null, source: 'lookup' };
    } catch (e) { /* none */ }
    return null;
  }

  app.get('/api/weather/home', requireAuth, async (req, res) => {
    const area = await homeArea(req.user);
    if (!area) return res.json({ needsArea: true });
    try {
      const w = await weather.forecast(area.lat, area.lon);
      res.json({ area: { label: w.place || area.label, zip: area.zip || null, source: area.source }, ...w });
    } catch (e) {
      console.error('[weather]', e.message);
      res.status(502).json({ error: 'Weather is unavailable right now.' });
    }
  });

  app.post('/api/weather/home', requireAuth, async (req, res) => {
    // "Use my location" from the phone or browser: save the coordinates (U.S. only, rounded to ~1 km).
    const lat = Number(req.body && req.body.lat), lon = Number(req.body && req.body.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      if (lat < 17 || lat > 72 || lon < -180 || lon > -64) return res.status(400).json({ error: 'Weather is available for U.S. locations only.' });
      const r = v => Math.round(v * 100) / 100;
      await userOps.update(req.user._id, { homeArea: { lat: r(lat), lon: r(lon), label: null, fromDevice: true } });
      return res.json({ success: true });
    }
    const zip = String((req.body && req.body.zip) || '').trim().slice(0, 5);
    if (!/^\d{5}$/.test(zip)) return res.status(400).json({ error: 'Enter a 5-digit ZIP code.' });
    const z = require('zipcodes').lookup(zip);
    if (!z || !Number.isFinite(z.latitude)) return res.status(400).json({ error: 'That ZIP code was not found.' });
    await userOps.update(req.user._id, { homeArea: { zip, lat: z.latitude, lon: z.longitude, label: `${z.city}, ${z.state}` } });
    res.json({ success: true, label: `${z.city}, ${z.state} ${zip}` });
  });
};
