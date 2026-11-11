/**
 * Source → import → screen comparison for each NOAA feed StormCheck Pro uses.
 *
 * Each evaluator is a pure function of what NOAA published (up), what the app
 * imported (pipe, from /api/monitor/pipeline) and what customer APIs serve
 * (served), so the rules can be tested with fixtures. The runners below fetch
 * those three things.
 *
 * Status: ok | warn (worth seeing, never pages) | fail (counts toward an incident) | setup
 */
const config = require('./config');
const up = require('./upstream');
const app = require('./app-client');
const fmt = require('./fmt');

const MIN = 60000;
const link = p => config.appUrl + p;

function result(base, extra) { return { group: 'feed', ...base, ...extra }; }

// ── Daily radar hail swath (MRMS MESH_Max_1440min) ──────────────────────────
const MESH = { id: 'feed.mesh', name: 'Radar hail swath', feature: 'Hail map swath, property radar hail, saved-property alerts', schedule: 'NOAA posts storm day D at about 7:05 AM CT on D+1. StormCheck checks hourly at :25.' };

/** When the app should have the file: first hh:25 run after it posts (and after 12:30Z), plus one hour of grace. */
function meshDeadline(day, publishedAt) {
  const base = Math.max(Date.parse(publishedAt), Date.parse(up.addDays(day, 1) + 'T12:30:00Z'));
  const d = new Date(base);
  let next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), 25);
  if (next < base) next += 60 * MIN;
  return new Date(next + 60 * MIN).toISOString();
}

function evalMesh({ up: u, pipe, served, now = Date.now() }) {
  const impDay = pipe.mesh.coverage.last;
  const impRec = (pipe.mesh.recent || []).find(r => r.date === u.convectiveDay) || (pipe.mesh.recent || [])[0] || {};
  const srvDay = served.lastDay;
  const base = {
    source: { label: 'NOAA', product: `Storm day ${fmt.day(u.convectiveDay)}`, time: u.publishedAt },
    imported: { product: impDay ? `Storm day ${fmt.day(impDay)}` : 'none', time: impRec.ingestedAt || null, detail: impRec.cells != null ? `${impRec.cells.toLocaleString()} hail cells, max ${impRec.maxIn}"` : null },
    served: { product: srvDay ? `Storm day ${fmt.day(srvDay)}` : 'none', time: null, label: 'Hail map shows' },
    link: link(`/hailmap?date=${impDay || u.convectiveDay}`),
  };
  if (impDay && impDay >= u.convectiveDay) {
    if (!srvDay || srvDay < impDay) {
      return result(MESH, { ...base, status: 'fail', kind: 'serve', problem: `NOAA has a newer hail file (storm day ${fmt.day(u.convectiveDay)}). StormCheck Pro imported it, but the hail map is still serving ${srvDay ? `storm day ${fmt.day(srvDay)}` : 'no days'}.` });
    }
    if (served.cells != null && impRec.date === impDay && impRec.cells != null && served.cells !== impRec.cells) {
      return result(MESH, { ...base, status: 'fail', kind: 'serve', problem: `StormCheck Pro imported ${impRec.cells.toLocaleString()} hail cells for ${fmt.day(impDay)}, but the hail map serves ${served.cells.toLocaleString()}. Part of the swath is missing for customers.` });
    }
    const quiet = impRec.date === impDay && impRec.cells === 0;
    return result(MESH, { ...base, status: 'ok', summary: quiet ? `No hail in NOAA's ${fmt.day(impDay)} file. Checked and imported; nothing to show.` : `Current: NOAA, import and hail map all on ${fmt.day(impDay)}.` });
  }
  const deadline = meshDeadline(u.convectiveDay, u.publishedAt);
  if (now < Date.parse(deadline)) {
    return result(MESH, { ...base, status: 'ok', summary: `NOAA posted ${fmt.day(u.convectiveDay)} at ${fmt.time(u.publishedAt)}. Import due by ${fmt.time(deadline)}.` });
  }
  const why = pipe.runs && pipe.runs.mesh ? (pipe.runs.mesh.lastError || (pipe.runs.mesh.lastResult && pipe.runs.mesh.lastResult.notReady)) : null;
  return result(MESH, { ...base, status: 'fail', kind: 'import', problem: `NOAA posted the hail file for storm day ${fmt.day(u.convectiveDay)} at ${fmt.time(u.publishedAt)}. StormCheck Pro has not imported it (newest import: ${impDay ? fmt.day(impDay) : 'none'}), so customers can't see that day's swath.${why ? ` Importer said: ${why}` : ''}` });
}

