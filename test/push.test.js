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
