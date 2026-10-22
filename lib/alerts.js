/**
 * Customer alerts:
 *   1. Portfolio  — a monitored property was hit (radar at the property or a
 *                   ground report within a mile). Runs after each radar day and
 *                   on every SPC refresh.
 *   2. Territory  — hail in one of the user's alert regions (circles drawn on
 *                   the Alert Settings page).
 *   3. Free alerts — public subscribers, daily radar digest for their area.
 *   4. Warnings   — NWS Severe Thunderstorm / Tornado Warnings with forecast hail
 *                   that cover a user's properties or regions: a heads-up
 *                   before the storm arrives (paid plans with `predictive`).
 */
const fs = require('fs');
const axios = require('axios');
const { dataPath } = require('./paths');
const mesh = require('./mesh-store');
const spc = require('./spc-store');
const places = require('./places');
const geo = require('./geo');
const { sizeName } = require('./hail-scale');
const { sendMail, layout, baseUrl, escapeHtml } = require('./mailer');

// ── Sent-alert ledger (prevents duplicates across restarts) ─────────────────
const LEDGER = () => dataPath('alerts-sent.json');
let ledger = null;
function sent(key) {
  if (!ledger) { try { ledger = JSON.parse(fs.readFileSync(LEDGER(), 'utf8')); } catch { ledger = {}; } }
  return !!ledger[key];
}
function markSent(key) {
  sent(key);
  ledger[key] = Date.now();
  const cutoff = Date.now() - 45 * 86400000;
  for (const [k, t] of Object.entries(ledger)) if (t < cutoff) delete ledger[k];
  fs.writeFileSync(LEDGER(), JSON.stringify(ledger));
}

const fmtDate = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
const inch = v => `${Number(v).toFixed(2)}"`;

// ── 1. Portfolio ─────────────────────────────────────────────────────────────
async function checkPortfolio(date, db) {
  const { watchlistOps, userOps, alertSettingsOps } = db;
  const contacts = await watchlistOps.getAllWithCoords();
  const byUser = new Map();
  const radarAt = mesh.hailAtForDay(date);
  let n = 0;
  for (const c of contacts) {
    if (++n % 500 === 0) await new Promise(r => setImmediate(r)); // keep the server responsive
    if (c.lat == null || c.lon == null) continue;
    const key = `pf:${c._id}:${date}`;
    if (sent(key)) continue;

    const ground = spc.eventsNear(c.lat, c.lon, 1.5, { sinceDate: date }).filter(e => e.date === date);
    const groundHail = ground.filter(e => e.type === 'hail').reduce((m, e) => Math.max(m, e.mag || 0), 0);
    const tornado = ground.find(e => e.type === 'tornado' && e.distance_miles <= 1);
    const radarIn = radarAt(c.lat, c.lon);
    const best = Math.max(radarIn, groundHail);
    if (!byUser.has(c.userId)) {
      const s = await alertSettingsOps.get(c.userId);
      byUser.set(c.userId, { min: parseFloat(s.minHailSize) || 1.0, email: s.alertEmail !== false, hits: [] });
    }
    const u = byUser.get(c.userId);
    if (best >= u.min || tornado) {
      u.hits.push({ c, best, radarIn, groundHail, tornado: !!tornado, key });
    }
  }

  let emails = 0;
  for (const [userId, u] of byUser) {
    if (!u.hits.length) continue;
    for (const h of u.hits) {
      await watchlistOps.markAlerted(h.c._id, date);
      await watchlistOps.updateContact(h.c._id, { lastHitSizeIn: h.best });
      markSent(h.key);
    }
    if (!u.email) continue;
    const user = await userOps.findById(userId);
    if (!user || !user.email) continue;
    const rows = u.hits.sort((a, b) => b.best - a.best).map(h => `<tr>
      <td style="padding:8px;border-bottom:1px solid #eee"><strong>${escapeHtml(h.c.name)}</strong><br><span style="color:#5b6a80">${escapeHtml(h.c.formattedAddress || h.c.address)}</span></td>
      <td style="padding:8px;border-bottom:1px solid #eee">${h.tornado ? 'Tornado within 1 mi' : `${inch(h.best)} ${sizeName(h.best)}`}</td>
      <td style="padding:8px;border-bottom:1px solid #eee">${h.radarIn >= 0.5 && h.groundHail >= 0.5 ? 'Radar + ground report' : h.radarIn >= 0.5 ? 'Radar' : 'Ground report'}</td>
    </tr>`).join('');
    await sendMail({
      to: user.email,
      subject: `${u.hits.length} of your properties hit by hail on ${fmtDate(date)}`,
      html: layout(`Portfolio alert: ${fmtDate(date)}`, `
        <p>Storms on <strong>${fmtDate(date)}</strong> hit ${u.hits.length} propert${u.hits.length === 1 ? 'y' : 'ies'} you monitor.</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr style="text-align:left;color:#5b6a80"><th style="padding:8px">Property</th><th style="padding:8px">Hail</th><th style="padding:8px">Source</th></tr>${rows}
        </table>
        <p style="margin-top:20px"><a href="${baseUrl()}/watchlist" style="background:#172235;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Open your portfolio</a></p>`),
    });
    emails++;
  }
  return { emails };
}

