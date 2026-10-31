/**
 * StormCheck Pro — Express Server
 * stormcheckpro.thepublicadjustertx.com
 */
require('dotenv').config();

// Log instead of crashing: one failed background task must not take the site down.
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err && err.stack || err));
process.on('uncaughtException', err => console.error('Uncaught exception:', err && err.stack || err));

// Trim storm data to the retention window before the databases load, so a
// full volume gets space back before anything else needs to write.
try { require('./lib/retention').prune(); } catch (e) { console.error('Retention prune failed:', e.message); }
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const cron = require('node-cron');

const db = require('./db');
const { userOps, lookupOps, alertOps, profileOps, resultsCacheOps, affiliateOps, watchlistOps, alertSettingsOps, freeAlertOps, reviewOps, AFFILIATE_COMMISSION, TIERS, tierFeatures, tierLookupLimit } = db;
const compression = require('compression');
const reportEngine = require('./lib/report-engine');
const spcStore = require('./lib/spc-store');
const dataJobs = require('./lib/data-jobs');
const { generateToken, generateMfaTicket, requireAuth, requireAdmin, requireActiveSubscription } = require('./auth');
const security = require('./lib/security');
const { geocodeAddress, reverseGeocode, fetchHailHistory, getImpactScore, getImpactRating } = require('./hail-engine');
const axios = require('axios');

// Simple in-memory cache for lookup results (saves re-scanning same address)
const lookupCache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours (reduced from 24h so recent storms appear faster)

// Async job store — holds in-progress and completed lookups
const jobs = new Map(); // jobId -> { status, result, error, startedAt }

const app = express();
// Railway sits one proxy hop in front of the app; use the real visitor IP for rate limits.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(security.headers());

const PORT = process.env.PORT || 3000;

// ── Stripe Webhook ────────────────────────────────────────────────────────────
// Registered before express.json() so the raw body is available for the
// signature check (with JSON parsing first, every webhook failed verification).
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).send('Stripe not configured');
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const meta = session.metadata || {};
        if (meta.kind === 'review' && meta.reviewId) {
          await reviewOps.update(meta.reviewId, { status: 'paid', stripeSessionId: session.id });
          break;
        }
        const purchasedTier = meta.tier || 'pro';
        const email = session.customer_email || (session.customer_details && session.customer_details.email);
        const user = (meta.userId && await userOps.findById(meta.userId)) || (email && await userOps.findByEmail(email));
        if (user) {
          await userOps.updateSubscription(user._id, { customerId: session.customer, subscriptionId: session.subscription, status: 'active', tier: purchasedTier });
          await userOps.updateTier(user._id, purchasedTier, tierLookupLimit(purchasedTier));
          if (user.referredBy) { try { await affiliateOps.recordReferral(user.referredBy, user._id, purchasedTier); } catch (e) { /* non-fatal */ } }
          console.log('Subscription activated: ' + user.email + ' -> ' + purchasedTier);
        }
        break;
      }
      case 'customer.subscription.deleted':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const user = await userOps.findByStripeCustomer(sub.customer);
        if (user) {
          const active = sub.status === 'active' || sub.status === 'trialing';
          await userOps.updateSubscription(user._id, { status: sub.status, tier: active ? user.tier : 'trial' });
          if (!active) await userOps.updateTier(user._id, 'trial', tierLookupLimit('trial'));
        }
        break;
      }
    }
  } catch (err) {
    console.error('Webhook handling error:', err.message);
  }
  res.json({ received: true });
});

app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Force HTTPS in production
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, 'https://' + req.headers.host + req.url);
    }
    next();
  });
}

app.use(express.static(path.join(__dirname, 'public')));

// ── Auth Routes ───────────────────────────────────────────────────────────────

// Login page
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

// Register page
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));

