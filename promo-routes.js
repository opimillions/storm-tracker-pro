/**
 * Promo Email Routes — Admin-triggered STORM50 campaign
 */
module.exports = function(app, { requireAuth, requireAdmin, userOps }) {

  async function sendPromoMail(to, name, base, coupon) {
    if (!require('./lib/mailer').isConfigured()) return false;
    const t = { sendMail: o => require('./lib/mailer').deliver(o), verify: async () => true };
    await t.sendMail({
            to,
      subject: 'Your exclusive offer: 50% off StormCheck Pro for 6 months',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px">
          <div style="background:#c0392b;color:white;padding:20px;border-radius:8px 8px 0 0">
            <h2 style="margin:0">Special offer — storm season is here</h2>
          </div>
          <div style="padding:24px;border:1px solid #ddd;border-top:none">
            <p>Hi ${name || 'there'},</p>
            <p>As a StormCheck Pro trial user, we want to give you <strong>50% off for your first 6 months</strong>.</p>
            <p>DFW has had significant hail activity this spring. Our subscribers are getting real-time alerts and generating lead lists within hours of each storm hitting.</p>
            <div style="background:#f8f9fa;border-radius:8px;padding:16px;margin:20px 0;text-align:center">
              <div style="font-size:1.6em;font-weight:900;color:#1a1a2e">Use code: <span style="color:#c0392b">${coupon}</span></div>
              <div style="font-size:0.85em;color:#888;margin-top:4px">50% off for 6 months · Limited time</div>
            </div>
            <p style="text-align:center;margin-top:24px">
              <a href="${base}/upgrade" style="background:#c0392b;color:white;padding:14px 28px;border-radius:7px;text-decoration:none;font-weight:700;font-size:1.05em">Claim 50% Off Now →</a>
            </p>
            <p style="font-size:0.82em;color:#888;margin-top:24px">
              Questions? Call or text <a href="tel:8176189884" style="color:#c0392b">(817) 618-9884</a><br>
              First Call Public Adjusters · Southlake, TX
            </p>
          </div>
        </div>
      `
    });
    return true;
  }

  // Send promo to single user
  app.post('/api/admin/send-promo', requireAuth, requireAdmin, async (req, res) => {
    const { email, userId } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    try {
      const base = process.env.BASE_URL || 'https://stormcheckpro.thepublicadjustertx.com';
      const coupon = process.env.TRIAL_COUPON_CODE || 'STORM50';
      const user = userId ? await userOps.findById(userId) : null;
      await sendPromoMail(email, user?.name, base, coupon);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Send promo to all trial users
  app.post('/api/admin/send-promo-all', requireAuth, requireAdmin, async (req, res) => {
    try {
      const allUsers = await userOps.getAll();
      const trialUsers = allUsers.filter(u => u.tier === 'trial' && u.email);
      const base = process.env.BASE_URL || 'https://stormcheckpro.thepublicadjustertx.com';
      const coupon = process.env.TRIAL_COUPON_CODE || 'STORM50';
      let sent = 0;
      for (const user of trialUsers) {
        try {
          await sendPromoMail(user.email, user.name, base, coupon);
          sent++;
          await new Promise(r => setTimeout(r, 400)); // rate limit Gmail
        } catch (e) { console.error('Promo error for', user.email, ':', e.message); }
      }
      res.json({ success: true, sent });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
};
