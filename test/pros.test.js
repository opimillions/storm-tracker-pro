const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-pros-'));
process.env.DATA_JOBS = 'off';
const { _arrange: arrange, _sanitize: sanitize } = require('../pro-routes');

test('sanitizes listing input', () => {
  const p = sanitize({ category: 'attorney', company: ' Smith Law ', website: 'smithlaw.com', states: 'tx, ok, zz', phone: '(214) 555-0100<script>', status: 'active', sponsored: true });
  assert.strictEqual(p.company, 'Smith Law');
  assert.strictEqual(p.website, 'https://smithlaw.com/');
  assert.deepStrictEqual(p.states, ['TX', 'OK']);
  assert.ok(!p.phone.includes('<'));
  assert.strictEqual(p.status, undefined, 'public applications cannot set admin fields');
  assert.strictEqual(sanitize({ website: 'javascript:alert(1)' }).website, '');
  assert.strictEqual(sanitize({ category: 'bogus' }).category, 'public-adjuster');
});

test('sponsored listings only lead when enabled, in their states and paid through', () => {
  const L = [
    { _id: 'a', company: 'Alpha', states: ['TX'], verified: false },
    { _id: 'b', company: 'Bravo', states: ['TX'], verified: true },
    { _id: 'z', company: 'Zulu', states: ['TX', 'OK'], sponsored: true, sponsorStates: ['TX'] },
    { _id: 'x', company: 'Xray', states: ['TX'], sponsored: true, sponsorUntil: '2000-01-01' },
    { _id: 'o', company: 'Okie', states: ['OK'] },
  ];
  let r = arrange(L, 'TX', { sponsoredEnabled: false });
  assert.deepStrictEqual(r.top, []);
  assert.deepStrictEqual(r.rest.map(p => p._id), ['b', 'a', 'x', 'z']);
  r = arrange(L, 'TX', { sponsoredEnabled: true });
  assert.deepStrictEqual(r.top.map(p => p._id), ['z']);
  assert.ok(!r.rest.some(p => p._id === 'o'));
  r = arrange(L, 'OK', { sponsoredEnabled: true });
  assert.deepStrictEqual(r.top, [], 'Zulu is only sponsored in TX');
});
