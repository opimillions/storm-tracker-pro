/**
 * Watch List Routes — Contact Storm Monitoring
 */
const path = require('path');
const axios = require('axios');

const { geocodeAddress: geocodeAddr } = require('./hail-engine');
const { geocodeBatch } = require('./lib/batch-geocode');

// The old CSV importer split "Street, City ST 12345" on the comma, so the city,
// state and ZIP landed in the phone (or email) field and the street alone could
// not be located. Put them back together.
function repairFields(c) {
  const looksLikeCityLine = v => v && /[a-z]/i.test(v) && /\b\d{5}(-\d{4})?\b/.test(v) && !/@/.test(v);
  if (/\b\d{5}\b/.test(c.address || '')) return null;
  if (looksLikeCityLine(c.phone)) return { address: `${c.address}, ${c.phone}`, phone: c.email && /^[\d\s().+-]{7,}$/.test(c.email) ? c.email : '', email: c.email && /@/.test(c.email) ? c.email : '' };
  if (looksLikeCityLine(c.email)) return { address: `${c.address}, ${c.email}`, email: '' };
  return null;
}

const geocodingUsers = new Set();
// Retry failed addresses once a day in case the geocoder was briefly down.
const needsGeocode = c => c.lat == null && (!c.geocodeFailed || Date.now() - (c.geocodeFailedAt || 0) > 86400000);

/**
 * Locate every contact that has no coordinates yet.
 * 1. Census batch geocoder: up to 1,000 addresses per request, so a large
 *    import is located in minutes rather than one-by-one over hours.
 * 2. Anything the batch did not match goes through the single-address
 *    lookup (Census, then OpenStreetMap), throttled for the free limits.
 * A failure on one contact is logged and skipped; it never stops the run.
 */
async function geocodeMissing(watchlistOps, userId, { batch = geocodeBatch, single = geocodeAddr, pauseMs = 1100 } = {}) {
  if (geocodingUsers.has(userId)) return;
  geocodingUsers.add(userId);
  const save = async (id, fields) => {
    try { await watchlistOps.updateContact(id, fields); return true; }
    catch (e) { console.error('watchlist save failed:', e.message); return false; }
  };
  try {
    const all = await watchlistOps.getForUser(userId);
    for (const c of all) {
      const fix = repairFields(c);
      if (fix && await save(c._id, { ...fix, lat: null, lon: null, geocodeFailed: false })) Object.assign(c, fix, { lat: null, geocodeFailed: false });
    }
    // Every unlocated contact goes in the batch (cheap, even ones that failed
    // before); the slow single lookup is limited to those due for a retry.
    const todo = all.filter(c => c.lat == null && String(c.address || '').trim());
    if (!todo.some(needsGeocode)) return; // only old failures left: wait for their daily retry

    let found = new Map();
    if (todo.length > 3) {
      found = await batch(todo.map(c => ({ id: String(c._id), address: c.address })), { log: m => console.log('[watchlist]', m) });
    }
    let located = 0;
    for (const c of todo) {
      const geo = found.get(String(c._id));
      if (geo && await save(c._id, { lat: geo.lat, lon: geo.lon, formattedAddress: geo.formattedAddress, state: geo.state || null, geocodeFailed: false })) located++;
    }
    for (const c of todo.filter(c => !found.has(String(c._id)) && needsGeocode(c))) {
      let geo = null;
      try { geo = await single(c.address); } catch (e) { geo = null; }
      if (geo) { if (await save(c._id, { lat: geo.lat, lon: geo.lon, formattedAddress: geo.formattedAddress, state: geo.state || null, geocodeFailed: false })) located++; }
      else await save(c._id, { geocodeFailed: true, geocodeFailedAt: Date.now() });
      if (pauseMs) await new Promise(r => setTimeout(r, pauseMs));
    }
    console.log(`[watchlist] located ${located}/${todo.length} addresses for user ${userId}`);
  } finally { geocodingUsers.delete(userId); }
}

/** Background pass over every user with unlocated contacts (no page visit needed). */
async function geocodeAllPending(watchlistOps) {
  if (!watchlistOps.userIdsNeedingGeocode) return;
  let ids = [];
  try { ids = await watchlistOps.userIdsNeedingGeocode(); } catch (e) { console.error('geocode sweep:', e.message); return; }
  for (const id of ids) {
    try { await geocodeMissing(watchlistOps, id); } catch (e) { console.error('geocode sweep:', e.message); }
  }
}

