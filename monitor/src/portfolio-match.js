/**
 * Saved-property storm matching, checked without emailing anyone:
 *  1. The alert rule says the known-storm test address WAS hit on the storm date.
 *  2. The same rule says a point with no hail that day was NOT hit.
 *  3. After NOAA's newest radar day was imported, the live alert run actually
 *     checked every saved property for that day, and didn't error.
 */
const config = require('./config');
const app = require('./app-client');
const fmt = require('./fmt');
const { cachedAddress } = require('./workflow');

const CHECK = { id: 'wf.match', name: 'Saved-property storm matching', feature: 'Portfolio hail alerts (which properties get flagged)', group: 'workflow' };
const MIN = 60000;

async function match(date, lat, lon, min) {
  const r = await app.call(`/api/monitor/portfolio-match?date=${date}&lat=${lat}&lon=${lon}&min=${min}`, { monitor: true, auth: false });
  if (r.status === 404) throw Object.assign(new Error('StormCheck Pro does not have the matching dry-run yet (deploy the portfolio-match update).'), { setup: true });
  if (r.status !== 200 || !r.json) throw new Error(`Matching dry-run answered HTTP ${r.status}`);
  return r.json;
}

/** Pure rule for the "did the live alert run happen" part, testable with fixtures. */
function evalRun({ pipe, now = Date.now() }) {
  const day = pipe.mesh && pipe.mesh.coverage && pipe.mesh.coverage.last;
  const rec = (pipe.mesh.recent || []).find(r => r.date === day) || {};
  const run = (pipe.portfolioRuns || {})[day];
  if (!day) return { ok: true, note: 'No radar days imported yet.' };
  if (run && run.error) return { ok: false, problem: `The saved-property alert run for storm day ${fmt.day(day)} failed: ${run.error}. Customers with properties in that storm got no alert.` };
  if (run && run.radarRunAt) return { ok: true, note: `Alert run for ${fmt.day(day)} checked ${run.checked} of ${run.properties} saved properties at ${fmt.time(run.radarRunAt)}: ${run.hits} hit, ${run.emails} email(s).` };
  // Not run yet: fine if StormCheck restarted after the import (runs are kept in memory) or the import is recent.
  const imported = rec.ingestedAt ? Date.parse(rec.ingestedAt) : null;
  if (pipe.startedAt && imported && Date.parse(pipe.startedAt) > imported) return { ok: true, note: `StormCheck restarted after ${fmt.day(day)} was imported, so that alert run isn't on record. The next radar day will be checked.` };
  if (imported && now - imported < 30 * MIN) return { ok: true, note: `${fmt.day(day)} was imported ${fmt.ago(rec.ingestedAt, now)}; alert run in progress.` };
  return { ok: false, problem: `StormCheck Pro imported radar day ${fmt.day(day)}${imported ? ` at ${fmt.time(rec.ingestedAt)}` : ''}, but the saved-property alert run never happened for it. Customers with properties in that storm got no alert.` };
}

async function runMatchCheck() {
  const ks = config.knownStorm;
  const picked = cachedAddress();
  const at = picked ? { lat: picked.lat, lon: picked.lon, label: picked.address } : ks.address ? null : { lat: ks.center.lat, lon: ks.center.lon, label: 'the storm center' };
  if (!at) return { ...CHECK, status: 'setup', problem: 'With a fixed KNOWN_STORM_ADDRESS, also set KNOWN_STORM_LAT / KNOWN_STORM_LON for the matching check.' };
  const min = ks.minInches;
  const link = `${config.appUrl}/hailmap?date=${ks.date}&lat=${at.lat}&lon=${at.lon}`;

  const hit = await match(ks.date, at.lat, at.lon, min);
  if (!hit.hit) return { ...CHECK, status: 'fail', link, problem: `A saved property at ${at.label} would NOT get an alert for the ${fmt.day(ks.date)} storm, though it got ${hit.radarIn}" by radar. The matching rule is broken, so customers could miss hail on their properties.` };

  // Control: same place, a calm day well before the storm (no radar, no reports expected).
  const calmDate = config.knownStorm.calmDate;
  const calm = await match(calmDate, at.lat, at.lon, min);
  if (calm.hit) return { ...CHECK, status: 'fail', link: `${config.appUrl}/hailmap?date=${calmDate}&lat=${at.lat}&lon=${at.lon}`, problem: `The matching rule flags ${at.label} for ${fmt.day(calmDate)}, a day with no hail there (${calm.best}"). Customers would get false hail alerts.` };

  const pipe = await app.pipeline();
  const run = evalRun({ pipe });
  if (!run.ok) return { ...CHECK, status: 'fail', link: `${config.appUrl}/watchlist`, problem: run.problem };
  return { ...CHECK, status: 'ok', summary: `${at.label}: flagged for ${fmt.day(ks.date)} (${hit.best}"), not flagged for calm day ${fmt.day(calmDate)}. ${run.note}` };
}

module.exports = { CHECK, runMatchCheck, evalRun };
