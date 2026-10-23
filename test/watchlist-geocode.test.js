const test = require('node:test');
const assert = require('node:assert');
process.env.DATA_JOBS = 'off';
const { splitAddress, parseBatchResponse, geocodeBatch } = require('../lib/batch-geocode');
const { _geocodeMissing } = require('../watchlist-routes');

test('splitAddress handles the common formats', () => {
  assert.deepStrictEqual(splitAddress('1000 Hazel Drive, Argyle TX 76226'), { street: '1000 Hazel Drive', city: 'Argyle', state: 'TX', zip: '76226' });
  assert.deepStrictEqual(splitAddress('100 COLUMBIA ST, FARMERSVILLE, TX, 75442'), { street: '100 COLUMBIA ST', city: 'FARMERSVILLE', state: 'TX', zip: '75442' });
  assert.deepStrictEqual(splitAddress('8048 Trimble Dr, Fort Worth TX 76134-5309'), { street: '8048 Trimble Dr', city: 'Fort Worth', state: 'TX', zip: '76134' });
  assert.deepStrictEqual(splitAddress('1326 Independence Trl'), { street: '1326 Independence Trl', city: '', state: '', zip: '' });
});

test('parseBatchResponse reads matches and skips misses', () => {
  const text = [
    '"a1","1000 Hazel Drive, Argyle, TX, 76226","Match","Exact","1000 HAZEL DR, ARGYLE, TX, 76226","-97.18,33.12","123","L"',
    '"a2","1 Fake Rd, Zzz, TX, 00000","No_Match"',
    '"a3","5 Elm, Dallas, TX, 75201","Tie"',
  ].join('\n');
  const m = parseBatchResponse(text);
  assert.strictEqual(m.size, 1);
  assert.deepStrictEqual(m.get('a1'), { lat: 33.12, lon: -97.18, formattedAddress: '1000 HAZEL DR, ARGYLE, TX, 76226', state: 'TX', zip: '76226' });
});

test('geocodeBatch chunks requests and survives a failed chunk', async () => {
  const items = Array.from({ length: 2500 }, (_, i) => ({ id: 'c' + i, address: `${i} Main St, Dallas TX 75201` }));
  let calls = 0;
  const post = async csv => {
    calls++;
    if (calls === 2) throw new Error('timeout');
    return csv.trim().split('\n').map(l => { const id = l.split(',')[0]; return `"${id}","x","Match","Exact","${id} MAIN ST, DALLAS, TX, 75201","-96.8,32.78","1","L"`; }).join('\n');
  };
  const m = await geocodeBatch(items, { post });
  assert.strictEqual(calls, 3);
  assert.strictEqual(m.size, 1500);
});

test('geocodeMissing uses the batch, falls back to single lookups, and keeps going after a failed save', async () => {
  const contacts = [
    { _id: '1', userId: 'u', address: '1 A St, Dallas TX 75201', lat: null },
    { _id: '2', userId: 'u', address: '2 B St, Dallas TX 75201', lat: null },
    { _id: '3', userId: 'u', address: '3 C St, Dallas TX 75201', lat: null },
    { _id: '4', userId: 'u', address: '4 D St, Dallas TX 75201', lat: null },
    { _id: '5', userId: 'u', address: '5 E St, Dallas TX 75201', lat: 32.1, lon: -96.1 },
  ];
  const saved = {};
  const ops = {
    getForUser: async () => contacts.map(c => ({ ...c })),
    updateContact: async (id, f) => { if (id === '2') throw new Error('ENOSPC'); saved[id] = f; },
  };
  const batch = async items => {
    assert.deepStrictEqual(items.map(i => i.id), ['1', '2', '3', '4']);
    return new Map([['1', { lat: 1, lon: 1, formattedAddress: 'A' }], ['2', { lat: 2, lon: 2, formattedAddress: 'B' }]]);
  };
  const single = async a => (a.startsWith('3') ? { lat: 3, lon: 3, formattedAddress: 'C' } : null);
  await _geocodeMissing(ops, 'u', { batch, single, pauseMs: 0 });
  assert.strictEqual(saved['1'].lat, 1);
  assert.strictEqual(saved['2'], undefined);   // save failed, run continued
  assert.strictEqual(saved['3'].lat, 3);       // batch miss, single hit
  assert.strictEqual(saved['4'].geocodeFailed, true);
  assert.strictEqual(saved['5'], undefined);   // already located
});
