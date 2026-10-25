/**
 * Database — NeDB (pure JavaScript, no compilation needed)
 */
const Datastore = require('nedb-promises');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

// Use Railway persistent volume if available, otherwise local data dir
const { DATA_DIR } = require('./lib/paths');

const users = Datastore.create({ filename: path.join(DATA_DIR, 'users.db'), autoload: true });
const lookups = Datastore.create({ filename: path.join(DATA_DIR, 'lookups.db'), autoload: true });
const alerts = Datastore.create({ filename: path.join(DATA_DIR, 'alerts.db'), autoload: true });
const profiles = Datastore.create({ filename: path.join(DATA_DIR, 'profiles.db'), autoload: true });
const affiliates = Datastore.create({ filename: path.join(DATA_DIR, 'affiliates.db'), autoload: true });
affiliates.ensureIndex({ fieldName: 'code', unique: true });
affiliates.ensureIndex({ fieldName: 'userId', unique: true });
const alertSettings = Datastore.create({ filename: path.join(DATA_DIR, 'alert-settings.db'), autoload: true });
alertSettings.ensureIndex({ fieldName: 'userId', unique: true });
const watchlist = Datastore.create({ filename: path.join(DATA_DIR, 'watchlist.db'), autoload: true });
watchlist.ensureIndex({ fieldName: 'userId' });
const resultsCache = Datastore.create({ filename: path.join(DATA_DIR, 'results-cache.db'), autoload: true });
resultsCache.ensureIndex({ fieldName: 'cacheKey', unique: true });
const freeAlerts = Datastore.create({ filename: path.join(DATA_DIR, 'free-alerts.db'), autoload: true });
freeAlerts.ensureIndex({ fieldName: 'token', unique: true });
const reviews = Datastore.create({ filename: path.join(DATA_DIR, 'reviews.db'), autoload: true });
const integrations = Datastore.create({ filename: path.join(DATA_DIR, 'integrations.db'), autoload: true });
integrations.ensureIndex({ fieldName: 'userId' });
const prospects = Datastore.create({ filename: path.join(DATA_DIR, 'prospects.db'), autoload: true });
prospects.ensureIndex({ fieldName: 'email', unique: true });
prospects.ensureIndex({ fieldName: 'token', unique: true });

// Indexes
users.ensureIndex({ fieldName: 'email', unique: true });
users.ensureIndex({ fieldName: 'stripeCustomerId', sparse: true });

// ── Tier Configuration ───────────────────────────────────────────────────────
// maxStates: -1 = nationwide. predictive = NWS warning heads-up alerts. playback = animated radar swaths.
const TIERS = {
  trial:      { lookupLimit: 1,  price: 0,    users: 1, maxStates: 1,  states: null, branding: false, logo: false, whitelabel: false, predictive: false, playback: false, label: 'Free Trial' },
  starter:    { lookupLimit: -1, price: 39,   users: 1, maxStates: 1,  states: null, branding: false, logo: false, whitelabel: false, predictive: false, playback: false, label: 'Starter' },
  pro:        { lookupLimit: -1, price: 79,   users: 1, maxStates: -1, states: null, branding: true,  logo: false, whitelabel: false, predictive: false, playback: true,  label: 'Pro' },
  team:       { lookupLimit: -1, price: 149,  users: 5, maxStates: -1, states: null, branding: true,  logo: true,  whitelabel: false, predictive: true,  playback: true,  label: 'Team' },
  enterprise: { lookupLimit: -1, price: 199,  users: -1,maxStates: -1, states: null, branding: true,  logo: true,  whitelabel: true,  predictive: true,  playback: true,  label: 'Enterprise' },
  client:     { lookupLimit: -1, price: 0,    users: 1, maxStates: -1, states: null, branding: false, logo: false, whitelabel: false, predictive: false, playback: true,  label: 'Client' },
  admin:      { lookupLimit: -1, price: 0,    users: -1,maxStates: -1, states: null, branding: true,  logo: true,  whitelabel: true,  predictive: true,  playback: true,  label: 'Admin' },
  suspended:  { lookupLimit: 0,  price: 0,    users: 0, maxStates: 0,  states: [],   branding: false, logo: false, whitelabel: false, predictive: false, playback: false, label: 'Suspended' },
};

