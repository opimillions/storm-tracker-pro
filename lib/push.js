/**
 * Phone / browser push notifications for a user's own alerts (portfolio hits,
 * territory hail, NWS warnings). Subscriptions are saved per user, so they
 * survive restarts and each person only gets alerts for their own areas.
 *
 * Keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY when set; otherwise a key pair is
 * generated once and kept on the data volume. Changing keys means every
 * device has to tap "Enable" again.
 *
 * iPhone: notifications work only after "Add to Home Screen" (iOS 16.4+).
 */
const fs = require('fs');
const webpush = require('web-push');
const { dataPath } = require('./paths');

let keys = null;
function vapid() {
  if (keys) return keys;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    const file = dataPath('.vapid-keys.json');
    try { keys = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { keys = null; }
    if (!keys || !keys.publicKey || !keys.privateKey) {
      keys = webpush.generateVAPIDKeys();
      fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
    }
  }
  webpush.setVapidDetails('mailto:' + (process.env.ADMIN_EMAIL || 'alerts@thepublicadjustertx.com'), keys.publicKey, keys.privateKey);
  return keys;
}
const publicKey = () => vapid().publicKey;

let db = null;
function init(database) { db = database; }

/**
 * Send to every device the user enabled. Never throws.
 * payload: { title, body, url, tag }
 */
async function sendToUser(userId, payload, { sender = webpush } = {}) {
  if (!db || !db.pushOps) return 0;
  const subs = await db.pushOps.forUser(userId);
  if (!subs.length) return 0;
  vapid();
  const body = JSON.stringify({ title: payload.title, body: payload.body, url: payload.url || '/dashboard', tag: payload.tag || 'storm-alert' });
  let sent = 0;
  await Promise.all(subs.map(async s => {
    try {
      await sender.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: 6 * 3600 });
      sent++;
    } catch (e) {
      // 404/410: the browser dropped this subscription; forget it.
      if (e && (e.statusCode === 404 || e.statusCode === 410)) await db.pushOps.remove(s.endpoint);
      else console.error('[push]', e && (e.statusCode || e.message));
    }
  }));
  return sent;
}

module.exports = { init, publicKey, sendToUser, vapid };
