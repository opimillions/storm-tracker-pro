/**
 * CRM integration routes: connect/disconnect JobNimbus, AccuLynx and webhooks,
 * manual sync, test events, and the public inbound webhook.
 */
const path = require('path');
const integrations = require('./lib/integrations');
const { baseUrl } = require('./lib/mailer');

const TYPES = ['jobnimbus', 'acculynx', 'webhook'];

module.exports = function integrationRoutes(app, { requireAuth, tierFeatures, db }) {
  const { integrationOps, watchlistOps } = db;

  // Paid plans only (trial and suspended accounts can see the page but not connect).
  const requirePaid = (req, res, next) => {
    if (['trial', 'suspended'].includes(req.user.tier)) return res.status(402).json({ error: 'CRM integrations are included with paid plans.', upgrade: true });
    next();
  };

  app.get('/integrations', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'integrations.html')));

  app.get('/api/integrations', requireAuth, async (req, res) => {
    const list = await integrationOps.getForUser(req.user._id);
    const byType = Object.fromEntries(list.filter(i => TYPES.includes(i.type)).map(i => [i.type, integrations.publicView(i)]));
    const contacts = await watchlistOps.getForUser(req.user._id);
    const counts = {};
    for (const c of contacts) if (c.source) counts[c.source] = (counts[c.source] || 0) + 1;
    const token = await integrationOps.inboundToken(req.user._id, integrations.newToken);
    res.json({
      integrations: byType, counts,
      inboundUrl: `${baseUrl()}/api/integrations/inbound/${token}`,
      paid: !['trial', 'suspended'].includes(req.user.tier),
    });
  });

  app.post('/api/integrations/:type/connect', requireAuth, requirePaid, async (req, res) => {
    const { type } = req.params;
    if (!TYPES.includes(type)) return res.status(404).json({ error: 'Unknown integration' });
    try {
      const r = await integrations.connect(req.user._id, type, { apiKey: req.body.apiKey, url: req.body.url, pushNotes: req.body.pushNotes });
      res.json({ success: true, ...r });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.patch('/api/integrations/:type', requireAuth, requirePaid, async (req, res) => {
    const { type } = req.params;
    const integ = await integrationOps.get(req.user._id, type);
    if (!integ) return res.status(404).json({ error: 'Not connected' });
    await integrationOps.upsert(req.user._id, type, { pushNotes: req.body.pushNotes !== false });
    res.json({ success: true });
  });

  app.post('/api/integrations/:type/sync', requireAuth, requirePaid, async (req, res) => {
    const { type } = req.params;
    if (!integrations.PROVIDERS[type]) return res.status(400).json({ error: 'Nothing to sync for this integration' });
    if (!await integrationOps.get(req.user._id, type)) return res.status(404).json({ error: 'Not connected' });
    integrations.syncUser(req.user._id, type).catch(e => console.error(`[integrations] ${type} sync:`, e.message));
    res.json({ started: true });
  });

  app.post('/api/integrations/webhook/test', requireAuth, requirePaid, async (req, res) => {
    try { res.json({ success: true, payload: await integrations.sendTestWebhook(req.user._id) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/integrations/inbound-token/rotate', requireAuth, requirePaid, async (req, res) => {
    const token = await integrationOps.rotateInboundToken(req.user._id, integrations.newToken);
    res.json({ inboundUrl: `${baseUrl()}/api/integrations/inbound/${token}` });
  });

  app.delete('/api/integrations/:type', requireAuth, async (req, res) => {
    const { type } = req.params;
    if (!TYPES.includes(type)) return res.status(404).json({ error: 'Unknown integration' });
    await integrationOps.remove(req.user._id, type);
    let removed = 0;
    if (req.body && req.body.removeProperties && type !== 'webhook') {
      const mine = (await watchlistOps.getForUser(req.user._id)).filter(c => c.source === type);
      for (const c of mine) { await watchlistOps.deleteContact(c._id, req.user._id); removed++; }
    }
    res.json({ success: true, removed });
  });

  // Public: Zapier / Make / a CRM posts new clients or properties here.
  const hits = new Map();
  app.post('/api/integrations/inbound/:token', async (req, res) => {
    const k = req.params.token;
    const now = Date.now();
    const arr = (hits.get(k) || []).filter(t => now - t < 60000); arr.push(now); hits.set(k, arr);
    if (arr.length > 120) return res.status(429).json({ error: 'Too many requests' });
    try { res.json({ success: true, ...(await integrations.inbound(k, req.body)) }); }
    catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not add property' }); }
  });

  void tierFeatures;
};