// POST login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const wait = security.lockedFor(email, req.ip);
  if (wait) return res.status(429).json({ error: `Too many wrong passwords. Try again in ${wait} minute${wait === 1 ? '' : 's'}, or reset your password.` });
  try {
    const user = await userOps.findByEmail(email);
    if (!user || !userOps.verifyPassword(user, password)) {
      security.recordFailure(email, req.ip);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    security.clearFailures(email);
    if (user.tier === 'suspended') {
      return res.status(403).json({ error: 'Your account has been suspended. Contact (817) 618-9884.' });
    }
    // A failed bookkeeping write (e.g. a full disk) must not block sign-in.
    try { await userOps.updateLastLogin(user._id); } catch (e) { console.error('updateLastLogin failed:', e.message); }
    // Track affiliate referral if ref cookie set
    const refCode = (req.cookies && req.cookies.ref) ? req.cookies.ref : null;
    if (refCode && user) {
      try { const aff = await affiliateOps.findByCode(refCode); if (aff) { await userOps.update(user._id, { referredBy: refCode.toUpperCase() }); console.log('Referral tracked: ' + email + ' by ' + refCode); } } catch(re) {}
      res.clearCookie('ref');
    }
    // Two-step sign-in: password was right; now ask for the authenticator code.
    if (user.totpEnabled) return res.json({ twoFactor: true, ticket: generateMfaTicket(user) });
    security.setSessionCookie(req, res, generateToken(user));
    res.json({ success: true, redirect: user.role === 'admin' ? '/admin' : '/dashboard' });
  } catch (err) {
    console.error('Login error:', err && err.stack || err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// POST register
// Track referral code from URL (?ref=CODE) — set cookie
app.get('/api/track-ref', (req, res) => {
  const code = req.query.ref;
  if (code) res.cookie('ref', code.toUpperCase(), { maxAge: 30*24*60*60*1000, httpOnly: false });
  res.json({ ok: true });
});

app.post('/api/auth/register', async (req, res) => {
  const { email, password, name, company } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Name, email, and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const existing = await userOps.findByEmail(email);
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });
    // Partner invite (/join/CODE): free Partner account instead of the trial.
    const inviteCode = (req.body && req.body.invite) || (req.cookies && req.cookies.scp_invite) || null;
    const invite = inviteCode ? await db.inviteOps.usable(inviteCode) : null;
    await userOps.create(invite
      ? { email, password, name, company, phone: req.body.phone, role: 'subscriber', tier: invite.tier || 'partner', invitedBy: invite.code }
      : { email, password, name, company, phone: req.body.phone, role: 'subscriber', tier: 'trial', lookupLimit: 1 });
    if (invite) { await db.inviteOps.use(invite.code); res.clearCookie('scp_invite'); }
    // Record where the sign-up came from (UTM tags kept by /js/tracking.js).
    const utm = require('./tracking-routes').readUtm(req);
    if (utm) { const nu = await userOps.findByEmail(email); if (nu) await userOps.update(nu._id, { signupSource: utm }); }
    const user = await userOps.findByEmail(email);
    // Track affiliate referral if ref cookie set
    const refCode = (req.cookies && req.cookies.ref) ? req.cookies.ref : null;
    if (refCode && user) {
      try { const aff = await affiliateOps.findByCode(refCode); if (aff) { await userOps.update(user._id, { referredBy: refCode.toUpperCase() }); console.log('Referral: '+email+' by '+refCode); } } catch(re) {}
      res.clearCookie('ref');
    }
    security.setSessionCookie(req, res, generateToken(user));
    res.json({ success: true, redirect: '/dashboard' });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// Forgot password
app.get('/forgot-password', (req, res) => res.sendFile(path.join(__dirname, 'public', 'forgot-password.html')));
app.get('/reset-password', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset-password.html')));

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  // Limit reset emails per address and per IP (shares the sign-in limiter).
  if (security.lockedFor('reset:' + email, req.ip)) return res.json({ success: true });
  security.recordFailure('reset:' + email, req.ip);
  try {
    const user = await userOps.findByEmail(email);
    if (user) {
      const crypto = require('crypto');
      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
      await userOps.setResetToken(email, token, expires);
      const baseUrl = process.env.BASE_URL || 'https://stormcheckpro.thepublicadjustertx.com';
      const resetUrl = `${baseUrl}/reset-password?token=${token}`;
      // Send the reset email (Resend or SMTP).
      const mailer = require('./lib/mailer');
      if (mailer.isConfigured()) {
        const sent = await mailer.sendMail({
          to: email,
          subject: 'Reset your StormCheck Pro password',
          html: mailer.layout('Password reset', `<p>Click the button below to reset your password. This link expires in 1 hour.</p><p><a href="${resetUrl}" style="background:#172235;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Reset password</a></p><p style="color:#5b6a80;font-size:13px">Or paste this link: ${resetUrl}</p><p style="color:#5b6a80;font-size:13px">If you didn't request this, ignore this email.</p>`),
        });
        // Never write the link itself to the logs: anyone who can read logs could use it.
        if (!sent) console.error(`Password reset email to ${email} failed. Check email settings (Admin → Test Email).`);
      } else {
        console.error(`Password reset requested for ${email}, but email is not configured (set RESEND_API_KEY).`);
      }
    }
    // Always return success to prevent email enumeration
    res.json({ success: true });
  } catch (err) {
    console.error('Forgot password error:', err.message);
    res.json({ success: true }); // still return success
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const user = await userOps.findByResetToken(token);
    if (!user) return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync(password, 12);
    await userOps.clearResetToken(user._id, hash);
    security.clearFailures(user.email);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Reset failed. Please try again.' });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  security.clearSessionCookie(req, res);
  res.json({ success: true });
});

// Sign out of every device (ends all sessions, including this one).
app.post('/api/auth/logout-all', requireAuth, async (req, res) => {
  await userOps.bumpTokenVersion(req.user._id);
  security.clearSessionCookie(req, res);
  res.json({ success: true });
});

// ── Dashboard ─────────────────────────────────────────────────────────────────

app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/upgrade', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'upgrade.html'));
});

// User info API
app.get('/api/me', requireAuth, async (req, res) => {
  // Never send secrets back to the browser, even the user's own.
  const { passwordHash, resetToken, resetTokenExpires, totpSecret, totpPending, totpBackup, totpLastStep, tokenVersion, ...user } = req.user;
  const recentLookups = await lookupOps.getForUser(user._id, 10);
  const features = tierFeatures(user.tier);
  // Add watchedStates and maxStates to response
  const maxStates = features.maxStates || 1;
  const profile = (features.branding || features.logo) ? await profileOps.get(user._id) : null;
  res.json({ user, recentLookups, features, profile });
});



// Cache clear route (admin) — use after engine fix or when recent storm missing
app.post('/api/admin/clear-cache', requireAuth, requireAdmin, async (req, res) => {
  const before = lookupCache.size;
  lookupCache.clear();
  try { await resultsCacheOps.clearAll(); } catch(e) { /* ignore */ }
  res.json({ success: true, message: `Cleared ${before} cached lookups. Next searches will re-fetch fresh data.` });
});

// SMTP test route
app.get('/api/admin/test-smtp', requireAuth, requireAdmin, async (req, res) => {
  res.json(await require('./lib/mailer').testSend(process.env.ADMIN_EMAIL));
});

// Promo routes
require('./promo-routes')(app, { requireAuth, requireAdmin, userOps });

// Watch List routes
const watchlistRoutes = require('./watchlist-routes');
watchlistRoutes(app, { requireAuth, watchlistOps });


// -- Phone / browser push alerts (saved per user; see lib/push.js) -------------
const push = require('./lib/push');
push.init(db);
const validSub = s => s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 1000
  && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string' && s.keys.p256dh.length < 200 && s.keys.auth.length < 100;
app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  if (!validSub(req.body)) return res.status(400).json({ error: 'Invalid subscription' });
  if ((await db.pushOps.countForUser(req.user._id)) >= 10) return res.status(400).json({ error: 'Too many devices. Turn alerts off on an old device first.' });
  await db.pushOps.save(req.user._id, req.body, req.get('user-agent'));
  res.json({ success: true });
});
app.post('/api/push/unsubscribe', requireAuth, async (req, res) => {
  if (req.body && req.body.endpoint) await db.pushOps.removeForUser(req.user._id, String(req.body.endpoint));
  res.json({ success: true });
});
app.get('/api/push/vapid-key', (req, res) => res.json({ publicKey: push.publicKey() }));
app.get('/api/push/status', requireAuth, async (req, res) => res.json({ devices: await db.pushOps.countForUser(req.user._id) }));
const pushTests = new Map();
app.post('/api/push/test', requireAuth, async (req, res) => {
  const id = String(req.user._id), now = Date.now();
  const recent = (pushTests.get(id) || []).filter(t => now - t < 3600000);
  if (recent.length >= 5) return res.status(429).json({ error: 'You can send 5 test notifications an hour.' });
  recent.push(now); pushTests.set(id, recent);
  const sent = await push.sendToUser(req.user._id, { title: 'StormCheck Pro test alert', body: 'Phone alerts are working. You will get a notification like this when hail hits your properties or territories.', url: '/alert-settings', tag: 'test' });
  res.json({ sent });
});