// ── 2. Territory regions ────────────────────────────────────────────────────
async function checkRegions(date, db) {
  const { userOps, alertSettingsOps } = db;
  const users = await userOps.getAll();
  let emails = 0;
  for (const user of users) {
    if (['suspended', 'trial'].includes(user.tier)) continue;
    const s = await alertSettingsOps.get(user._id);
    if (!s.regions || !s.regions.length || s.alertEmail === false || s.alertHail === false) continue;
    const min = parseFloat(s.minHailSize) || 1.0;
    const hits = [];
    for (const r of s.regions) {
      const key = `rg:${user._id}:${r.lat},${r.lon}:${date}`;
      if (sent(key)) continue;
      const dLat = r.radius / 69, dLon = r.radius / (69 * Math.cos(r.lat * Math.PI / 180));
      const cells = mesh.cellsForDay(date, r.lon - dLon, r.lat - dLat, r.lon + dLon, r.lat + dLat)
        .filter(([la, lo, v]) => v >= min && geo.distanceMiles(r.lat, r.lon, (la + 0.5) / 100, (lo + 0.5) / 100) <= r.radius);
      if (!cells.length) continue;
      const maxIn = cells.reduce((m, c) => Math.max(m, c[2]), 0);
      const { cities } = places.affectedBy(cells, { minIn: min });
      hits.push({ r, maxIn, cities: cities.slice(0, 8), key });
    }
    if (!hits.length) continue;
    hits.forEach(h => markSent(h.key));
    const body = hits.map(h => `<p><strong>${escapeHtml(h.r.name)}</strong>: radar estimated up to <strong>${inch(h.maxIn)} (${sizeName(h.maxIn)})</strong>${h.cities.length ? `. Areas hit: ${h.cities.map(c => escapeHtml(c.name)).join(', ')}` : ''}.</p>`).join('');
    await sendMail({
      to: user.email,
      subject: `Hail in your territory: up to ${inch(Math.max(...hits.map(h => h.maxIn)))} on ${fmtDate(date)}`,
      html: layout(`Territory alert: ${fmtDate(date)}`, `${body}
        <p><a href="${baseUrl()}/hailmap?date=${date}" style="background:#172235;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">View the hail swath</a>
        &nbsp; <a href="${baseUrl()}/leads?date=${date}">Build a lead list</a></p>`),
    });
    emails++;
  }
  return { emails };
}

// ── 3. Free alert subscribers ───────────────────────────────────────────────
async function checkFreeSubscribers(date, freeAlertOps) {
  const subs = await freeAlertOps.getActive();
  let emails = 0;
  for (const s of subs) {
    const key = `fa:${s._id}:${date}`;
    if (sent(key)) continue;
    const r = s.radiusMi || 15;
    const dLat = r / 69, dLon = r / (69 * Math.cos(s.lat * Math.PI / 180));
    const cells = mesh.cellsForDay(date, s.lon - dLon, s.lat - dLat, s.lon + dLon, s.lat + dLat)
      .filter(([la, lo, v]) => v >= (s.minIn || 1) && geo.distanceMiles(s.lat, s.lon, (la + 0.5) / 100, (lo + 0.5) / 100) <= r);
    if (!cells.length) continue;
    markSent(key);
    const maxIn = cells.reduce((m, c) => Math.max(m, c[2]), 0);
    const { cities } = places.affectedBy(cells, { minIn: s.minIn || 1 });
    const unsub = `${baseUrl()}/alerts/unsubscribe?token=${s.token}`;
    await sendMail({
      to: s.email,
      subject: `Hail near ${s.label}: up to ${inch(maxIn)} on ${fmtDate(date)}`,
      html: layout(`Free hail alert: ${fmtDate(date)}`, `
        <p>NOAA radar estimated hail up to <strong>${inch(maxIn)} (${sizeName(maxIn)})</strong> within ${r} miles of ${escapeHtml(s.label)}.</p>
        ${cities.length ? `<p>Areas hit: ${cities.slice(0, 10).map(c => `${escapeHtml(c.name)} (${inch(c.maxIn)})`).join(', ')}</p>` : ''}
        <p><a href="${baseUrl()}/hail-maps/${date}" style="background:#172235;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">See the storm map</a></p>
        <p style="color:#5b6a80">Want to know if a specific address was hit? <a href="${baseUrl()}/register">Run a free property report</a>.</p>`,
      { footer: `You signed up for free hail alerts at StormCheck Pro. <a href="${unsub}">Unsubscribe</a>.` }),
    });
    emails++;
  }
  return { emails };
}

