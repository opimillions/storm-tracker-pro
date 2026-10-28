/**
 * Two-step sign-in (authenticator app codes) and account security.
 *
 * Setup:   /api/account/2fa/setup → QR code + key; /enable with a code turns
 *          it on and returns 8 one-time backup codes (stored hashed).
 * Sign-in: /api/auth/login answers { twoFactor, ticket } after a correct
 *          password; /api/auth/login/verify trades ticket + code for a session.
 * The authenticator secret is stored encrypted (secret-box).
 */
const QRCode = require('qrcode');
const sec = require('./lib/security');
const box = require('./lib/secret-box');
const { generateToken, readMfaTicket } = require('./auth');

module.exports = function securityRoutes(app, { db, requireAuth, requireAdmin }) {
  const { userOps } = db;

  async function checkSecondFactor(user, code) {
    const c = String(code || '').trim();
    if (/^\d{6}$/.test(c.replace(/\s/g, ''))) {
      let secret;
      try { secret = box.open(user.totpSecret); } catch { return false; }
      const step = sec.verifyTotp(secret, c, { lastStep: user.totpLastStep || -1 });
      if (step < 0) return false;
      await userOps.update(user._id, { totpLastStep: step });
      return true;
    }
    // Backup code: single use.
    const h = sec.hashCode(c);
    const list = user.totpBackup || [];
    if (!list.includes(h)) return false;
    await userOps.update(user._id, { totpBackup: list.filter(x => x !== h) });
    return true;
  }

  // ── Sign-in, step 2 ───────────────────────────────────────────────────────
  app.post('/api/auth/login/verify', async (req, res) => {
    const t = readMfaTicket(req.body && req.body.ticket);
    if (!t) return res.status(401).json({ error: 'That sign-in expired. Enter your password again.', restart: true });
    const user = await userOps.findById(t.id);
    if (!user || !user.totpEnabled || (user.tokenVersion || 0) !== (t.tv || 0)) return res.status(401).json({ error: 'Sign in again.', restart: true });
    const wait = sec.lockedFor('mfa:' + user._id, req.ip);
    if (wait) return res.status(429).json({ error: `Too many wrong codes. Try again in ${wait} minute${wait === 1 ? '' : 's'}.` });
    if (!(await checkSecondFactor(user, req.body.code))) {
      sec.recordFailure('mfa:' + user._id, req.ip);
      return res.status(401).json({ error: 'That code is not right. Use the 6-digit code from your authenticator app, or a backup code.' });
    }
    sec.clearFailures('mfa:' + user._id);
    sec.setSessionCookie(req, res, generateToken(user));
    res.json({ success: true, redirect: user.role === 'admin' ? '/admin' : '/dashboard' });
  });

  // ── Account security settings ─────────────────────────────────────────────
  app.get('/api/account/security', requireAuth, (req, res) => {
    const u = req.user;
    res.json({ twoFactor: !!u.totpEnabled, backupCodesLeft: (u.totpBackup || []).length, isAdmin: u.role === 'admin' });
  });

  app.post('/api/account/2fa/setup', requireAuth, async (req, res) => {
    if (req.user.totpEnabled) return res.status(400).json({ error: 'Two-step sign-in is already on.' });
    const secret = sec.newTotpSecret();
    await userOps.update(req.user._id, { totpPending: box.seal(secret) });
    const uri = sec.otpauthUri(secret, req.user.email);
    const svg = await QRCode.toString(uri, { type: 'svg', margin: 1, width: 200, errorCorrectionLevel: 'M' });
    res.json({ qrSvg: svg, key: secret.replace(/(.{4})/g, '$1 ').trim() });
  });

  app.post('/api/account/2fa/enable', requireAuth, async (req, res) => {
    const u = await userOps.findById(req.user._id);
    if (!u.totpPending) return res.status(400).json({ error: 'Start setup first.' });
    let secret;
    try { secret = box.open(u.totpPending); } catch { return res.status(400).json({ error: 'Start setup again.' }); }
    const step = sec.verifyTotp(secret, req.body && req.body.code);
    if (step < 0) return res.status(400).json({ error: 'That code is not right. Check the time on your phone and try the newest code.' });
    const { codes, hashes } = sec.newBackupCodes();
    await userOps.update(u._id, { totpSecret: u.totpPending, totpPending: null, totpEnabled: true, totpLastStep: step, totpBackup: hashes, totpEnabledAt: new Date().toISOString() });
    // Other devices must sign in again with a code; this one stays signed in.
    await userOps.bumpTokenVersion(u._id);
    sec.setSessionCookie(req, res, generateToken(await userOps.findById(u._id)));
    res.json({ success: true, backupCodes: codes });
  });

  app.post('/api/account/2fa/disable', requireAuth, async (req, res) => {
    const u = await userOps.findById(req.user._id);
    if (!u.totpEnabled) return res.json({ success: true });
    if (!userOps.verifyPassword(u, String((req.body || {}).password || ''))) return res.status(400).json({ error: 'Password is not right.' });
    if (!(await checkSecondFactor(u, (req.body || {}).code))) return res.status(400).json({ error: 'Code is not right.' });
    await userOps.update(u._id, { totpSecret: null, totpPending: null, totpEnabled: false, totpBackup: [], totpLastStep: null });
    res.json({ success: true });
  });

  app.post('/api/account/2fa/backup-codes', requireAuth, async (req, res) => {
    const u = await userOps.findById(req.user._id);
    if (!u.totpEnabled) return res.status(400).json({ error: 'Turn on two-step sign-in first.' });
    if (!(await checkSecondFactor(u, (req.body || {}).code))) return res.status(400).json({ error: 'Code is not right.' });
    const { codes, hashes } = sec.newBackupCodes();
    await userOps.update(u._id, { totpBackup: hashes });
    res.json({ backupCodes: codes });
  });

  // ── Admin: security checklist ─────────────────────────────────────────────
  app.get('/api/admin/security', requireAuth, requireAdmin, async (req, res) => {
    const { hasEnvSecret } = require('./lib/app-secret');
    const backups = require('./lib/backups');
    const admins = (await userOps.getAll()).filter(u => u.role === 'admin');
    res.json({
      checks: [
        { ok: hasEnvSecret(), label: 'Sign-in secret (JWT_SECRET) is set in hosting', fix: 'Add JWT_SECRET in Railway: 64+ random characters. Everyone signs in again once.' },
        { ok: req.secure, label: 'Site is served over HTTPS', fix: 'Use the https:// address.' },
        { ok: process.env.NODE_ENV === 'production', label: 'NODE_ENV is production', fix: 'Add NODE_ENV=production in Railway.' },
        { ok: admins.every(a => a.totpEnabled), label: 'Every admin uses two-step sign-in', fix: 'Turn it on in Settings → Security.' },
        { ok: !!process.env.BACKUP_KEY, label: 'Backup encryption key (BACKUP_KEY) is set', fix: 'Add BACKUP_KEY in Railway and keep a copy in your password manager. Backups cannot be restored without it.' },
        { ok: backups.offsiteConfigured(), label: 'Backups are copied off the server', fix: 'Add the BACKUP_S3_* settings for a storage bucket (Cloudflare R2, Backblaze B2 or AWS S3).' },
        { ok: !!backups.latest(), label: 'A backup was made in the last 26 hours', fix: 'Click "Back up now".', stale: backups.latestAgeHours() },
      ],
      backups: backups.list().slice(0, 30),
      lastRun: backups.lastRun(),
    });
  });
};
