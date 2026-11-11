/**
 * Billing helpers: which plan a Stripe subscription is for, and promo codes.
 */

const PRICE_ENV = {
  starter: 'STRIPE_PRICE_ID_STARTER',
  pro: 'STRIPE_PRICE_ID_PRO',
  team: 'STRIPE_PRICE_ID_TEAM',
  enterprise: 'STRIPE_PRICE_ID_ENTERPRISE',
};
const PAID_TIERS = Object.keys(PRICE_ENV);

// The plan a Stripe price belongs to, from the STRIPE_PRICE_ID_* (monthly) and
// STRIPE_PRICE_ID_*_YEARLY settings.
function tierForPrice(priceId, env = process.env) {
  if (!priceId) return null;
  for (const [tier, key] of Object.entries(PRICE_ENV)) {
    if (env[key] && env[key] === priceId) return tier;
    if (env[key + '_YEARLY'] && env[key + '_YEARLY'] === priceId) return tier;
  }
  if (env.STRIPE_PRICE_ID && env.STRIPE_PRICE_ID === priceId) return 'pro';
  return null;
}

// The plan an active subscription should give: its price first, then the plan the
// customer bought at checkout, then their current plan if it is a paid one.
function tierForSubscription(sub, user, env = process.env) {
  const items = (sub && sub.items && sub.items.data) || [];
  for (const it of items) {
    const t = tierForPrice(it && it.price && it.price.id, env);
    if (t) return t;
  }
  if (user && PAID_TIERS.includes(user.paidTier)) return user.paidTier;
  if (user && PAID_TIERS.includes(user.tier)) return user.tier;
  return 'pro';
}

// Turn what a customer typed into a Stripe discount. Customer-facing promotion codes
// are checked first. A raw coupon ID is only accepted for the trial offer code
// (TRIAL_COUPON_CODE, e.g. STORM50) while PROMO_OFFERS=on, so other coupons can't be
// guessed and applied.
async function resolveDiscount(stripe, typed, env = process.env) {
  const code = String(typed || '').trim();
  if (!code || code.length > 64) return null;
  try {
    const found = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
    if (found && found.data && found.data[0]) return { promotion_code: found.data[0].id };
  } catch (e) { /* fall through to the trial coupon */ }
  // The trial coupon is only honored while discount offers are switched on.
  if (String(env.PROMO_OFFERS || '').toLowerCase() !== 'on') return null;
  const trial = String(env.TRIAL_COUPON_CODE || 'STORM50').trim();
  if (code.toUpperCase() !== trial.toUpperCase()) return null;
  for (const id of [...new Set([trial, code, code.toUpperCase()])]) {
    try {
      const c = await stripe.coupons.retrieve(id);
      if (c && c.valid !== false) return { coupon: c.id };
    } catch (e) { /* try the next spelling */ }
  }
  return null;
}

// The Stripe price for a plan and billing period ('month' or 'year').
function priceFor(tier, interval, env = process.env) {
  const key = PRICE_ENV[tier];
  if (interval === 'year') return key ? env[key + '_YEARLY'] || null : null;
  if (tier === 'pro') return env.STRIPE_PRICE_ID_PRO || env.STRIPE_PRICE_ID || null;
  return key ? env[key] || null : env.STRIPE_PRICE_ID || null;
}

module.exports = { priceFor, tierForPrice, tierForSubscription, resolveDiscount, PAID_TIERS };