module.exports = function(app, { requireAuth, watchlistOps }) {

  // Locate pending imports in the background: shortly after startup (picks
  // up anything a restart interrupted), then every 30 minutes.
  if (process.env.DATA_JOBS !== 'off') {
    setTimeout(() => geocodeAllPending(watchlistOps), 20000);
    setInterval(() => geocodeAllPending(watchlistOps), 30 * 60 * 1000);
  }

  app.get('/watchlist', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'watchlist.html'));
  });

  // Get contacts for current user
  // "Send me a test alert": emails the signed-in user the portfolio alert they
  // would get if one of their properties were hit. Nothing is saved or synced.
  const testUse = new Map();
  app.post('/api/watchlist/test-alert', requireAuth, async (req, res) => {
    const id = String(req.user._id), now = Date.now();
    const recent = (testUse.get(id) || []).filter(t => now - t < 3600000);
    if (recent.length >= 5) return res.status(429).json({ error: 'You can send 5 test alerts an hour. Try again later.' });
    const list = (await watchlistOps.getForUser(req.user._id)).filter(c => c.lat != null);
    const c = (req.body && req.body.id && list.find(x => x._id === req.body.id)) || list[0];
    if (!c) return res.status(400).json({ error: 'Add a property with a valid address to your portfolio first.' });
    recent.push(now); testUse.set(id, recent);
    const { portfolioEmail } = require('./lib/alerts');
    const { sendMail } = require('./lib/mailer');
    const date = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const msg = portfolioEmail(date, [{ c, best: 1.75, radarIn: 1.75, groundHail: 1.5, tornado: false, sevProb: 80 }], { test: true });
    const sent = await sendMail({ to: req.user.email, subject: msg.subject, html: msg.html });
    if (!sent) return res.status(502).json({ error: 'The email could not be sent. Check email settings (Admin → Test Email).' });
    res.json({ success: true, to: req.user.email, property: c.name || c.address });
  });

  app.get('/api/watchlist', requireAuth, async (req, res) => {
    const contacts = await watchlistOps.getForUser(req.user._id);
    if (contacts.some(needsGeocode) || contacts.some(c => repairFields(c))) geocodeMissing(watchlistOps, req.user._id).catch(e => console.error('geocode:', e.message));
    res.json({ contacts, locating: geocodingUsers.has(req.user._id) });
  });

  // Edit one contact's address (re-locates it)
  app.patch('/api/watchlist/:id', requireAuth, async (req, res) => {
    const address = String(req.body.address || '').trim();
    if (!address) return res.status(400).json({ error: 'Address required' });
    const geo = await geocodeAddr(address);
    if (!geo) return res.status(400).json({ error: 'Could not locate that address. Include city, state and ZIP.' });
    const n = await watchlistOps.updateContactForUser(req.params.id, req.user._id, { address, lat: geo.lat, lon: geo.lon, formattedAddress: geo.formattedAddress, state: geo.state || null, geocodeFailed: false });
    if (!n) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, formattedAddress: geo.formattedAddress });
  });

  // Add single contact
  app.post('/api/watchlist', requireAuth, async (req, res) => {
    const { name, address, phone, email } = req.body;
    if (!name || !address) return res.status(400).json({ error: 'Name and address required' });
    try {
      // Geocode
      const geo = await geocodeAddr(address);
      const contact = await watchlistOps.addContact(req.user._id, {
        name, address, phone: phone||'', email: email||'',
        lat: geo?.lat ?? null, lon: geo?.lon ?? null,
        formattedAddress: geo?.formattedAddress || address,
        state: geo?.state || null, geocodeFailed: !geo
      });
      res.json({ success: true, contact });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Bulk import
  app.post('/api/watchlist/bulk', requireAuth, async (req, res) => {
    const { contacts } = req.body;
    if (!contacts || !contacts.length) return res.status(400).json({ error: 'No contacts provided' });
    
    // Add all contacts immediately (geocode async in background)
    const docs = contacts.slice(0, 2000).map(c => ({ name: String(c.name || '').slice(0, 200), address: String(c.address || '').slice(0, 300), phone: String(c.phone || '').slice(0, 40), email: String(c.email || '').slice(0, 200), lat: null, lon: null }));
    await watchlistOps.bulkAdd(req.user._id, docs);
    
    geocodeMissing(watchlistOps, req.user._id).catch(e => console.error('geocode:', e.message));

    res.json({ success: true, imported: docs.length });
  });

  // Delete every contact (requires typing DELETE in the UI)
  app.delete('/api/watchlist', requireAuth, async (req, res) => {
    if (!req.body || req.body.confirm !== 'DELETE') return res.status(400).json({ error: 'Confirmation required' });
    const removed = await watchlistOps.deleteAllForUser(req.user._id);
    res.json({ success: true, removed });
  });

  // Remove duplicate addresses
  app.post('/api/watchlist/dedupe', requireAuth, async (req, res) => {
    const removed = await watchlistOps.deleteDuplicates(req.user._id);
    res.json({ success: true, removed });
  });

  // Delete one contact (only your own)
  app.delete('/api/watchlist/:id', requireAuth, async (req, res) => {
    const removed = await watchlistOps.deleteContact(req.params.id, req.user._id);
    if (!removed) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  });
};

// ── Storm Checker for Watch List ────────────────────────────────────────────
module.exports._geocodeMissing = geocodeMissing;
