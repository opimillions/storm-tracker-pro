const test = require('node:test');
const assert = require('node:assert');
const { tierForPrice, tierForSubscription, resolveDiscount } = require('../lib/billing');

const env = { STRIPE_PRICE_ID_STARTER: 'price_s', STRIPE_PRICE_ID_PRO: 'price_p', STRIPE_PRICE_ID_TEAM: 'price_t', STRIPE_PRICE_ID_ENTERPRISE: 'price_e', TRIAL_COUPON_CODE: 'STORM50', PROMO_OFFERS: 'on' };

test('maps Stripe prices to plans', () => {
  assert.strictEqual(tierForPrice('price_t', env), 'team');
  assert.strictEqual(tierForPrice('price_x', env), null);
  assert.strictEqual(tierForPrice('legacy', { STRIPE_PRICE_ID: 'legacy' }), 'pro');
});

test('a fixed card restores the plan that was paid for', () => {
  // Paused at trial after a failed payment; the subscription is for Team.
  const paused = { tier: 'trial', paidTier: 'pro' };
  assert.strictEqual(tierForSubscription({ items: { data: [{ price: { id: 'price_t' } }] } }, paused, env), 'team');
  assert.strictEqual(tierForSubscription({}, paused, env), 'pro', 'falls back to the plan bought at checkout');
  assert.strictEqual(tierForSubscription({}, { tier: 'starter' }, env), 'starter');
  assert.strictEqual(tierForSubscription({}, { tier: 'trial' }, env), 'pro');
});

function fakeStripe({ promos = {}, coupons = {} } = {}) {
  return {
    promotionCodes: { list: async ({ code }) => ({ data: Object.entries(promos).filter(([c]) => c.toLowerCase() === code.toLowerCase()).map(([, id]) => ({ id })) }) },
    coupons: { retrieve: async (id) => { if (!coupons[id]) throw new Error('No such coupon'); return { id, valid: coupons[id] !== 'expired' }; } },
  };
}

test('promo codes: promotion codes, the trial coupon, and nothing else', async () => {
  const s = fakeStripe({ promos: { SPRING25: 'promo_123' }, coupons: { STORM50: true, FREE100: true } });
  assert.deepStrictEqual(await resolveDiscount(s, 'spring25', env), { promotion_code: 'promo_123' });
  assert.deepStrictEqual(await resolveDiscount(s, 'storm50', env), { coupon: 'STORM50' });
  assert.strictEqual(await resolveDiscount(s, 'FREE100', env), null, 'other coupon IDs cannot be typed in');
  assert.strictEqual(await resolveDiscount(s, 'NOPE', env), null);
  assert.strictEqual(await resolveDiscount(fakeStripe({ coupons: { STORM50: 'expired' } }), 'STORM50', env), null);
});

test('the trial coupon is refused while discount offers are off', async () => {
  const s = fakeStripe({ coupons: { STORM50: true } });
  assert.strictEqual(await resolveDiscount(s, 'STORM50', { ...env, PROMO_OFFERS: '' }), null);
});
