/**
 * Data retention: keep only the last RETENTION_YEARS of storm data on the
 * volume (default 5) and delete anything older.
 *
 * Covers the radar hail tiles, NCEI storm events, SPC ground reports, daily
 * storm summaries and cached playback frames. User accounts, watchlists and
 * other app databases are never touched.
 *
 * Environment:
 *   RETENTION_YEARS=5   years of storm data to keep (0 or "off" disables pruning)
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');

const REC = 6; // radar tile record size (see mesh-store)
const EPOCH = Date.UTC(2000, 0, 1);
const DAY_MS = 86400000;

function retentionYears() {
  const v = String(process.env.RETENTION_YEARS ?? '5').trim().toLowerCase();
  if (v === 'off' || v === 'false') return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Oldest date (YYYY-MM-DD) still kept, or null when retention is disabled. */
function cutoffDate(now = new Date()) {
  const years = retentionYears();
  if (!years) return null;
  const d = new Date(now.getTime());
  d.setUTCFullYear(d.getUTCFullYear() - Math.floor(years));
  const extraDays = Math.round((years % 1) * 365);
  return new Date(d.getTime() - extraDays * DAY_MS).toISOString().slice(0, 10);
}

/** Later of two YYYY-MM-DD dates (null-safe). */
function laterDate(a, b) { if (!a) return b; if (!b) return a; return a > b ? a : b; }

const exists = p => { try { fs.statSync(p); return true; } catch { return false; } };
const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };

// Rewrites shrink files, so write in place: the 'w' flag truncates first,
// freeing space before writing. A temp-file swap would need extra free space,
// which a full volume does not have.
function writeInPlace(file, data) { fs.writeFileSync(file, data, { flag: 'w' }); }

/** Delete <date>.json files older than the cutoff in a directory. */
function pruneDatedFiles(dir, cutoff) {
  if (!exists(dir)) return { files: 0, bytes: 0 };
  let files = 0, bytes = 0;
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m || m[1] >= cutoff) continue;
    const p = path.join(dir, f);
    try { bytes += fs.statSync(p).size; fs.unlinkSync(p); files++; } catch { /* already gone */ }
  }
  return { files, bytes };
}

function pruneMesh(cutoff) {
  const root = path.join(DATA_DIR, 'mesh');
  const tiles = path.join(root, 'tiles');
  const cutDay = Math.round((Date.parse(cutoff + 'T00:00:00Z') - EPOCH) / DAY_MS);
  let bytes = 0, records = 0, tilesTouched = 0;
  if (exists(tiles)) {
    for (const f of fs.readdirSync(tiles)) {
      if (!f.endsWith('.bin')) continue;
      const file = path.join(tiles, f);
      let buf;
      try { buf = fs.readFileSync(file); } catch { continue; }
      const n = Math.floor(buf.length / REC);
      let keepCount = 0;
      for (let i = 0; i < n; i++) if (buf.readUInt16LE(i * REC) >= cutDay) keepCount++;
      if (keepCount === n) continue;
      const out = Buffer.alloc(keepCount * REC);
      let k = 0;
      for (let i = 0; i < n; i++) {
        const o = i * REC;
        if (buf.readUInt16LE(o) >= cutDay) { buf.copy(out, k * REC, o, o + REC); k++; }
      }
      if (keepCount) writeInPlace(file, out); else fs.unlinkSync(file);
      bytes += buf.length - out.length; records += n - keepCount; tilesTouched++;
    }
  }
  // Manifest after the tiles: the tile rewrites free the space it needs.
  const manifestFile = path.join(root, 'days.json');
  const manifest = readJson(manifestFile, null);
  let days = 0;
  if (manifest) {
    for (const date of Object.keys(manifest)) if (date < cutoff) { delete manifest[date]; days++; }
    if (days) writeInPlace(manifestFile, JSON.stringify(manifest));
  }
  const failFile = path.join(root, 'failures.json');
  const failures = readJson(failFile, null);
  if (failures) {
    let changed = false;
    for (const date of Object.keys(failures)) if (date < cutoff) { delete failures[date]; changed = true; }
    if (changed) writeInPlace(failFile, JSON.stringify(failures));
  }
  return { days, records, tiles: tilesTouched, bytes };
}

function pruneNcei(cutoff) {
  const root = path.join(DATA_DIR, 'ncei');
  const tiles = path.join(root, 'tiles');
  const cutYear = +cutoff.slice(0, 4);
  let bytes = 0, events = 0;
  if (exists(tiles)) {
    for (const f of fs.readdirSync(tiles)) {
      if (!f.endsWith('.json')) continue;
      const file = path.join(tiles, f);
      let before, list;
      try { before = fs.statSync(file).size; list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      if (!Array.isArray(list)) continue;
      const kept = list.filter(e => !e.date || e.date >= cutoff);
      if (kept.length === list.length) continue;
      events += list.length - kept.length;
      if (kept.length) {
        const data = JSON.stringify(kept);
        writeInPlace(file, data);
        bytes += before - Buffer.byteLength(data);
      } else { fs.unlinkSync(file); bytes += before; }
    }
  }
  const manifestFile = path.join(root, 'manifest.json');
  const manifest = readJson(manifestFile, null);
  let years = 0;
  if (manifest && manifest.years) {
    for (const y of Object.keys(manifest.years)) if (+y < cutYear) { delete manifest.years[y]; years++; }
    if (years) writeInPlace(manifestFile, JSON.stringify(manifest));
  }
  return { years, events, bytes };
}

function pruneStormDays(cutoff) {
  const dir = path.join(DATA_DIR, 'storm-days');
  const res = pruneDatedFiles(dir, cutoff);
  const indexFile = path.join(dir, '_index.json');
  const index = readJson(indexFile, null);
  if (index) {
    let changed = false;
    for (const date of Object.keys(index)) if (date < cutoff) { delete index[date]; changed = true; }
    if (changed) writeInPlace(indexFile, JSON.stringify(index));
  }
  return res;
}

/**
 * Delete storm data older than the retention window. Synchronous on purpose:
 * it runs once at startup before anything else writes to the volume, and
 * then daily. Returns a summary (also logged).
 */
function prune({ log = console.log, now = new Date() } = {}) {
  const cutoff = cutoffDate(now);
  if (!cutoff) { log('Retention disabled (RETENTION_YEARS=off)'); return { cutoff: null }; }
  const res = { cutoff };
  const step = (name, fn) => {
    try { res[name] = fn(); } catch (e) { res[name] = { error: e.message }; log(`Retention ${name} failed: ${e.message}`); }
  };
  step('mesh', () => pruneMesh(cutoff));
  step('ncei', () => pruneNcei(cutoff));
  step('spc', () => pruneDatedFiles(path.join(DATA_DIR, 'spc', 'days'), cutoff));
  step('stormDays', () => pruneStormDays(cutoff));
  step('frames', () => pruneDatedFiles(path.join(DATA_DIR, 'frames'), cutoff));
  const freed = ['mesh', 'ncei', 'spc', 'stormDays', 'frames'].reduce((s, k) => s + ((res[k] && res[k].bytes) || 0), 0);
  res.freedMB = Math.round(freed / 1e5) / 10;
  log(`Retention: kept storm data since ${cutoff}, freed ${res.freedMB} MB` +
    (res.mesh && res.mesh.days ? `, ${res.mesh.days} radar days` : '') +
    (res.ncei && res.ncei.events ? `, ${res.ncei.events} NWS events` : ''));
  return res;
}

module.exports = { prune, cutoffDate, laterDate, retentionYears };