function tierLookupLimit(tier) {
  return (TIERS[tier] || TIERS.trial).lookupLimit;
}

function tierFeatures(tier) {
  return TIERS[tier] || TIERS.trial;
}

// ── User Operations ───────────────────────────────────────────────────────────
const userOps = {
  async create(data) {
    const hash = bcrypt.hashSync(data.password, 12);
    const trialEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    return users.insert({
      email: data.email.toLowerCase(),
      passwordHash: hash,
      name: data.name,
      company: data.company || null,
      role: data.role || 'subscriber',
      tier: data.tier || 'trial',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      subscriptionStatus: 'inactive',
      lookupsThisMonth: 0,
      lookupLimit: data.lookupLimit !== undefined ? data.lookupLimit : tierLookupLimit(data.tier),
      notes: data.notes || null,
      createdAt: new Date().toISOString(),
      lastLogin: null,
      trialEndsAt: null, // No time limit — 1 free lookup only
    });
  },

  async findByEmail(email) {
    return users.findOne({ email: email.toLowerCase() });
  },

  async findById(id) {
    return users.findOne({ _id: id });
  },

  verifyPassword(user, password) {
    return bcrypt.compareSync(password, user.passwordHash);
  },

  async updateLastLogin(id) {
    return users.update({ _id: id }, { $set: { lastLogin: new Date().toISOString() } });
  },

  async updateTier(id, tier, lookupLimit) {
    const limit = lookupLimit !== undefined ? lookupLimit : tierLookupLimit(tier);
    return users.update({ _id: id }, { $set: { tier, lookupLimit: limit } });
  },

  async updateSubscription(id, data) {
    const update = {};
    if (data.customerId) update.stripeCustomerId = data.customerId;
    if (data.subscriptionId) update.stripeSubscriptionId = data.subscriptionId;
    if (data.status) update.subscriptionStatus = data.status;
    if (data.tier) update.tier = data.tier;
    return users.update({ _id: id }, { $set: update });
  },

  async incrementLookups(id) {
    return users.update({ _id: id }, { $inc: { lookupsThisMonth: 1 } });
  },

  async resetMonthlyLookups() {
    return users.update({}, { $set: { lookupsThisMonth: 0 } }, { multi: true });
  },

  canLookup(user) {
    if (user.tier === 'suspended') return false;
    if (user.lookupLimit === -1) return true;
    // No time-based trial expiry — only lookup limit applies
    return user.lookupsThisMonth < user.lookupLimit;
  },

  async getAll() {
    const all = await users.find({}).sort({ createdAt: -1 });
    return all.map(u => { const { passwordHash, ...rest } = u; return rest; });
  },

  async update(id, data) {
    return users.update({ _id: id }, { $set: data });
  },

  async setResetToken(email, token, expiresAt) {
    return users.update({ email: email.toLowerCase() }, { $set: { resetToken: token, resetTokenExpires: expiresAt } });
  },

  async findByResetToken(token) {
    return users.findOne({ resetToken: token, resetTokenExpires: { $gt: new Date().toISOString() } });
  },

  async clearResetToken(id, newPasswordHash) {
    return users.update({ _id: id }, { $set: { passwordHash: newPasswordHash, resetToken: null, resetTokenExpires: null } });
  },

  async delete(id) {
    return users.remove({ _id: id });
  },

  async findByStripeCustomer(customerId) {
    return users.findOne({ stripeCustomerId: customerId });
  }
};

