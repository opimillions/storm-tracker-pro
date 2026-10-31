/**
 * End-to-end tests for the core flows, against the real server process:
 * sign-up, sign-in (lockout, sessions), password reset tokens, lookups,
 * the Stripe webhook, and phone-alert subscriptions.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), path = require('path'), fs = require('fs'), net = require('net');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-routes-'));
const WEBHOOK_SECRET = 'whsec_test_secret';
let base, proc;

function freePort() {
  return new Promise(resolve => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

// Minimal cookie-keeping client.
function client() {
  const jar = {};
  async function call(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method, redirect: 'manual',
      headers: { ...(body && typeof body !== 'string' ? { 'Content-Type': 'application/json' } : {}), cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
      body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (v) jar[k] = v; else delete jar[k];
    }
    let json = null; const text = await res.text();
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  return { get: (u, h) => call('GET', u, null, h), post: (u, b, h) => call('POST', u, b, h), jar };
}

test.before(async () => {
  // Seed one radar hail day so lookups use the local data stores (no network).
  execFileSync(process.execPath, ['-e', `
    const mesh = require('./lib/mesh-store');
    const ni = 7000, la1 = 54.995, lo1 = -129.995;
    const idx = (lat, lon) => Math.round((la1 - lat) / 0.01) * ni + Math.round((lon - lo1) / 0.01);
    const index = [], data = [];
    for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) { index.push(idx(32.92 + a * 0.01, -97.16 + b * 0.01)); data.push(44.45); }
    mesh.ingestGrid('2025-05-28', { ni, nj: 3500, la1, lo1, di: 0.01, dj: 0.01, scanMode: 0, index, data });
  `], { cwd: ROOT, env: { ...process.env, DATA_DIR: DATA } });

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), DATA_DIR: DATA, DATA_JOBS: 'off', NODE_ENV: 'test',
      ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'AdminPass123!', JWT_SECRET: 'x'.repeat(64),
      STRIPE_SECRET_KEY: 'sk_test_dummy', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      RESEND_API_KEY: '', SMTP_HOST: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { out += d; });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/login'); if (r.ok) return; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('server did not start:\n' + out);
});
test.after(() => { if (proc) proc.kill(); });

test('security headers are sent', async () => {
  const r = await client().get('/login');
  assert.strictEqual(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(!r.headers.get('x-powered-by'));
});

test('sign-up, session, sign-out', async () => {
  const c = client();
  let r = await c.post('/api/auth/register', { name: 'Ann', email: 'Ann@Roof.co', password: 'short' });
  assert.strictEqual(r.status, 400, 'short password rejected');
  r = await c.post('/api/auth/register', { name: 'Ann', company: 'Ann Roofing', email: 'Ann@Roof.co', password: 'password123' });
  assert.strictEqual(r.status, 200);
  assert.ok(c.jar.token, 'session cookie set');
  r = await c.get('/api/me');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.user.email, 'ann@roof.co');
  assert.strictEqual(r.json.user.tier, 'trial');
  for (const secret of ['passwordHash', 'resetToken', 'totpSecret', 'totpBackup', 'tokenVersion']) assert.ok(!(secret in r.json.user), `${secret} not exposed`);
  r = await c.post('/api/auth/register', { name: 'Ann', email: 'ann@roof.co', password: 'password123' });
  assert.strictEqual(r.status, 409, 'duplicate email');
  await c.post('/api/auth/logout');
  r = await c.get('/api/me');
  assert.strictEqual(r.status, 401);
});

test('sign-in locks after 5 wrong passwords', async () => {
  const c = client();
  await c.post('/api/auth/register', { name: 'Bob', email: 'bob@roof.co', password: 'password123' });
  for (let i = 0; i < 5; i++) assert.strictEqual((await c.post('/api/auth/login', { email: 'bob@roof.co', password: 'wrong' })).status, 401);
  const r = await c.post('/api/auth/login', { email: 'bob@roof.co', password: 'password123' });
  assert.strictEqual(r.status, 429, 'even the right password waits out the lock');
  assert.match(r.json.error, /Too many wrong passwords/);
});

test('sign-out everywhere ends other sessions', async () => {
  const a = client(), b = client();
  await a.post('/api/auth/register', { name: 'Cy', email: 'cy@roof.co', password: 'password123' });
  await b.post('/api/auth/login', { email: 'cy@roof.co', password: 'password123' });
  assert.strictEqual((await b.get('/api/me')).status, 200);
  await a.post('/api/auth/logout-all');
  assert.strictEqual((await b.get('/api/me')).status, 401);
});

test('forgot password always answers the same (no account probing)', async () => {
  const c = client();
  const known = await c.post('/api/auth/forgot-password', { email: 'ann@roof.co' });
  const unknown = await c.post('/api/auth/forgot-password', { email: 'nobody@roof.co' });
  assert.deepStrictEqual(known.json, unknown.json);
  const r = await c.post('/api/auth/reset-password', { token: 'not-a-real-token', password: 'password456' });
  assert.strictEqual(r.status, 400);
});

test('lookup: trial gets one report, then must upgrade', async () => {
  const c = client();
  await c.post('/api/auth/register', { name: 'Dee', email: 'dee@roof.co', password: 'password123' });
  let r = await c.post('/api/lookup', { address: '100 Test St, Southlake, TX 76092', lat: 32.945, lon: -97.135, state: 'TX', years: 5 });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.stormDates[0].date, '2025-05-28');
  assert.strictEqual(r.json.stormDates[0].radar.atPropertyIn, 1.75);
  assert.ok(r.json.score > 0);
  r = await c.post('/api/lookup', { address: '100 Test St, Southlake, TX 76092', lat: 32.945, lon: -97.135, years: 5 });
  assert.strictEqual(r.status, 402);
  assert.ok(r.json.upgrade);
  r = await client().post('/api/lookup', { address: 'x', lat: 32, lon: -97 });
  assert.strictEqual(r.status, 401, 'signed out');
});

test('Stripe webhook: rejects bad signatures, upgrades on checkout', async () => {
  const c = client();
  await c.post('/api/auth/register', { name: 'Eve', email: 'eve@roof.co', password: 'password123' });
  const me = (await c.get('/api/me')).json.user;
  const payload = JSON.stringify({
    id: 'evt_test', object: 'event', type: 'checkout.session.completed',
    data: { object: { id: 'cs_test', customer: 'cus_test', subscription: 'sub_test', customer_email: 'eve@roof.co', metadata: { userId: me._id, tier: 'team' } } },
  });
  let r = await c.post('/api/stripe/webhook', payload, { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=bad' });
  assert.strictEqual(r.status, 400);
  const stripe = require('stripe')('sk_test_dummy');
  const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  r = await c.post('/api/stripe/webhook', payload, { 'Content-Type': 'application/json', 'stripe-signature': sig });
  assert.strictEqual(r.status, 200, r.text);
  const after = (await c.get('/api/me')).json.user;
  assert.strictEqual(after.tier, 'team');
  assert.strictEqual(after.lookupLimit, -1);
});

test('phone alerts: subscriptions are saved per user and validated', async () => {
  const c = client();
  await c.post('/api/auth/register', { name: 'Fay', email: 'fay@roof.co', password: 'password123' });
  const key = (await c.get('/api/push/vapid-key')).json.publicKey;
  assert.ok(key && key.length > 40, 'keys exist without setup');
  let r = await c.post('/api/push/subscribe', { endpoint: 'http://insecure.example/x', keys: { p256dh: 'a', auth: 'b' } });
  assert.strictEqual(r.status, 400);
  r = await c.post('/api/push/subscribe', { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'BPk', auth: 'xyz' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await c.get('/api/push/status')).json.devices, 1);
  await c.post('/api/push/unsubscribe', { endpoint: 'https://push.example.com/abc' });
  assert.strictEqual((await c.get('/api/push/status')).json.devices, 0);
});

test('admin pages need an admin', async () => {
  const c = client();
  await c.post('/api/auth/register', { name: 'Gus', email: 'gus@roof.co', password: 'password123' });
  assert.strictEqual((await c.get('/api/admin/stats')).status, 403);
  const a = client();
  await a.post('/api/auth/login', { email: 'admin@test.local', password: 'AdminPass123!' });
  const r = await a.get('/api/admin/stats');
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.json.recentAlerts));
});
