/**
 * Storm recap emails.
 *
 * After a radar day posts, prospects (an imported email list of roofers,
 * adjusters, etc.) whose area was hit get a short recap: a swath map image,
 * the hardest-hit cities, the largest hail, the radar hail algorithm's severe
 * probability and a link to start a free trial. Free alert subscribers get the
 * same recap for their own ZIP and radius (see alerts.checkFreeSubscribers).
 *
 * Commercial email rules (CAN-SPAM): every recap carries the business postal
 * address, a one-click unsubscribe link and List-Unsubscribe headers, and
 * nothing is sent until an address is set. Unsubscribes are permanent.
 *
 * Settings live in dataPath('recap-settings.json') and are edited from the
 * admin page. Auto-send is OFF until turned on there.
 */
const fs = require('fs');
const { dataPath } = require('./paths');
const mesh = require('./mesh-store');
const spc = require('./spc-store');
const hailsig = require('./hailsig-store');
const places = require('./places');
const geo = require('./geo');
const { sizeName } = require('./hail-scale');
const { LEGEND, W: IMG_W, H: IMG_H } = require('./storm-image');
const { sendMail, baseUrl, escapeHtml: esc } = require('./mailer');

const DEFAULTS = { enabled: false, minIn: 1.25, radiusMi: 50, minDaysBetween: 3, dailyCap: 400, address: '' };
const SETTINGS = () => dataPath('recap-settings.json');
const LOG = () => dataPath('recap-log.json');

function settings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS(), 'utf8')); } catch { s = {}; }
  return { ...DEFAULTS, ...s };
}
function saveSettings(patch) {
  const cur = settings();
  const num = (v, lo, hi, d) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const next = {
    enabled: patch.enabled != null ? !!patch.enabled : cur.enabled,
    minIn: patch.minIn != null ? num(patch.minIn, 0.75, 3, cur.minIn) : cur.minIn,
    radiusMi: patch.radiusMi != null ? Math.round(num(patch.radiusMi, 10, 150, cur.radiusMi)) : cur.radiusMi,
    minDaysBetween: patch.minDaysBetween != null ? Math.round(num(patch.minDaysBetween, 1, 30, cur.minDaysBetween)) : cur.minDaysBetween,
    dailyCap: patch.dailyCap != null ? Math.round(num(patch.dailyCap, 1, 5000, cur.dailyCap)) : cur.dailyCap,
    address: patch.address != null ? String(patch.address).replace(/\s+/g, ' ').trim().slice(0, 200) : cur.address,
  };
  fs.writeFileSync(SETTINGS(), JSON.stringify(next));
  return next;
}
/** Postal address for the email footer: admin setting, else BUSINESS_ADDRESS. */
const businessAddress = () => settings().address || String(process.env.BUSINESS_ADDRESS || '').trim();

function logRun(entry) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(LOG(), 'utf8')); } catch { list = []; }
  list.unshift({ ...entry, at: new Date().toISOString() });
  fs.writeFileSync(LOG(), JSON.stringify(list.slice(0, 100)));
}
function recentRuns() { try { return JSON.parse(fs.readFileSync(LOG(), 'utf8')); } catch { return []; } }

const fmtDate = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
const fmtShort = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const inch = v => `${Number(v).toFixed(2)}"`;

// ── What hit the area ────────────────────────────────────────────────────────
/**
 * Hail within `radiusMi` of a point on `date`, or null if nothing reached minIn.
 * { maxIn, nearestMi, cities: [{name, state, lat, lon, maxIn, sevProb}], cellCount,
 *   groundHail, sig: {maxSevProb, count} | null, bbox: [w, s, e, n] }
 */