// ── Lookup Operations ─────────────────────────────────────────────────────────
const lookupOps = {
  async create(data) {
    return lookups.insert({
      userId: data.userId,
      address: data.address,
      lat: data.lat,
      lon: data.lon,
      eventsFound: data.eventsFound || 0,
      impactScore: data.impactScore || 0,
      createdAt: new Date().toISOString(),
    });
  },

  async getForUser(userId, limit = 20) {
    return lookups.find({ userId }).sort({ createdAt: -1 }).limit(limit);
  },

  async getRecent(limit = 50) {
    const recent = await lookups.find({}).sort({ createdAt: -1 }).limit(limit);
    // Join with user data
    const enriched = await Promise.all(recent.map(async l => {
      const user = await users.findOne({ _id: l.userId });
      return { ...l, email: user?.email, name: user?.name };
    }));
    return enriched;
  },

  async getStats() {
    try {
      const all = await lookups.find({});
      const today = new Date().toDateString();
      const thisMonth = new Date().toISOString().slice(0, 7);
      return {
        total: all.length,
        today: all.filter(l => l.createdAt && new Date(l.createdAt).toDateString() === today).length,
        thisMonth: all.filter(l => l.createdAt && l.createdAt.startsWith(thisMonth)).length,
      };
    } catch (e) { return { total: 0, today: 0, thisMonth: 0 }; }
  }
};

// ── Alert Operations ──────────────────────────────────────────────────────────
const alertOps = {
  async upsert(data) {
    const existing = await alerts.findOne({ alertId: data.alertId });
    if (existing) return existing;
    return alerts.insert({
      alertId: data.alertId,
      area: data.area,
      eventType: data.eventType,
      hailSize: data.hailSize,
      severity: data.severity,
      onset: data.onset,
      detectedAt: new Date().toISOString(),
    });
  },

  async getRecent(limit = 20) {
    return alerts.find({}).sort({ detectedAt: -1 }).limit(limit);
  }
};

// ── Seed Admin ────────────────────────────────────────────────────────────────
async function seedAdmin() {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    console.warn('ADMIN_EMAIL / ADMIN_PASSWORD not set — admin account not seeded or synced.');
    return;
  }
  const existing = await userOps.findByEmail(adminEmail);
  if (!existing) {
    await userOps.create({
      email: adminEmail,
      password: adminPassword,
      name: 'Ryan',
      company: 'First Call Public Adjusters',
      role: 'admin',
      tier: 'admin',
      lookupLimit: -1,
    });
    console.log(`Admin account created: ${adminEmail}`);
  } else {
    // Always sync admin password from env var on startup
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync(adminPassword, 12);
    await users.update({ email: adminEmail }, { $set: { passwordHash: hash, role: 'admin', tier: 'admin', lookupLimit: -1 } });
    console.log(`Admin password synced from env: ${adminEmail}`);
  }
}

seedAdmin().catch(console.error);

// Auto-seed client users from environment variables
// Format: SEED_USERS=name:email:password:tier|name:email:password:tier
async function seedClientUsers() {
  const seedData = process.env.SEED_USERS;
  if (!seedData) return;
  const entries = seedData.split('|');
  for (const entry of entries) {
    const [name, email, password, tier] = entry.split(':');
    if (!name || !email || !password) continue;
    const existing = await userOps.findByEmail(email);
    if (!existing) {
      const seedTier = tier || 'client';
      await userOps.create({ name, email, password, tier: seedTier, role: 'subscriber', lookupLimit: tierLookupLimit(seedTier) });
      console.log(`Auto-seeded user: ${email} (${seedTier})`);
    } else if (existing.lookupLimit === 10 && existing.tier === 'trial') {
      // Fix old trial users that got 10 instead of 1
      await users.update({ email: email.toLowerCase() }, { $set: { lookupLimit: 1 } });
      console.log(`Fixed lookup limit for trial user: ${email}`);
    }
  }
}

seedClientUsers().catch(console.error);

// ── Company Profile Operations ──────────────────────────────────────────────────
const profileOps = {
  async get(userId) {
    const p = await profiles.findOne({ userId });
    return p || {
      userId,
      companyName: '',
      companyPhone: '',
      licenseNumbers: '',
      logoUrl: '',
      accentColor: '#c0392b',
      reportFooter: '',
      whitelabelEnabled: false,
      updatedAt: null
    };
  },

  async save(userId, data) {
    const existing = await profiles.findOne({ userId });
    const update = { ...data, userId, updatedAt: new Date().toISOString() };
    if (existing) return profiles.update({ userId }, { $set: update });
    return profiles.insert(update);
  }
};

