const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-int-'));
process.env.DATA_JOBS = 'off';
process.env.JWT_SECRET = 'test-secret';
const axios = require('axios');
const box = require('../lib/secret-box');
const { isPrivateIp, assertPublicHttpsUrl } = require('../lib/safe-url');
const integrations = require('../lib/integrations');
const db = require('../db');

test('API keys are encrypted at rest and round-trip', () => {
  const s = box.seal('jn_secret_key_123');
  assert.ok(!s.includes('jn_secret'));
  assert.strictEqual(box.open(s), 'jn_secret_key_123');
});

test('webhook URLs must be public https', async () => {
  assert.ok(isPrivateIp('10.0.0.5') && isPrivateIp('169.254.169.254') && isPrivateIp('127.0.0.1') && isPrivateIp('::1'));
  assert.ok(!isPrivateIp('34.120.1.1'));
  await assert.rejects(assertPublicHttpsUrl('http://hooks.zapier.com/x'), /https/);
  await assert.rejects(assertPublicHttpsUrl('https://internal.local/x', { lookup: async () => [{ address: '10.1.2.3' }] }), /public/);
  assert.ok(await assertPublicHttpsUrl('https://hooks.zapier.com/x', { lookup: async () => [{ address: '54.1.2.3' }] }));
});

test('inbound mapping handles separate city/state/zip and full addresses', () => {
  const m = integrations._mapInbound({ first_name: 'Jane', last_name: 'Doe', address: '456 Oak Ave', city: 'Fairview', state: 'OR', zip: '97024', id: 'cw-9' });
  assert.deepStrictEqual([m.name, m.address, m.externalId], ['Jane Doe', '456 Oak Ave, Fairview, OR 97024', 'cw-9']);
  assert.strictEqual(integrations._mapInbound({ name: 'X', address: '1 A St, Town, TX 75001' }).address, '1 A St, Town, TX 75001');
  assert.strictEqual(integrations._mapInbound({ name: 'no address' }), null);
});

