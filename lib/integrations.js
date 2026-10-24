/**
 * CRM integrations.
 *
 *   JobNimbus  — imports contacts (with property addresses) into Portfolio and
 *                writes a note on the contact when it's hit by hail.
 *   AccuLynx   — imports jobs (job location address) into Portfolio and posts a
 *                job message when the property is hit.
 *   Webhook    — any other CRM (ClaimWizard, HubSpot, SPOTIO, ...) via Zapier,
 *                Make, or a custom endpoint: sends one JSON event per hit, and
 *                an inbound URL adds properties to Portfolio.
 *
 * Imported properties are ordinary Portfolio entries tagged with `source` and
 * `externalId`, so they get the same radar checks and email alerts.
 */
const crypto = require('crypto');
const axios = require('axios');
const cron = require('node-cron');
const box = require('./secret-box');
const { assertPublicHttpsUrl } = require('./safe-url');
const { sizeName } = require('./hail-scale');
const { baseUrl } = require('./mailer');

const UA = 'StormCheckPro/2.0 (stormcheckpro.thepublicadjustertx.com)';
const MAX_IMPORT = parseInt(process.env.INTEGRATION_MAX_IMPORT || '25000', 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function apiError(e, name) {
  const s = e.response && e.response.status;
  if (s === 401 || s === 403) return new Error(`${name} rejected the API key. Check it was copied in full and has access.`);
  if (s === 429) return new Error(`${name} is rate-limiting requests. Try again in a few minutes.`);
  const body = e.response && e.response.data;
  const msg = body && (body.message || body.error || (typeof body === 'string' ? body.slice(0, 200) : ''));
  return new Error(`${name} error${s ? ' ' + s : ''}: ${msg || e.message}`);
}

const joinAddress = (line1, line2, city, state, zip) =>
  [[line1, line2].filter(Boolean).join(' '), city, [state, zip].filter(Boolean).join(' ')]
    .map(x => String(x || '').trim()).filter(Boolean).join(', ');

// ── JobNimbus ────────────────────────────────────────────────────────────────
const jobnimbus = {
  label: 'JobNimbus',
  base: 'https://app.jobnimbus.com/api1',
  async req(key, method, path, { params, data } = {}) {
    try {
      const r = await axios({ method, url: `${this.base}/${path}`, params, data, timeout: 30000,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': UA } });
      return r.data;
    } catch (e) { throw apiError(e, 'JobNimbus'); }
  },
  async test(key) {
    const d = await this.req(key, 'GET', 'contacts', { params: { size: 1, from: 0 } });
    return { count: d && d.count != null ? d.count : (d && d.results ? d.results.length : 0) };
  },
  mapContact(c) {
    const address = joinAddress(c.address_line1, c.address_line2, c.city, c.state_text, c.zip);
    if (!c.address_line1 || !address) return null;
    const geo = c.geo || {};
    const lat = parseFloat(geo.lat ?? c.geo_lat), lon = parseFloat(geo.lon ?? c.geo_lon);
    return {
      externalId: c.jnid,
      name: c.display_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company || address,
      address,
      phone: c.mobile_phone || c.home_phone || c.work_phone || c.phone || '',
      email: c.email || '',
      crmStatus: c.status_name || '',
      ...(Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 ? { lat, lon } : {}),
    };
  },
  async fetchProperties(key, { log = () => {} } = {}) {
    const out = [];
    const size = 1000;
    for (let from = 0; from < MAX_IMPORT; from += size) {
      const d = await this.req(key, 'GET', 'contacts', { params: { size, from, sort_field: 'date_created', sort_direction: 'asc' } });
      const rows = (d && d.results) || [];
      for (const c of rows) { const m = this.mapContact(c); if (m && m.externalId) out.push(m); }
      log(`JobNimbus: read ${from + rows.length}${d && d.count ? ' of ' + d.count : ''} contacts`);
      if (rows.length < size || (d && d.count && from + size >= d.count)) break;
      await sleep(250);
    }
    return out;
  },
  async pushNote(key, externalId, text) {
    await this.req(key, 'POST', 'activities', {
      data: {
        note: text,
        record_type: 1,
        record_type_name: 'Note',
        primary: { id: externalId, type: 'contact' },
        related: [{ id: externalId, type: 'contact' }],
      },
    });
  },
};

// ── AccuLynx ─────────────────────────────────────────────────────────────────
const acculynx = {
  label: 'AccuLynx',
  base: 'https://api.acculynx.com/api/v2',
  async req(key, method, path, { params, data } = {}, attempt = 0) {
    try {
      const r = await axios({ method, url: `${this.base}/${path}`, params, data, timeout: 30000,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA } });
      return r.data;
    } catch (e) {
      if (e.response && e.response.status === 429 && attempt < 5) {
        const wait = Math.min(60, parseInt(e.response.headers && e.response.headers['retry-after'], 10) || 5 * (attempt + 1));
        await sleep(wait * 1000);
        return this.req(key, method, path, { params, data }, attempt + 1);
      }
      throw apiError(e, 'AccuLynx');
    }
  },
  async test(key) {
    const d = await this.req(key, 'GET', 'jobs', { params: { pageSize: 1, pageStartIndex: 0 } });
    return { count: d && d.count != null ? d.count : 0 };
  },
  mapJob(j) {
    const a = j.locationAddress || {};
    const state = typeof a.state === 'object' && a.state ? (a.state.abbreviation || a.state.name || '') : (a.state || '');
    const address = joinAddress(a.street1, a.street2, a.city, state, a.zipCode || a.zip);
    if (!a.street1 || !address) return null;
    if (String(j.currentMilestone || '').toLowerCase() === 'cancelled') return null;
    const primary = (j.contacts || []).find(c => c.isPrimary) || (j.contacts || [])[0];
    const pc = primary && primary.contact ? primary.contact : {};
    const phone = (pc.phoneNumbers && pc.phoneNumbers[0] && (pc.phoneNumbers[0].number || pc.phoneNumbers[0].phoneNumber)) || pc.phone || '';
    const email = (pc.emailAddresses && pc.emailAddresses[0] && (pc.emailAddresses[0].address || pc.emailAddresses[0].emailAddress)) || pc.email || '';
    const contactName = [pc.firstName, pc.lastName].filter(Boolean).join(' ');
    return {
      externalId: j.id,
      name: j.jobName || contactName || j.jobNumber || address,
      address, phone, email,
      crmStatus: j.currentMilestone || '',
    };
  },
  async fetchProperties(key, { log = () => {} } = {}) {
    const out = [];
    const pageSize = 25;
    let total = null;
    for (let i = 0; i < MAX_IMPORT; i += pageSize) {
      const d = await this.req(key, 'GET', 'jobs', { params: { pageSize, pageStartIndex: i, includes: 'contact', sortBy: 'CreatedDate', sortOrder: 'Ascending' } });
      const items = (d && d.items) || [];
      if (total == null) total = d && d.count;
      for (const j of items) { const m = this.mapJob(j); if (m && m.externalId) out.push(m); }
      if ((i / pageSize) % 20 === 0) log(`AccuLynx: read ${i + items.length}${total ? ' of ' + total : ''} jobs`);
      if (items.length < pageSize || (total != null && i + pageSize >= total)) break;
      await sleep(300);
    }
    return out;
  },
  async pushNote(key, externalId, text) {
    await this.req(key, 'POST', `jobs/${encodeURIComponent(externalId)}/messages`, { data: { message: text } });
  },
};

const PROVIDERS = { jobnimbus, acculynx };

// ── Messages ─────────────────────────────────────────────────────────────────
const fmtDate = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function reportUrl(c) {
  const q = new URLSearchParams({ address: c.formattedAddress || c.address });
  if (c.lat != null && c.lon != null) { q.set('lat', c.lat); q.set('lon', c.lon); }
  return `${baseUrl()}/dashboard?${q.toString()}`;
}

function hitSource(h) {
  return h.radarIn >= 0.5 && h.groundHail >= 0.5 ? 'radar+ground' : h.radarIn >= 0.5 ? 'radar' : h.tornado ? 'tornado' : 'ground';
}

function noteText(h, date) {
  const what = h.tornado && h.best < 0.75
    ? 'A tornado was reported within 1 mile of this property'
    : `${h.best.toFixed(2)}" (${sizeName(h.best)}) hail estimated at this property`;
  const basis = { 'radar+ground': 'NOAA radar, confirmed by a ground report', radar: 'NOAA radar estimate', ground: 'ground storm report', tornado: 'NWS storm report' }[hitSource(h)];
  return `StormCheck Pro storm alert, ${fmtDate(date)}: ${what} (${basis}). Full storm report: ${reportUrl(h.c)}`;
}

function webhookPayload(h, date) {
  const c = h.c;
  return {
    event: 'property.hit',
    date,
    property: {
      id: String(c._id), name: c.name || '', address: c.formattedAddress || c.address || '',
      phone: c.phone || '', email: c.email || '', lat: c.lat, lon: c.lon,
      source: c.source || 'stormcheck', externalId: c.externalId || null,
    },
    hail: { sizeIn: Math.round(h.best * 100) / 100, sizeName: h.best ? sizeName(h.best) : null, radarIn: h.radarIn, groundReportIn: h.groundHail, tornadoNearby: !!h.tornado, basis: hitSource(h) },
    summary: noteText(h, date),
    reportUrl: reportUrl(c),
  };
}

async function postWebhook(url, payload) {
  const safe = await assertPublicHttpsUrl(url);
  await axios.post(safe, payload, { timeout: 15000, maxRedirects: 0, headers: { 'Content-Type': 'application/json', 'User-Agent': UA } });
}

// ── Engine ───────────────────────────────────────────────────────────────────
let db = null;
const syncing = new Set();

function publicView(i) {
  return {
    type: i.type, connected: true, status: i.status || 'ok', lastError: i.lastError || null,
    lastSyncAt: i.lastSyncAt || null, lastSyncCount: i.lastSyncCount ?? null, lastPushAt: i.lastPushAt || null,
    pushNotes: i.pushNotes !== false, keyLast4: i.keyLast4 || null,
    url: i.type === 'webhook' ? i.url : undefined, syncing: syncing.has(`${i.userId}:${i.type}`),
  };
}

async function connect(userId, type, { apiKey, url, pushNotes = true }) {
  if (type === 'webhook') {
    const safe = await assertPublicHttpsUrl(url);
    await db.integrationOps.upsert(userId, 'webhook', { url: safe, status: 'ok', lastError: null, pushNotes: true });
    return { ok: true };
  }
  const p = PROVIDERS[type];
  if (!p) throw new Error('Unknown integration');
  const key = String(apiKey || '').trim();
  if (key.length < 10) throw new Error(`Paste your ${p.label} API key.`);
  const t = await p.test(key);
  await db.integrationOps.upsert(userId, type, {
    keySealed: box.seal(key), keyLast4: box.last4(key), pushNotes: pushNotes !== false,
    status: 'ok', lastError: null, connectedAt: new Date().toISOString(),
  });
  syncUser(userId, type).catch(e => console.error(`[integrations] ${type} sync:`, e.message));
  return { ok: true, count: t.count };
}

async function syncUser(userId, type, { log = m => console.log('[integrations]', m) } = {}) {
  const p = PROVIDERS[type];
  if (!p) return null;
  const k = `${userId}:${type}`;
  if (syncing.has(k)) return { running: true };
  syncing.add(k);
  try {
    const integ = await db.integrationOps.get(userId, type);
    if (!integ) return null;
    let key;
    try { key = box.open(integ.keySealed); }
    catch { await db.integrationOps.upsert(userId, type, { status: 'error', lastError: 'Saved key can no longer be read. Reconnect with your API key.' }); return null; }

    let props;
    try { props = await p.fetchProperties(key, { log }); }
    catch (e) { await db.integrationOps.upsert(userId, type, { status: 'error', lastError: e.message }); throw e; }

    const existing = (await db.watchlistOps.getForUser(userId)).filter(c => c.source === type && c.externalId);
    const byExt = new Map(existing.map(c => [c.externalId, c]));
    const inserts = [];
    let updated = 0;
    for (const m of props) {
      const cur = byExt.get(m.externalId);
      if (!cur) {
        inserts.push({ name: m.name, address: m.address, phone: m.phone, email: m.email, crmStatus: m.crmStatus,
          source: type, externalId: m.externalId, lat: m.lat ?? null, lon: m.lon ?? null, ...(m.lat != null ? { formattedAddress: m.address } : {}) });
        continue;
      }
      const set = {};
      if (cur.name !== m.name) set.name = m.name;
      if ((cur.phone || '') !== m.phone) set.phone = m.phone;
      if ((cur.email || '') !== m.email) set.email = m.email;
      if ((cur.crmStatus || '') !== m.crmStatus) set.crmStatus = m.crmStatus;
      if (cur.address !== m.address) Object.assign(set, { address: m.address, lat: m.lat ?? null, lon: m.lon ?? null, formattedAddress: m.lat != null ? m.address : null, geocodeFailed: false });
      if (Object.keys(set).length) { await db.watchlistOps.updateContactForUser(cur._id, userId, set); updated++; }
    }
    for (let i = 0; i < inserts.length; i += 1000) await db.watchlistOps.bulkAdd(userId, inserts.slice(i, i + 1000));

    await db.integrationOps.upsert(userId, type, {
      status: 'ok', lastError: null, lastSyncAt: new Date().toISOString(),
      lastSyncCount: props.length, lastSyncAdded: inserts.length, lastSyncUpdated: updated,
    });
    log(`${p.label} sync for ${userId}: ${props.length} records, ${inserts.length} added, ${updated} updated`);
    if (db.locateMissing) db.locateMissing(userId);
    return { total: props.length, added: inserts.length, updated };
  } finally { syncing.delete(k); }
}

async function syncAll() {
  const all = await db.integrationOps.allActive();
  for (const i of all) {
    if (!PROVIDERS[i.type]) continue;
    try { await syncUser(i.userId, i.type); } catch (e) { console.error(`[integrations] ${i.type} ${i.userId}:`, e.message); }
  }
}

/**
 * Called by the portfolio alert check with one user's new hits for a day.
 * Writes notes back to the CRM record each property came from, and sends one
 * webhook event per hit. Errors are recorded on the integration, never thrown.
 */
async function pushHits(userId, hits, date) {
  if (!db || !hits.length) return { pushed: 0 };
  const integs = await db.integrationOps.getForUser(userId);
  if (!integs.length) return { pushed: 0 };
  let pushed = 0;

  for (const integ of integs) {
    const p = PROVIDERS[integ.type];
    if (p) {
      if (integ.pushNotes === false) continue;
      const mine = hits.filter(h => h.c.source === integ.type && h.c.externalId);
      if (!mine.length) continue;
      let key;
      try { key = box.open(integ.keySealed); } catch { continue; }
      let lastError = null, n = 0;
      for (const h of mine) {
        try { await p.pushNote(key, h.c.externalId, noteText(h, date)); n++; }
        catch (e) { lastError = e.message; }
        await sleep(200);
      }
      pushed += n;
      await db.integrationOps.upsert(userId, integ.type, { lastPushAt: new Date().toISOString(), lastPushCount: n, ...(lastError ? { lastError: `Note failed: ${lastError}` } : {}) });
    } else if (integ.type === 'webhook' && integ.url) {
      let lastError = null, n = 0;
      for (const h of hits.slice(0, 500)) {
        try { await postWebhook(integ.url, webhookPayload(h, date)); n++; }
        catch (e) { lastError = e.message; }
        await sleep(100);
      }
      pushed += n;
      await db.integrationOps.upsert(userId, 'webhook', { lastPushAt: new Date().toISOString(), lastPushCount: n, status: lastError ? 'error' : 'ok', lastError });
    }
  }
  return { pushed };
}

async function sendTestWebhook(userId) {
  const integ = await db.integrationOps.get(userId, 'webhook');
  if (!integ || !integ.url) throw new Error('Add a webhook URL first.');
  const sample = {
    c: { _id: 'test', name: 'Sample Property', address: '123 Main St, Springfield, MO 65806', formattedAddress: '123 MAIN ST, SPRINGFIELD, MO, 65806', lat: 37.209, lon: -93.292, phone: '555-555-0100', email: 'owner@example.com', source: 'stormcheck', externalId: null },
    best: 1.75, radarIn: 1.75, groundHail: 1.5, tornado: false,
  };
  const payload = { ...webhookPayload(sample, new Date().toISOString().slice(0, 10)), test: true };
  await postWebhook(integ.url, payload);
  return payload;
}

/** Inbound: add one or more properties from Zapier/Make/a CRM. */
function mapInbound(r) {
  const pick = (...ks) => { for (const k of ks) { const v = r[k]; if (v != null && String(v).trim()) return String(v).trim(); } return ''; };
  const line1 = pick('address', 'street', 'address1', 'address_line1', 'street_address', 'property_address', 'loss_address');
  const address = /\d{5}/.test(line1) ? line1
    : joinAddress(line1, pick('address2', 'address_line2'), pick('city', 'loss_city'), pick('state', 'state_text', 'loss_state'), pick('zip', 'zipcode', 'zip_code', 'postal_code', 'loss_zip'));
  if (!line1) return null;
  const name = pick('name', 'full_name', 'client_name', 'display_name') || [pick('first_name', 'firstname'), pick('last_name', 'lastname')].filter(Boolean).join(' ') || address;
  return { name: name.slice(0, 200), address: address.slice(0, 300), phone: pick('phone', 'mobile', 'mobile_phone', 'cell').slice(0, 40), email: pick('email', 'email_address').slice(0, 200), externalId: pick('id', 'external_id', 'client_id', 'claim_id').slice(0, 100) || null };
}

async function inbound(token, body) {
  const integ = await db.integrationOps.findByInboundToken(String(token || ''));
  if (!integ) { const e = new Error('Unknown webhook link'); e.status = 404; throw e; }
  const rows = Array.isArray(body) ? body : Array.isArray(body && body.properties) ? body.properties : [body || {}];
  const mapped = rows.slice(0, 1000).map(mapInbound).filter(Boolean);
  if (!mapped.length) { const e = new Error('No address found. Send at least an "address" field (with city, state and ZIP).'); e.status = 400; throw e; }
  const existing = (await db.watchlistOps.getForUser(integ.userId)).filter(c => c.source === 'webhook' && c.externalId);
  const byExt = new Map(existing.map(c => [c.externalId, c]));
  const inserts = [];
  let updated = 0;
  for (const m of mapped) {
    const cur = m.externalId && byExt.get(m.externalId);
    if (cur) {
      const set = { name: m.name, phone: m.phone, email: m.email };
      if (cur.address !== m.address) Object.assign(set, { address: m.address, lat: null, lon: null, formattedAddress: null, geocodeFailed: false });
      await db.watchlistOps.updateContactForUser(cur._id, integ.userId, set); updated++;
    } else inserts.push({ ...m, source: 'webhook', lat: null, lon: null });
  }
  if (inserts.length) await db.watchlistOps.bulkAdd(integ.userId, inserts);
  if (db.locateMissing) db.locateMissing(integ.userId);
  return { added: inserts.length, updated };
}

function newToken() { return crypto.randomBytes(24).toString('base64url'); }

function start(context) {
  db = context;
  if (process.env.DATA_JOBS === 'off' || process.env.INTEGRATIONS_SYNC === 'off') return;
  // Every 6 hours at :40, plus once a few minutes after startup.
  cron.schedule('40 */6 * * *', () => syncAll().catch(e => console.error('[integrations]', e.message)));
  setTimeout(() => syncAll().catch(e => console.error('[integrations]', e.message)), 3 * 60 * 1000);
}

module.exports = {
  PROVIDERS, start, connect, syncUser, syncAll, pushHits, sendTestWebhook, inbound, newToken, publicView,
  _mapInbound: mapInbound, _noteText: noteText, _webhookPayload: webhookPayload, _setDb: d => { db = d; },
};
