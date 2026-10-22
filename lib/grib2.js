/**
 * Minimal GRIB2 decoder for NOAA MRMS products.
 *
 * Supports what MRMS publishes:
 *   - Grid definition template 3.0 (regular lat/lon)
 *   - Data representation template 5.41 (PNG) and 5.0 (simple packing)
 *   - No bitmap (section 6 indicator 255) or a bitmap (indicator 0)
 *
 * A full CONUS MRMS grid is 7000 x 3500 = 24.5M cells, so the decoder can run
 * in sparse mode: pass { minValue } and it returns only the cells at or above
 * that value, without allocating the full grid.
 *
 * Dense:  { ni, nj, la1, lo1, la2, lo2, di, dj, scanMode, values: Float32Array }
 * Sparse: same header + { index: Uint32Array, data: Float32Array }  (index = j*ni + i)
 */
const zlib = require('zlib');

function sInt(buf, off, bytes) {
  let v = 0;
  for (let i = 0; i < bytes; i++) v = v * 256 + buf[off + i];
  const signBit = 2 ** (bytes * 8 - 1);
  return v >= signBit ? -(v - signBit) : v;
}
function uInt(buf, off, bytes) {
  let v = 0;
  for (let i = 0; i < bytes; i++) v = v * 256 + buf[off + i];
  return v;
}

function decodeGrib2(input, opts = {}) {
  let buf = input;
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  if (buf.toString('ascii', 0, 4) !== 'GRIB') throw new Error('Not a GRIB file');
  if (buf[7] !== 2) throw new Error('Only GRIB edition 2 is supported');

  let off = 16;
  const out = {};
  let rep = null;
  let bitmap = null;

  while (off < buf.length - 4) {
    if (buf.toString('ascii', off, off + 4) === '7777') break;
    const len = uInt(buf, off, 4);
    const num = buf[off + 4];
    const s = buf.subarray(off, off + len);

    if (num === 3) {
      const tmpl = uInt(s, 12, 2);
      if (tmpl !== 0) throw new Error(`Unsupported grid template 3.${tmpl}`);
      out.ni = uInt(s, 30, 4);
      out.nj = uInt(s, 34, 4);
      const basic = uInt(s, 38, 4);
      const sub = uInt(s, 42, 4);
      const unit = (basic === 0 || basic === 0xffffffff) ? 1e-6 : basic / sub;
      out.la1 = sInt(s, 46, 4) * unit;
      out.lo1 = sInt(s, 50, 4) * unit;
      out.la2 = sInt(s, 55, 4) * unit;
      out.lo2 = sInt(s, 59, 4) * unit;
      out.di = uInt(s, 63, 4) * unit;
      out.dj = uInt(s, 67, 4) * unit;
      out.scanMode = s[71];
      if (out.lo1 > 180) out.lo1 -= 360;
      if (out.lo2 > 180) out.lo2 -= 360;
    } else if (num === 5) {
      rep = {
        n: uInt(s, 5, 4),
        tmpl: uInt(s, 9, 2),
        R: s.readFloatBE(11),
        E: sInt(s, 15, 2),
        D: sInt(s, 17, 2),
        bits: s[19],
      };
    } else if (num === 6) {
      const ind = s[5];
      if (ind === 0) bitmap = s.subarray(6);
      else if (ind !== 255) throw new Error(`Unsupported bitmap indicator ${ind}`);
    } else if (num === 7) {
      if (!rep) throw new Error('Data section before representation section');
      Object.assign(out, unpack(s.subarray(5), rep, out.ni * out.nj, bitmap, opts));
    }
    off += len;
  }
  if (!out.values && !out.index) throw new Error('No data section found');
  return out;
}