// Affiliate routes
require('./affiliate-routes')(app, { requireAuth, requireAdmin, affiliateOps, AFFILIATE_COMMISSION });

// Storm activity page
app.get('/onboarding', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'onboarding.html')));
app.post('/api/me/states', requireAuth, async (req, res) => {
  const { states } = req.body;
  await userOps.update(req.user._id, { watchedStates: states, onboardingComplete: true });
  res.json({ success: true });
});

// Street View for a property: the nearest street-level photo (within ~110 yd)
// and the compass direction from it to the house, so the view faces the home.
// Google's Street View metadata lookup is free; it needs a server key with the
// Street View Static API enabled (GOOGLE_MAPS_SERVER_KEY, else the embed key).
const svCache = new Map();
app.get('/api/streetview', requireAuth, async (req, res) => {
  const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'lat and lon required' });
  const key = String(process.env.GOOGLE_MAPS_SERVER_KEY || process.env.GOOGLE_MAPS_EMBED_KEY || '').trim();
  if (!key) return res.json({ available: false, reason: 'no-key' });
  const ck = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (svCache.has(ck)) return res.json(svCache.get(ck));
  try {
    const r = await axios.get('https://maps.googleapis.com/maps/api/streetview/metadata', {
      params: { location: `${lat},${lon}`, radius: 100, source: 'outdoor', key }, timeout: 8000,
    });
    let out = { available: false, reason: r.data && r.data.status };
    if (r.data && r.data.status === 'OK' && r.data.location) {
      const pl = r.data.location.lat, pn = r.data.location.lng;
      const toRad = d => d * Math.PI / 180, toDeg = r2 => r2 * 180 / Math.PI;
      const y = Math.sin(toRad(lon - pn)) * Math.cos(toRad(lat));
      const x = Math.cos(toRad(pl)) * Math.sin(toRad(lat)) - Math.sin(toRad(pl)) * Math.cos(toRad(lat)) * Math.cos(toRad(lon - pn));
      out = { available: true, panoId: r.data.pano_id, lat: pl, lon: pn, heading: Math.round((toDeg(Math.atan2(y, x)) + 360) % 360), date: r.data.date || null };
    }
    svCache.set(ck, out); if (svCache.size > 5000) svCache.clear();
    res.json(out);
  } catch (e) {
    res.json({ available: false, reason: 'lookup-failed' });
  }
});

