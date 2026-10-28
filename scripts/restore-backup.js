#!/usr/bin/env node
/**
 * Restore a StormCheck Pro backup.
 *
 *   BACKUP_KEY=... node scripts/restore-backup.js <backup.bin> [output-folder]
 *
 * Decrypts the backup and writes its files to output-folder (default
 * ./restored-<date>). It never touches the live data folder: stop the app,
 * check the restored files, then copy them into the data folder yourself.
 */
const fs = require('fs');
const path = require('path');
const [file, out] = process.argv.slice(2);
if (!file) {
  console.error('Usage: BACKUP_KEY=... node scripts/restore-backup.js <backup.bin> [output-folder]');
  process.exit(1);
}
if (!process.env.BACKUP_KEY) {
  console.error('Set BACKUP_KEY to the passphrase used when the backup was made.');
  process.exit(1);
}
process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(require('os').tmpdir(), 'scp-restore-'));
const { decode } = require('../lib/backups');
let res;
try { res = decode(fs.readFileSync(file), process.env.BACKUP_KEY); }
catch (e) { console.error('Could not decrypt this backup. Is BACKUP_KEY right?', e.message); process.exit(1); }
const dir = out || `restored-${res.createdAt.slice(0, 10)}`;
fs.mkdirSync(dir, { recursive: true });
for (const [name, buf] of Object.entries(res.files)) {
  if (name.includes('/') || name.includes('\\') || name.startsWith('.')) continue;
  fs.writeFileSync(path.join(dir, name), buf);
  console.log(`  ${name}  ${buf.length.toLocaleString()} bytes`);
}
console.log(`Restored ${Object.keys(res.files).length} files from the backup made ${res.createdAt} into ${dir}`);
