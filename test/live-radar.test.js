const test = require('node:test');
const assert = require('node:assert');
const mrms = require('../lib/mrms-source');
const grib2 = require('../lib/grib2');

test('live radar reads MESH at watch points from the newest NOAA hourly frame', async () => {
  const ni = 7000, la1 = 54.995, lo1 = -129.995;
  const idx = (lat, lon) => Math.round((la1 - lat) / 0.01) * ni + Math.round((lon - lo1) / 0.01);
  const origLatest = mrms.latestHourlyFrame, origDl = mrms.download, origDecode = grib2.decodeGrib2;
  mrms.latestHourlyFrame = async () => ({ time: '2026-11-11T22:00:00Z', url: 'x' });
  mrms.download = async () => Buffer.alloc(0);
  grib2.decodeGrib2 = () => ({ ni, la1, lo1, di: 0.01, dj: 0.01, scanMode: 0, index: [idx(32.944, -97.134), idx(35.0, -97.0)], data: [44.45, 30] });
  try {
    const { frame, values } = await require('../storm-alerts')._meshAtWatchPoints();
    assert.strictEqual(frame.time, '2026-11-11T22:00:00Z');
    assert.strictEqual(values.get('Southlake TX'), 44.45);
    assert.strictEqual(values.get('Oklahoma City'), 0);
  } finally { mrms.latestHourlyFrame = origLatest; mrms.download = origDl; grib2.decodeGrib2 = origDecode; }
});