// Browser-side Google Maps Embed key (restrict it to this domain in Google Cloud).
app.get('/api/config/maps', (req, res) => {
  const k = String(process.env.GOOGLE_MAPS_EMBED_KEY || '').trim();
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ embedKey: /^[A-Za-z0-9_-]{20,60}$/.test(k) ? k : null });
});
app.get('/alert-settings', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'alert-settings.html')));
app.get('/api/alert-settings', requireAuth, async (req, res) => { const settings = await alertSettingsOps.get(req.user._id); res.json({ settings }); });
app.post('/api/alert-settings', requireAuth, async (req, res) => {
  const b = req.body || {};
  const num = (v, lo, hi, d) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const regions = (Array.isArray(b.regions) ? b.regions : []).slice(0, 25)
    .map(r => ({ name: String(r.name || 'Region').slice(0, 80), lat: num(r.lat, -90, 90, NaN), lon: num(r.lon, -180, 180, NaN), radius: Math.round(num(r.radius, 1, 250, 50)) }))
    .filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lon));
  await alertSettingsOps.save(req.user._id, {
    minHailSize: num(b.minHailSize, 0.5, 4, 1),
    minSevProb: Math.round(num(b.minSevProb, 0, 100, 0)),
    alertHail: b.alertHail !== false, alertWind: b.alertWind !== false,
    alertTornado: b.alertTornado !== false, alertEmail: b.alertEmail !== false,
    regions,
  });
  res.json({ success: true });
});

app.get('/hailmap', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'hailmap.html')));
app.get('/storms', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'storms.html')));
app.get('/leads', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'leads.html')));

// Storm events API — pulls SPC data for the user's watched states
app.get('/api/storms', requireAuth, async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 7, 730); // max 2 years
  const events = [];
  const today = new Date();

  // Filter by user's watched states, falling back to TX/OK/CO for legacy accounts
  // with no selection yet. Admin/enterprise users with no selection get all states.
  const features = tierFeatures(req.user.tier);
  const watched = Array.isArray(req.user.watchedStates) ? req.user.watchedStates.filter(Boolean) : [];
  let stateFilter;
  if (watched.length > 0) {
    stateFilter = Object.fromEntries(watched.map(s => [String(s).toUpperCase(), true]));
  } else if (features.maxStates === -1) {
    stateFilter = null; // unlimited tier, no selection → show every state SPC reports
  } else {
    stateFilter = null; // no selection yet → nationwide
  }

  const sizeName = require('./lib/hail-scale').sizeName;
  for (let d = 0; d < days; d++) {
    const fullDate = new Date(Date.parse(spcStore.today() + 'T00:00:00Z') - d * 86400000).toISOString().slice(0, 10);
    const r = spcStore.reportsForDay(fullDate);
    const ok = e => !stateFilter || stateFilter[e.state];
    for (const e of r.hail) {
      if (!ok(e) || !(e.mag >= 0.75)) continue;
      events.push({ type: 'hail', date: fullDate, size_in: e.mag, size_desc: sizeName(e.mag), location: [e.loc, e.state].filter(Boolean).join(', '), county: e.county, state: e.state, lat: e.lat, lon: e.lon, comments: e.n });
    }
    for (const e of r.tornado) {
      if (!ok(e)) continue;
      events.push({ type: 'tornado', date: fullDate, ef: String(e.ef || 'EFU').replace('EF', ''), location: [e.loc, e.state].filter(Boolean).join(', '), county: e.county, state: e.state, lat: e.lat, lon: e.lon, comments: e.n });
    }
    for (const e of r.wind) {
      if (!ok(e)) continue;
      const mph = e.mag ? Math.round(e.mag * 1.151) : null;
      if (!mph || mph < 58) continue;
      events.push({ type: 'wind', date: fullDate, mph, location: [e.loc, e.state].filter(Boolean).join(', '), county: e.county, state: e.state, lat: e.lat, lon: e.lon });
    }
  }

  // Sort by date desc, then by significance
  events.sort((a, b) => {
    if (a.date !== b.date) return new Date(b.date) - new Date(a.date);
    const scoreA = a.type==='tornado'?100:(a.size_in||0)*10;
    const scoreB = b.type==='tornado'?100:(b.size_in||0)*10;
    return scoreB - scoreA;
  });

  res.json({ events, total: events.length, days });
});