// ── Persistent Result Cache ────────────────────────────────────────────────────────────────────────
const CACHE_TTL_DAYS = 0.25; // 6 hours — refresh frequently so recent storms appear fast
const resultsCacheOps = {
  async get(cacheKey) {
    const rec = await resultsCache.findOne({ cacheKey });
    if (!rec) return null;
    const age = Date.now() - new Date(rec.cachedAt).getTime();
    if (age > CACHE_TTL_DAYS * 24 * 60 * 60 * 1000) return null; // expired
    return rec.data;
  },
  async set(cacheKey, data) {
    await resultsCache.remove({ cacheKey }, { multi: false });
    return resultsCache.insert({ cacheKey, data, cachedAt: new Date().toISOString() });
  },
  async invalidate(cacheKey) {
    return resultsCache.remove({ cacheKey }, { multi: false });
  },
  async clearAll() {
    return resultsCache.remove({}, { multi: true });
  }
};

// On startup: wipe any DB cache entries older than 6 hours so stale zero-results don't persist across deploys
(async () => {
  try {
    const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const removed = await resultsCache.remove({ cachedAt: { $lt: cutoff } }, { multi: true });
    if (removed > 0) console.log(`Startup: cleared ${removed} stale cache entries`);
  } catch(e) { /* non-fatal */ }
})();

// ── Affiliate Operations ────────────────────────────────────────────────────────────────────────
const AFFILIATE_COMMISSION = 0.20; // 20% recurring

const affiliateOps = {
  async create(userId, name, email) {
    // Generate unique 6-char code from name
    const base = name.replace(/[^a-zA-Z]/g,'').toUpperCase().slice(0,6);
    let code = base;
    let attempt = 0;
    while (await affiliates.findOne({ code })) {
      attempt++;
      code = base + attempt;
    }
    return affiliates.insert({
      userId, code, name, email,
      totalReferrals: 0,
      activeReferrals: 0,
      totalEarned: 0,
      pendingPayout: 0,
      createdAt: new Date().toISOString(),
      enabled: true
    });
  },

  async findByUserId(userId) {
    return affiliates.findOne({ userId });
  },

  async findByCode(code) {
    return affiliates.findOne({ code: code.toUpperCase(), enabled: true });
  },

  async recordReferral(affiliateCode, referredUserId, tier) {
    const aff = await affiliates.findOne({ code: affiliateCode.toUpperCase() });
    if (!aff) return;
    const tierPrices = { starter:39, pro:79, team:149, enterprise:199 };
    const monthlyCommission = (tierPrices[tier] || 99) * AFFILIATE_COMMISSION;
    await affiliates.update({ code: affiliateCode.toUpperCase() }, {
      $inc: { totalReferrals: 1, activeReferrals: 1, pendingPayout: monthlyCommission }
    });
    // Tag the referred user with the affiliate code
    await users.update({ _id: referredUserId }, { $set: { referredBy: affiliateCode.toUpperCase() } });
    return monthlyCommission;
  },

  async addCommission(affiliateCode, amount) {
    return affiliates.update({ code: affiliateCode.toUpperCase() }, {
      $inc: { totalEarned: amount, pendingPayout: amount }
    });
  },

  async requestPayout(userId) {
    const aff = await affiliates.findOne({ userId });
    if (!aff || aff.pendingPayout < 20) return null; // min $20 payout
    const amount = aff.pendingPayout;
    await affiliates.update({ userId }, { $set: { pendingPayout: 0 }, $inc: { totalEarned: 0 } });
    return amount;
  },

  async getAll() {
    return affiliates.find({}).sort({ totalEarned: -1 });
  },

  async getStats() {
    const all = await affiliates.find({});
    return {
      total: all.length,
      totalReferrals: all.reduce((s,a) => s+a.totalReferrals, 0),
      totalPaidOut: all.reduce((s,a) => s+(a.totalEarned-a.pendingPayout), 0),
      pendingPayout: all.reduce((s,a) => s+a.pendingPayout, 0),
    };
  }
};

