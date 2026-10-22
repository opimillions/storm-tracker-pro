/**
 * StormCheck Pro — Express Server
 * stormcheckpro.thepublicadjustertx.com
 */
require('dotenv').config();
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
const { generateToken, requireAuth, requireAdmin, requireActiveSubscription } = require('./auth');
const { geocodeAddress, fetchHailHistory, getImpactScore, getImpactRating } = require('./hail-engine');
const axios = require('axios');

// Simple in-memory cache for lookup results (saves re-scanning same address)
const lookupCache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours (reduced from 24h so recent storms appear faster)

// Async job store — holds in-progress and completed lookups
const jobs = new Map(); // jobId -> { status, result, error, startedAt }

const app = express();
const { startStormMonitor } = require('./storm-alerts');

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
  try {
    const user = await userOps.findByEmail(email);
    if (!user || !userOps.verifyPassword(user, password)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (user.tier === 'suspended') {
      return res.status(403).json({ error: 'Your account has been suspended. Contact (817) 618-9884.' });
    }
    await userOps.updateLastLogin(user._id);
    // Track affiliate referral if ref cookie set
    const refCode = (req.cookies && req.cookies.ref) ? req.cookies.ref : null;
    if (refCode && user) {
      try { const aff = await affiliateOps.findByCode(refCode); if (aff) { await userOps.update(user._id, { referredBy: refCode.toUpperCase() }); console.log('Referral tracked: ' + email + ' by ' + refCode); } } catch(re) {}
      res.clearCookie('ref');
    }
    const token = generateToken(user);
    res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ success: true, redirect: user.role === 'admin' ? '/admin' : '/dashboard' });
  } catch (err) {
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
    await userOps.create({ email, password, name, company, role: 'subscriber', tier: 'trial', lookupLimit: 1 });
    const user = await userOps.findByEmail(email);
    // Track affiliate referral if ref cookie set
    const refCode = (req.cookies && req.cookies.ref) ? req.cookies.ref : null;
    if (refCode && user) {
      try { const aff = await affiliateOps.findByCode(refCode); if (aff) { await userOps.update(user._id, { referredBy: refCode.toUpperCase() }); console.log('Referral: '+email+' by '+refCode); } } catch(re) {}
      res.clearCookie('ref');
    }
    const token = generateToken(user);
    res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 });
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
  try {
    const user = await userOps.findByEmail(email);
    if (user) {
      const crypto = require('crypto');
      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
      await userOps.setResetToken(email, token, expires);
      const baseUrl = process.env.BASE_URL || 'https://stormcheckpro.thepublicadjustertx.com';
      const resetUrl = `${baseUrl}/reset-password?token=${token}`;
      // Send email via nodemailer if configured, otherwise log to console
      if (process.env.SMTP_HOST) {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT || '587'),
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        });
        await transporter.sendMail({
          from: `StormCheck Pro <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
          to: email,
          subject: 'Reset your StormCheck Pro password',
          html: `<p>Hi,</p><p>Click the link below to reset your password. This link expires in 1 hour.</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you didn't request this, ignore this email.</p><p>— StormCheck Pro / First Call Public Adjusters</p>`
        });
      } else {
        // No email configured — log the reset URL so admin can share manually
        console.log(`\nPASSWORD RESET LINK for ${email}:\n${resetUrl}\n`);
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
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Reset failed. Please try again.' });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
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
  const { passwordHash, ...user } = req.user;
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
  try {
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT||'587'), auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
    await t.verify();
    await t.sendMail({ from: process.env.SMTP_FROM||process.env.SMTP_USER, to: process.env.ADMIN_EMAIL, subject: 'StormCheck Pro SMTP Test', text: 'SMTP is working correctly! You will receive storm alerts and promo emails.' });
    res.json({ success: true, message: 'Test email sent to ' + process.env.ADMIN_EMAIL, smtp: { host: process.env.SMTP_HOST, user: process.env.SMTP_USER, configured: !!process.env.SMTP_PASS } });
  } catch(err) { res.json({ success: false, error: err.message, smtp: { host: process.env.SMTP_HOST, user: process.env.SMTP_USER, configured: !!process.env.SMTP_PASS } }); }
});

// Promo routes
require('./promo-routes')(app, { requireAuth, requireAdmin, userOps });

// Watch List routes
const watchlistRoutes = require('./watchlist-routes');
watchlistRoutes(app, { requireAuth, watchlistOps });


// -- Web Push Setup ------------------------------------------------------------
const webpush = require('web-push');
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:' + (process.env.ADMIN_EMAIL || 'admin@example.com'),
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}
const pushSubscriptionStore = [];

// Subscribe to push notifications
app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  const exists = pushSubscriptionStore.some(s => s.endpoint === sub.endpoint);
  if (!exists) pushSubscriptionStore.push(sub);
  res.json({ success: true });
});

// Unsubscribe
app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  const { endpoint } = req.body;
  const idx = pushSubscriptionStore.findIndex(s => s.endpoint === endpoint);
  if (idx !== -1) pushSubscriptionStore.splice(idx, 1);
  res.json({ success: true });
});

// Get VAPID public key (needed by browser to subscribe)
app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
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

app.get('/alert-settings', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'alert-settings.html')));
app.get('/api/alert-settings', requireAuth, async (req, res) => { const settings = await alertSettingsOps.get(req.user._id); res.json({ settings }); });
app.post('/api/alert-settings', requireAuth, async (req, res) => { await alertSettingsOps.save(req.user._id, req.body); res.json({ success: true }); });

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

// ── Hail Lookup API ───────────────────────────────────────────────────────────

// POST /api/lookup — starts async job, returns jobId immediately
app.post('/api/lookup', requireAuth, requireActiveSubscription, async (req, res) => {
  const { address, years = 5 } = req.body;
  if (!address) return res.status(400).json({ error: 'Address is required' });

  // Geocode first (fast, ~200ms)
  const geo = await geocodeAddress(address);
  if (!geo) return res.status(400).json({ error: 'Address not found. Please check and try again.' });

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
  const recentAlerts = await alertOps.getRecent(10);
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
      success_url: `${process.env.BASE_URL}/dashboard?subscribed=1`,
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
require('./public-pages')(app, { db });

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

startStormMonitor(alertOps, pushSubscriptionStore);
dataJobs.start({ db, tierFeatures, freeAlertOps });
module.exports = app;
