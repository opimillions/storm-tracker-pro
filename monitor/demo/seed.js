// DEMO ONLY: seeds a local StormCheck data folder with a synthetic 03-14-2024 hail swath
// over Southlake and 24 hourly playback frames, standing in for the NOAA downloads
// the sandbox can't reach. Real runs use the production data.
process.env.DATA_JOBS = 'off';
const fs = require('fs'), path = require('path');
const mesh = require('../../lib/mesh-store');
const { dataPath, ensureDir } = require('../../lib/paths');
const ni = 7000, la1 = 54.995, lo1 = -129.995;
const idx = (lat, lon) => Math.round((la1 - lat) / 0.01) * ni + Math.round((lon - lo1) / 0.01);
const index = [], data = [];
for (let a = 0; a < 40; a++) for (let b = 0; b < 90; b++) {
  const lat = 32.80 + a * 0.01, lon = -97.60 + b * 0.01;
  const core = Math.abs(lat - 32.94) < 0.06;
  index.push(idx(lat, lon)); data.push(core ? 44.45 : 25.4); // 1.75" core, 1.00" edges
}
console.log(mesh.ingestGrid('2024-03-14', { ni, nj: 3500, la1, lo1, di: 0.01, dj: 0.01, scanMode: 0, index, data }));
const frames = [];
for (let h = 13; h <= 36; h++) {
  const day = h < 24 ? '2024-03-14' : '2024-03-15', hh = String(h % 24).padStart(2, '0');
  const cells = [];
  if (h >= 22 && h <= 26) for (let k = 0; k < 30; k++) cells.push(3280 + k, -9760 + (h - 22) * 12 + k % 10, 150 + (h - 22) * 5);
  frames.push({ time: `${day}T${hh}:00:00Z`, cells });
}
fs.writeFileSync(path.join(ensureDir(dataPath('frames')), '2024-03-14.json'), JSON.stringify(frames));
console.log('seeded frames', frames.length);
