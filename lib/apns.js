/**
 * Native iPhone push (Apple Push Notification service) for the StormCheck Pro
 * App Store app. Web push (lib/push.js) still handles browsers and home-screen
 * installs; this covers the native app, whose device tokens are saved through
 * /api/push/register-native.
 *
 * Env (Railway):
 *   APNS_KEY_ID     the 10-character Key ID of the .p8 key (Apple Developer → Keys)
 *   APNS_TEAM_ID    the 10-character Team ID (Apple Developer → Membership)
 *   APNS_KEY        the full .p8 file text; "\n" escapes are accepted
 *   APNS_BUNDLE_ID  defaults to com.thepublicadjustertx.stormcheckpro
 *   APNS_ENV        "production" (App Store + TestFlight, default) or "sandbox" (Xcode debug builds)
 *
 * Not configured → configured() is false and nothing is sent.
 */
const http2 = require('http2');
const jwt = require('jsonwebtoken');

const BUNDLE_DEFAULT = 'com.thepublicadjustertx.stormcheckpro';

function cfg() {
  const key = String(process.env.APNS_KEY || '').replace(/\\n/g, '\n').trim();
  return {
    keyId: String(process.env.APNS_KEY_ID || '').trim(),
    teamId: String(process.env.APNS_TEAM_ID || '').trim(),
    key,
    bundleId: String(process.env.APNS_BUNDLE_ID || BUNDLE_DEFAULT).trim(),
    host: String(process.env.APNS_ENV || 'production').toLowerCase() === 'sandbox'
      ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com',
  };
}
const configured = () => { const c = cfg(); return !!(c.keyId && c.teamId && c.key); };

// Apple wants the provider token reused for 20–60 minutes.
let cached = { token: null, at: 0, id: '' };
function providerToken(c) {
  const id = c.keyId + c.teamId;
  if (cached.token && cached.id === id && Date.now() - cached.at < 40 * 60000) return cached.token;
  const token = jwt.sign({ iss: c.teamId, iat: Math.floor(Date.now() / 1000) }, c.key, { algorithm: 'ES256', header: { alg: 'ES256', kid: c.keyId } });
  cached = { token, at: Date.now(), id };
  return token;
}

let session = null;
function client(host) {
  if (session && !session.closed && !session.destroyed && session.host === host) return session;
  session = http2.connect(host);
  session.host = host;
  session.on('error', () => { session = null; });
  session.on('goaway', () => { session = null; });
  session.setTimeout(5 * 60000, () => { try { session.close(); } catch {} session = null; });
  return session;
}

/**
 * Send one alert. payload: { title, body, url, tag }.
 * Resolves { ok, status, reason, gone } and never throws.
 * gone = true means Apple says the token is dead (app deleted / alerts off).
 */
function send(deviceToken, payload) {
  return new Promise(resolve => {
    if (!configured()) return resolve({ ok: false, reason: 'not-configured' });
    const c = cfg();
    let req;
    try {
      const body = JSON.stringify({
        aps: { alert: { title: payload.title, body: payload.body }, sound: 'default', 'thread-id': payload.tag || 'storm-alert' },
        url: payload.url || '/dashboard',
      });
      req = client(c.host).request({
        ':method': 'POST',
        ':path': '/3/device/' + encodeURIComponent(deviceToken),
        authorization: 'bearer ' + providerToken(c),
        'apns-topic': c.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + 6 * 3600),
        'apns-collapse-id': String(payload.tag || 'storm-alert').slice(0, 64),
        'content-type': 'application/json',
      });
      let status = 0, data = '';
      req.setTimeout(15000, () => { try { req.close(); } catch {} resolve({ ok: false, reason: 'timeout' }); });
      req.on('response', h => { status = h[':status']; });
      req.on('data', d => { data += d; });
      req.on('end', () => {
        let reason = '';
        try { reason = JSON.parse(data || '{}').reason || ''; } catch {}
        const gone = status === 410 || (status === 400 && (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic'));
        resolve({ ok: status === 200, status, reason, gone });
      });
      req.on('error', e => resolve({ ok: false, reason: e.message }));
      req.end(body);
    } catch (e) {
      resolve({ ok: false, reason: e.message });
    }
  });
}

module.exports = { configured, send, BUNDLE_DEFAULT };
