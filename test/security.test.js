const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-sec-'));
process.env.DATA_JOBS = 'off';
delete process.env.JWT_SECRET; delete process.env.INTEGRATION_SECRET;
process.env.BACKUP_KEY = 'correct horse battery staple';

const sec = require('../lib/security');
const appSecret = require('../lib/app-secret');
const box = require('../lib/secret-box');
const backups = require('../lib/backups');

test('TOTP matches the RFC 6238 test vector', () => {
  const secret = sec.base32Encode(Buffer.from('12345678901234567890'));
  assert.strictEqual(sec.totpAt(secret, 1), '287082');           // T = 59s
  assert.strictEqual(sec.totpAt(secret, 37037036), '081804');    // T = 1111111109s
  const now = 59 * 1000;
  assert.strictEqual(sec.verifyTotp(secret, '287082', { now }), 1);
  assert.strictEqual(sec.verifyTotp(secret, '287082', { now, lastStep: 1 }), -1, 'a code cannot be reused');
  assert.strictEqual(sec.verifyTotp(secret, '000000', { now }), -1);
  assert.strictEqual(sec.base32Decode(secret).toString(), '12345678901234567890');
});

test('backup codes are single-format and hashed', () => {
  const { codes, hashes } = sec.newBackupCodes();
  assert.strictEqual(codes.length, 8);
  assert.match(codes[0], /^[0-9A-F]{5}-[0-9A-F]{5}$/);
  assert.strictEqual(sec.hashCode(codes[0].toLowerCase().replace('-', ' ')), hashes[0]);
  assert.ok(!hashes.includes(codes[0]));
});

test('locks an email after 5 wrong passwords', () => {
  for (let i = 0; i < 4; i++) sec.recordFailure('a@x.com', '1.1.1.1');
  assert.strictEqual(sec.lockedFor('a@x.com', '1.1.1.1'), 0);
  sec.recordFailure('a@x.com', '1.1.1.1');
  assert.ok(sec.lockedFor('A@X.com', '2.2.2.2') >= 14, 'locked for the account from any IP');
  assert.strictEqual(sec.lockedFor('b@x.com', '1.1.1.1'), 0, 'other accounts are fine');
  sec.clearFailures('a@x.com');
  assert.strictEqual(sec.lockedFor('a@x.com', '1.1.1.1'), 0);
});

test('no hardcoded signing secret; generated secret persists', () => {
  const s = appSecret.jwtSecret();
  assert.notStrictEqual(s, appSecret.LEGACY_DEFAULT);
  assert.ok(s.length >= 64);
  assert.strictEqual(fs.readFileSync(path.join(process.env.DATA_DIR, '.app-secret'), 'utf8'), s);
  assert.ok(!appSecret.hasEnvSecret());
});

test('CRM keys sealed with the old default can still be read', () => {
  const k = crypto.createHash('sha256').update('stormcheck-integrations:' + appSecret.LEGACY_DEFAULT).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update('old-api-key', 'utf8'), c.final()]);
  const sealed = ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
  assert.strictEqual(box.open(sealed), 'old-api-key');
  assert.strictEqual(box.open(box.seal('new-key')), 'new-key');
});

test('sessions are ended by bumping the token version', async () => {
  const db = require('../db');
  const { generateToken, requireAuth, generateMfaTicket } = require('../auth');
  await db.userOps.create({ email: 'v@x.com', password: 'password123', name: 'V', role: 'subscriber', tier: 'pro' });
  const user = await db.userOps.findByEmail('v@x.com');
  const call = token => new Promise(resolve => {
    const req = { cookies: { token }, headers: {}, path: '/api/me', secure: true };
    const res = { status(c) { this.code = c; return this; }, json() { resolve(this.code || 200); }, clearCookie() {}, redirect() { resolve(302); } };
    requireAuth(req, res, () => resolve(200));
  });
  const t = generateToken(user);
  assert.strictEqual(await call(t), 200);
  assert.strictEqual(await call(generateMfaTicket(user)), 401, 'a two-step ticket is not a session');
  await db.userOps.bumpTokenVersion(user._id);
  assert.strictEqual(await call(t), 401, 'old session no longer works');
  assert.strictEqual(await call(generateToken(await db.userOps.findById(user._id))), 200);
});

test('reset tokens are stored hashed', async () => {
  const db = require('../db');
  const exp = new Date(Date.now() + 3600000).toISOString();
  await db.userOps.setResetToken('v@x.com', 'plain-token', exp);
  const u = await db.userOps.findByEmail('v@x.com');
  assert.notStrictEqual(u.resetToken, 'plain-token');
  assert.ok(await db.userOps.findByResetToken('plain-token'));
  assert.strictEqual(await db.userOps.findByResetToken(u.resetToken), null, 'the stored hash itself does not work as a link');
});

test('encrypted backups round-trip and skip secrets and caches', async () => {
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'results-cache.db'), 'cache');
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'recap-settings.json'), '{"a":1}');
  const r = await backups.run();
  assert.ok(r.files >= 2);
  assert.strictEqual(r.offsite, 'not set up');
  const buf = fs.readFileSync(backups.filePath(r.name));
  assert.ok(!buf.includes(Buffer.from('v@x.com')), 'backup is encrypted');
  const out = backups.decode(buf, 'correct horse battery staple');
  assert.ok(out.files['users.db'].toString().includes('v@x.com'));
  assert.ok(!out.files['results-cache.db']);
  assert.ok(!out.files['.app-secret']);
  assert.throws(() => backups.decode(buf, 'wrong key'));
  assert.strictEqual(backups.filePath('../users.db'), null);
});

test('offsite upload is signed for S3', async () => {
  Object.assign(process.env, { BACKUP_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', BACKUP_S3_BUCKET: 'scp', BACKUP_S3_ACCESS_KEY: 'AK', BACKUP_S3_SECRET_KEY: 'SK' });
  let seen = null;
  await backups.upload('x.bin', Buffer.from('data'), { http: { put: async (url, data, opts) => { seen = { url, opts }; } } });
  assert.strictEqual(seen.url, 'https://acct.r2.cloudflarestorage.com/scp/stormcheck-backups/x.bin');
  assert.match(seen.opts.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request/);
  assert.ok(seen.opts.headers['X-Amz-Content-Sha256']);
});
