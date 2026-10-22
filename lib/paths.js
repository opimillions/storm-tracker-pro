/**
 * Where persistent data lives. Uses the Railway volume when mounted.
 */
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data')
    : path.join(__dirname, '..', 'data'));

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

ensureDir(DATA_DIR);

function dataPath(...parts) {
  const p = path.join(DATA_DIR, ...parts);
  ensureDir(path.dirname(p));
  return p;
}

module.exports = { DATA_DIR, dataPath, ensureDir };
