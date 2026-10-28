const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-help-'));
const help = require('../lib/help-content');

test('help search finds the right topic', () => {
  assert.match(help.search('how do I make a lead list')[0].title, /lead list/i);
  assert.match(help.search('what does verified mean')[0].title, /Verified/);
  assert.match(help.search('jobnimbus')[0].title, /CRM|JobNimbus/);
  assert.deepStrictEqual(help.search('the a to'), []);
});

test('guide text covers every guide and FAQ for the assistant', () => {
  const t = help.asText();
  for (const g of help.GUIDES) assert.ok(t.includes(g.title));
  for (const f of help.FAQ) assert.ok(t.includes(f.q));
  assert.ok(help.RELEASE.id && help.RELEASE.items.length);
});

test('chat endpoint: search fallback without a key, Claude with a key', async () => {
  const express = require('express');
  const axios = require('axios');
  const app = express(); app.use(express.json());
  const user = { _id: 'u1', name: 'Ryan', email: 'r@x.com', tier: 'pro' };
  const db = { userOps: { update: async () => {} }, watchlistOps: { count: async () => 12 }, integrationOps: { getForUser: async () => [{ type: 'jobnimbus' }, { type: 'inbound' }] } };
  require('../help-routes')(app, { requireAuth: (req, res, next) => { req.user = user; next(); }, requireAdmin: (q, r, n) => n(), tierFeatures: () => ({ label: 'Pro', playback: true, maxStates: -1 }), db });
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  const post = body => fetch(base + '/api/assistant/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  try {
    delete process.env.ANTHROPIC_API_KEY;
    let r = await post({ messages: [{ role: 'user', content: 'how do I play back a storm' }] });
    assert.strictEqual(r.mode, 'search');
    assert.match(r.reply, /play/i);

    process.env.ANTHROPIC_API_KEY = 'sk-test';
    let sent = null; const orig = axios.post;
    axios.post = async (url, body, opts) => { sent = { url, body, opts }; return { data: { content: [{ type: 'text', text: 'Open Hail Map (/hailmap) and click Play storm.' }] } }; };
    r = await post({ messages: [{ role: 'assistant', content: 'hi' }, { role: 'user', content: 'playback?' }] });
    axios.post = orig;
    assert.strictEqual(r.mode, 'ai');
    assert.match(r.reply, /Play storm/);
    assert.strictEqual(sent.url, 'https://api.anthropic.com/v1/messages');
    assert.strictEqual(sent.opts.headers['x-api-key'], 'sk-test');
    assert.strictEqual(sent.body.messages[0].role, 'user'); // leading assistant turn dropped
    assert.match(sent.body.system, /12 properties in Portfolio/);
    assert.match(sent.body.system, /connected: jobnimbus/);
    assert.ok(!/inbound/.test(sent.body.system.split('About this user')[1].split('\n')[0]));

    axios.post = async () => { throw new Error('down'); };
    r = await post({ messages: [{ role: 'user', content: 'lead list' }] });
    axios.post = orig;
    assert.strictEqual(r.mode, 'search');
  } finally { srv.close(); delete process.env.ANTHROPIC_API_KEY; }
});

test('public assistant: answers prospects, rate limited, no login', async () => {
  const express = require('express');
  const axios = require('axios');
  const app = express(); app.use(express.json());
  const db = { userOps: { update: async () => {} }, watchlistOps: { count: async () => 0 }, integrationOps: { getForUser: async () => [] } };
  require('../help-routes')(app, { requireAuth: (q, r) => r.status(401).end(), requireAdmin: (q, r, n) => n(), tierFeatures: () => ({}), db });
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  const post = body => fetch(base + '/api/public/assistant/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    delete process.env.ANTHROPIC_API_KEY;
    let r = await (await post({ messages: [{ role: 'user', content: 'how much does it cost' }] })).json();
    assert.strictEqual(r.mode, 'search');
    assert.match(r.reply, /\$39/);
    assert.match(r.reply, /\/register/);

    process.env.ANTHROPIC_API_KEY = 'sk-test';
    let sent = null; const orig = axios.post;
    axios.post = async (url, body) => { sent = body; return { data: { content: [{ type: 'text', text: 'Yes, JobNimbus connects directly. Try it free: /register' }] } }; };
    r = await (await post({ messages: [{ role: 'user', content: 'jobnimbus?' }] })).json();
    axios.post = orig;
    assert.strictEqual(r.mode, 'ai');
    assert.match(sent.system, /public website/);
    assert.match(sent.system, /JobNimbus and AccuLynx connect directly/);
    assert.ok(sent.max_tokens <= 400);

    let limited = false;
    for (let i = 0; i < 15; i++) { const x = await post({ messages: [{ role: 'user', content: 'q' + i }] }); if (x.status === 429) { limited = true; break; } }
    assert.ok(limited, 'per-visitor limit kicks in');
  } finally { srv.close(); delete process.env.ANTHROPIC_API_KEY; }
});

test('live / current hail questions find the right answer', () => {
  const help = require('../lib/help-content');
  for (const q of ['Does this app show active, current or past hail locations', 'real time hail tracking?', 'can I see hail happening right now']) {
    assert.strictEqual(help.search(q, 2, { publicOnly: true })[0].title, 'Does it show live, active or current hail?', q);
  }
});