// Home dashboard data API
app.get('/api/home', requireAuth, async (req, res) => {
  try {
    const recentLookups = await lookupOps.getForUser(req.user._id, 5);
    const recentAlerts = await alertOps.getRecent(10);

    // Active NWS warnings near the user's first alert region (if any)
    let activeAlerts = [];
    try {
      const settings = await alertSettingsOps.get(req.user._id);
      const r0 = (settings.regions || [])[0];
      if (r0) {
        const r = await axios.get(`https://api.weather.gov/alerts/active?point=${r0.lat.toFixed(4)},${r0.lon.toFixed(4)}`, {
          headers: { 'User-Agent': 'StormCheckPro/2.0' }, timeout: 5000
        });
        activeAlerts = (r.data.features || [])
          .filter(a => a.properties.severity === 'Severe' || a.properties.severity === 'Extreme')
          .slice(0, 3)
          .map(a => ({ event: a.properties.event, headline: a.properties.headline, severity: a.properties.severity, onset: a.properties.onset }));
      }
    } catch (e) { /* silent */ }

    // Hail days (1"+ ground reports) in the user's watched states over the last 7 days
    const watched = Array.isArray(req.user.watchedStates) && req.user.watchedStates.length ? req.user.watchedStates.map(s => String(s).toUpperCase()) : null;
    const recentStormDates = [];
    for (const date of spcStore.recentDays(7)) {
      const hail = spcStore.reportsForDay(date, watched).hail.filter(e => e.mag >= 1);
      if (hail.length) recentStormDates.push({ date, count: hail.length, maxSize: Math.max(...hail.map(e => e.mag)) });
    }
    const recentSPCCount = recentStormDates.length;
    const watchArea = watched ? watched.join(', ') : 'Nationwide';

    res.json({ recentLookups, recentAlerts, activeAlerts, recentSPCCount, recentStormDates, watchArea });
  } catch (err) {
    res.json({ recentLookups: [], recentAlerts: [], activeAlerts: [], recentSPCCount: 0, recentStormDates: [] });
  }
});

// Company profile routes
app.get('/settings', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));

app.get('/api/profile', requireAuth, async (req, res) => {
  const features = tierFeatures(req.user.tier);
  if (!features.branding) return res.status(403).json({ error: 'Profile customization requires Pro tier or higher.' });
  const profile = await profileOps.get(req.user._id);
  res.json({ profile, features });
});

app.post('/api/profile', requireAuth, async (req, res) => {
  const features = tierFeatures(req.user.tier);
  if (!features.branding) return res.status(403).json({ error: 'Profile customization requires Pro tier or higher.' });
  const { companyName, companyPhone, licenseNumbers, logoUrl, accentColor, reportFooter } = req.body;
  // White-label only for enterprise
  const whitelabelEnabled = features.whitelabel && req.body.whitelabelEnabled;
  await profileOps.save(req.user._id, { companyName, companyPhone, licenseNumbers, logoUrl, accentColor, reportFooter, whitelabelEnabled });
  res.json({ success: true });
});

