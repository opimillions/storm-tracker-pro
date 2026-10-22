/**
 * Background data jobs: keeps the radar, NCEI and SPC stores current, builds
 * storm summaries and sends alerts.
 *
 * Environment:
 *   DATA_JOBS=off             disable everything (local dev / tests)
 *   MESH_BACKFILL_FROM=YYYY-MM-DD   oldest radar day to backfill (default 2020-10-15,
 *                             the start of NOAA's AWS archive; IEM goes back to 2014-10-01)
 *   NCEI_FROM_YEAR=1996       oldest NCEI year to ingest
 */
const fs = require('fs');
const cron = require('node-cron');
const { dataPath } = require('./paths');
const { decodeGrib2 } = require('./grib2');
const mrms = require('./mrms-source');
const mesh = require('./mesh-store');
const ncei = require('./ncei-store');
const spc = require('./spc-store');
const stormDays = require('./storm-days');
const alerts = require('./alerts');

const status = { mesh: {}, ncei: {}, spc: {}, startedAt: null, log: [] };
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log('[data]', msg);
  status.log.push(line);
  if (status.log.length > 200) status.log.shift();
}

const FAIL_FILE = () => dataPath('mesh', 'failures.json');
let failures = null;
function failed(date) {
  if (!failures) { try { failures = JSON.parse(fs.readFileSync(FAIL_FILE(), 'utf8')); } catch { failures = {}; } }
  return failures[date] && Date.now() - failures[date] < 7 * 86400000;
}
function markFailed(date) { failed(date); failures[date] = Date.now(); fs.writeFileSync(FAIL_FILE(), JSON.stringify(failures)); }

const ds = d => d.toISOString().slice(0, 10);
const lastCompleteDay = () => ds(new Date(Date.now() - 36 * 3600000 - 30 * 60000)); // file for D posts ~12:10Z on D+1

let ctx = null; // { db, tierFeatures, freeAlertOps }

async function ingestMeshDay(date, { force = false, runAlerts = false } = {}) {
  if (mesh.hasDay(date) && !force) return { skipped: true };
  const { buffer, source } = await mrms.fetchDailyMesh(date);
  const grid = decodeGrib2(buffer, { minValue: mesh.MIN_MM });
  const res = mesh.ingestGrid(date, grid, { force, source });
  stormDays.summarize(date);
  if (runAlerts && ctx) await afterRadarDay(date);
  return res;
}

async function afterRadarDay(date) {
  try {
    const a = await alerts.checkPortfolio(date, ctx.db);
    const b = await alerts.checkRegions(date, ctx.db);
    const c = ctx.freeAlertOps ? await alerts.checkFreeSubscribers(date, ctx.freeAlertOps) : { emails: 0 };
    log(`alerts ${date}: portfolio ${a.emails}, territory ${b.emails}, free ${c.emails}`);
  } catch (e) { log(`alerts ${date} error: ${e.message}`); }
}

/** Newest-first radar backfill, one day at a time, until `from`. */
let backfilling = false;
async function backfillMesh(from) {
  if (backfilling) return;
  backfilling = true;
  try {
    let d = new Date(lastCompleteDay() + 'T00:00:00Z');
    const stop = new Date(from + 'T00:00:00Z');
    let n = 0;
    while (d >= stop) {
      const date = ds(d);
      if (!mesh.hasDay(date) && !failed(date)) {
        try {
          const r = await ingestMeshDay(date);
          n++;
          if (n % 25 === 0 || r.cells > 50000) log(`MESH ${date}: ${r.cells} cells, max ${r.maxIn}" (${n} days this run)`);
        } catch (e) { markFailed(date); log(`MESH ${date} failed: ${e.message}`); }
        await new Promise(r => setTimeout(r, 1500));
      }
      d = new Date(d.getTime() - 86400000);
    }
    log(`MESH backfill complete to ${from} (${n} new days)`);
  } finally { backfilling = false; status.mesh = mesh.coverage(); }
}

async function refreshRecentMesh() {
  for (let i = 0; i < 4; i++) {
    const date = ds(new Date(Date.parse(lastCompleteDay() + 'T00:00:00Z') - i * 86400000));
    if (mesh.hasDay(date)) continue;
    try {
      const r = await ingestMeshDay(date, { runAlerts: true });
      log(`MESH ${date}: ${r.cells} cells, max ${r.maxIn}"`);
    } catch (e) { log(`MESH ${date} not ready: ${e.message}`); }
  }
  status.mesh = mesh.coverage();
}

async function refreshSpc() {
  const r = await spc.sync({ backDays: 2, concurrency: 2 });
  status.spc = { ...spc.coverage(), lastRefresh: new Date().toISOString(), ...r };
  if (ctx) {
    // Ground reports can confirm a portfolio hit before the radar day file posts.
    for (const date of spc.recentDays(2)) {
      try { await alerts.checkPortfolio(date, ctx.db); } catch (e) { log(`portfolio ${date}: ${e.message}`); }
    }
  }
}

async function syncNcei() {
  try {
    const done = await ncei.syncAll({ fromYear: parseInt(process.env.NCEI_FROM_YEAR || '1996', 10), log });
    status.ncei = { ...ncei.coverage(), lastSync: new Date().toISOString(), updatedYears: done.map(d => d.year) };
  } catch (e) { log(`NCEI sync failed: ${e.message}`); }
}

function start(context) {
  ctx = context;
  status.startedAt = new Date().toISOString();
  spc.loadFromDisk();
  status.mesh = mesh.coverage(); status.ncei = ncei.coverage(); status.spc = spc.coverage();
  if (process.env.DATA_JOBS === 'off') { log('Data jobs disabled (DATA_JOBS=off)'); return; }

  // Every 15 min: SPC reports for today/yesterday + portfolio check.
  cron.schedule('*/15 * * * *', () => refreshSpc().catch(e => log('SPC refresh: ' + e.message)));
  // Every 5 min: NWS warnings heads-up for paid plans.
  cron.schedule('*/5 * * * *', () => alerts.checkWarnings(ctx.db, ctx.tierFeatures).catch(e => log('warnings: ' + e.message)));
  // Hourly at :25: pick up new radar days (posts shortly after 12Z).
  cron.schedule('25 * * * *', () => refreshRecentMesh().catch(e => log('MESH refresh: ' + e.message)));
  // Sundays 08:00 UTC: NCEI revisions and new months.
  cron.schedule('0 8 * * 0', () => syncNcei());

  // Startup: fill gaps in the background, most useful data first.
  setTimeout(async () => {
    try { await spc.sync({ backDays: 30, concurrency: 4, log }); } catch (e) { log('SPC startup: ' + e.message); }
    await refreshRecentMesh().catch(e => log('MESH startup: ' + e.message));
    if (!ncei.coverage().lastYear) await syncNcei();
    spc.sync({ backDays: 730, concurrency: 2, log }).then(r => log(`SPC backfill: ${r.done} days`)).catch(() => {});
    backfillMesh(process.env.MESH_BACKFILL_FROM || '2020-10-15').catch(e => log('MESH backfill: ' + e.message));
  }, 5000);
}

function getStatus() {
  return { ...status, mesh: mesh.coverage(), ncei: ncei.coverage(), spc: spc.coverage(), backfilling };
}

module.exports = { start, getStatus, ingestMeshDay, backfillMesh, syncNcei, refreshSpc, afterRadarDay };
