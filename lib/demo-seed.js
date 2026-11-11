/**
 * Staging/demo helpers, all off unless their environment variable is set.
 *
 *   PRELOAD_DATES=2026-04-25,2026-05-25
 *       Load these radar days (and their hourly playback frames) at startup
 *       instead of waiting for the newest-first backfill to reach them.
 *
 *   DEMO_PORTFOLIO=email|Name;Address;lat;lon|Name;Address;lat;lon
 *       Give an existing account (e.g. one from SEED_USERS) a ready portfolio
 *       of already-located properties, once, when it has none. Also marks the
 *       account's onboarding as done.
 */
const mesh = require('./mesh-store');

async function preload(dataJobs, frames, log = console.log) {
  const dates = String(process.env.PRELOAD_DATES || '').split(',').map(s => s.trim()).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
  for (const date of dates) {
    try {
      if (!mesh.hasDay(date)) { const r = await dataJobs.ingestMeshDay(date); log(`[demo] radar ${date}: ${r.cells || 0} cells`); }
      if (!frames.isCached(date)) { await frames.framesForDay(date); log(`[demo] hourly frames ${date} ready`); }
    } catch (e) { log(`[demo] preload ${date} failed: ${e.message}`); }
  }
}

async function seedPortfolio(db, log = console.log) {
  const spec = String(process.env.DEMO_PORTFOLIO || '');
  if (!spec) return;
  const [email, ...rows] = spec.split('|');
  const user = await db.userOps.findByEmail(String(email).trim());
  if (!user) return log(`[demo] DEMO_PORTFOLIO: no account ${email}`);
  if (!user.onboardingComplete) await db.userOps.update(user._id, { onboardingComplete: true, watchedStates: user.watchedStates && user.watchedStates.length ? user.watchedStates : ['TX'] });
  const have = await db.watchlistOps.getForUser(user._id);
  if (have.length) return;
  for (const row of rows) {
    const [name, address, lat, lon] = row.split(';');
    if (!name || !address || !Number.isFinite(+lat) || !Number.isFinite(+lon)) continue;
    await db.watchlistOps.addContact(user._id, { name, address, phone: '', email: '', lat: +lat, lon: +lon, formattedAddress: address, state: (address.match(/\b([A-Z]{2})\b\s*\d{5}/) || [])[1] || null });
  }
  log(`[demo] seeded ${rows.length} portfolio properties for ${email}`);
}

module.exports = { preload, seedPortfolio };