// Logo upload: the browser sends the image file as the raw request body.
// Stored on the data volume and served from /logos/. SVG is not accepted
// (it can carry script); the file type is checked from its first bytes.
const LOGO_DIR = () => require('./lib/paths').ensureDir(require('./lib/paths').dataPath('logos'));
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
function imageExt(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}
app.post('/api/profile/logo', requireAuth,
  express.raw({ type: () => true, limit: LOGO_MAX_BYTES }),
  async (req, res) => {
    const features = tierFeatures(req.user.tier);
    if (!features.logo) return res.status(403).json({ error: 'Logo upload requires Team plan or higher.' });
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const ext = imageExt(buf);
    if (!ext) return res.status(400).json({ error: 'Please upload a PNG, JPG, GIF or WebP image.' });
    try {
      const fs = require('fs');
      const id = String(req.user._id).replace(/[^a-zA-Z0-9]/g, '');
      const dir = LOGO_DIR();
      // Remove this user's previous logo files, then save the new one.
      for (const f of fs.readdirSync(dir)) if (f.startsWith(id + '-')) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
      const name = `${id}-${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(dir, name), buf);
      const logoUrl = '/logos/' + name;
      await profileOps.save(req.user._id, { logoUrl });
      res.json({ success: true, logoUrl });
    } catch (e) {
      console.error('Logo upload failed:', e.message);
      res.status(500).json({ error: 'Upload failed. Please try again.' });
    }
  });
app.use('/api/profile/logo', (err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Logo must be 2 MB or smaller.' });
  next(err);
});
app.get('/logos/:file', (req, res) => {
  const file = path.basename(req.params.file);
  if (!/^[a-zA-Z0-9]+-\d+\.(png|jpg|gif|webp)$/.test(file)) return res.status(404).end();
  res.set('X-Content-Type-Options', 'nosniff');
  res.sendFile(path.join(LOGO_DIR(), file), { maxAge: '30d' }, err => { if (err && !res.headersSent) res.status(404).end(); });
});

// ── Hail Lookup API ───────────────────────────────────────────────────────────

// POST /api/lookup — starts async job, returns jobId immediately
// "Use my location": the street address at the phone's GPS position.
const revUse = new Map();
app.get('/api/reverse-geocode', requireAuth, async (req, res) => {
  const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 17 || lat > 72 || lon < -180 || lon > -64) {
    return res.status(400).json({ error: 'That location is outside the United States.' });
  }
  const id = String(req.user._id), now = Date.now();
  const recent = (revUse.get(id) || []).filter(t => now - t < 60000);
  if (recent.length >= 10) return res.status(429).json({ error: 'Too many location lookups. Wait a minute.' });
  recent.push(now); revUse.set(id, recent);
  const r = await reverseGeocode(lat, lon);
  if (!r) return res.status(404).json({ error: 'Could not find an address at your location.' });
  res.json(r);
});

app.post('/api/lookup', requireAuth, requireActiveSubscription, async (req, res) => {
  const { address, years = 5 } = req.body;
  if (!address) return res.status(400).json({ error: 'Address is required' });

  // Portfolio properties are already located: use their coordinates directly.
  const lat = parseFloat(req.body.lat), lon = parseFloat(req.body.lon);
  const geo = Number.isFinite(lat) && Number.isFinite(lon)
    ? { lat, lon, formattedAddress: address, state: req.body.state ? String(req.body.state).toUpperCase().slice(0, 2) : null }
    : await geocodeAddress(address);
  if (!geo) {
    const hint = /\d{5}/.test(address) ? '' : ' Include the city, state and ZIP code.';
    return res.status(400).json({ error: 'Address not found.' + hint });
  }

  // Starter covers one state: reports outside the user's chosen state need Pro.
  if (req.user.tier === 'starter' && Array.isArray(req.user.watchedStates) && req.user.watchedStates.length && geo.state
      && !req.user.watchedStates.map(x => String(x).toUpperCase()).includes(String(geo.state).toUpperCase())) {
    return res.status(402).json({ error: `Your Starter plan covers ${req.user.watchedStates.join(', ')}. Upgrade to Pro for nationwide reports.`, upgrade: true });
  }

  // Fast path: local radar + NCEI + SPC stores (milliseconds).
  if (reportEngine.storesReady()) {
    const result = reportEngine.buildReport(geo.lat, geo.lon, { years: Math.min(parseInt(years) || 10, 30) });
    result.impact = getImpactRating(result.score);
    result.address = geo.formattedAddress;
    await userOps.incrementLookups(req.user._id);
    await lookupOps.create({ userId: req.user._id, address: geo.formattedAddress, lat: geo.lat, lon: geo.lon, eventsFound: result.stats.total, impactScore: result.score });
    return res.json(result);
  }

  // Legacy path (until the data stores finish their first load): live SPC scan.
  const cacheKey = `${geo.lat.toFixed(4)},${geo.lon.toFixed(4)},${parseInt(years)||5}`;
  // Check persistent DB cache first, then memory cache
  const dbCached = await resultsCacheOps.get(cacheKey);
  const memCached = lookupCache.get(cacheKey);
  const cachedData = dbCached || (memCached && (Date.now() - memCached.timestamp) < CACHE_TTL_MS ? memCached.data : null);
  if (cachedData) {
    await userOps.incrementLookups(req.user._id);
    await lookupOps.create({ userId: req.user._id, address: geo.formattedAddress, lat: geo.lat, lon: geo.lon, eventsFound: cachedData.stats?.total||0, impactScore: cachedData.score||0 });
    return res.json({ ...cachedData, address: geo.formattedAddress, lat: geo.lat, lon: geo.lon, cached: true });
  }

  // Create job and respond immediately with jobId
  const jobId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  jobs.set(jobId, { status: 'processing', startedAt: Date.now() });

  // Run the slow part in background
  (async () => {
    try {
      const events = await fetchHailHistory(geo.lat, geo.lon, Math.min(parseInt(years) || 5, 10));
      const score = getImpactScore(events);
      const impact = getImpactRating(score);
      const result = {
        success: true,
        address: geo.formattedAddress,
        lat: geo.lat, lon: geo.lon,
        events, score, impact,
        stats: {
          total: events.length,
          atProperty: events.filter(e => e.at_property).length,
          largestHail: events.length > 0 ? Math.max(...events.map(e => e.size_in)) : 0,
          mostRecent: events.length > 0 ? events[0].date : null,
        }
      };
      lookupCache.set(cacheKey, { data: result, timestamp: Date.now() });
      resultsCacheOps.set(cacheKey, result).catch(() => {}); // persist to DB
      await userOps.incrementLookups(req.user._id);
      await lookupOps.create({ userId: req.user._id, address: geo.formattedAddress, lat: geo.lat, lon: geo.lon, eventsFound: events.length, impactScore: score });
      jobs.set(jobId, { status: 'done', result, completedAt: Date.now() });
    } catch (err) {
      jobs.set(jobId, { status: 'error', error: err.message });
    }
    // Clean up job after 10 minutes
    setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000);
  })();

  // Return jobId immediately so frontend can poll
  res.json({ jobId, status: 'processing', address: geo.formattedAddress });
});

// GET /api/lookup/:jobId — poll for job status
app.get('/api/lookup/:jobId', requireAuth, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });
  if (job.status === 'processing') return res.json({ status: 'processing' });
  if (job.status === 'error') return res.status(500).json({ status: 'error', error: job.error });
  res.json({ status: 'done', ...job.result });
});

// ── Admin Routes ──────────────────────────────────────────────────────────────

app.get('/admin', requireAuth, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Get all users
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  res.json(await userOps.getAll());
});

// ── CSV exports (admin) ─────────────────────────────────────────────────────
// Cells starting with = + - @ are prefixed so Excel can't run them as formulas.
const csvSafe = v => { const s = v == null ? '' : String(v); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
const csvDate = v => (v ? String(v).slice(0, 10) : '');
function sendCsv(res, name, rows) {
  const { toCsv } = require('./lib/csv');
  const stamp = new Date().toISOString().slice(0, 10);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${name}-${stamp}.csv"`);
  res.send('\ufeff' + toCsv(rows.map(r => r.map(csvSafe))));
}

app.get('/api/admin/export/users.csv', requireAuth, requireAdmin, async (req, res) => {
  const users = (await userOps.getAll()).filter(u => u.role !== 'admin');
  const rows = [['Name', 'Email', 'Company', 'Phone', 'Plan', 'Subscription Status', 'Lookups This Month', 'Joined', 'Last Login', 'Referred By', 'Source', 'Campaign', 'Ad / Content', 'Landing Page', 'Notes']];
  for (const u of users) {
    let p = null;
    try { p = await profileOps.get(u._id); } catch { /* no profile */ }
    rows.push([
      u.name, u.email, (p && p.companyName) || u.company || '', (p && p.companyPhone) || '',
      (TIERS[u.tier] && TIERS[u.tier].label) || u.tier, u.subscriptionStatus || '',
      u.lookupsThisMonth || 0, csvDate(u.createdAt), csvDate(u.lastLogin), u.referredBy || '',
      [u.signupSource && u.signupSource.utm_source, u.signupSource && u.signupSource.utm_medium].filter(Boolean).join(' / '),
      (u.signupSource && u.signupSource.utm_campaign) || '', (u.signupSource && u.signupSource.utm_content) || '',
      (u.signupSource && u.signupSource.landing) || '', u.notes || '',
    ]);
  }
  sendCsv(res, 'stormcheck-users', rows);
});

app.get('/api/admin/export/alert-signups.csv', requireAuth, requireAdmin, async (req, res) => {
  const subs = await freeAlertOps.all();
  const rows = [['Email', 'Area', 'ZIP', 'Radius (mi)', 'Min Hail (in)', 'Status', 'Signed Up', 'Unsubscribed']];
  for (const s of subs) {
    rows.push([s.email, s.label || '', s.zip || '', s.radiusMi || '', s.minIn || '', s.active ? 'Subscribed' : 'Unsubscribed', csvDate(s.createdAt), csvDate(s.unsubscribedAt)]);
  }
  sendCsv(res, 'stormcheck-alert-signups', rows);
});

// Create user
app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const { email, password, name, company, tier, notes } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Name, email, password required' });
  const existing = await userOps.findByEmail(email);
  if (existing) return res.status(409).json({ error: 'Email already exists' });
  try {
    await userOps.create({ email, password, name, company, tier: tier || 'trial', notes, role: 'subscriber', lookupLimit: (tier === 'pro' || tier === 'client') ? -1 : 10 });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update user tier/status
app.patch('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const { tier, notes } = req.body;
  const userId = req.params.id;
  if (tier) await userOps.updateTier(userId, tier);
  if (notes !== undefined) await userOps.update(userId, { notes });
  res.json({ success: true });
});

// Delete user
app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  await userOps.delete(req.params.id);
  res.json({ success: true });
});

