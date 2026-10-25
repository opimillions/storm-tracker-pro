/**
 * Storm recap emails: map images, unsubscribe and the admin API.
 */
const recaps = require('./lib/recaps');
const stormImage = require('./lib/storm-image');
const mesh = require('./lib/mesh-store');
const { parseCsv, toCsv } = require('./lib/csv');
const { sendMail } = require('./lib/mailer');

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function unsubPage(title, msg) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} | StormCheck Pro</title><link rel="stylesheet" href="/site.css"></head>
<body><main><section><div class="wrap narrow"><h1>${esc(title)}</h1><p class="lede">${msg}</p><p><a href="/">StormCheck Pro home</a></p></div></section></main></body></html>`;
}

module.exports = function recapRoutes(app, { db, requireAuth, requireAdmin }) {
  const { prospectOps, freeAlertOps } = db;

  // ── Map image used inside recap emails ────────────────────────────────────
  const rendering = new Map();
  app.get('/storm-images/:date.png', async (req, res) => {
    const { date } = req.params;
    const b = String(req.query.b || '').split(',').map(Number);
    if (!isDate(date) || b.length !== 4 || !b.every(Number.isFinite)) return res.status(400).end();
    const [w, s, e, n] = b;
    if (e <= w || n <= s || e - w > 8 || n - s > 6 || s < 15 || n > 60 || w < -135 || e > -55) return res.status(400).end();
    if (!mesh.hasDay(date)) return res.status(404).end();
    const c = String(req.query.c || '').split(',').map(Number);
    const center = c.length === 2 && c.every(Number.isFinite) ? { lat: c[0], lon: c[1] } : null;
    const key = `${date}|${b.join(',')}|${c.join(',')}`;
    try {
      if (!rendering.has(key)) rendering.set(key, stormImage.cached(date, b, { center }).finally(() => rendering.delete(key)));
      const png = await rendering.get(key);
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=604800');
      res.send(png);
    } catch (err) {
      console.error('[storm-image]', err.message);
      res.status(500).end();
    }
  });

  // ── Unsubscribe (link and RFC 8058 one-click POST) ────────────────────────
  app.get('/recap/unsubscribe', async (req, res) => {
    const p = await prospectOps.byToken(String(req.query.t || ''));
    if (p) await prospectOps.unsubscribe(p.token);
    res.send(unsubPage('You are unsubscribed.', 'You will not get any more storm recap emails from StormCheck Pro.'));
  });
  app.post('/recap/unsubscribe', async (req, res) => {
    const p = await prospectOps.byToken(String(req.query.t || ''));
    if (p) await prospectOps.unsubscribe(p.token);
    res.status(200).send('Unsubscribed');
  });
  app.post('/alerts/unsubscribe', async (req, res) => {
    if (req.query.token) await freeAlertOps.unsubscribe(String(req.query.token));
    res.status(200).send('Unsubscribed');
  });

  // ── Admin ─────────────────────────────────────────────────────────────────
  const admin = [requireAuth, requireAdmin];

  app.get('/api/admin/recaps', ...admin, async (req, res) => {
    const [counts, list] = await Promise.all([prospectOps.counts(), prospectOps.list({ limit: 100 })]);
    res.json({
      settings: recaps.settings(),
      addressSet: !!recaps.businessAddress(),
      envAddress: !!process.env.BUSINESS_ADDRESS,
      counts,
      prospects: list.map(p => ({ _id: p._id, email: p.email, name: p.name, company: p.company, label: p.label, active: p.active, recaps: p.recaps || 0, lastRecapDate: p.lastRecapDate || null })),
      runs: recaps.recentRuns().slice(0, 15),
      recentDays: mesh.ingestedDays().slice(-14).reverse().map(d => ({ date: d, maxIn: (mesh.dayInfo(d) || {}).maxIn || 0 })),
    });
  });

  app.post('/api/admin/recaps/settings', ...admin, (req, res) => {
    const s = recaps.saveSettings(req.body || {});
    if (s.enabled && !recaps.businessAddress()) {
      recaps.saveSettings({ enabled: false });
      return res.status(400).json({ error: 'Add your business mailing address first. U.S. law (CAN-SPAM) requires it in every marketing email.', settings: recaps.settings() });
    }
    res.json({ settings: s });
  });

  app.post('/api/admin/recaps/import', ...admin, async (req, res) => {
    const csv = String((req.body && req.body.csv) || '');
    if (!csv.trim()) return res.status(400).json({ error: 'Choose a CSV file.' });
    if (csv.length > 1.9e6) return res.status(400).json({ error: 'File too large (about 2 MB max). Split it into smaller files.' });
    const { prospects, errors } = recaps.parseProspects(parseCsv(csv));
    const r = prospects.length ? await prospectOps.upsertMany(prospects) : { added: 0, updated: 0, skipped: 0 };
    res.json({ ...r, errors: errors.slice(0, 50), errorCount: errors.length });
  });

  app.delete('/api/admin/recaps/prospects/:id', ...admin, async (req, res) => {
    await prospectOps.remove(req.params.id);
    res.json({ success: true });
  });

  app.get('/api/admin/recaps/prospects.csv', ...admin, async (req, res) => {
    const all = await prospectOps.all();
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', 'attachment; filename="storm-recap-prospects.csv"');
    res.send(toCsv([['Email', 'Name', 'Company', 'Location', 'ZIP', 'Status', 'Recaps sent', 'Last recap', 'Added'],
      ...all.map(p => [p.email, p.name, p.company, p.label, p.zip, p.active ? 'Active' : 'Unsubscribed', p.recaps || 0, p.lastRecapDate || '', (p.createdAt || '').slice(0, 10)])]));
  });

  // Preview: the email a recipient at `zip` would get for `date`.
  app.post('/api/admin/recaps/preview', ...admin, async (req, res) => {
    const { date } = req.body || {};
    const z = require('./lib/places').zipInfo(String((req.body || {}).zip || '').trim());
    if (!isDate(date)) return res.status(400).json({ error: 'Pick a storm date.' });
    if (!z) return res.status(400).json({ error: 'Enter a valid ZIP code.' });
    const cfg = recaps.settings();
    const recap = recaps.buildRecap(date, z.lat, z.lon, { label: `${z.city}, ${z.state}`, radiusMi: cfg.radiusMi, minIn: cfg.minIn, unsubUrl: '#', firstName: '' });
    if (!recap) return res.json({ none: true, message: `No ${cfg.minIn}"+ hail within ${cfg.radiusMi} miles of ${z.city}, ${z.state} on that date.` });
    let to = null;
    if (req.body.send) {
      to = req.user.email;
      await sendMail({ to, subject: '[Test] ' + recap.subject, html: recap.html, text: recap.text });
    }
    // In the admin preview, load the map from this server so it shows before deploy too.
    const base = require('./lib/mailer').baseUrl();
    res.json({ subject: recap.subject, html: recap.html.split(base + '/storm-images/').join('/storm-images/'), sentTo: to });
  });

  // Send (or count with dryRun) the recap for a date to every prospect in the hit area.
  app.post('/api/admin/recaps/send', ...admin, async (req, res) => {
    const { date, dryRun } = req.body || {};
    if (!isDate(date)) return res.status(400).json({ error: 'Pick a storm date.' });
    if (dryRun) return res.json(await recaps.sendForDate(date, db, { manual: true, dryRun: true }));
    if (!recaps.businessAddress()) return res.status(400).json({ error: 'Add your business mailing address first.' });
    // Large lists take a while; run in the background and report in the log.
    recaps.sendForDate(date, db, { manual: true }).catch(e => console.error('[recap]', e.message));
    res.json({ started: true });
  });
};
