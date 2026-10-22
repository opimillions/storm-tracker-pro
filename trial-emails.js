/**
 * Trial Conversion Email Sequence — StormCheck Pro
 * Day 7: 50% off first month offer
 * Day 14: gentle nudge to use free lookup
 */
module.exports = function(cron, userOps, env) {
  async function sendTrialEmails() {
    if (!require('./lib/mailer').isConfigured()) return;
    try {
      const t = { sendMail: o => require('./lib/mailer').deliver(o), verify: async () => true };
      const base = env.BASE_URL || 'https://stormcheckpro.thepublicadjustertx.com';
      const coupon = env.TRIAL_COUPON_CODE || 'STORM50';
      const from = undefined; // mailer picks EMAIL_FROM

      const allUsers = await userOps.getAll();
      const trialUsers = allUsers.filter(u => u.tier === 'trial' && u.createdAt);

      for (const user of trialUsers) {
        const daysSince = Math.floor((Date.now() - new Date(user.createdAt).getTime()) / 86400000);

        // Day 7: 50% off offer
        if (daysSince === 7 && !user.trialEmail7Sent) {
          try {
            await t.sendMail({
              from,
              to: user.email,
              subject: 'Your exclusive offer: 50% off StormCheck Pro',
              html: `
                <div style="font-family:Arial,sans-serif;max-width:600px">
                  <div style="background:#c0392b;color:white;padding:20px;border-radius:8px 8px 0 0">
                    <h2 style="margin:0">Your exclusive offer expires in 48 hours</h2>
                  </div>
                  <div style="padding:24px;border:1px solid #ddd;border-top:none">
                    <p>Hi ${user.name || 'there'},</p>
                    <p>You signed up for StormCheck Pro a week ago. Storm season is in full swing — and our subscribers are getting alerts and generating lead lists every time hail hits.</p>
                    <p>As a thank-you for trying the platform, we're offering you <strong>50% off your first month</strong> when you upgrade today.</p>
                    <div style="background:#f8f9fa;border-radius:8px;padding:16px;margin:20px 0;text-align:center">
                      <div style="font-size:1.6em;font-weight:900;color:#1a1a2e">Use code: <span style="color:#c0392b">${coupon}</span></div>
                      <div style="font-size:0.85em;color:#888;margin-top:4px">50% off your first month · Offer expires in 48 hours</div>
                    </div>
                    <p><strong>What you get with StormCheck Pro:</strong></p>
                    <ul>
                      <li>Unlimited hail, wind &amp; tornado lookups (TX, OK, CO)</li>
                      <li>Real-time storm alerts — email + push notifications</li>
                      <li>Lead list exports for direct mail campaigns</li>
                      <li>Contact watch list — get alerted when YOUR clients get hit</li>
                      <li>National Hail Map with radar detection</li>
                    </ul>
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
            await userOps.update(user._id, { trialEmail7Sent: true });
            console.log('Trial day-7 email sent:', user.email);
          } catch (e) { console.error('Trial email error (day 7):', e.message); }
        }

        // Day 14: gentle nudge
        if (daysSince === 14 && !user.trialEmail14Sent) {
          try {
            await t.sendMail({
              from,
              to: user.email,
              subject: 'Still thinking about it? Storm season won\'t wait.',
              html: `
                <div style="font-family:Arial,sans-serif;max-width:600px">
                  <div style="background:#1a1a2e;color:white;padding:20px;border-radius:8px 8px 0 0">
                    <h2 style="margin:0">Storm season is here. Are you ready?</h2>
                  </div>
                  <div style="padding:24px;border:1px solid #ddd;border-top:none">
                    <p>Hi ${user.name || 'there'},</p>
                    <p>DFW has seen significant hail activity this spring. StormCheck Pro subscribers received alerts and generated lead lists within hours of each storm — calling clients before any other PA could.</p>
                    <p>If you haven't used your free report yet, try it now. Look up any address and see the full storm history, interactive map, and impact score.</p>
                    <p style="text-align:center;margin:24px 0">
                      <a href="${base}/dashboard" style="background:#c0392b;color:white;padding:14px 28px;border-radius:7px;text-decoration:none;font-weight:700">Use My Free Lookup →</a>
                    </p>
                    <p>Ready to upgrade? Plans start at <strong>$39/month</strong>.</p>
                    <p style="text-align:center;margin:20px 0">
                      <a href="${base}/upgrade" style="background:#172235;color:white;padding:12px 24px;border-radius:7px;text-decoration:none;font-weight:600">View Plans →</a>
                    </p>
                    <p style="font-size:0.82em;color:#888;margin-top:24px">
                      Questions? Call or text <a href="tel:8176189884" style="color:#c0392b">(817) 618-9884</a><br>
                      First Call Public Adjusters · Southlake, TX
                    </p>
                  </div>
                </div>
              `
            });
            await userOps.update(user._id, { trialEmail14Sent: true });
            console.log('Trial day-14 email sent:', user.email);
          } catch (e) { console.error('Trial email error (day 14):', e.message); }
        }
      }
    } catch (err) {
      console.error('Trial email sequence error:', err.message);
    }
  }

  // Run daily at 9 AM CDT
  cron.schedule('0 9 * * *', sendTrialEmails, { timezone: 'America/Chicago' });
  console.log('Trial conversion emails: active (daily 9 AM CDT, day 7 = 50% off, day 14 = nudge)');
};