const swathVerified = { day: null, cells: null, at: 0 };
async function servedMesh(day) {
  // The date list customers get, and the swath for that day summed over the whole radar grid.
  const r = await app.customer('/api/mesh/days?w=-104&s=24&e=-74&n=50&limit=1&minIn=0.75');
  if (r.status !== 200 || !r.json) throw new Error(`Hail map date list answered HTTP ${r.status}`);
  const lastDay = r.json.coverage && r.json.coverage.last;
  let cells = null;
  if (day && lastDay === day && swathVerified.day === day && Date.now() - swathVerified.at < 6 * 3600000) {
    cells = swathVerified.cells; // full-grid comparison already done for this day recently
  } else if (day && lastDay === day) {
    // Whole MRMS grid (130W-60W, 20N-55N) in 12°x13° boxes; boxes overlap by one cell, so de-duplicate.
    const seen = new Set();
    for (let w = -131; w < -59; w += 12) for (let s = 19; s < 56; s += 13) {
      const q = await app.customer(`/api/mesh/swath?date=${day}&w=${w}&s=${s}&e=${w + 12}&n=${s + 13}`, { timeout: 60000 });
      if (q.status !== 200 || !q.json) throw new Error(`Hail swath answered HTTP ${q.status}`);
      for (const c of q.json.cells) seen.add(c[0] * 100000 + c[1]);
    }
    cells = seen.size;
    Object.assign(swathVerified, { day, cells, at: Date.now() });
  }
  return { lastDay, cells };
}

// ── SPC preliminary storm reports (hail, wind, tornado) ─────────────────────
const SPC = { id: 'feed.spc', name: 'Ground storm reports', feature: 'Storm list, ground reports on the map, early portfolio hits', schedule: 'SPC updates through the day. StormCheck pulls every 15 min.' };
const STALE_SPC = 35 * MIN;

function evalSpc({ up: u, pipe, served, now = Date.now() }) {
  const imp = pipe.spc.days[u.date];
  const f = u.filtered, sv = served.byType;
  const cnt = o => `${o.hail} hail · ${o.wind} wind · ${o.tornado} tornado`;
  const base = {
    source: { label: 'SPC', product: `${fmt.day(u.date)}: ${cnt(u.filtered)}`, time: u.lastModified },
    imported: { product: imp ? `${imp.hail + imp.wind + imp.tornado} raw reports` : 'none', time: imp ? imp.fetchedAt : null },
    served: { product: sv ? cnt(sv) : '—', time: null, label: 'Storm list shows' },
    link: link('/storms'),
  };
  const lastErr = pipe.runs && pipe.runs.spc && pipe.runs.spc.lastError;
  if (!imp || now - Date.parse(imp.fetchedAt) > STALE_SPC) {
    return result(SPC, { ...base, status: 'fail', kind: 'import', problem: `StormCheck Pro last pulled SPC storm reports for ${fmt.day(u.date)} ${imp ? fmt.ago(imp.fetchedAt, now) : 'never'} (it should every 15 min). New hail, wind and tornado reports aren't reaching customers.${lastErr ? ` Last error: ${lastErr}` : ''}` });
  }
  const importCurrent = !u.lastModified || Date.parse(imp.fetchedAt) >= Date.parse(u.lastModified);
  const rawUp = u.raw.hail + u.raw.wind + u.raw.tornado, rawImp = imp.hail + imp.wind + imp.tornado;
  if (importCurrent && rawImp < rawUp) {
    return result(SPC, { ...base, status: 'fail', kind: 'import', problem: `SPC has ${rawUp} reports for ${fmt.day(u.date)} and StormCheck Pro pulled after SPC's last update, but it stored only ${rawImp}. The importer is dropping reports.` });
  }
  if (importCurrent && sv && (sv.hail !== f.hail || sv.wind !== f.wind || sv.tornado !== f.tornado)) {
    return result(SPC, { ...base, status: 'fail', kind: 'serve', problem: `SPC lists ${cnt(f)} for ${fmt.day(u.date)}. StormCheck Pro imported them, but the storm list shows ${cnt(sv)}.` });
  }
  const quiet = rawUp === 0;
  return result(SPC, { ...base, status: 'ok', summary: quiet ? `No storm reports yet for ${fmt.day(u.date)}. SPC checked and processed ${fmt.ago(imp.fetchedAt, now)}.` : (importCurrent ? `Matches SPC: ${cnt(f)} on the storm list.` : `SPC updated ${fmt.ago(u.lastModified, now)}; next 15-min pull will bring it in.`) });
}

