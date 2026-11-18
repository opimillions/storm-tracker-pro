const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-hide-'));
process.env.MONITOR_SEED_USER = 'StormCheck Monitor:Monitor+Test@Example.com:pw-123456:client';
const db = require('../db');

test('monitor test account lookups are hidden from admin lists and counts, kept for its own history', async () => {
  const mon = await db.userOps.create({ name: 'StormCheck Monitor', email: 'monitor+test@example.com', password: 'pw-123456', tier: 'client' });
  const real = await db.userOps.create({ name: 'Real Customer', email: 'real@example.com', password: 'pw-123456', tier: 'pro' });
  await db.lookupOps.create({ userId: mon._id, address: '2651 BROADWAY DR, TROPHY CLUB, TX', lat: 33, lon: -97 });
  await db.lookupOps.create({ userId: real._id, address: '100 MAIN ST, KELLER, TX', lat: 32.9, lon: -97.2 });
  const recent = await db.lookupOps.getRecent(50);
  assert.deepStrictEqual(recent.map(l => l.email), ['real@example.com']);
  assert.strictEqual((await db.lookupOps.getStats()).total, 1);
  assert.strictEqual((await db.lookupOps.getForUser(mon._id)).length, 1);
});