function areaSummary(date, lat, lon, radiusMi, minIn) {
  const dLat = radiusMi / 69, dLon = radiusMi / (69 * Math.cos(lat * Math.PI / 180));
  let nearest = Infinity, maxIn = 0;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const cells = [];
  for (const c of mesh.cellsForDay(date, lon - dLon, lat - dLat, lon + dLon, lat + dLat)) {
    if (c[2] < minIn) continue;
    const cl = (c[0] + 0.5) / 100, co = (c[1] + 0.5) / 100;
    const d = geo.distanceMiles(lat, lon, cl, co);
    if (d > radiusMi) continue;
    cells.push(c);
    if (d < nearest) nearest = d;
    if (c[2] > maxIn) maxIn = c[2];
    w = Math.min(w, co); e = Math.max(e, co); s = Math.min(s, cl); n = Math.max(n, cl);
  }
  if (!cells.length) return null;
  const { cities } = places.affectedBy(cells, { minIn });
  // Closest places first: the recipient cares about their own area.
  for (const c of cities) c.distMi = geo.distanceMiles(lat, lon, c.lat, c.lon);
  const top = [...cities].sort((x, y) => x.distMi - y.distMi).slice(0, 8);
  const probs = hailsig.maxProbNear(date, top, 5);
  top.forEach((c, i) => { c.sevProb = probs ? probs[i] : null; });
  const sig = hailsig.nearPoint(date, lat, lon, radiusMi, { minProb: 50 });
  const groundHail = spc.eventsNear(lat, lon, radiusMi, { sinceDate: date })
    .filter(ev => ev.date === date && ev.type === 'hail' && (ev.mag || 0) >= 0.75).length;
  // Map: the swath plus the subscriber's location, at least ~0.6° across.
  w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat);
  const padX = Math.max(0.15, (0.6 - (e - w)) / 2), padY = Math.max(0.12, (0.35 - (n - s)) / 2);
  const bbox = [w - padX, s - padY, e + padX, n + padY].map(v => Math.round(v * 100) / 100);
  return {
    maxIn, nearestMi: Math.round(nearest * 10) / 10, cities: top, cityCount: cities.length,
    cellCount: cells.length, groundHail, sig: sig ? { maxSevProb: sig.maxSevProb, count: sig.count } : null, bbox,
  };
}

// ── Email ────────────────────────────────────────────────────────────────────
function cityList(cities, total) {
  const names = cities.slice(0, 2).map(c => c.name);
  if (!names.length) return 'your area';
  const more = total - names.length;
  return more > 0 ? `${names.join(', ')} and ${more} more` : names.join(' and ');
}

/**
 * Build a recap for one recipient location. Returns null when nothing hit.
 * opts: { label, radiusMi, minIn, audience: 'prospect' | 'free', unsubUrl, firstName }
 */