// ── 4. NWS warnings (heads-up before hail arrives) ──────────────────────────
function pointInPolygon(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function polygonRings(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates[0]];
  if (geom.type === 'MultiPolygon') return geom.coordinates.map(p => p[0]);
  return [];
}
function circleTouchesRings(lat, lon, radiusMi, rings) {
  for (const ring of rings) {
    if (pointInPolygon(lat, lon, ring)) return true;
    if (ring.some(([x, y]) => geo.distanceMiles(lat, lon, y, x) <= radiusMi)) return true;
  }
  return false;
}

async function fetchWarnings() {
  const r = await axios.get('https://api.weather.gov/alerts/active', {
    params: { event: 'Severe Thunderstorm Warning,Tornado Warning', status: 'actual' },
    headers: { 'User-Agent': 'StormCheckPro/2.0 (stormcheckpro.thepublicadjustertx.com)', Accept: 'application/geo+json' },
    timeout: 15000,
  });
  return (r.data.features || []).map(f => {
    const p = f.properties || {};
    const prm = p.parameters || {};
    return {
      id: p.id, event: p.event, headline: p.headline, areaDesc: p.areaDesc,
      expires: p.expires, rings: polygonRings(f.geometry),
      maxHailIn: parseFloat((prm.maxHailSize || [])[0]) || 0,
      maxWindMph: parseFloat(String((prm.maxWindGust || [])[0] || '').replace(/[^0-9.]/g, '')) || 0,
    };
  }).filter(w => w.rings.length);
}

async function checkWarnings(db, tierFeatures) {
  const { userOps, alertSettingsOps, watchlistOps } = db;
  let warnings;
  try { warnings = await fetchWarnings(); } catch { return { emails: 0 }; }
  warnings = warnings.filter(w => w.maxHailIn >= 1 || w.event === 'Tornado Warning');
  if (!warnings.length) return { emails: 0 };
  const users = (await userOps.getAll()).filter(u => tierFeatures(u.tier).predictive);
  let emails = 0;
  for (const user of users) {
    const s = await alertSettingsOps.get(user._id);
    if (s.alertEmail === false) continue;
    const contacts = (await watchlistOps.getForUser(user._id)).filter(c => c.lat != null);
    const lines = [];
    for (const w of warnings) {
      const key = `wn:${user._id}:${w.id}`;
      if (sent(key)) continue;
      const inside = contacts.filter(c => circleTouchesRings(c.lat, c.lon, 0, w.rings));
      const regions = (s.regions || []).filter(r => circleTouchesRings(r.lat, r.lon, r.radius, w.rings));
      if (!inside.length && !regions.length) continue;
      markSent(key);
      lines.push(`<p><strong>${escapeHtml(w.event)}</strong>${w.maxHailIn ? `: hail up to <strong>${inch(w.maxHailIn)}</strong>` : ''}${w.maxWindMph ? `, gusts to ${w.maxWindMph} mph` : ''}<br>
        <span style="color:#5b6a80">${escapeHtml(w.areaDesc)} · until ${new Date(w.expires).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}</span><br>
        ${inside.length ? `Properties in the warning: ${inside.slice(0, 15).map(c => escapeHtml(c.name)).join(', ')}${inside.length > 15 ? ` and ${inside.length - 15} more` : ''}<br>` : ''}
        ${regions.length ? `Territories: ${regions.map(r => escapeHtml(r.name)).join(', ')}` : ''}</p>`);
    }
    if (!lines.length) continue;
    await sendMail({
      to: user.email,
      subject: 'Hail warning issued for your properties',
      html: layout('Storm heads-up from the National Weather Service', lines.join('') +
        '<p style="color:#5b6a80">Warnings are forecasts. Check the radar swath after the storm to confirm what fell.</p>'),
    });
    emails++;
  }
  return { emails };
}

module.exports = { checkPortfolio, checkRegions, checkFreeSubscribers, checkWarnings, fetchWarnings, _pointInPolygon: pointInPolygon };
