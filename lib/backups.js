/**
 * Encrypted nightly backups of the app's own data: accounts, portfolios,
 * alert settings, integrations, prospects, directory listings and settings.
 * Storm data is NOT included (it is public NOAA data and reloads itself).
 *
 * Each backup is one file: gzip(JSON bundle) encrypted with AES-256-GCM.
 * The 30 newest are kept on the data volume under backups/. When the
 * BACKUP_S3_* settings are present, each backup is also uploaded to an
 * S3-compatible bucket (Cloudflare R2, Backblaze B2, AWS S3), which protects
 * against losing the server's disk.
 *
 *   BACKUP_KEY            encryption passphrase (keep a copy somewhere safe)
 *   BACKUP_S3_ENDPOINT    e.g. https://<account>.r2.cloudflarestorage.com
 *   BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY, BACKUP_S3_SECRET_KEY
 *   BACKUP_S3_REGION      default "auto"
 *
 * Restore with: node scripts/restore-backup.js <file>
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const axios = require('axios');
const { DATA_DIR, ensureDir } = require('./paths');
const { sealBuffer, openBuffer } = require('./secret-box');

const KEEP = 30;
const MAX_FILE = 200e6;
const SKIP = new Set(['results-cache.db']); // rebuildable cache
const DIR = () => ensureDir(path.join(DATA_DIR, 'backups'));

function key() {
  const k = process.env.BACKUP_KEY || require('./app-secret').jwtSecret();
  return crypto.createHash('sha256').update('scp-backup:' + k).digest();
}
const keyFor = passphrase => crypto.createHash('sha256').update('scp-backup:' + passphrase).digest();

/** App data files at the top of the data folder (not storm data, not secrets). */
function appFiles() {
  return fs.readdirSync(DATA_DIR, { withFileTypes: true })
    .filter(d => d.isFile() && !d.name.startsWith('.') && !SKIP.has(d.name) && /\.(db|json|jsonl)$/.test(d.name))
    .map(d => d.name)
    .filter(n => { try { return fs.statSync(path.join(DATA_DIR, n)).size <= MAX_FILE; } catch { return false; } })
    .sort();
}

function build() {
  const files = {};
  for (const n of appFiles()) files[n] = fs.readFileSync(path.join(DATA_DIR, n)).toString('base64');
  const bundle = Buffer.from(JSON.stringify({ app: 'stormcheck-pro', version: 1, createdAt: new Date().toISOString(), files }));
  return { data: sealBuffer(zlib.gzipSync(bundle, { level: 9 }), key()), count: Object.keys(files).length };
}

/** Decrypt a backup file's bytes → { createdAt, files: {name: Buffer} }. */
function decode(buf, passphrase) {
  const json = JSON.parse(zlib.gunzipSync(openBuffer(buf, passphrase ? keyFor(passphrase) : key())).toString('utf8'));
  const files = {};
  for (const [n, b64] of Object.entries(json.files || {})) files[n] = Buffer.from(b64, 'base64');
  return { createdAt: json.createdAt, files };
}

// ── Offsite copy (S3-compatible) ─────────────────────────────────────────────
function offsiteConfigured() {
  return !!(process.env.BACKUP_S3_ENDPOINT && process.env.BACKUP_S3_BUCKET && process.env.BACKUP_S3_ACCESS_KEY && process.env.BACKUP_S3_SECRET_KEY);
}
async function upload(name, data, { http = axios } = {}) {
  const aws4 = require('aws4');
  const ep = new URL(process.env.BACKUP_S3_ENDPOINT);
  const objectPath = `/${encodeURIComponent(process.env.BACKUP_S3_BUCKET)}/stormcheck-backups/${encodeURIComponent(name)}`;
  const opts = aws4.sign({
    host: ep.host, path: objectPath, method: 'PUT', service: 's3', region: process.env.BACKUP_S3_REGION || 'auto',
    body: data, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length },
  }, { accessKeyId: process.env.BACKUP_S3_ACCESS_KEY, secretAccessKey: process.env.BACKUP_S3_SECRET_KEY });
  await http.put(`${ep.protocol}//${ep.host}${objectPath}`, data, { headers: opts.headers, timeout: 120000, maxBodyLength: Infinity, maxContentLength: Infinity });
}

// ── Run / list ───────────────────────────────────────────────────────────────
function list() {
  let names = [];
  try { names = fs.readdirSync(DIR()).filter(n => /^scp-backup-.*\.bin$/.test(n)); } catch { names = []; }
  return names.sort().reverse().map(n => {
    const st = fs.statSync(path.join(DIR(), n));
    return { name: n, bytes: st.size, at: st.mtime.toISOString() };
  });
}
const latest = () => { const l = list()[0]; return l && Date.now() - Date.parse(l.at) < 26 * 3600000 ? l : null; };
const latestAgeHours = () => { const l = list()[0]; return l ? Math.round((Date.now() - Date.parse(l.at)) / 3600000) : null; };
const RUN_FILE = () => path.join(DIR(), 'last-run.json');
function lastRun() { try { return JSON.parse(fs.readFileSync(RUN_FILE(), 'utf8')); } catch { return null; } }

let running = false;
async function run({ http } = {}) {
  if (running) return { skipped: 'already running' };
  running = true;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `scp-backup-${stamp}.bin`;
    const { data, count } = build();
    fs.writeFileSync(path.join(DIR(), name), data, { mode: 0o600 });
    for (const old of list().slice(KEEP)) { try { fs.unlinkSync(path.join(DIR(), old.name)); } catch { /* gone */ } }
    let offsite = 'not set up';
    if (offsiteConfigured()) {
      try { await upload(name, data, { http }); offsite = 'uploaded'; }
      catch (e) { offsite = 'failed: ' + (e.response ? `HTTP ${e.response.status}` : e.message); }
    }
    const res = { name, bytes: data.length, files: count, offsite, at: new Date().toISOString(), keyFromEnv: !!process.env.BACKUP_KEY };
    fs.writeFileSync(RUN_FILE(), JSON.stringify(res));
    if (offsite.startsWith('failed')) console.error('[backup] offsite copy', offsite);
    return res;
  } finally { running = false; }
}

/** Path of a stored backup by name (validated), or null. */
function filePath(name) {
  if (!/^scp-backup-[0-9TZ-]+\.bin$/.test(String(name))) return null;
  const p = path.join(DIR(), name);
  return fs.existsSync(p) ? p : null;
}

module.exports = { run, list, latest, latestAgeHours, lastRun, decode, appFiles, offsiteConfigured, filePath, upload, keyFor };
