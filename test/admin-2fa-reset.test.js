const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), path = require('path'), fs = require('fs');

test('ADMIN_2FA_RESET=on turns off two-step for the admin account on startup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-2fa-'));
  process.env.DATA_DIR = dir;
  process.env.ADMIN_EMAIL = 'owner@example.com';
  process.env.ADMIN_PASSWORD = 'owner-pass-123';
  let db = require('../db');
  await new Promise(r => setTimeout(r, 1500));
  const u = await db.userOps.findByEmail('owner@example.com');
  await db.userOps.update(u._id, { totpEnabled: true, totpSecret: 'x', totpBackup: [] });
  // Simulate the next deploy with the switch on.
  process.env.ADMIN_2FA_RESET = 'on';
  for (const k of Object.keys(require.cache)) if (k.includes(path.sep + 'db.js')) delete require.cache[k];
  db = require('../db');
  await new Promise(r => setTimeout(r, 1500));
  const after = await db.userOps.findByEmail('owner@example.com');
  assert.strictEqual(after.totpEnabled, false);
  assert.strictEqual(after.totpSecret, null);
  delete process.env.ADMIN_2FA_RESET;
});
