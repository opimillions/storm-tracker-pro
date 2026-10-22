/**
 * Watch List Routes — Contact Storm Monitoring
 */
const path = require('path');
const axios = require('axios');

// Geocode an address using Census Bureau (free)
async function geocodeAddr(address) {
  try {
    const r = await axios.get('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress', {
      params: { address, benchmark: 'Public_AR_Current', format: 'json' }, timeout: 8000
    });
    const matches = r.data.result?.addressMatches || [];
    if (!matches.length) return null;
    return { lat: parseFloat(matches[0].coordinates.y), lon: parseFloat(matches[0].coordinates.x), formattedAddress: matches[0].matchedAddress };
  } catch (e) { return null; }
}

// Check if a lat/lon was hit by a storm event on a given date
function getDistanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

module.exports = function(app, { requireAuth, watchlistOps }) {

  app.get('/watchlist', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'watchlist.html'));
  });

  // Get contacts for current user
  app.get('/api/watchlist', requireAuth, async (req, res) => {
    const contacts = await watchlistOps.getForUser(req.user._id);
    res.json({ contacts });
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
        lat: geo?.lat || null, lon: geo?.lon || null,
        formattedAddress: geo?.formattedAddress || address
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
    
    // Geocode in background
    (async () => {
      const all = await watchlistOps.getForUser(req.user._id);
      const ungeocoded = all.filter(c => !c.lat);
      for (const c of ungeocoded) {
        const geo = await geocodeAddr(c.address || c.formattedAddress);
        if (geo) {
          await watchlistOps.updateContact(c._id, { lat: geo.lat, lon: geo.lon, formattedAddress: geo.formattedAddress });
        }
        await new Promise(r => setTimeout(r, 200)); // rate limit
      }
      console.log(`Geocoded ${ungeocoded.length} watchlist contacts for user ${req.user._id}`);
    })();

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
// Called by storm-alerts.js after each SPC check
module.exports.checkWatchlistForStorm = async function(spcEvents, watchlistOps, sendEmailFn, userOps) {
  if (!spcEvents || !spcEvents.length) return;

  // Get all geocoded contacts
  const allContacts = await watchlistOps.getAllWithCoords();
  if (!allContacts.length) return;

  // Group contacts by userId for email grouping
  const userHits = {};

  for (const contact of allContacts) {
    const today = new Date().toISOString().split('T')[0];
    // Skip if already alerted today
    if (contact.lastAlertDate && contact.lastAlertDate.startsWith(today)) continue;

    for (const evt of spcEvents) {
      if (!evt.lat || !evt.lon) continue;
      const dist = getDistanceMiles(contact.lat, contact.lon, evt.lat, evt.lon);
      if (dist <= 1.5) { // within 1.5 miles = definitely hit
        if (!userHits[contact.userId]) userHits[contact.userId] = [];
        userHits[contact.userId].push({ contact, event: evt, distance: dist.toFixed(1) });
        await watchlistOps.markAlerted(contact._id, today);
        break;
      }
    }
  }

  // Send one email per user with all their hit contacts
  for (const [userId, hits] of Object.entries(userHits)) {
    try {
      const user = await userOps.findById(userId);
      if (!user || !user.email) continue;

      const rows = hits.map(h => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee"><strong>${h.contact.name}</strong></td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee">${h.contact.address}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee">${h.event.type === 'tornado' ? `🌪️ EF${h.event.ef||'?'} Tornado` : `🌨️ ${h.event.size_in}" Hail`}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee">${h.distance} mi</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee">${h.contact.phone || '—'}</td>
        </tr>
      `).join('');

      await sendEmailFn(
        `⚠️ ${hits.length} Contact(s) Hit by Storm — StormCheck Pro`,
        `<div style="font-family:Arial,sans-serif;max-width:700px">
          <div style="background:#c0392b;color:white;padding:20px;border-radius:8px 8px 0 0">
            <h2 style="margin:0">⚠️ Storm Hit ${hits.length} Monitored Contact(s)</h2>
          </div>
          <div style="padding:20px;background:#f9f9f9;border:1px solid #ddd;border-top:none">
            <p>The following contacts on your StormCheck Pro watch list were just hit by a storm. <strong>Call them now before anyone else does.</strong></p>
            <table style="width:100%;border-collapse:collapse;margin-top:16px">
              <thead><tr style="background:#1a1a2e;color:white">
                <th style="padding:10px 12px;text-align:left">Contact</th>
                <th style="padding:10px 12px;text-align:left">Address</th>
                <th style="padding:10px 12px;text-align:left">Event</th>
                <th style="padding:10px 12px;text-align:left">Distance</th>
                <th style="padding:10px 12px;text-align:left">Phone</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
            <p style="margin-top:20px">
              <a href="${process.env.BASE_URL}/watchlist" style="background:#c0392b;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold">View Watch List →</a>
            </p>
          </div>
          <div style="background:#1a1a2e;color:rgba(255,255,255,0.6);padding:12px 20px;font-size:0.8em;border-radius:0 0 8px 8px">
            StormCheck Pro · First Call Public Adjusters · (817) 618-9884
          </div>
        </div>`
      );
      console.log(`Watch list alert sent to ${user.email}: ${hits.length} contacts hit`);
    } catch (err) {
      console.error('Watch list email error:', err.message);
    }
  }
};
