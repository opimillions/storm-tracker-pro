/**
 * Encrypts CRM API keys before they are written to disk (AES-256-GCM, key
 * derived from INTEGRATION_SECRET or JWT_SECRET). If the secret changes,
 * stored keys can't be read and the customer reconnects.
 */
const crypto = require('crypto');

function key() {
  const secret = process.env.INTEGRATION_SECRET || process.env.JWT_SECRET || 'dev-secret-change-in-production';
  return crypto.createHash('sha256').update('stormcheck-integrations:' + secret).digest();
}

function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

function open(sealed) {
  const [v, iv, tag, enc] = String(sealed || '').split('.');
  if (v !== 'v1') throw new Error('Unreadable credential');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

const last4 = s => String(s || '').slice(-4);

module.exports = { seal, open, last4 };
