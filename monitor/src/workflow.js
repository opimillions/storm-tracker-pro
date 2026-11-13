/**
 * Customer workflow test, driven in a real browser as the dedicated test account:
 * sign in → search the known address → property history → hail swath →
 * two different radar frames → PDF report (opened and read back).
 *
 * Each step becomes its own check so the panel shows exactly where it broke.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const fmt = require('./fmt');

const STEPS = [
  { id: 'wf.signin', name: 'Sign in', feature: 'Customer login' },
  { id: 'wf.search', name: 'Address search', feature: 'Property lookup' },
  { id: 'wf.history', name: 'Property history', feature: 'Storm dates and date of loss' },
  { id: 'wf.swath', name: 'Hail swath loads', feature: 'Hail map for a storm day' },
  { id: 'wf.playback', name: 'Radar playback (2 frames)', feature: 'Play storm' },
  { id: 'wf.pdf', name: 'PDF report', feature: 'Print / Save as PDF' },
];


/**
 * Picks the test address from production data: the hail cell nearest the known-storm
 * center where that cell and its 8 neighbors all got at least `need` inches on the
 * storm date, turned into a street address by the app's own reverse lookup. Cached in
 * the data folder until the storm stops showing at that address.
 */
const CAL_FILE = () => path.join(config.dataDir, 'known-storm-address.json');
function cachedAddress() { try { const c = JSON.parse(fs.readFileSync(CAL_FILE(), 'utf8')); return c.date === config.knownStorm.date ? c : null; } catch { return null; } }
function forgetAddress() { try { fs.unlinkSync(CAL_FILE()); } catch { /* none */ } }
async function calibrateAddress(page, base) {
  const ks = config.knownStorm;
  if (ks.addressFixed) return { address: ks.address, source: 'set by KNOWN_STORM_ADDRESS' };
  const hit = cachedAddress();
  if (hit) return hit;
  const need = Math.max(ks.minInches + 0.25, 1.25);
  const { lat, lon } = ks.center;
  const sw = await (await page.request.get(`${base}/api/mesh/swath?date=${ks.date}&w=${lon - 0.4}&s=${lat - 0.3}&e=${lon + 0.4}&n=${lat + 0.3}`)).json();
  const grid = new Map((sw.cells || []).map(c => [`${c[0]},${c[1]}`, c[2]]));
  const core = [];
  for (const [k, v] of grid) {
    if (v < need) continue;
    const [la, lo] = k.split(',').map(Number);
    let all = true;
    for (let a = -1; a <= 1 && all; a++) for (let b = -1; b <= 1 && all; b++) if (!((grid.get(`${la + a},${lo + b}`) || 0) >= need)) all = false;
    if (all) core.push({ lat: (la + 0.5) / 100, lon: (lo + 0.5) / 100, inches: v });
  }
  if (!core.length) throw new Error(`no spot near ${lat}, ${lon} got ${need}"+ hail on ${fmt.day(ks.date)}; pick another KNOWN_STORM_DATE`);
  core.sort((p, q) => Math.hypot(p.lat - lat, p.lon - lon) - Math.hypot(q.lat - lat, q.lon - lon));
  for (const c of core.slice(0, 6)) {
    const r = await page.request.get(`${base}/api/reverse-geocode?lat=${c.lat.toFixed(5)}&lon=${c.lon.toFixed(5)}`);
    const j = r.ok() ? await r.json() : null;
    if (j && j.exact && j.address) {
      const out = { date: ks.date, address: j.address, lat: c.lat, lon: c.lon, inches: c.inches, pickedAt: new Date().toISOString(), source: `picked from the ${fmt.day(ks.date)} swath (${c.inches}" at that spot)` };
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(CAL_FILE(), JSON.stringify(out));
      return out;
    }
  }
  throw new Error('could not find a street address at the hail core');
}

/** Close the "Welcome / What's new" popup if it's up, the way a customer would ("Got it"). */
async function dismissPopups(page) {
  const ok = page.locator('.scp-modal-bg [data-ok]');
  try { await ok.waitFor({ state: 'visible', timeout: 4000 }); await ok.click(); await page.locator('.scp-modal-bg').waitFor({ state: 'detached', timeout: 5000 }); } catch { /* no popup */ }
}

function mdY(iso) { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; }

async function readPdfText(buf) {
  const pdfParse = require('pdf-parse');
  const out = await pdfParse(buf);
  return { pages: out.numpages, text: out.text };
}

/**
 * Runs the whole flow once. Returns { [stepId]: { ok, detail|problem, link } }.
 * A failed step stops the steps that depend on it; those are marked skipped.
 */