// Admin stats
app.get('/api/admin/stats', requireAuth, requireAdmin, async (req, res) => {
  const allUsers = await userOps.getAll();
  const lookupStats = await lookupOps.getStats();
  // Alerts sent to customers (portfolio, territory, NWS warnings).
  const recentAlerts = require('./lib/alerts').recentAlerts(25).map(a => ({
    detectedAt: a.at, area: `${a.email || ''} · ${a.detail || ''}`, eventType: a.type,
    hailSize: a.maxIn || null, severity: [a.emailed ? 'Email' : '', a.phones ? `${a.phones} phone${a.phones === 1 ? '' : 's'}` : ''].filter(Boolean).join(' + ') || 'None',
  }));
  const recentLookups = await lookupOps.getRecent(20);
  res.json({
    users: {
      total: allUsers.length,
      pro: allUsers.filter(u => u.tier === 'pro').length,
      trial: allUsers.filter(u => u.tier === 'trial').length,
      client: allUsers.filter(u => u.tier === 'client').length,
      suspended: allUsers.filter(u => u.tier === 'suspended').length,
    },
    lookups: lookupStats,
    recentAlerts,
    recentLookups,
  });
});

// Recent lookups for admin
app.get('/api/admin/lookups', requireAuth, requireAdmin, async (req, res) => {
  res.json(await lookupOps.getRecent(50));
});

