/**
 * Saved-property alert test. A controlled event (the app's own "send test
 * alert" for a saved property) goes only to the test account's inbox, then the
 * monitor confirms it arrived there.
 */
const config = require('./config');
const app = require('./app-client');

const CHECK = { id: 'wf.alert', name: 'Saved-property alert email', feature: 'Portfolio hail alerts' };
const TEST_PROPERTY = { name: 'Monitor test property', address: () => config.knownStorm.address || '100 E Southlake Blvd, Southlake, TX 76092' };

async function ensureProperty() {
  const list = await app.customer('/api/watchlist');
  if (list.status !== 200) throw new Error(`Saved properties answered HTTP ${list.status}`);
  const items = (list.json && (list.json.contacts || list.json.items || list.json)) || [];
  const found = Array.isArray(items) && items.find(c => c.name === TEST_PROPERTY.name && c.lat != null);
  if (found) return found;
  const add = await app.customer('/api/watchlist', { method: 'POST', body: { name: TEST_PROPERTY.name, address: TEST_PROPERTY.address() } });
  if (add.status !== 200 || !add.json || !add.json.contact) throw new Error(`Couldn't save the test property (HTTP ${add.status})`);
  if (add.json.contact.lat == null) throw new Error('The test property saved but its address did not geocode');
  return add.json.contact;
}

async function waitForMail(sinceMs, timeoutMs = 5 * 60000) {
  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({ host: config.inbox.host, port: config.inbox.port, secure: true, auth: { user: config.inbox.user, pass: config.inbox.pass }, logger: false });
  await client.connect();
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = await client.search({ since: new Date(sinceMs - 86400000), subject: '[TEST]' }, { uid: true });
        for (const uid of (uids || []).slice(-10).reverse()) {
          const msg = await client.fetchOne(String(uid), { envelope: true, internalDate: true }, { uid: true });
          if (msg && Date.parse(msg.internalDate) >= sinceMs - 60000 && /properties hit by hail/i.test(msg.envelope.subject || '')) {
            return { subject: msg.envelope.subject, receivedAt: new Date(msg.internalDate).toISOString(), delaySec: Math.round((Date.parse(msg.internalDate) - sinceMs) / 1000) };
          }
        }
      } finally { lock.release(); }
      await new Promise(r => setTimeout(r, 15000));
    }
    return null;
  } finally { await client.logout().catch(() => {}); }
}

async function runAlertTest() {
  if (!app.hasCredentials()) return { ...CHECK, status: 'setup', problem: 'Needs the dedicated test account (TEST_EMAIL / TEST_PASSWORD).' };
  const prop = await ensureProperty();
  const sentAt = Date.now();
  const r = await app.customer('/api/watchlist/test-alert', { method: 'POST', body: { id: prop._id } });
  if (r.status !== 200 || !r.json || !r.json.success) throw new Error(`StormCheck Pro couldn't send the test alert: ${(r.json && r.json.error) || `HTTP ${r.status}`}`);
  if (String(r.json.to).toLowerCase() !== config.testEmail.toLowerCase()) throw new Error(`The test alert was addressed to ${r.json.to}, not the test inbox. Stopped.`);
  if (!config.inbox.host || !config.inbox.user || !config.inbox.pass) {
    return { ...CHECK, status: 'setup', summary: `StormCheck Pro accepted and sent the test alert to ${r.json.to}.`, problem: 'Arrival not verified yet: add the test inbox IMAP login (TEST_INBOX_IMAP_*).' };
  }
  const got = await waitForMail(sentAt);
  if (!got) throw new Error(`StormCheck Pro sent the test alert to the test inbox, but it hadn't arrived after 5 minutes. Real saved-property alerts may not be reaching customers.`);
  return { ...CHECK, status: 'ok', summary: `Test alert arrived in the test inbox in ${got.delaySec}s ("${got.subject}").` };
}

module.exports = { CHECK, runAlertTest };