function buildRecap(date, lat, lon, opts) {
  const { label = 'your area', radiusMi = 50, minIn = 1, audience = 'prospect', unsubUrl, firstName } = opts;
  const a = areaSummary(date, lat, lon, radiusMi, minIn);
  if (!a) return null;
  const base = baseUrl();
  const utm = `utm_source=${audience === 'free' ? 'free-alerts' : 'storm-recap'}&utm_medium=email&utm_campaign=recap-${date}`;
  const img = `${base}/storm-images/${date}.png?b=${a.bbox.join(',')}&c=${lat.toFixed(2)},${lon.toFixed(2)}`;
  const mapUrl = `${base}/hail-maps/${date}?${utm}`;
  const trialUrl = `${base}/register?${utm}&utm_content=cta`;
  const where = cityList(a.cities, a.cityCount);
  const subject = `Hail hit ${where} ${fmtShort(date)}: up to ${inch(a.maxIn)}`;

  const stat = (big, small) => `<td style="padding:10px 8px;text-align:center;border:1px solid #e1e6ed;width:25%"><div style="font-size:20px;font-weight:800;color:#172235">${big}</div><div style="font-size:12px;color:#5b6a80;margin-top:2px">${small}</div></td>`;
  const probCol = a.cities.some(c => c.sevProb != null);
  const rows = a.cities.map(c => `<tr>
      <td style="padding:7px 8px;border-bottom:1px solid #eef1f5">${esc(c.name)}, ${esc(c.state)}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #eef1f5;font-weight:700">${inch(c.maxIn)} <span style="font-weight:400;color:#5b6a80">${esc(sizeName(c.maxIn))}</span></td>
      ${probCol ? `<td style="padding:7px 8px;border-bottom:1px solid #eef1f5">${c.sevProb ? c.sevProb + '%' : '—'}</td>` : ''}
    </tr>`).join('');
  const legend = LEGEND.map(l => `<span style="display:inline-block;margin:0 6px 4px 0;font-size:11px;color:#5b6a80"><span style="display:inline-block;width:10px;height:10px;background:${l.color};vertical-align:-1px;margin-right:3px"></span>${l.label}</span>`).join('');
  const address = businessAddress();
  const why = audience === 'free'
    ? `You signed up for free hail alerts for ${esc(label)} at StormCheck Pro.`
    : `You're receiving this storm recap because you work in storm restoration, insurance or real estate near ${esc(label)}.`;

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#172235">
  <div style="background:#172235;color:#fff;padding:16px 22px;border-radius:8px 8px 0 0">
    <div style="font-weight:800;font-size:17px">StormCheck Pro</div>
    <div style="font-size:14px;opacity:.85;margin-top:3px">Storm recap · ${fmtDate(date)}</div>
  </div>
  <div style="padding:22px;background:#fff;border:1px solid #e1e6ed;border-top:none">
    <p style="margin:0 0 14px;font-size:16px">${firstName ? `${esc(firstName)}, h` : 'H'}ail up to <strong>${inch(a.maxIn)} (${esc(sizeName(a.maxIn))})</strong> fell within ${radiusMi} miles of ${esc(label)} on ${fmtDate(date)}.</p>
    <a href="${mapUrl}"><img src="${img}" width="${IMG_W}" height="${IMG_H}" alt="Radar hail swath map for ${fmtShort(date)}" style="display:block;width:100%;max-width:${IMG_W}px;height:auto;border-radius:6px;border:1px solid #e1e6ed"></a>
    <div style="margin-top:6px">${legend}<span style="font-size:11px;color:#94a3b8">Blue dot: ${esc(label)}. Map © OpenStreetMap contributors.</span></div>
    <table role="presentation" style="width:100%;border-collapse:collapse;margin:16px 0"><tr>
      ${stat(inch(a.maxIn), 'Largest hail')}
      ${stat(a.cityCount, `Cit${a.cityCount === 1 ? 'y' : 'ies'} hit`)}
      ${stat(`${a.nearestMi} mi`, 'Closest to you')}
      ${a.sig && a.sig.maxSevProb ? stat(`${a.sig.maxSevProb}%`, 'Severe hail probability') : stat(a.groundHail, 'Ground hail reports')}
    </tr></table>
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px">
      <tr style="text-align:left;color:#5b6a80;font-size:12px"><th style="padding:6px 8px">Closest areas hit</th><th style="padding:6px 8px">Radar hail size</th>${probCol ? '<th style="padding:6px 8px">Severe hail probability</th>' : ''}</tr>
      ${rows}
    </table>
    <p style="margin:22px 0 8px"><a href="${trialUrl}" style="background:#F2A93B;color:#172235;padding:13px 22px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">Check any address free</a>
      &nbsp; <a href="${mapUrl}" style="color:#172235">See the full storm map</a></p>
    <p style="color:#5b6a80;font-size:13px;margin:12px 0 0">StormCheck Pro shows hail, wind and tornado history for any U.S. address, with portfolio alerts, lead lists and CRM sync for JobNimbus, AccuLynx and ClaimWizard.</p>
    <p style="color:#94a3b8;font-size:12px;margin:10px 0 0">Sizes are NOAA MRMS radar estimates. Severe hail probability is the National Weather Service radar hail algorithm's chance of 1"+ hail. What fell at a specific roof can differ.</p>
  </div>
  <div style="padding:12px 22px;font-size:12px;color:#5b6a80;line-height:1.5">${why}<br>StormCheck Pro${address ? ` · ${esc(address)}` : ''}<br><a href="${unsubUrl}" style="color:#5b6a80">Unsubscribe</a></div>
</div>`;

  const text = [
    `Storm recap: ${fmtDate(date)}`,
    `Hail up to ${inch(a.maxIn)} (${sizeName(a.maxIn)}) fell within ${radiusMi} miles of ${label}.`,
    `Closest hail: ${a.nearestMi} mi. Cities hit: ${a.cityCount}.${a.sig && a.sig.maxSevProb ? ` Severe hail probability: ${a.sig.maxSevProb}%.` : ''}`,
    '', 'Closest areas hit:',
    ...a.cities.map(c => `- ${c.name}, ${c.state}: ${inch(c.maxIn)}${c.sevProb ? ` (${c.sevProb}% severe)` : ''}`),
    '', `Storm map: ${mapUrl}`, `Check any address free: ${trialUrl}`, '',
    why.replace(/<[^>]+>/g, ''), `StormCheck Pro${address ? ` · ${address}` : ''}`, `Unsubscribe: ${unsubUrl}`,
  ].join('\n');

  return { subject, html, text, summary: a };
}

const unsubHeaders = url => ({ 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
const prospectUnsub = token => `${baseUrl()}/recap/unsubscribe?t=${token}`;

// ── Sending ──────────────────────────────────────────────────────────────────
function daysSince(iso) { return iso ? (Date.now() - Date.parse(iso)) / 86400000 : Infinity; }

/**
 * Send the recap for `date` to every active prospect whose area was hit.
 * opts.manual: sent from the admin page (allowed for any date, ignores `enabled`).
 */
let running = false;
async function sendForDate(date, db, { manual = false, dryRun = false } = {}) {
  const cfg = settings();
  if (!manual && !cfg.enabled) return { skipped: 'auto-send is off' };
  if (!businessAddress()) return { skipped: 'no business mailing address set' };
  if (!mesh.hasDay(date)) return { skipped: 'radar for that day is not loaded' };
  if (running) return { skipped: 'already sending' };
  running = true;
  const { prospectOps, userOps } = db;
  let sent = 0, hit = 0, recent = 0, failed = 0;
  try {
    const customers = new Set((await userOps.getAll()).map(u => String(u.email || '').toLowerCase()));
    const list = (await prospectOps.getActive()).filter(p => p.lat != null && p.lon != null && !customers.has(p.email));
    const built = new Map(); // same rounded location -> same recap
    for (const p of list) {
      if (sent >= cfg.dailyCap) break;
      if (p.lastRecapDate === date) continue;
      if (daysSince(p.lastRecapAt) < cfg.minDaysBetween) { recent++; continue; }
      const k = `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;
      if (!built.has(k)) {
        built.set(k, areaSummary(date, p.lat, p.lon, cfg.radiusMi, cfg.minIn) ? true : false);
        await new Promise(r => setImmediate(r));
      }
      if (!built.get(k)) continue;
      hit++;
      if (dryRun) continue;
      const unsub = prospectUnsub(p.token);
      const recap = buildRecap(date, p.lat, p.lon, { label: p.label, radiusMi: cfg.radiusMi, minIn: cfg.minIn, audience: 'prospect', unsubUrl: unsub, firstName: p.firstName });
      if (!recap) continue;
      const ok = await sendMail({ to: p.email, subject: recap.subject, html: recap.html, text: recap.text, headers: unsubHeaders(unsub) });
      if (ok) { sent++; await prospectOps.markSent(p._id, date); } else failed++;
      await new Promise(r => setTimeout(r, 600)); // stay under the email provider's rate limit
    }
  } finally { running = false; }
  const res = { date, sent, inArea: hit, skippedRecent: recent, failed, manual, dryRun };
  if (!dryRun) logRun(res);
  return res;
}

