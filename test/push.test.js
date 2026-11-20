const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-push-'));
process.env.DATA_JOBS = 'off';
delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY;

const db = require('../db');
const push = require('../lib/push');

test('keys are generated once and kept', () => {
  const k1 = push.publicKey();
  assert.ok(k1.length > 40);
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, '.vapid-keys.json')));
  assert.strictEqual(push.publicKey(), k1);
});

test('sends only to the user\'s own devices and drops dead ones', async () => {
  push.init(db);
  const sub = e => ({ endpoint: e, keys: { p256dh: 'k', auth: 'a' } });
  await db.pushOps.save('u1', sub('https://p.example/live'), 'iPhone');
  await db.pushOps.save('u1', sub('https://p.example/gone'), 'old');
  await db.pushOps.save('u2', sub('https://p.example/other'), 'x');
  const calls = [];
  const sender = { sendNotification: async (s, body) => { calls.push([s.endpoint, JSON.parse(body)]); if (s.endpoint.endsWith('gone')) { const e = new Error('Gone'); e.statusCode = 410; throw e; } } };
  const sent = await push.sendToUser('u1', { title: 'Hail hit 2 of your properties', body: 'x', url: '/watchlist' }, { sender });
  assert.strictEqual(sent, 1);
  assert.deepStrictEqual(calls.map(c => c[0]).sort(), ['https://p.example/gone', 'https://p.example/live']);
  assert.strictEqual(calls[0][1].title, 'Hail hit 2 of your properties');
  assert.strictEqual(await db.pushOps.countForUser('u1'), 1, 'expired device removed');
  assert.strictEqual(await db.pushOps.countForUser('u2'), 1, 'other users untouched');
});

test('native iPhone tokens go through APNs and dead tokens are dropped', async () => {
  push.init(db);
  await db.pushOps.saveNative('n1', 'aa'.repeat(32), 'StormCheckProApp/1.0');
  await db.pushOps.saveNative('n1', 'bb'.repeat(32), 'StormCheckProApp/1.0');
  await db.pushOps.saveNative('n1', 'aa'.repeat(32), 'StormCheckProApp/1.0'); // same device again: no duplicate
  assert.strictEqual(await db.pushOps.countForUser('n1'), 2);
  const calls = [];
  const apnsSender = { send: async (token, p) => { calls.push([token, p.url]); return token.startsWith('bb') ? { ok: false, status: 410, gone: true } : { ok: true, status: 200 }; } };
  const sender = { sendNotification: async () => { throw new Error('web push should not be used for native tokens'); } };
  const sent = await push.sendToUser('n1', { title: 'Hail', body: 'x', url: '/watchlist' }, { sender, apnsSender });
  assert.strictEqual(sent, 1);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0][1], '/watchlist');
  assert.strictEqual(await db.pushOps.countForUser('n1'), 1, 'uninstalled device removed');
});

test('APNs is off until keys are set', async () => {
  delete process.env.APNS_KEY; delete process.env.APNS_KEY_ID; delete process.env.APNS_TEAM_ID;
  const apns = require('../lib/apns');
  assert.strictEqual(apns.configured(), false);
  assert.deepStrictEqual(await apns.send('aa'.repeat(32), { title: 't', body: 'b' }), { ok: false, reason: 'not-configured' });
});
