/**
 * Affiliate Routes — StormCheck Pro
 * Handles affiliate registration, dashboard, tracking, and admin management
 */
const path = require('path');

module.exports = function(app, { requireAuth, requireAdmin, affiliateOps, AFFILIATE_COMMISSION }) {

  // Affiliate dashboard page
  app.get('/affiliate', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'affiliate.html'));
  });

  // Get my affiliate info
  app.get('/api/affiliate/me', requireAuth, async (req, res) => {
    let aff = await affiliateOps.findByUserId(req.user._id);
    res.json({ affiliate: aff, commissionRate: AFFILIATE_COMMISSION });
  });

  // Apply to become an affiliate
  app.post('/api/affiliate/apply', requireAuth, async (req, res) => {
    const existing = await affiliateOps.findByUserId(req.user._id);
    if (existing) return res.json({ affiliate: existing });
    try {
      const aff = await affiliateOps.create(req.user._id, req.user.name, req.user.email);
      res.json({ success: true, affiliate: aff });
    } catch (err) {
      res.status(500).json({ error: 'Failed to create affiliate account. ' + err.message });
    }
  });

  // Admin: get all affiliates
  app.get('/api/admin/affiliates', requireAuth, requireAdmin, async (req, res) => {
    const all = await affiliateOps.getAll();
    const stats = await affiliateOps.getStats();
    res.json({ affiliates: all, stats });
  });

  // Admin: approve/disable affiliate
  app.patch('/api/admin/affiliates/:code', requireAuth, requireAdmin, async (req, res) => {
    const { enabled } = req.body;
    const { affiliates } = require('./db');
    await affiliates.update({ code: req.params.code }, { $set: { enabled } });
    res.json({ success: true });
  });

  // Track referral link click (called from landing page JS when ?ref= is in URL)
  app.get('/api/ref/:code', async (req, res) => {
    const code = req.params.code.toUpperCase();
    const aff = await affiliateOps.findByCode(code);
    if (aff) {
      res.cookie('ref', code, { maxAge: 30*24*60*60*1000, httpOnly: false, path: '/' });
    }
    res.redirect('/register' + (req.query.next ? '?next=' + req.query.next : ''));
  });
};
