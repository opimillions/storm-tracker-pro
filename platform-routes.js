/**
 * Logged-in platform APIs: radar swaths, playback, lead areas, portfolio
 * summaries, meteorologist review orders and data-pipeline admin.
 */
const path = require('path');
const mesh = require('./lib/mesh-store');
const spc = require('./lib/spc-store');
const places = require('./lib/places');
const frames = require('./lib/frames');
const stormDays = require('./lib/storm-days');
const dataJobs = require('./lib/data-jobs');
const { toCsv } = require('./lib/csv');
const { sizeName } = require('./lib/hail-scale');
const { sendMail, layout, baseUrl, escapeHtml } = require('./lib/mailer');

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

function bboxFrom(q, maxDeg) {
  const w = parseFloat(q.w), s = parseFloat(q.s), e = parseFloat(q.e), n = parseFloat(q.n);
  if (![w, s, e, n].every(Number.isFinite) || w >= e || s >= n) return null;
  if (e - w > maxDeg || n - s > maxDeg) return null;
  return [w, s, e, n];
}

module.exports = function platformRoutes(app, { requireAuth, requireAdmin, requireActiveSubscription, tierFeatures, db }) {
  const { watchlistOps, reviewOps, userOps } = db;

  // ── Radar hail swaths ─────────────────────────────────────────────────────
  app.get('/api/mesh/days', requireAuth, (req, res) => {
    const bbox = bboxFrom(req.query, 30);
    if (!bbox) return res.status(400).json({ error: 'Valid bbox (w,s,e,n) up to 30° required' });
    const minIn = parseFloat(req.query.minIn) || 0.75;
    res.json({ days: mesh.daysInBBox(...bbox, { limit: Math.min(+req.query.limit || 60, 200), minIn }), coverage: mesh.coverage() });
  });

  app.get('/api/mesh/swath', requireAuth, (req, res) => {
    if (!isDate(req.query.date)) return res.status(400).json({ error: 'date=YYYY-MM-DD required' });
    const bbox = bboxFrom(req.query, 16);
    if (!bbox) return res.status(400).json({ error: 'Valid bbox up to 16° required. Zoom in.' });
    const cells = mesh.cellsForDay(req.query.date, ...bbox);
    const reports = spc.reportsForDay(req.query.date);
    const inBox = r => r.lon >= bbox[0] && r.lat >= bbox[1] && r.lon <= bbox[2] && r.lat <= bbox[3];
    res.json({
      date: req.query.date,
      cells,
      maxIn: cells.reduce((m, c) => Math.max(m, c[2]), 0),
      reports: {
        hail: reports.hail.filter(inBox).map(r => ({ lat: r.lat, lon: r.lon, size: r.mag, loc: r.loc, state: r.state, n: r.n })),
        wind: reports.wind.filter(inBox).map(r => ({ lat: r.lat, lon: r.lon, mph: r.mag ? Math.round(r.mag * 1.151) : null, loc: r.loc, state: r.state })),
        tornado: reports.tornado.filter(inBox).map(r => ({ lat: r.lat, lon: r.lon, ef: r.ef, loc: r.loc, state: r.state })),
      },
    });
  });

  // Animated playback (hourly frames). Pro and above.
  app.get('/api/mesh/frames', requireAuth, async (req, res) => {
    if (!tierFeatures(req.user.tier).playback) return res.status(403).json({ error: 'Storm playback is included with Pro and above.', upgrade: true });
    if (!isDate(req.query.date)) return res.status(400).json({ error: 'date=YYYY-MM-DD required' });
    const bbox = bboxFrom(req.query, 8);
    if (!bbox) return res.status(400).json({ error: 'Zoom in to play back a storm (8° max).' });
    if (req.query.date < '2020-10-15') return res.status(400).json({ error: 'Playback is available for storms since October 2020.' });
    try {
      res.json({ date: req.query.date, frames: await frames.framesInBBox(req.query.date, ...bbox) });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // ── Lead areas from the swath ─────────────────────────────────────────────
  app.get('/api/leads/areas', requireAuth, requireActiveSubscription, (req, res) => {
    if (!isDate(req.query.date)) return res.status(400).json({ error: 'date=YYYY-MM-DD required' });
    const bbox = bboxFrom(req.query, 16);
    if (!bbox) return res.status(400).json({ error: 'Valid bbox up to 16° required' });
    const minIn = parseFloat(req.query.minIn) || 1;
    const cells = mesh.cellsForDay(req.query.date, ...bbox).filter(c => c[2] >= minIn);
    const { cities, zips } = places.affectedBy(cells, { minIn });
    const areaSqMi = Math.round(cells.reduce((a, [latC]) => a + 0.476 * Math.cos((latC / 100) * Math.PI / 180), 0));
    const fmt = req.query.format;

    if (fmt === 'csv') {
      const rows = [['storm_date', 'zip', 'city', 'state', 'max_hail_in', 'hail_name', 'swath_cells_in_zip', 'priority']];
      for (const z of zips) {
        const priority = z.maxIn >= 1.75 ? 'HIGH' : z.maxIn >= 1.25 ? 'MEDIUM' : 'STANDARD';
        rows.push([req.query.date, z.zip, z.city, z.state, z.maxIn.toFixed(2), sizeName(z.maxIn), z.cells, priority]);
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="hail-zips-${req.query.date}.csv"`);
      return res.send(toCsv(rows));
    }

    if (fmt === 'geojson' || fmt === 'kml') {
      const capped = cells.slice(0, 60000);
      const square = ([latC, lonC]) => {
        const s = latC / 100, w = lonC / 100, n = s + 0.01, e = w + 0.01;
        return [[w, s], [e, s], [e, n], [w, n], [w, s]];
      };
      if (fmt === 'geojson') {
        res.setHeader('Content-Disposition', `attachment; filename="hail-swath-${req.query.date}.geojson"`);
        return res.json({
          type: 'FeatureCollection',
          features: capped.map(c => ({ type: 'Feature', properties: { hail_in: c[2] }, geometry: { type: 'Polygon', coordinates: [square(c)] } })),
        });
      }
      const placemarks = capped.map(c => `<Placemark><styleUrl>#h${c[2] >= 1.75 ? 3 : c[2] >= 1.25 ? 2 : 1}</styleUrl><ExtendedData><Data name="hail_in"><value>${c[2]}</value></Data></ExtendedData><Polygon><outerBoundaryIs><LinearRing><coordinates>${square(c).map(p => p.join(',')).join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`).join('');
      res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml');
      res.setHeader('Content-Disposition', `attachment; filename="hail-swath-${req.query.date}.kml"`);
      return res.send(`<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Hail swath ${req.query.date}</name>
<Style id="h1"><PolyStyle><color>99009ef2</color><outline>0</outline></PolyStyle></Style><Style id="h2"><PolyStyle><color>990058ea</color><outline>0</outline></PolyStyle></Style><Style id="h3"><PolyStyle><color>991c1cb9</color><outline>0</outline></PolyStyle></Style>${placemarks}</Document></kml>`);
    }

    res.json({ date: req.query.date, minIn, areaSqMi, cellCount: cells.length, cities: cities.slice(0, 300), zips });
  });

  // ── Portfolio (watch list) summary ────────────────────────────────────────
  app.get('/api/watchlist/summary', requireAuth, async (req, res) => {
    const contacts = await watchlistOps.getForUser(req.user._id);
    const since = new Date(Date.now() - 3 * 365 * 86400000).toISOString().slice(0, 10);
    const summary = contacts.map(c => {
      if (c.lat == null) return { _id: c._id, geocoded: false };
      const hist = mesh.pointHistory(c.lat, c.lon, 1, { sinceDate: since }).filter(r => r.atProperty >= 0.75);
      const biggest = hist.reduce((m, r) => (r.atProperty > (m ? m.atProperty : 0) ? r : m), null);
      return {
        _id: c._id, geocoded: true,
        lastHit: hist[0] ? { date: hist[0].date, sizeIn: hist[0].atProperty } : null,
        largest3yr: biggest ? { date: biggest.date, sizeIn: biggest.atProperty } : null,
        hitDays3yr: hist.length,
      };
    });
    res.json({ summary });
  });

  // ── Meteorologist reviewed reports ─────────────────────────────────────────
  app.post('/api/reviews', requireAuth, async (req, res) => {
    const { address, lat, lon, dateOfLoss, notes } = req.body || {};
    if (!address || !isDate(dateOfLoss)) return res.status(400).json({ error: 'Address and date of loss are required.' });
    const order = await reviewOps.create({
      userId: req.user._id, email: req.user.email, name: req.user.name,
      address: String(address).slice(0, 300), lat: +lat || null, lon: +lon || null,
      dateOfLoss, notes: String(notes || '').slice(0, 2000),
      price: parseFloat(process.env.REVIEW_PRICE || '150'),
      status: process.env.STRIPE_PRICE_ID_REVIEW ? 'awaiting_payment' : 'requested',
    });

    if (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID_REVIEW) {
      try {
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          customer_email: req.user.email,
          line_items: [{ price: process.env.STRIPE_PRICE_ID_REVIEW, quantity: 1 }],
          success_url: `${baseUrl()}/dashboard?review=paid`,
          cancel_url: `${baseUrl()}/dashboard?review=cancelled`,
          metadata: { reviewId: order._id, kind: 'review' },
        });
        return res.json({ success: true, checkoutUrl: session.url, orderId: order._id });
      } catch (e) { return res.status(500).json({ error: e.message }); }
    }

    // No payment configured: notify the admin to quote and fulfil manually.
    // Respond first; email can be slow or blocked and must not hold up the customer.
    res.json({ success: true, orderId: order._id, status: order.status });
    if (process.env.ADMIN_EMAIL) {
      sendMail({
        to: process.env.ADMIN_EMAIL,
        subject: `Review request: ${order.address} (${order.dateOfLoss})`,
        html: layout('New meteorologist review request', `<p><strong>${escapeHtml(order.name)}</strong> (${escapeHtml(order.email)}) requested a reviewed report.</p>
          <p>${escapeHtml(order.address)}<br>Date of loss: ${order.dateOfLoss}</p><p>${escapeHtml(order.notes)}</p>
          <p><a href="${baseUrl()}/admin#reviews">Open review queue</a></p>`),
      }).catch(() => {});
    }
  });

  app.get('/api/reviews', requireAuth, async (req, res) => {
    res.json({ reviews: await reviewOps.forUser(req.user._id) });
  });

  app.get('/api/admin/reviews', requireAuth, requireAdmin, async (req, res) => {
    res.json({ reviews: await reviewOps.all() });
  });

  app.patch('/api/admin/reviews/:id', requireAuth, requireAdmin, async (req, res) => {
    const { status, reportUrl, adminNotes } = req.body || {};
    const allowed = ['requested', 'awaiting_payment', 'paid', 'in_review', 'completed', 'cancelled'];
    if (status && !allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const order = await reviewOps.get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Not found' });
    await reviewOps.update(order._id, { ...(status ? { status } : {}), ...(reportUrl !== undefined ? { reportUrl } : {}), ...(adminNotes !== undefined ? { adminNotes } : {}) });
    if (status === 'completed' && reportUrl) {
      await sendMail({
        to: order.email,
        subject: `Your reviewed storm report is ready: ${order.address}`,
        html: layout('Reviewed report ready', `<p>The meteorologist review for <strong>${escapeHtml(order.address)}</strong> (date of loss ${order.dateOfLoss}) is complete.</p>
          <p><a href="${escapeHtml(reportUrl)}" style="background:#172235;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Download the report</a></p>`),
      });
    }
    res.json({ success: true });
  });

  // ── Data pipeline admin ───────────────────────────────────────────────────
  app.get('/api/admin/data/status', requireAuth, requireAdmin, (req, res) => res.json(dataJobs.getStatus()));

  app.post('/api/admin/data/ingest-mesh', requireAuth, requireAdmin, async (req, res) => {
    const { date, force } = req.body || {};
    if (!isDate(date)) return res.status(400).json({ error: 'date required' });
    try { res.json(await dataJobs.ingestMeshDay(date, { force: !!force })); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.post('/api/admin/data/sync-ncei', requireAuth, requireAdmin, (req, res) => {
    dataJobs.syncNcei();
    res.json({ started: true });
  });

  app.post('/api/admin/data/rebuild-summaries', requireAuth, requireAdmin, (req, res) => {
    const days = mesh.ingestedDays().filter(d => !req.body?.since || d >= req.body.since);
    setImmediate(() => { for (const d of days) { try { stormDays.summarize(d); } catch { /* skip */ } } });
    res.json({ started: true, days: days.length });
  });

  // Pages for the new tools
  app.get('/report/print', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'report-print.html')));

  void userOps;
};
