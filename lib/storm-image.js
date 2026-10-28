/**
 * Static hail swath map image (PNG) for emails, where interactive maps
 * can't run. Draws the radar hail swath for one day over map tiles.
 *
 *   MAP_TILE_URL   tile template (default OpenStreetMap). If tiles can't be
 *                  fetched the swath is drawn on a plain background.
 *
 * Tiles and finished images are cached on the volume.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { PNG } = require('pngjs');
const { dataPath, ensureDir } = require('./paths');
const mesh = require('./mesh-store');

const W = 600, H = 340, TILE = 256;
const UA = { 'User-Agent': 'StormCheckPro/2.0 (stormcheckpro.thepublicadjustertx.com; storm recap emails)' };
const tileUrl = () => process.env.MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

// Same color ramp as the in-app swath layer (public/js/swath-layer.js).
const STOPS = [[3.0, '#3b0764'], [2.5, '#6d28d9'], [2.0, '#9d174d'], [1.75, '#b91c1c'], [1.5, '#dc2626'],
  [1.25, '#ea580c'], [1.0, '#f59e0b'], [0.75, '#fbbf24'], [0, '#fde68a']];
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function hailColor(inches) { for (const [v, c] of STOPS) if (inches >= v) return c; return STOPS[STOPS.length - 1][1]; }
const LEGEND = [[0.75, '0.75"'], [1, '1"'], [1.25, '1.25"'], [1.5, '1.5"'], [1.75, '1.75"'], [2, '2"'], [2.5, '2.5"'], [3, '3"+']]
  .map(([v, label]) => ({ color: hailColor(v), label }));

// Web Mercator, pixels at zoom z.
const px = (lon, z) => ((lon + 180) / 360) * TILE * 2 ** z;
const py = (lat, z) => {
  const r = lat * Math.PI / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z;
};

function fitZoom(w, s, e, n) {
  for (let z = 11; z >= 3; z--) {
    if (px(e, z) - px(w, z) <= W - 40 && py(s, z) - py(n, z) <= H - 40) return z;
  }
  return 3;
}

async function getTile(z, x, y) {
  const max = 2 ** z;
  x = ((x % max) + max) % max;
  if (y < 0 || y >= max) return null;
  const file = path.join(ensureDir(dataPath('map-tiles', String(z), String(x))), `${y}.png`);
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < 60 * 86400000) return PNG.sync.read(fs.readFileSync(file));
  } catch { /* not cached */ }
  const url = tileUrl().replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'a');
  const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000, headers: UA });
  const buf = Buffer.from(r.data);
  const png = PNG.sync.read(buf);
  fs.writeFileSync(file, buf);
  return png;
}

function blend(img, x, y, rgb, a) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  img.data[i] = Math.round(img.data[i] * (1 - a) + rgb[0] * a);
  img.data[i + 1] = Math.round(img.data[i + 1] * (1 - a) + rgb[1] * a);
  img.data[i + 2] = Math.round(img.data[i + 2] * (1 - a) + rgb[2] * a);
  img.data[i + 3] = 255;
}
function fillRect(img, x0, y0, x1, y1, rgb, a) {
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++)
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) blend(img, x, y, rgb, a);
}
function dot(img, cx, cy, r, rgb, a = 1) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) blend(img, x, y, rgb, a);
}

/**
 * Render the swath for `date` inside bbox [w, s, e, n].
 * opts.points: [{lat, lon}] drawn as dark dots (cities); opts.center: {lat, lon} drawn as a ring.
 */
