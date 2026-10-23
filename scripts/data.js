#!/usr/bin/env node
/**
 * Manual data commands (the server also runs these automatically).
 *
 *   node scripts/data.js status
 *   node scripts/data.js mesh 2024-05-28              # one radar day
 *   node scripts/data.js mesh 2024-03-01 2024-09-30   # a range (newest first)
 *   node scripts/data.js ncei [fromYear]              # NWS Storm Events
 *   node scripts/data.js spc [days]                   # SPC reports, default 730 days
 *   node scripts/data.js summaries                    # rebuild storm-day pages
 *   node scripts/data.js prune                        # delete data older than RETENTION_YEARS (default 5)
 */
process.env.DATA_JOBS = 'off';
require('dotenv').config();
const mesh = require('../lib/mesh-store');
const ncei = require('../lib/ncei-store');
const spc = require('../lib/spc-store');
const stormDays = require('../lib/storm-days');
const jobs = require('../lib/data-jobs');
const retention = require('../lib/retention');

const [cmd, a, b] = process.argv.slice(2);
const ds = d => d.toISOString().slice(0, 10);

(async () => {
  spc.loadFromDisk();
  if (cmd === 'status') {
    console.log(JSON.stringify({ radar: mesh.coverage(), ncei: ncei.coverage(), spc: spc.coverage() }, null, 2));
  } else if (cmd === 'mesh') {
    if (!a) throw new Error('date required');
    let d = new Date((b || a) + 'T00:00:00Z');
    const stop = new Date(a + 'T00:00:00Z');
    while (d >= stop) {
      const date = ds(d);
      try { console.log(date, JSON.stringify(await jobs.ingestMeshDay(date))); }
      catch (e) { console.log(date, 'FAILED', e.message); }
      d = new Date(d.getTime() - 86400000);
    }
  } else if (cmd === 'ncei') {
    const cutoff = retention.cutoffDate();
    const fromYear = Math.max(parseInt(a || '1996', 10), cutoff ? +cutoff.slice(0, 4) : 0);
    console.log(await ncei.syncAll({ fromYear, minDate: cutoff }));
  } else if (cmd === 'spc') {
    console.log(await spc.sync({ backDays: parseInt(a || '730', 10), concurrency: 4, log: console.log }));
  } else if (cmd === 'prune') {
    console.log(JSON.stringify(retention.prune(), null, 2));
  } else if (cmd === 'summaries') {
    for (const d of mesh.ingestedDays()) stormDays.summarize(d);
    console.log('rebuilt', mesh.ingestedDays().length);
  } else {
    console.log('Commands: status | mesh <from> [to] | ncei [fromYear] | spc [days] | summaries | prune');
  }
})().catch(e => { console.error(e.message); process.exit(1); });