async function servedSpc(date) {
  const r = await app.customer('/api/storms?days=2');
  if (r.status !== 200 || !r.json) throw new Error(`Storm list answered HTTP ${r.status}`);
  const byType = { hail: 0, wind: 0, tornado: 0 };
  for (const e of r.json.events || []) if (e.date === date && byType[e.type] != null) byType[e.type]++;
  return { byType };
}

// ── NCEI Storm Events (official history) ────────────────────────────────────
const NCEI = { id: 'feed.ncei', name: 'Official storm history (NCEI)', feature: 'Property history and PDF report for older storms', schedule: 'NOAA revises yearly files about monthly. StormCheck syncs Sundays 2 AM CT.' };
const STALE_NCEI = 8 * 24 * 60 * MIN;

function evalNcei({ up: years, pipe, now = Date.now() }) {
  const ys = Object.keys(years).sort().slice(-3);
  const imp = pipe.ncei.years || {};
  const newest = ys[ys.length - 1];
  const base = {
    source: { label: 'NCEI', product: newest ? `${newest} file rev. ${fmt.day(years[newest].revision.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'))}` : 'none', time: newest ? years[newest].publishedAt : null },
    imported: { product: imp[newest] ? `${newest} rev. ${fmt.day(String(imp[newest].revision).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'))}` : 'none', time: imp[newest] ? imp[newest].ingestedAt : null },
    served: { product: pipe.ncei.coverage && pipe.ncei.coverage.end ? `History through ${fmt.day(pipe.ncei.coverage.end)}` : '—', time: null, label: 'Reports include' },
    link: link('/dashboard'),
  };
  for (const y of ys) {
    const u = years[y], have = imp[y];
    if (have && have.revision === u.revision) continue;
    const age = u.publishedAt ? now - Date.parse(u.publishedAt) : Infinity;
    if (age > STALE_NCEI) {
      return result(NCEI, { ...base, status: 'fail', kind: 'import', problem: `NOAA published an updated ${y} storm database on ${fmt.time(u.publishedAt)}. StormCheck Pro still has ${have ? `the ${have.revision} version` : 'nothing for that year'}, so property history is missing storms NOAA has added since.` });
    }
    return result(NCEI, { ...base, status: 'ok', summary: `NOAA posted a new ${y} file ${fmt.ago(u.publishedAt, now)}; Sunday's sync will import it.` });
  }
  return result(NCEI, { ...base, status: 'ok', summary: `Current with NOAA for ${ys.join(', ')}.` });
}

// ── NEXRAD hail signatures (SWDI nx3hail) ───────────────────────────────────
const SIG = { id: 'feed.hailsig', name: 'Radar hail probability (NEXRAD)', feature: 'Hail probability in alerts, recaps and reports', schedule: 'NCEI finalizes about 3 days after a storm. StormCheck pulls daily at 10:40 AM CT for 1"+ storm days.' };