async function render(date, [w, s, e, n], { points = [], center = null, minIn = 0.75, tiles = true } = {}) {
  const z = fitZoom(w, s, e, n);
  const cx = (px(w, z) + px(e, z)) / 2, cy = (py(n, z) + py(s, z)) / 2;
  const ox = Math.round(cx - W / 2), oy = Math.round(cy - H / 2);
  const img = new PNG({ width: W, height: H });
  const bg = hex('#eef2f6');
  for (let i = 0; i < W * H; i++) { img.data[i * 4] = bg[0]; img.data[i * 4 + 1] = bg[1]; img.data[i * 4 + 2] = bg[2]; img.data[i * 4 + 3] = 255; }

  let tilesOk = false;
  if (tiles) {
    try {
      for (let ty = Math.floor(oy / TILE); ty <= Math.floor((oy + H - 1) / TILE); ty++) {
        for (let tx = Math.floor(ox / TILE); tx <= Math.floor((ox + W - 1) / TILE); tx++) {
          const t = await getTile(z, tx, ty);
          if (!t) continue;
          for (let y = 0; y < TILE; y++) {
            const dy = ty * TILE + y - oy;
            if (dy < 0 || dy >= H) continue;
            for (let x = 0; x < TILE; x++) {
              const dx = tx * TILE + x - ox;
              if (dx < 0 || dx >= W) continue;
              const si = (y * t.width + x) * 4, di = (dy * W + dx) * 4;
              // Lighten the base map so the swath stands out.
              img.data[di] = Math.round(t.data[si] * 0.75 + 255 * 0.25);
              img.data[di + 1] = Math.round(t.data[si + 1] * 0.75 + 255 * 0.25);
              img.data[di + 2] = Math.round(t.data[si + 2] * 0.75 + 255 * 0.25);
            }
          }
          tilesOk = true;
        }
      }
    } catch { tilesOk = false; }
  }

  // Swath: smaller sizes first so the largest hail is drawn on top.
  const pad = 0.05;
  const cells = mesh.cellsForDay(date, w - pad, s - pad, e + pad, n + pad).filter(c => c[2] >= minIn).sort((a, b) => a[2] - b[2]);
  for (const [latC, lonC, inches] of cells) {
    // Round both edges the same way so neighbouring cells meet exactly (no gaps or overlaps).
    const x0 = Math.round(px(lonC / 100, z) - ox), x1 = Math.round(px((lonC + 1) / 100, z) - ox);
    const y0 = Math.round(py((latC + 1) / 100, z) - oy), y1 = Math.round(py(latC / 100, z) - oy);
    fillRect(img, x0, y0, Math.max(x1, x0 + 1), Math.max(y1, y0 + 1), hex(hailColor(inches)), 0.78);
  }
  for (const p of points) {
    const x = px(p.lon, z) - ox, y = py(p.lat, z) - oy;
    dot(img, x, y, 4, [255, 255, 255]);
    dot(img, x, y, 2.6, hex('#172235'));
  }
  if (center) {
    const x = px(center.lon, z) - ox, y = py(center.lat, z) - oy;
    dot(img, x, y, 7, [255, 255, 255]);
    dot(img, x, y, 5, hex('#2563eb'));
    dot(img, x, y, 2, [255, 255, 255]);
  }
  // Thin frame
  fillRect(img, 0, 0, W, 1, hex('#cbd5e1'), 1); fillRect(img, 0, H - 1, W, H, hex('#cbd5e1'), 1);
  fillRect(img, 0, 0, 1, H, hex('#cbd5e1'), 1); fillRect(img, W - 1, 0, W, H, hex('#cbd5e1'), 1);
  return { png: PNG.sync.write(img), tiles: tilesOk, cells: cells.length, zoom: z };
}

/** Cached render; bbox rounded to 0.05° so nearby requests share a file. */
async function cached(date, bbox, opts = {}) {
  const r = v => (Math.round(v * 20) / 20).toFixed(2);
  const key = `${date}_${bbox.map(r).join('_')}${opts.center ? `_c${r(opts.center.lat)}_${r(opts.center.lon)}` : ''}`.replace(/[^0-9_.-]/g, '');
  const file = path.join(ensureDir(dataPath('storm-images')), key + '.png');
  try { return fs.readFileSync(file); } catch { /* render */ }
  const out = await render(date, bbox.map(Number), opts);
  if (out.tiles || opts.tiles === false) fs.writeFileSync(file, out.png); // don't cache a tile-less fallback
  return out.png;
}

module.exports = { render, cached, hailColor, LEGEND, W, H };