// Iterate packed integers, calling fn(k, x) for each of the n packed values.
function eachPacked(data, rep, fn) {
  const n = rep.n, bits = rep.bits;
  if (bits === 0) { for (let k = 0; k < n; k++) fn(k, 0); return; }
  if (rep.tmpl === 41) return eachPng(data, n, fn);
  if (rep.tmpl === 0) {
    let bitPos = 0;
    for (let k = 0; k < n; k++) {
      let x = 0;
      for (let b = 0; b < bits; b++) {
        x = x * 2 + ((data[bitPos >> 3] >> (7 - (bitPos & 7))) & 1);
        bitPos++;
      }
      fn(k, x);
    }
    return;
  }
  throw new Error(`Unsupported data template 5.${rep.tmpl}`);
}

// Small PNG reader: grayscale / RGB / RGBA (+alpha gray), 8 or 16 bit, no interlace.
function eachPng(png, n, fn) {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('Bad PNG signature');
  let p = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  const idat = [];
  while (p < png.length) {
    const len = png.readUInt32BE(p);
    const type = png.toString('ascii', p + 4, p + 8);
    const body = png.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]; color = body[9]; interlace = body[12];
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (interlace) throw new Error('Interlaced PNG not supported');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[color];
  if (!channels || (depth !== 8 && depth !== 16)) throw new Error(`Unsupported PNG color ${color} depth ${depth}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bps = depth / 8;
  const bpp = channels * bps;
  const stride = width * bpp;
  let prev = Buffer.alloc(stride);
  let cur = Buffer.alloc(stride);
  let k = 0;
  for (let y = 0; y < height && k < n; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    for (let x = 0; x < stride; x++) {
      const v = raw[rowStart + 1 + x];
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let r;
      switch (filter) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`Bad PNG filter ${filter}`);
      }
      cur[x] = r & 255;
    }
    for (let x = 0; x < width && k < n; x++) {
      let val;
      const o = x * bpp;
      if (channels === 1 || channels === 2) {
        val = bps === 2 ? (cur[o] << 8) | cur[o + 1] : cur[o];
      } else if (bps === 1) {
        // RGB(A) 8-bit holds a 24/32-bit integer
        val = channels === 4
          ? ((cur[o] << 24) >>> 0) + (cur[o + 1] << 16) + (cur[o + 2] << 8) + cur[o + 3]
          : (cur[o] << 16) | (cur[o + 1] << 8) | cur[o + 2];
      } else {
        throw new Error('16-bit RGB PNG not supported');
      }
      fn(k++, val);
    }
    const t = prev; prev = cur; cur = t;
  }
}

function unpack(data, rep, total, bitmap, opts) {
  const { R, E, D } = rep;
  const scale2 = 2 ** E;
  const scale10 = 10 ** -D;
  const toVal = x => (R + x * scale2) * scale10;

  // Map packed index -> grid index (identity unless a bitmap is present).
  let gridIndexOf = null;
  if (bitmap) {
    gridIndexOf = new Uint32Array(rep.n);
    let k = 0;
    for (let i = 0; i < total && k < rep.n; i++) {
      if ((bitmap[i >> 3] >> (7 - (i & 7))) & 1) gridIndexOf[k++] = i;
    }
  }

  if (opts.minValue != null) {
    const min = opts.minValue;
    let idx = new Uint32Array(4096), dat = new Float32Array(4096), m = 0;
    eachPacked(data, rep, (k, x) => {
      const v = toVal(x);
      if (!(v >= min)) return;
      if (m === idx.length) {
        const ni = new Uint32Array(m * 2); ni.set(idx); idx = ni;
        const nd = new Float32Array(m * 2); nd.set(dat); dat = nd;
      }
      idx[m] = gridIndexOf ? gridIndexOf[k] : k;
      dat[m] = v;
      m++;
    });
    return { index: idx.subarray(0, m), data: dat.subarray(0, m) };
  }

  const values = new Float32Array(total);
  if (bitmap) values.fill(NaN);
  eachPacked(data, rep, (k, x) => { values[gridIndexOf ? gridIndexOf[k] : k] = toVal(x); });
  return { values };
}

module.exports = { decodeGrib2 };