// Stripe checkout session — supports multiple tier price IDs
app.post('/api/stripe/checkout', requireAuth, async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Stripe not configured yet' });
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const { tier, promoCode } = req.body;

  // Look up price ID for the requested tier
  // Set STRIPE_PRICE_ID_STARTER, _PRO, _TEAM, _ENTERPRISE in Railway
  // Falls back to STRIPE_PRICE_ID for backward compat
  const tierPriceMap = {
    starter: process.env.STRIPE_PRICE_ID_STARTER,
    pro: process.env.STRIPE_PRICE_ID_PRO || process.env.STRIPE_PRICE_ID,
    team: process.env.STRIPE_PRICE_ID_TEAM,
    enterprise: process.env.STRIPE_PRICE_ID_ENTERPRISE,
  };
  const priceId = tier ? (tierPriceMap[tier] || process.env.STRIPE_PRICE_ID) : process.env.STRIPE_PRICE_ID;
  if (!priceId) return res.status(500).json({ error: `No Stripe price configured for ${tier || 'this plan'}. Contact (817) 618-9884.` });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: req.user.email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.BASE_URL}/dashboard?subscribed=1&plan=${encodeURIComponent(tier || 'pro')}`,
      cancel_url: `${process.env.BASE_URL}/upgrade`,
      metadata: { userId: req.user._id, tier: tier || 'pro' },
      ...(promoCode ? { discounts: [{ coupon: promoCode }] } : { allow_promotion_codes: true }),
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Radar platform + public pages ────────────────────────────────────────────
require('./platform-routes')(app, { requireAuth, requireAdmin, requireActiveSubscription, tierFeatures, db });
require('./integration-routes')(app, { requireAuth, tierFeatures, db });
require('./help-routes')(app, { requireAuth, requireAdmin, tierFeatures, db });
require('./tracking-routes')(app);
require('./recap-routes')(app, { db, requireAuth, requireAdmin });
require('./security-routes')(app, { db, requireAuth, requireAdmin });

// ── Backups (admin) ───────────────────────────────────────────────────────────
const backups = require('./lib/backups');
app.post('/api/admin/backups/run', requireAuth, requireAdmin, async (req, res) => {
  try { res.json(await backups.run()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/backups/:name', requireAuth, requireAdmin, (req, res) => {
  const p = backups.filePath(req.params.name);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.download(p);
});
// Nightly at 08:30 UTC (about 3:30 AM Central), plus one at startup if the last is old.
cron.schedule('30 8 * * *', () => backups.run().then(r => console.log('[backup]', r.name, r.offsite)).catch(e => console.error('[backup]', e.message)));
setTimeout(() => { if (!backups.latest() && process.env.DATA_JOBS !== 'off') backups.run().catch(e => console.error('[backup]', e.message)); }, 90000);
require('./public-pages')(app, { db });
require('./pro-routes')(app, { db, requireAuth, requireAdmin });
require('./referral-routes')(app, { db, requireAuth, requireAdmin, geocodeAddress });

// ── Root redirect ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  const token = req.cookies?.token;
  if (token) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Catch-all for SPA
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.redirect('/');
});

// ── Cron: Reset monthly lookups on 1st of each month ─────────────────────────
cron.schedule('0 0 1 * *', () => {
  userOps.resetMonthlyLookups();
  console.log('Monthly lookup counts reset');
}, { timezone: 'America/Chicago' });


// Trial conversion emails -- loaded from trial-emails.js
require('./trial-emails')(cron, userOps, process.env);



// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nStormCheck Pro running on http://localhost:${PORT}`);
  console.log(`Admin: ${process.env.ADMIN_EMAIL}`);
  console.log(`Env: ${process.env.NODE_ENV || 'development'}\n`);
});

dataJobs.start({ db, tierFeatures, freeAlertOps });
require('./lib/integrations').start({
  ...db,
  locateMissing: userId => watchlistRoutes._geocodeMissing(watchlistOps, userId).catch(e => console.error('[integrations] locate:', e.message)),
});
module.exports = app;