function evalHailsig({ pipe, swdiOk, swdiError, now = Date.now() }) {
  const storm = (pipe.mesh.recent || []).filter(r => (r.maxIn || 0) >= 1);
  const days = pipe.hailsig.days || {};
  const due = storm.filter(r => now - Date.parse(up.addDays(r.date, 2) + 'T12:00:00Z') > 4 * 24 * 60 * MIN);
  const missing = due.filter(r => !(days[r.date] && days[r.date].final && days[up.addDays(r.date, 1)] && days[up.addDays(r.date, 1)].final));
  const base = {
    source: { label: 'NCEI SWDI', product: swdiOk ? 'Reachable' : 'Unreachable', time: null },
    imported: { product: pipe.hailsig.coverage && pipe.hailsig.coverage.last ? `Through ${fmt.day(pipe.hailsig.coverage.last)}` : 'none', time: null },
    served: { product: storm.length ? `${storm.length} recent 1"+ storm day(s)` : 'No recent 1"+ storm days', time: null, label: 'Needed for' },
    link: link('/dashboard'),
  };
  if (missing.length) {
    return result(SIG, { ...base, status: 'fail', kind: swdiOk ? 'import' : 'source', problem: `Radar hail probabilities are missing for storm day${missing.length > 1 ? 's' : ''} ${missing.map(r => fmt.day(r.date)).join(', ')}, more than 4 days after the storm.${swdiOk ? ' NOAA has the data; the daily importer hasn\'t stored it.' : ` NOAA's SWDI service isn't answering (${swdiError}).`}` });
  }
  if (!swdiOk) return result(SIG, { ...base, status: 'warn', kind: 'source', problem: `NOAA's SWDI service isn't answering (${swdiError}). Nothing is overdue yet.` });
  return result(SIG, { ...base, status: 'ok', summary: storm.length ? `Recent storm days are covered or not yet due.` : 'No 1"+ storm days in the last 5 radar days. Source checked.' });
}

// ── NWS active warnings ─────────────────────────────────────────────────────
const NWS = { id: 'feed.nws', name: 'NWS warnings', feature: 'Warning heads-up emails (Team+), dashboard active alerts', schedule: 'NWS issues warnings live. StormCheck polls every 5 min.' };

function evalNws({ up: u, pipe, now = Date.now() }) {
  const run = (pipe.runs && pipe.runs.warnings) || {};
  const res = run.lastResult || {};
  const base = {
    source: { label: 'NWS', product: `${u.active} active hail/tornado-capable warning${u.active === 1 ? '' : 's'}`, time: u.newestSent || u.updated },
    imported: { product: res.active != null ? `${res.active} seen at last poll` : '—', time: run.lastSuccess || null },
    served: { product: 'Emails and dashboard alerts use the live poll', time: null, label: 'Customers get' },
    link: link('/dashboard'),
  };
  if (!pipe.jobsEnabled) return result(NWS, { ...base, status: 'fail', kind: 'import', problem: 'StormCheck Pro\'s background jobs are turned off (DATA_JOBS=off), so no feed is updating.' });
  if (!run.lastSuccess || now - Date.parse(run.lastSuccess) > 15 * MIN) {
    return result(NWS, { ...base, status: 'fail', kind: 'import', problem: `StormCheck Pro hasn't checked NWS warnings successfully since ${run.lastSuccess ? fmt.time(run.lastSuccess) : 'it started'} (it should every 5 min). Warning heads-up emails won't go out.${run.lastError ? ` Last error: ${run.lastError}` : ''}` });
  }
  if (u.newestSent && (!res.newest || res.newest < u.newestSent) && now - Date.parse(u.newestSent) > 10 * MIN && Date.parse(run.lastSuccess) > Date.parse(u.newestSent)) {
    return result(NWS, { ...base, status: 'fail', kind: 'import', problem: `NWS issued a warning at ${fmt.time(u.newestSent)}. StormCheck Pro polled after that but didn't pick it up.` });
  }
  return result(NWS, { ...base, status: 'ok', summary: u.active ? `Polling normally; ${u.active} active warning(s) seen.` : 'No active hail or tornado warnings. Polled normally.' });
}

// ── Hourly radar frames (playback) ──────────────────────────────────────────
const FRAMES = { id: 'feed.frames', name: 'Radar playback frames', feature: 'Play storm (hourly radar frames)', schedule: 'NOAA posts an hourly frame every hour. StormCheck builds a storm day on first view and keeps it.' };