test('JobNimbus: connect, import contacts, update on resync, push note', async () => {
  const calls = [];
  const contacts = [
    { jnid: 'c1', display_name: 'John Smith', address_line1: '123 Main St', city: 'Springfield', state_text: 'MO', zip: '65806', mobile_phone: '555', status_name: 'Lead', geo: { lat: 37.2, lon: -93.29 } },
    { jnid: 'c2', first_name: 'No', last_name: 'Address' },
    { jnid: 'c3', display_name: 'Jane', address_line1: '9 Elm', city: 'Plano', state_text: 'TX', zip: '75024' },
  ];
  const orig = axios.request; const origFn = axios;
  integrations.PROVIDERS.jobnimbus.req = async function (key, method, p, { params, data } = {}) {
    calls.push({ key, method, p, params, data });
    if (method === 'GET' && p === 'contacts') return { count: contacts.length, results: params.size === 1 ? contacts.slice(0, 1) : contacts };
    if (method === 'POST' && p === 'activities') return { jnid: 'a1' };
    throw new Error('unexpected ' + method + ' ' + p);
  };
  const located = [];
  integrations._setDb({ ...db, locateMissing: id => located.push(id) });
  const r = await integrations.connect('u1', 'jobnimbus', { apiKey: 'jn-key-abcdefgh' });
  assert.strictEqual(r.count, 3);
  await new Promise(res => setTimeout(res, 50));
  await integrations.syncUser('u1', 'jobnimbus'); // second run: no duplicates
  let wl = await db.watchlistOps.getForUser('u1');
  assert.strictEqual(wl.length, 2);
  const john = wl.find(c => c.externalId === 'c1');
  assert.strictEqual(john.address, '123 Main St, Springfield, MO 65806');
  assert.strictEqual(john.lat, 37.2);
  assert.strictEqual(john.source, 'jobnimbus');
  assert.ok(located.includes('u1'));
  const saved = await db.integrationOps.get('u1', 'jobnimbus');
  assert.ok(!JSON.stringify(saved).includes('jn-key-abcdefgh'));
  assert.strictEqual(saved.keyLast4, 'efgh');

  contacts[2].address_line1 = '10 Elm';
  await integrations.syncUser('u1', 'jobnimbus');
  wl = await db.watchlistOps.getForUser('u1');
  assert.strictEqual(wl.find(c => c.externalId === 'c3').address, '10 Elm, Plano, TX 75024');

  const res = await integrations.pushHits('u1', [{ c: john, best: 1.75, radarIn: 1.75, groundHail: 1.5, tornado: false }], '2026-05-28');
  assert.strictEqual(res.pushed, 1);
  const note = calls.find(c => c.p === 'activities');
  assert.strictEqual(note.key, 'jn-key-abcdefgh');
  assert.strictEqual(note.data.primary.id, 'c1');
  assert.match(note.data.note, /1\.75" \(Golf Ball\) hail/);
  assert.match(note.data.note, /confirmed by a ground report/);
  void orig; void origFn;
});

test('AccuLynx: pages jobs, skips cancelled, posts job message', async () => {
  const jobs = Array.from({ length: 30 }, (_, i) => ({
    id: 'j' + i, jobName: 'Job ' + i, currentMilestone: i === 5 ? 'Cancelled' : 'Lead',
    locationAddress: { street1: `${i} Oak St`, city: 'Dallas', state: i % 2 ? { abbreviation: 'TX' } : 'TX', zipCode: '75201' },
    contacts: [{ isPrimary: true, contact: { firstName: 'A', lastName: 'B', phoneNumbers: [{ number: '214' }] } }],
  }));
  const calls = [];
  integrations.PROVIDERS.acculynx.req = async function (key, method, p, { params, data } = {}) {
    calls.push({ method, p, params, data });
    if (method === 'GET' && p === 'jobs') { const s = params.pageStartIndex; return { count: jobs.length, pageSize: params.pageSize, pageStartIndex: s, items: jobs.slice(s, s + params.pageSize) }; }
    if (method === 'POST' && /^jobs\/.+\/messages$/.test(p)) return { messageId: 'm1' };
    throw new Error('unexpected');
  };
  await integrations.connect('u2', 'acculynx', { apiKey: 'alx-key-1234567' });
  let wl = [];
  for (let t = 0; t < 40 && wl.length < 29; t++) { await new Promise(res => setTimeout(res, 100)); wl = await db.watchlistOps.getForUser('u2'); }
  assert.strictEqual(wl.length, 29);
  assert.ok(wl.every(c => c.address.endsWith('Dallas, TX 75201')));
  assert.strictEqual(wl.find(c => c.externalId === 'j1').phone, '214');
  const c = wl.find(x => x.externalId === 'j3');
  await integrations.pushHits('u2', [{ c, best: 0, radarIn: 0, groundHail: 0, tornado: true }], '2026-05-28');
  const msg = calls.find(x => x.method === 'POST');
  assert.strictEqual(msg.p, 'jobs/j3/messages');
  assert.match(msg.data.message, /tornado was reported within 1 mile/i);
});

test('webhook events and inbound adds', async () => {
  integrations._setDb({ ...db, locateMissing: () => {} });
  await db.integrationOps.upsert('u3', 'webhook', { url: 'https://hooks.example.com/abc' });
  const posted = [];
  const origPost = axios.post;
  axios.post = async (url, body) => { posted.push({ url, body }); return { data: {} }; };
  const dns = require('dns').promises; const origLookup = dns.lookup;
  dns.lookup = async () => [{ address: '54.1.2.3' }];
  try {
    const r = await integrations.pushHits('u3', [{ c: { _id: 'p1', name: 'X', address: '1 A St', lat: 1, lon: 2 }, best: 1.25, radarIn: 1.25, groundHail: 0, tornado: false }], '2026-05-28');
    assert.strictEqual(r.pushed, 1);
    assert.strictEqual(posted[0].body.event, 'property.hit');
    assert.strictEqual(posted[0].body.hail.sizeName, 'Half Dollar');
  } finally { axios.post = origPost; dns.lookup = origLookup; }

  const token = await db.integrationOps.inboundToken('u3', integrations.newToken);
  const a = await integrations.inbound(token, { name: 'Client', address: '5 Pine Rd', city: 'Waco', state: 'TX', zip: '76701', id: 'cw1' });
  assert.deepStrictEqual(a, { added: 1, updated: 0 });
  const b = await integrations.inbound(token, { name: 'Client', address: '6 Pine Rd', city: 'Waco', state: 'TX', zip: '76701', id: 'cw1' });
  assert.deepStrictEqual(b, { added: 0, updated: 1 });
  await assert.rejects(integrations.inbound('bad-token', {}), /Unknown/);
});
