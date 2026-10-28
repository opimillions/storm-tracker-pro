/**
 * The app's signing secret (sign-in tokens) with no hardcoded fallback.
 *
 * Uses JWT_SECRET when set. Otherwise a random 64-byte secret is generated
 * once and kept on the data volume (file mode 600), so sign-ins survive
 * restarts but nobody can forge one from a default in the source code.
 */
const fs = require('fs');
const crypto = require('crypto');
const { dataPath } = require('./paths');

// The old built-in default. Never used for signing; only to read CRM keys
// sealed before this change (see secret-box).
const LEGACY_DEFAULT = 'dev-secret-change-in-production';

let cached = null;
function jwtSecret() {
  if (cached) return cached;
  const env = String(process.env.JWT_SECRET || '').trim();
  if (env && env !== LEGACY_DEFAULT) {
    if (env.length < 32) console.warn('[security] JWT_SECRET is short. Use at least 32 random characters.');
    cached = env;
    return cached;
  }
  const file = dataPath('.app-secret');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 64) { cached = s; return cached; }
  } catch { /* create below */ }
  cached = crypto.randomBytes(64).toString('hex');
  fs.writeFileSync(file, cached, { mode: 0o600 });
  console.warn('[security] JWT_SECRET is not set; generated a random secret on the data volume. Set JWT_SECRET in your hosting settings.');
  return cached;
}

const hasEnvSecret = () => { const e = String(process.env.JWT_SECRET || '').trim(); return !!e && e !== LEGACY_DEFAULT && e.length >= 32; };

module.exports = { jwtSecret, hasEnvSecret, LEGACY_DEFAULT };
