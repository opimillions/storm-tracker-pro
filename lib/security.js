/**
 * Security helpers: browser security headers, sign-in cookie settings,
 * sign-in attempt limits, and two-step sign-in codes (TOTP, RFC 6238).
 */
const crypto = require('crypto');

// ── Security headers ─────────────────────────────────────────────────────────
function headers() {
  return (req, res, next) => {
    res.removeHeader('X-Powered-By');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('Permissions-Policy', 'camera=(), microphone=(), payment=(), usb=(), geolocation=(self)');
    // Framing only by this site (stops clickjacking); no plugins; no <base> hijacking.
    res.set('Content-Security-Policy', "frame-ancestors 'self'; object-src 'none'; base-uri 'self'");
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // Signed-in pages and API answers carry customer data: never cache them in shared caches.
    if (req.path.startsWith('/api/') && !req.path.startsWith('/api/public/') && !req.path.startsWith('/api/config/')) {
      res.set('Cache-Control', 'no-store');
    }
    next();
  };
}

// ── Sign-in cookie ───────────────────────────────────────────────────────────
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: !!(req.secure || process.env.NODE_ENV === 'production'),
    maxAge: SESSION_MS,
    path: '/',
  };
}
function setSessionCookie(req, res, token) { res.cookie('token', token, cookieOptions(req)); }
function clearSessionCookie(req, res) { res.clearCookie('token', { ...cookieOptions(req), maxAge: undefined }); }

// ── Sign-in attempt limits ───────────────────────────────────────────────────
// 5 wrong passwords for an email within 15 minutes locks that email for 15
// minutes; 30 failures from one IP across any emails locks that IP.
const WINDOW = 15 * 60 * 1000;
const PER_ACCOUNT = 5, PER_IP = 30;
const fails = new Map(); // key -> [timestamps]
function recent(key) {
  const now = Date.now();
  const arr = (fails.get(key) || []).filter(t => now - t < WINDOW);
  if (arr.length) fails.set(key, arr); else fails.delete(key);
  return arr;
}
/** Minutes until unlocked, or 0 when allowed. */
function lockedFor(email, ip) {
  const a = recent('e:' + String(email || '').toLowerCase());
  const b = recent('i:' + ip);
  const until = Math.max(a.length >= PER_ACCOUNT ? a[a.length - PER_ACCOUNT] + WINDOW : 0, b.length >= PER_IP ? b[b.length - PER_IP] + WINDOW : 0);
  return until > Date.now() ? Math.ceil((until - Date.now()) / 60000) : 0;
}
function recordFailure(email, ip) {
  const now = Date.now();
  for (const k of ['e:' + String(email || '').toLowerCase(), 'i:' + ip]) { const arr = recent(k); arr.push(now); fails.set(k, arr); }
  if (fails.size > 50000) fails.clear(); // memory guard under a flood
}
function clearFailures(email) { fails.delete('e:' + String(email || '').toLowerCase()); }

// ── Two-step sign-in (TOTP) ──────────────────────────────────────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function base32Decode(s) {
  s = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, val = 0; const out = [];
  for (const ch of s) { val = (val << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
function totpAt(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  msg.writeUInt32BE(counter % 2 ** 32, 4);
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 127) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1e6;
  return String(code).padStart(6, '0');
}
/** Returns the matched time step, or -1. Accepts one step of clock drift each way. */
function verifyTotp(secret, code, { now = Date.now(), lastStep = -1 } = {}) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return -1;
  const step = Math.floor(now / 30000);
  for (const s of [step, step - 1, step + 1]) {
    if (s <= lastStep) continue; // a code can't be reused
    const a = Buffer.from(totpAt(secret, s)), b = Buffer.from(code);
    if (crypto.timingSafeEqual(a, b)) return s;
  }
  return -1;
}
function otpauthUri(secret, account, issuer = 'StormCheck Pro') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
/** One-time backup codes: shown once, stored hashed. */
function newBackupCodes(n = 8) {
  const codes = Array.from({ length: n }, () => {
    const s = crypto.randomBytes(5).toString('hex').toUpperCase();
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
  return { codes, hashes: codes.map(hashCode) };
}
const hashCode = c => crypto.createHash('sha256').update('scp-backup:' + String(c).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

module.exports = {
  headers, cookieOptions, setSessionCookie, clearSessionCookie, SESSION_MS,
  lockedFor, recordFailure, clearFailures,
  newTotpSecret, totpAt, verifyTotp, otpauthUri, newBackupCodes, hashCode, base32Encode, base32Decode, sha256,
};