/** Called after each new radar day. Only recent days, so backfills never email anyone. */
async function autoSend(date, db) {
  if (!db || !db.prospectOps) return null;
  const ageDays = (Date.now() - Date.parse(date + 'T12:00:00Z')) / 86400000;
  if (ageDays > 3) return { skipped: 'old day' };
  return sendForDate(date, db);
}

/** Parse an uploaded prospect CSV (email required; name, company, zip or city+state). */
function parseProspects(rows) {
  if (!rows.length) return { prospects: [], errors: ['The file is empty.'] };
  const head = rows[0].map(h => String(h).trim().toLowerCase());
  const col = (...names) => head.findIndex(h => names.includes(h));
  const iEmail = col('email', 'email address', 'e-mail');
  if (iEmail < 0) return { prospects: [], errors: ['Add an "email" column.'] };
  const iName = col('name', 'full name', 'contact', 'contact name', 'first name');
  const iCompany = col('company', 'company name', 'business');
  const iZip = col('zip', 'zip code', 'zipcode', 'postal code');
  const iCity = col('city'), iState = col('state', 'st');
  const out = [], errors = [];
  const seen = new Set();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const email = String(row[iEmail] || '').trim().toLowerCase();
    if (!email) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errors.push(`Row ${r + 1}: "${email}" is not a valid email`); continue; }
    if (seen.has(email)) continue;
    seen.add(email);
    let loc = null;
    const zip = iZip >= 0 ? String(row[iZip] || '').trim().slice(0, 5).padStart(5, '0') : '';
    if (/^\d{5}$/.test(zip) && zip !== '00000') {
      const z = places.zipInfo(zip);
      if (z) loc = { lat: z.lat, lon: z.lon, label: `${z.city}, ${z.state}`, zip };
    }
    if (!loc && iCity >= 0 && iState >= 0) {
      const st = String(row[iState] || '').trim().toUpperCase();
      const c = places.findCity(st, places.slugify(String(row[iCity] || '').trim()));
      if (c) loc = { lat: c.lat, lon: c.lon, label: `${c.name}, ${c.state}`, zip: null };
    }
    if (!loc) { errors.push(`Row ${r + 1}: ${email} has no usable ZIP or city/state`); continue; }
    const name = iName >= 0 ? String(row[iName] || '').trim().slice(0, 80) : '';
    out.push({
      email, name, firstName: name ? name.split(/\s+/)[0] : '',
      company: iCompany >= 0 ? String(row[iCompany] || '').trim().slice(0, 100) : '',
      ...loc, source: 'import',
    });
  }
  return { prospects: out, errors };
}

module.exports = {
  settings, saveSettings, businessAddress, buildRecap, areaSummary, sendForDate, autoSend,
  parseProspects, recentRuns, unsubHeaders, prospectUnsub, DEFAULTS,
};