async function runWorkflow({ browserFactory } = {}) {
  const ks = config.knownStorm;
  const res = {};
  const mark = (id, ok, text, extra = {}) => { res[id] = { ok, ...(ok ? { detail: text } : { problem: text }), ...extra }; };
  const skip = (from, why) => { let on = false; for (const s of STEPS) { if (s.id === from) on = true; if (on && !res[s.id]) res[s.id] = { ok: null, problem: `Skipped: ${why}` }; } };

  if (!config.testEmail || !config.testPassword) {
    for (const s of STEPS) res[s.id] = { ok: null, setup: true, problem: 'Needs the dedicated test account (TEST_EMAIL / TEST_PASSWORD).' };
    return res;
  }

  const { chromium } = require('playwright');
  const browser = browserFactory ? await browserFactory() : await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: 'StormCheckMonitor/1.0 (Playwright)' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(45000);
  const base = config.appUrl;
  try {
    // 1. Sign in through the real form.
    try {
      await page.goto(base + '/login');
      await page.fill('#email', config.testEmail);
      await page.fill('#password', config.testPassword);
      await Promise.all([page.waitForURL(/\/(dashboard|onboarding|admin)/, { timeout: 30000 }), page.click('#loginBtn')]);
      if (/\/admin/.test(page.url())) throw new Error('The test account is an admin. Use a regular customer account so the test matches what customers see.');
      // A brand-new test account lands on onboarding once. Finish it nationwide (no state filter)
      // so the storm list matches NOAA's full list.
      await page.waitForLoadState('domcontentloaded');
      const me = await (await page.request.get(base + '/api/me')).json().catch(() => ({}));
      const u = me.user || me;
      if (/\/onboarding/.test(page.url()) || u.onboardingComplete === false || (Array.isArray(u.watchedStates) && u.watchedStates.length)) {
        const r = await page.request.post(base + '/api/me/states', { data: { states: [] } });
        if (!r.ok()) throw new Error(`could not finish onboarding for the test account (HTTP ${r.status()})`);
      }
      mark('wf.signin', true, 'Signed in through the login form.');
    } catch (e) { mark('wf.signin', false, `Sign-in failed: ${e.message}`, { link: base + '/login' }); skip('wf.search', 'sign-in failed'); return res; }

    // Pick (or reuse) a test address that production data says got hit.
    let addr, picked;
    try { picked = await calibrateAddress(page, base); addr = picked.address; }
    catch (e) { mark('wf.search', null, `Couldn't pick a test address: ${e.message}`, { setup: true }); skip('wf.history', 'no test address'); return res; }

    // 2. Search the known address the way a customer does.
    let report;
    try {
      await page.goto(base + '/dashboard');
      await dismissPopups(page);
      await page.fill('#addressInput', addr);
      const [resp] = await Promise.all([
        page.waitForResponse(r => r.url().includes('/api/lookup') && r.request().method() === 'POST', { timeout: 60000 }),
        page.click('#lookupBtn'),
      ]);
      report = await resp.json();
      if (report.jobId && !report.stormDates) { // legacy slow path while stores load
        for (let i = 0; i < 40 && !(report && report.status === 'done'); i++) {
          await page.waitForTimeout(3000);
          report = await (await page.request.get(`${base}/api/lookup/${report.jobId}`)).json();
        }
      }
      if (resp.status() !== 200 || !report || report.error) throw new Error(report && report.error ? report.error : `HTTP ${resp.status()}`);
      await page.waitForSelector('#resultsSection', { state: 'visible', timeout: 30000 });
      mark('wf.search', true, `Found "${report.address}" (${picked.source}).`);
    } catch (e) { mark('wf.search', false, `Searching "${addr}" failed: ${e.message}`, { link: `${base}/dashboard?address=${encodeURIComponent(addr)}` }); skip('wf.history', 'address search failed'); return res; }

    // 3. Property history includes the known storm.
    const lookupLink = `${base}/dashboard?address=${encodeURIComponent(addr)}`;
    const day = (report.stormDates || []).find(s => s.date === ks.date);
    if (!day) mark('wf.history', false, `Property history for ${addr} no longer lists the known storm on ${fmt.day(ks.date)}. Customers would miss that date of loss.`, { link: lookupLink });
    else if (day.bestEstimateIn < ks.minInches) { if (!ks.addressFixed) forgetAddress(); mark('wf.history', false, `The ${fmt.day(ks.date)} storm now shows ${day.bestEstimateIn}" at the property, below the expected ${ks.minInches}".`, { link: lookupLink }); }
    else mark('wf.history', true, `${fmt.day(ks.date)} listed: ${day.bestEstimateIn}" (${day.confidence}). ${(report.stormDates || []).length} storm days total.`, { measure: { bestEstimateIn: day.bestEstimateIn, stormDays: report.stormDates.length } });

    // 4. Hail swath for the storm day on the hail map.
    const mapLink = `${base}/hailmap?date=${ks.date}&lat=${report.lat}&lon=${report.lon}`;
    try {
      const [sw] = await Promise.all([
        page.waitForResponse(r => r.url().includes('/api/mesh/swath') && r.url().includes(ks.date), { timeout: 45000 }),
        page.goto(mapLink),
      ]);
      await dismissPopups(page);
      const j = await sw.json();
      if (sw.status() !== 200) throw new Error(j.error || `HTTP ${sw.status()}`);
      if (!j.cells || !j.cells.length) throw new Error(`the swath for ${fmt.day(ks.date)} came back empty`);
      if (!(j.maxIn >= ks.minInches)) throw new Error(`max hail in view is ${j.maxIn}", expected at least ${ks.minInches}"`);
      mark('wf.swath', true, `${j.cells.length.toLocaleString()} hail cells, max ${j.maxIn}".`, { measure: { cells: j.cells.length, maxIn: j.maxIn } });
    } catch (e) { mark('wf.swath', false, `Hail swath for ${fmt.day(ks.date)} didn't load: ${e.message}`, { link: mapLink }); }

    // 5. Radar playback: load frames, show two different ones.
    try {
      const [fr] = await Promise.all([
        page.waitForResponse(r => r.url().includes('/api/mesh/frames'), { timeout: 120000 }),
        page.click('#playBtn'),
      ]);
      const j = await fr.json();
      if (fr.status() !== 200) throw new Error(j.error || `HTTP ${fr.status()}`);
      const withHail = (j.frames || []).map((f, i) => ({ i, n: f.cells.length, time: f.time })).filter(f => f.n > 0);
      if (withHail.length < 2) throw new Error(`only ${withHail.length} frame(s) with hail in view`);
      const a = withHail[0], b = withHail[withHail.length - 1];
      await page.waitForFunction(() => !document.getElementById('frameSlider').disabled, null, { timeout: 15000 });
      await page.evaluate(() => { const btn = document.getElementById('playBtn'); if (btn && /stop|pause/i.test(btn.textContent)) btn.click(); });
      await page.evaluate(i => window.showFrame ? window.showFrame(i) : document.getElementById('frameSlider').dispatchEvent(new Event('input')), a.i);
      const labelA = await page.textContent('#frameLabel');
      await page.evaluate(i => window.showFrame(i), b.i);
      const labelB = await page.textContent('#frameLabel');
      if (!labelA || labelA === labelB) throw new Error('the frame label did not change between frames');
      mark('wf.playback', true, `${j.frames.length} frames; showed ${fmt.time(a.time)} and ${fmt.time(b.time)}.`, { measure: { frames: j.frames.length, withHail: withHail.length } });
    } catch (e) { mark('wf.playback', false, `Radar playback for ${fmt.day(ks.date)} failed: ${e.message}`, { link: mapLink }); }

    // 6. PDF: same button customers use, then read the PDF back.
    try {
      await page.goto(lookupLink);
      await dismissPopups(page);
      await page.waitForSelector('#resultsSection', { state: 'visible', timeout: 60000 });
      const [popup] = await Promise.all([ctx.waitForEvent('page'), page.click('text=Print / Save as PDF')]);
      await popup.waitForLoadState('networkidle');
      await popup.waitForFunction(() => document.body && document.body.innerText.length > 200, null, { timeout: 30000 });
      const buf = await popup.pdf({ format: 'Letter', printBackground: true });
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(path.join(config.dataDir, 'last-report.pdf'), buf);
      const pdf = await readPdfText(buf);
      const text = pdf.text.replace(/\s+/g, ' ');
      const street = String(report.address || addr).split(',')[0].trim(); // the address StormCheck matched, as customers see it
      const missing = [];
      if (!new RegExp(street.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text)) missing.push(`the address "${street}"`);
      // The report lists dates of loss plus at most 60 storm dates (newest first). Check the
      // known storm when the report promises to include it; otherwise check the newest date of loss.
      const sdAll = report.stormDates || [];
      const listed = new Set([...(report.dateOfLoss || []).map(d => d.date), ...sdAll.filter(d => d.radar || (d.groundReports && d.groundReports.hailCount)).slice(0, 60).map(d => d.date)]);
      const checkDate = listed.has(ks.date) ? ks.date : ((report.dateOfLoss || [])[0] || {}).date;
      if (checkDate && !text.includes(mdY(checkDate))) missing.push(`the storm date ${mdY(checkDate)}`);
      const capNote = listed.has(ks.date) ? '' : ` The report's storm-date table stops at 60 rows, so ${mdY(ks.date)} isn't listed; checked ${checkDate ? mdY(checkDate) : 'no date'} instead.`;
      if (missing.length) throw new Error(`the PDF opened (${pdf.pages} page${pdf.pages === 1 ? '' : 's'}) but is missing ${missing.join(' and ')}`);
      mark('wf.pdf', true, `PDF opened: ${pdf.pages} page(s), ${Math.round(buf.length / 1024)} KB, has the address and ${checkDate ? mdY(checkDate) : 'no dated storms'}.${capNote}`, { measure: { pages: pdf.pages, kb: Math.round(buf.length / 1024) } });
      await popup.close();
    } catch (e) { mark('wf.pdf', false, `PDF report failed: ${e.message}`, { link: lookupLink }); }
    return res;
  } finally { await browser.close().catch(() => {}); }
}

module.exports = { STEPS, runWorkflow, readPdfText, cachedAddress };