// ── Watch List Operations ─────────────────────────────────────────────────────────────────────
const watchlistOps = {
  async addContact(userId, contact) {
    // contact = { name, address, phone, email, lat, lon, tags }
    return watchlist.insert({
      userId, ...contact,
      createdAt: new Date().toISOString(),
      lastChecked: null,
      lastAlertDate: null,
      hitCount: 0
    });
  },

  async bulkAdd(userId, contacts) {
    // contacts = array of { name, address, phone, email, lat, lon }
    const docs = contacts.map(c => ({
      userId, ...c,
      createdAt: new Date().toISOString(),
      lastChecked: null,
      lastAlertDate: null,
      hitCount: 0
    }));
    return watchlist.insert(docs);
  },

  async getForUser(userId) {
    return watchlist.find({ userId }).sort({ name: 1 });
  },

  // Users that have contacts still waiting to be located on the map.
  async userIdsNeedingGeocode() {
    const docs = await watchlist.find({ $or: [{ lat: null }, { lat: { $exists: false } }] }, { userId: 1 });
    return [...new Set(docs.map(d => d.userId))];
  },

  async deleteContact(id, userId) {
    return watchlist.remove({ _id: id, userId });
  },

  async deleteAllForUser(userId) {
    return watchlist.remove({ userId }, { multi: true });
  },

  // Remove repeat entries of the same address (keeps the first one added).
  async deleteDuplicates(userId) {
    const all = await watchlist.find({ userId }).sort({ createdAt: 1 });
    const norm = c => String(c.formattedAddress || c.address || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const seen = new Set(), dupes = [];
    for (const c of all) {
      const k = norm(c);
      if (!k) continue;
      if (seen.has(k)) dupes.push(c._id); else seen.add(k);
    }
    if (dupes.length) await watchlist.remove({ _id: { $in: dupes }, userId }, { multi: true });
    return dupes.length;
  },

  async updateContact(id, data) {
    return watchlist.update({ _id: id }, { $set: data });
  },

  async updateContactForUser(id, userId, data) {
    return watchlist.update({ _id: id, userId }, { $set: data });
  },

  async getAllWithCoords() {
    return watchlist.find({ lat: { $exists: true }, lon: { $exists: true } });
  },

  async markAlerted(id, date) {
    return watchlist.update({ _id: id }, { $set: { lastAlertDate: date }, $inc: { hitCount: 1 } });
  },

  async count(userId) {
    return watchlist.count({ userId });
  }
};

// ── Alert Settings Operations ────────────────────────────────────────────────────────────────────
const alertSettingsOps = {
  async get(userId) {
    const s = await alertSettings.findOne({ userId });
    return s || { userId, minHailSize: 1.0, alertHail: true, alertWind: true, alertTornado: true, alertEmail: true, regions: [] };
  },
  async save(userId, data) {
    const existing = await alertSettings.findOne({ userId });
    if (existing) return alertSettings.update({ userId }, { $set: { ...data, userId } });
    return alertSettings.insert({ ...data, userId });
  }
};

// ── Free Alert Subscribers (public, no account) ─────────────────────────────────
const freeAlertOps = {
  async subscribe({ email, label, lat, lon, zip, radiusMi = 15, minIn = 1 }) {
    const crypto = require('crypto');
    email = String(email).toLowerCase().trim();
    const existing = await freeAlerts.findOne({ email, zip: zip || null, active: true });
    if (existing) return existing;
    return freeAlerts.insert({
      email, label, lat, lon, zip: zip || null, radiusMi, minIn,
      token: crypto.randomBytes(20).toString('hex'),
      active: true, createdAt: new Date().toISOString(),
    });
  },
  async unsubscribe(token) { return freeAlerts.update({ token }, { $set: { active: false, unsubscribedAt: new Date().toISOString() } }); },
  async getActive() { return freeAlerts.find({ active: true }); },
  async count() { return freeAlerts.count({ active: true }); },
  async recent(limit = 50) { return freeAlerts.find({}).sort({ createdAt: -1 }).limit(limit); },
  async all() { return freeAlerts.find({}).sort({ createdAt: -1 }); },
};

// ── Meteorologist Review Orders ────────────────────────────────────────────────
const reviewOps = {
  async create(data) {
    return reviews.insert({ ...data, status: data.status || 'awaiting_payment', createdAt: new Date().toISOString() });
  },
  async get(id) { return reviews.findOne({ _id: id }); },
  async forUser(userId) { return reviews.find({ userId }).sort({ createdAt: -1 }); },
  async all() { return reviews.find({}).sort({ createdAt: -1 }); },
  async update(id, data) { return reviews.update({ _id: id }, { $set: { ...data, updatedAt: new Date().toISOString() } }); },
};

// ── CRM Integrations (one doc per user per type: jobnimbus, acculynx, webhook) ──
const integrationOps = {
  async getForUser(userId) { return integrations.find({ userId }); },
  async get(userId, type) { return integrations.findOne({ userId, type }); },
  async upsert(userId, type, data) {
    const existing = await integrations.findOne({ userId, type });
    const now = new Date().toISOString();
    if (existing) return integrations.update({ _id: existing._id }, { $set: { ...data, updatedAt: now } });
    return integrations.insert({ userId, type, ...data, createdAt: now, updatedAt: now });
  },
  async remove(userId, type) { return integrations.remove({ userId, type }, { multi: true }); },
  async allActive() { return integrations.find({ type: { $in: ['jobnimbus', 'acculynx'] } }); },
  // Inbound webhook token lives on a per-user 'inbound' doc.
  async inboundToken(userId, makeToken) {
    const doc = await integrations.findOne({ userId, type: 'inbound' });
    if (doc) return doc.token;
    const token = makeToken();
    await integrations.insert({ userId, type: 'inbound', token, createdAt: new Date().toISOString() });
    return token;
  },
  async rotateInboundToken(userId, makeToken) {
    const token = makeToken();
    await integrations.remove({ userId, type: 'inbound' }, { multi: true });
    await integrations.insert({ userId, type: 'inbound', token, createdAt: new Date().toISOString() });
    return token;
  },
  async findByInboundToken(token) { return token ? integrations.findOne({ type: 'inbound', token }) : null; },
};

// ── Storm recap prospects (imported email list) ───────────────────────────────
// Unsubscribed prospects are kept (active: false) so a re-import can't add them back.
const prospectOps = {
  async upsertMany(list) {
    const crypto = require('crypto');
    let added = 0, updated = 0, skipped = 0;
    for (const p of list) {
      const existing = await prospects.findOne({ email: p.email });
      if (existing) {
        if (!existing.active) { skipped++; continue; }
        await prospects.update({ _id: existing._id }, { $set: { ...p, updatedAt: new Date().toISOString() } });
        updated++;
      } else {
        await prospects.insert({ ...p, token: crypto.randomBytes(20).toString('hex'), active: true, recaps: 0, createdAt: new Date().toISOString() });
        added++;
      }
    }
    return { added, updated, skipped };
  },
  async getActive() { return prospects.find({ active: true }); },
  async list({ limit = 200, skip = 0 } = {}) { return prospects.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit); },
  async all() { return prospects.find({}).sort({ createdAt: -1 }); },
  async counts() {
    const [active, unsubscribed] = await Promise.all([prospects.count({ active: true }), prospects.count({ active: false })]);
    return { active, unsubscribed };
  },
  async byToken(token) { return token ? prospects.findOne({ token }) : null; },
  async unsubscribe(token) { return prospects.update({ token }, { $set: { active: false, unsubscribedAt: new Date().toISOString() } }); },
  async markSent(id, date) { return prospects.update({ _id: id }, { $set: { lastRecapAt: new Date().toISOString(), lastRecapDate: date }, $inc: { recaps: 1 } }); },
  async remove(id) { return prospects.remove({ _id: id }); },
  async removeAllActive() { return prospects.remove({ active: true }, { multi: true }); },
};

module.exports = { prospectOps, integrationOps, freeAlertOps, reviewOps, userOps, lookupOps, alertOps, profileOps, resultsCacheOps, affiliateOps, watchlistOps, alertSettingsOps, AFFILIATE_COMMISSION, TIERS, tierFeatures, tierLookupLimit };