function evalFrames({ up: u, pipe, counts, now = Date.now() }) {
  const base = {
    source: { label: 'NOAA', product: `Newest frame ${fmt.time(u.validTime)}`, time: u.publishedAt },
    imported: { product: (pipe.frames || []).length ? `${pipe.frames.length} storm day(s) cached` : 'none cached', time: (pipe.frames || []).map(f => f.builtAt).sort().pop() || null },
    served: { product: 'Built on first view', time: null, label: 'Playback' },
    link: link('/hailmap'),
  };
  for (const f of pipe.frames || []) {
    const total = counts[f.date];
    const windowEnd = Date.parse(up.addDays(f.date, 1) + 'T12:10:00Z');
    if (total != null && f.frames < total && Date.parse(f.builtAt) < windowEnd) {
      return result(FRAMES, { ...base, status: 'fail', kind: 'serve', problem: `Playback for ${fmt.day(f.date)} was saved at ${fmt.time(f.builtAt)}, when NOAA had only posted ${f.frames} of its ${total} hourly frames. It's cached, so customers see an incomplete storm.`, link: link(`/hailmap?date=${f.date}`) });
    }
  }
  if (now - Date.parse(u.validTime) > 90 * MIN) {
    return result(FRAMES, { ...base, status: 'warn', kind: 'source', problem: `NOAA's newest hourly hail frame is from ${fmt.time(u.validTime)}. NOAA is running late; nothing StormCheck can do.` });
  }
  return result(FRAMES, { ...base, status: 'ok', summary: 'NOAA hourly frames are current; cached storm days are complete.' });
}

// ── Runners ─────────────────────────────────────────────────────────────────
function failed(def, e, kind = 'source') {
  if (e && e.setup) return result(def, { status: 'setup', kind: 'setup', problem: e.message });
  return result(def, { status: 'fail', kind, problem: e.message });
}

/** Returns a runner per feed. pipe is fetched once per cycle and shared. */
function runners(getPipe) {
  return {
    [MESH.id]: async () => {
      let u; try { u = await up.mrmsDaily(); } catch (e) { return failed(MESH, new Error(`Couldn't read NOAA's hail file listing: ${e.message}. This is on NOAA's side.`)); }
      const pipe = await getPipe();
      const imp = pipe.mesh.coverage.last;
      const served = await servedMesh(imp && imp >= u.convectiveDay ? imp : null);
      return evalMesh({ up: u, pipe, served });
    },
    [SPC.id]: async () => {
      const pipe = await getPipe();
      const date = pipe.spc.convectiveToday;
      let u; try { u = await up.spcDay(date); } catch (e) { return failed(SPC, new Error(`Couldn't reach SPC (${e.message}). This is on NOAA's side.`)); }
      return evalSpc({ up: u, pipe, served: await servedSpc(date) });
    },
    [NCEI.id]: async () => {
      let u; try { u = await up.nceiFiles(); } catch (e) { return failed(NCEI, new Error(`Couldn't read NOAA's storm database listing (${e.message}).`)); }
      return evalNcei({ up: u, pipe: await getPipe() });
    },
    [SIG.id]: async () => {
      const pipe = await getPipe();
      let swdiOk = true, swdiError = null;
      try { await up.swdiReachable(pipe.mesh.coverage.last || up.addDays(new Date().toISOString().slice(0, 10), -2)); } catch (e) { swdiOk = false; swdiError = e.message; }
      return evalHailsig({ pipe, swdiOk, swdiError });
    },
    [NWS.id]: async () => {
      let u; try { u = await up.nwsWarnings(); } catch (e) { return failed(NWS, new Error(`Couldn't reach api.weather.gov (${e.message}).`)); }
      return evalNws({ up: u, pipe: await getPipe() });
    },
    [FRAMES.id]: async () => {
      let u; try { u = await up.mrmsHourly(); } catch (e) { return failed(FRAMES, new Error(`Couldn't read NOAA's hourly frame listing (${e.message}).`)); }
      const pipe = await getPipe();
      const counts = {};
      for (const f of pipe.frames || []) if (Date.now() - Date.parse(f.date) < 4 * 86400000) counts[f.date] = await up.mrmsHourlyCount(f.date);
      return evalFrames({ up: u, pipe, counts });
    },
  };
}

const DEFS = [MESH, SPC, NWS, FRAMES, SIG, NCEI];

module.exports = { DEFS, runners, evalMesh, evalSpc, evalNcei, evalHailsig, evalNws, evalFrames, meshDeadline };
