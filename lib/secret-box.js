/**
 * Encrypts CRM API keys before they are written to disk (AES-256-GCM, key
 * derived from INTEGRATION_SECRET, else the app secret). Credentials sealed
 * with an older secret are still readable. If every secret changes, stored
 * keys can't be read and the customer reconnects.
 */
const crypto = require('crypto');

const derive = secret => crypto.createHash('sha256').update('stormcheck-integrations:' + secret).digest();
function key() {
  return derive(process.env.INTEGRATION_SECRET || require('./app-secret').jwtSecret());
}
// Keys that may have sealed older credentials: the current JWT_SECRET (before
// INTEGRATION_SECRET was set) and the old built-in default.
function legacyKeys() {
  const { LEGACY_DEFAULT } = require('./app-secret');
  return [process.env.JWT_SECRET, LEGACY_DEFAULT].filter(Boolean).map(derive);
}

function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

function openWith(k, iv, tag, enc) {
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

function open(sealed) {
  const [v, iv, tag, enc] = String(sealed || '').split('.');
  if (v !== 'v1') throw new Error('Unreadable credential');
  for (const k of [key(), ...legacyKeys()]) {
    try { return openWith(k, iv, tag, enc); } catch { /* try the next key */ }
  }
  throw new Error('Unreadable credential');
}

/** Generic AES-256-GCM with a caller key (used by backups and two-step secrets). */
function sealBuffer(buf, k) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([Buffer.from('SCPB1'), iv, c.getAuthTag(), enc]);
}
function openBuffer(buf, k) {
  if (buf.subarray(0, 5).toString() !== 'SCPB1') throw new Error('Not a StormCheck Pro backup');
  const iv = buf.subarray(5, 17), tag = buf.subarray(17, 33);
  const d = crypto.createDecipheriv('aes-256-gcm', k, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(33)), d.final()]);
}

const last4 = s => String(s || '').slice(-4);

module.exports = { seal, open, last4, sealBuffer, openBuffer };
