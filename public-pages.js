/**
 * Public, indexable pages: storm maps by day and state, city hail history,
 * free alert signup, sample report, sitemap. Server-rendered for SEO.
 */
const fs = require('fs');
const mesh = require('./lib/mesh-store');
const ncei = require('./lib/ncei-store');
const spc = require('./lib/spc-store');
const places = require('./lib/places');
const stormDays = require('./lib/storm-days');
const report = require('./lib/report-engine');
const { SCALE, severity, sizeName } = require('./lib/hail-scale');
const { dataPath } = require('./lib/paths');
const { sendMail, layout: emailLayout, baseUrl } = require('./lib/mailer');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const fmtDate = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const fmtShort = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const inch = v => `${Number(v || 0).toFixed(2)}"`;
const sevColor = level => (SCALE.find(s => s.level === level) || SCALE[SCALE.length - 1]).color;

const LOGO = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#F2A93B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.5 14H7a4.5 4.5 0 1 1 1.1-8.86A6 6 0 0 1 19.5 9a2.5 2.5 0 0 1-2 5z"></path><circle cx="8" cy="19" r="1.3"></circle><circle cx="12.5" cy="20.5" r="1.3"></circle><circle cx="16.5" cy="18.5" r="1.3"></circle></svg>';

function header() {
  return `<header class="site-head"><div class="wrap">
  <a href="/" class="logo">${LOGO}<span>StormCheck Pro</span></a>
  <nav class="site-nav" aria-label="Main">
    <a href="/hail-maps">Hail maps</a><a href="/#features">Features</a><a href="/#pricing">Pricing</a><a href="/alerts">Free alerts</a>
    <a href="/login" style="color:#fff">Sign in</a>
    <a href="/register" class="btn btn-accent">Run a free report</a>
  </nav></div></header>`;
}

function footer() {
  const states = Object.entries(places.STATE_NAMES).map(([ab, name]) => `<a href="/hail/${ab.toLowerCase()}">${esc(name)}</a>`).join('');
  return `<footer class="site-foot"><div class="wrap">
  <strong style="color:var(--ink)">Hail history by state</strong>
  <nav class="states" aria-label="Hail history by state">${states}</nav>
  <div class="row">
    <p style="margin:0">StormCheck Pro is built by <a href="https://thepublicadjustertx.com">First Call Public Adjusters</a> · Southlake, TX · <a href="tel:+18176189884">(817) 618-9884</a></p>
    <p style="margin:0">Storm data: NOAA National Weather Service · <a href="/sample-report">Sample report</a> · <a href="/hail-maps">Hail maps</a></p>
  </div></div></footer>`;
}

function page({ title, description, path, body, head = '', noindex = false, jsonld = null }) {
  const url = baseUrl() + path;
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
${noindex ? '<meta name="robots" content="noindex,follow">' : ''}
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#172235">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;700;800&family=Source+Sans+3:wght@400;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/site.css">
<link rel="manifest" href="/manifest.json"><link rel="apple-touch-icon" href="/icons/icon-192.png">
<script src="/js/tracking.js" async></script>
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>` : ''}
${head}
</head><body>${header()}<main>${body}</main>${footer()}<script src="/js/assistant.js" data-mode="public" defer></script></body></html>`;
}

const LEAFLET = '<link rel="stylesheet" href="/lib/leaflet.min.css"><script src="/lib/leaflet.min.js"></script><script src="/js/swath-layer.js"></script>';

function breadcrumbs(items) {
  return {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, p], i) => ({ '@type': 'ListItem', position: i + 1, name, item: baseUrl() + p })),
  };
}

function freeAlertForm(dark = false, label = 'Get free hail alerts') {
  return `<form class="${dark ? 'dark' : ''}" data-free-alerts style="display:flex;flex-direction:column;gap:12px">
  <div class="form-row">
    <div class="field" style="flex:2 1 240px"><label for="fa-email">Email</label><input id="fa-email" name="email" type="email" required placeholder="you@company.com" autocomplete="email"></div>
    <div class="field"><label for="fa-zip">ZIP code</label><input id="fa-zip" name="zip" inputmode="numeric" pattern="[0-9]{5}" required placeholder="76092" autocomplete="postal-code"></div>
    <div class="field"><label for="fa-radius">Radius</label><select id="fa-radius" name="radiusMi"><option value="10">10 miles</option><option value="25" selected>25 miles</option><option value="50">50 miles</option></select></div>
    <div class="field"><label for="fa-min">Hail size</label><select id="fa-min" name="minIn"><option value="0.75">0.75" and up</option><option value="1" selected>1" and up</option><option value="1.5">1.5" and up</option></select></div>
  </div>
  <div><button class="btn btn-accent" type="submit">${esc(label)}</button></div>
  <p data-msg role="status" style="margin:0"></p>
</form>
<script>
document.querySelectorAll('[data-free-alerts]').forEach(function(f){
  f.addEventListener('submit', async function(e){
    e.preventDefault(); var msg=f.querySelector('[data-msg]'); var btn=f.querySelector('button');
    btn.disabled=true; msg.className=''; msg.textContent='Signing you up…';
    try {
      var r = await fetch('/api/public/free-alerts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f)))});
      var d = await r.json();
      msg.className = 'notice ' + (r.ok ? 'ok' : 'err');
      msg.textContent = r.ok ? 'You are signed up. We will email you when radar shows hail near ' + d.label + '.' : (d.error || 'Something went wrong.');
      if (r.ok) f.reset();
    } catch(err){ msg.className='notice err'; msg.textContent='Network error. Try again.'; }
    btn.disabled=false;
  });
});
</script>`;
}

function stormCards(list) {
  if (!list.length) return '<p class="lede">No significant hail days recorded yet. Radar data is still loading. Check back soon.</p>';
  return `<div class="grid-tight">${list.map(s => `<a class="storm-card" href="/hail-maps/${s.date}">
    <div class="date">${fmtShort(s.date)}</div>
    <div class="size">${inch(s.maxIn)}</div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px"><span class="sev" style="background:${sevColor(s.severity)}">${esc(s.severity)}</span><span style="color:var(--muted-2);font-size:14px">${s.cityCount} cit${s.cityCount === 1 ? 'y' : 'ies'} hit</span></div>
    <div style="color:var(--muted);font-size:15px">${esc((s.topCities || []).join(' · '))}</div>
  </a>`).join('')}</div>`;
}

function mapScript(id, date, bounds, { minIn = 0.75 } = {}) {
  if (!bounds) return '';
  return `<script>
(function(){
  var map = L.map('${id}', { scrollWheelZoom: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap', maxZoom: 16 }).addTo(map);
  var b = ${JSON.stringify(bounds)};
  map.fitBounds([[b[1], b[0]], [b[3], b[2]]]);
  var layer = new L.SwathLayer([], { opacity: 0.75, minIn: ${minIn} }).addTo(map);
  fetch('/api/public/swath?date=${date}&w=' + b[0] + '&s=' + b[1] + '&e=' + b[2] + '&n=' + b[3])
    .then(function(r){ return r.json(); }).then(function(d){ layer.setCells(d.cells || []); });
  renderHailLegend(document.getElementById('${id}-legend'));
})();
</script>`;
}

function boundsOf(points, pad = 0.15) {
  if (!points.length) return null;
  let w = 180, s = 90, e = -180, n = -90;
  for (const p of points) { w = Math.min(w, p.lon); e = Math.max(e, p.lon); s = Math.min(s, p.lat); n = Math.max(n, p.lat); }
  const r = v => Math.round(v * 100) / 100;
  return [r(w - pad), r(s - pad), r(e + pad), r(n + pad)];
}

// ── Waitlist (bundle "notify me") ────────────────────────────────────────────
function addToWaitlist(email, product) {
  const file = dataPath('waitlist.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new */ }
  if (!list.some(x => x.email === email && x.product === product)) list.push({ email, product, at: new Date().toISOString() });
  fs.writeFileSync(file, JSON.stringify(list));
}

const rateHits = new Map();
function rateLimited(ip, max = 10) {
  const now = Date.now(), win = 3600000;
  const arr = (rateHits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); rateHits.set(ip, arr);
  return arr.length > max;
}

module.exports = function publicPages(app, { db }) {
  const { freeAlertOps } = db;

  // ── Public JSON ────────────────────────────────────────────────────────────
  app.get('/api/public/recent-storms', (req, res) => {
    const state = req.query.state ? String(req.query.state).toUpperCase() : null;
    res.set('Cache-Control', 'public, max-age=600');
    res.json({ storms: stormDays.recent({ limit: Math.min(+req.query.limit || 8, 30), minIn: 1, state }) });
  });

  app.get('/api/public/swath', (req, res) => {
    if (!isDate(req.query.date)) return res.status(400).json({ error: 'date required' });
    const [w, s, e, n] = ['w', 's', 'e', 'n'].map(k => parseFloat(req.query[k]));
    if (![w, s, e, n].every(Number.isFinite) || e - w > 25 || n - s > 25 || e <= w || n <= s) return res.status(400).json({ error: 'bbox too large' });
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ cells: mesh.cellsForDay(req.query.date, w, s, e, n).filter(c => c[2] >= 0.75) });
  });

  app.post('/api/public/free-alerts', async (req, res) => {
    if (rateLimited(req.ip)) return res.status(429).json({ error: 'Too many requests. Try again later.' });
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    const z = places.zipInfo(String(req.body.zip || '').trim());
    if (!z) return res.status(400).json({ error: 'Enter a valid U.S. ZIP code.' });
    const radiusMi = [10, 25, 50].includes(+req.body.radiusMi) ? +req.body.radiusMi : 25;
    const minIn = [0.75, 1, 1.5].includes(+req.body.minIn) ? +req.body.minIn : 1;
    const label = `${z.city}, ${z.state} ${z.zip}`;
    const sub = await freeAlertOps.subscribe({ email, label, lat: z.lat, lon: z.lon, zip: z.zip, radiusMi, minIn });
    sendMail({
      to: email,
      subject: `Hail alerts are on for ${label}`,
      html: emailLayout('Free hail alerts confirmed', `<p>We'll email you when NOAA radar shows ${minIn}" or larger hail within ${radiusMi} miles of <strong>${esc(label)}</strong>.</p>
        <p>Need to know whether a specific address was hit? <a href="${baseUrl()}/register">Run a free property report</a>.</p>`,
      { footer: `<a href="${baseUrl()}/alerts/unsubscribe?token=${sub.token}">Unsubscribe</a>` }),
    }).catch(() => {});
    res.json({ success: true, label });
  });

  app.post('/api/public/waitlist', (req, res) => {
    if (rateLimited(req.ip)) return res.status(429).json({ error: 'Too many requests.' });
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    addToWaitlist(email, String(req.body.product || 'bundle').slice(0, 40));
    res.json({ success: true });
  });

  app.get('/alerts/unsubscribe', async (req, res) => {
    if (req.query.token) await freeAlertOps.unsubscribe(String(req.query.token));
    res.send(page({ title: 'Unsubscribed | StormCheck Pro', description: 'Hail alert unsubscribe', path: '/alerts/unsubscribe', noindex: true,
      body: '<section><div class="wrap narrow"><h1>You are unsubscribed.</h1><p class="lede">You will not get any more hail alerts from us. You can sign up again any time on the <a href="/alerts">free alerts page</a>.</p></div></section>' }));
  });

  // ── Free alerts landing ────────────────────────────────────────────────────
  // ── Install on your phone ──────────────────────────────────────────────────
  app.get('/install', (req, res) => {
    const share = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-3px"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/></svg>';
    res.send(page({
      title: 'Put StormCheck Pro on Your Phone | StormCheck Pro',
      description: 'Add StormCheck Pro to your iPhone or Android home screen. It opens full-screen like an app, with no app store download.',
      path: '/install',
      head: '<script src="/js/install.js" defer></script>',
      body: `<section class="dark" style="padding:48px 0"><div class="wrap narrow">
        <p class="eyebrow">No app store needed</p>
        <h1>Put StormCheck Pro on your phone.</h1>
        <p class="lede">Add it to your home screen once and it opens full-screen like any other app, signed in and ready to check an address.</p>
        <button type="button" class="btn btn-accent" data-install-button hidden onclick="if(!window.scpInstall()){document.getElementById('android').scrollIntoView()}">Install now</button>
      </div></section>
      <section><div class="wrap narrow">
        <div class="grid">
          <div class="card" id="iphone"><h2 style="font-size:24px">iPhone or iPad</h2>
            <ol style="color:var(--muted);line-height:1.7;padding-left:20px">
              <li>Open <strong>${esc(baseUrl().replace(/^https?:\/\//, ''))}</strong> in <strong>Safari</strong>.</li>
              <li>Tap the <strong>Share</strong> button ${share} at the bottom of the screen (top right on iPad).</li>
              <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
              <li>Tap <strong>Add</strong>. The StormCheck Pro icon appears on your home screen.</li>
            </ol>
            <p style="font-size:15px">Using Chrome on iPhone? Tap the Share button in the address bar, then <strong>Add to Home Screen</strong>.</p>
          </div>
          <div class="card" id="android"><h2 style="font-size:24px">Android</h2>
            <ol style="color:var(--muted);line-height:1.7;padding-left:20px">
              <li>Open <strong>${esc(baseUrl().replace(/^https?:\/\//, ''))}</strong> in <strong>Chrome</strong>.</li>
              <li>Tap the <strong>⋮</strong> menu at the top right.</li>
              <li>Tap <strong>Install app</strong> (on some phones it says <strong>Add to Home screen</strong>).</li>
              <li>Tap <strong>Install</strong>. The StormCheck Pro icon appears with your other apps.</li>
            </ol>
          </div>
        </div>
        <h2 style="margin-top:48px;font-size:28px">After it's installed</h2>
        <ul style="color:var(--muted);line-height:1.7;padding-left:20px">
          <li>Sign in once; you stay signed in.</li>
          <li>To get hail alerts on the phone, open the app and tap <strong>Enable Alerts</strong> on the Lookup page, then allow notifications.</li>
          <li>Updates arrive automatically. There's nothing to update in an app store.</li>
        </ul>
        <p style="margin-top:28px"><a class="btn btn-navy" href="/register">Create a free account</a></p>
      </div></section>`,
    }));
  });

  app.get('/alerts', (req, res) => {
    res.send(page({
      title: 'Free Hail Alerts by ZIP Code | StormCheck Pro',
      description: 'Get a free email when NOAA radar shows hail near your ZIP code. Pick your radius and minimum hail size.',
      path: '/alerts',
      body: `<section class="dark"><div class="wrap narrow">
        <p class="eyebrow">Free · No account needed</p>
        <h1>Know when hail hits your area.</h1>
        <p class="lede">We check NOAA radar every day. When hail at or above your size threshold falls within your radius, you get one email with the storm map and the areas hit.</p>
        ${freeAlertForm(true, 'Start my free alerts')}
      </div></section>
      <section><div class="wrap narrow">
        <h2>Need more than a heads-up?</h2>
        <p class="lede">Paid plans add property-level reports, portfolio monitoring for every address you manage, territory alerts, post-storm lead lists and warnings before the storm arrives.</p>
        <a class="btn btn-navy" href="/register">Run a free property report</a>
      </div></section>`,
    }));
  });

  // ── Storm index ────────────────────────────────────────────────────────────
  app.get('/hail-maps', (req, res) => {
    const recent = stormDays.recent({ limit: 36, minIn: 1 });
    res.send(page({
      title: 'Recent Hail Storms & Hail Maps | StormCheck Pro',
      description: 'Daily radar hail maps for the U.S.: where hail fell, how big, and which cities were hit. Updated every day from NOAA data.',
      path: '/hail-maps',
      body: `<section class="dark" style="padding-bottom:56px"><div class="wrap">
        <h1>Recent hail storms</h1>
        <p class="lede">Every day we map radar-estimated hail from NOAA across the U.S. Pick a storm to see the swath, the largest hail and every city in its path.</p>
      </div></section>
      <section style="padding-top:48px"><div class="wrap">${stormCards(recent)}</div></section>
      <section class="white"><div class="wrap"><h2>Hail history by state</h2>
        <div class="chips">${Object.entries(places.STATE_NAMES).map(([ab, name]) => `<a class="chip" href="/hail/${ab.toLowerCase()}">${esc(name)}</a>`).join('')}</div>
      </div></section>
      <section><div class="wrap narrow"><h2>Get free hail alerts</h2><p class="lede">One email when radar shows hail near your ZIP code.</p>${freeAlertForm()}</div></section>`,
      jsonld: breadcrumbs([['Home', '/'], ['Hail maps', '/hail-maps']]),
    }));
  });

  // ── Storm day ──────────────────────────────────────────────────────────────
  app.get('/hail-maps/:date', (req, res, next) => {
    if (!isDate(req.params.date)) return next();
    const sd = stormDays.get(req.params.date);
    if (!sd) return res.status(404).send(notFound());
    const pts = sd.cities.filter(c => c.maxIn >= 1).slice(0, 200);
    const bounds = boundsOf(pts.length ? pts : sd.cities);
    const title = `Hail Map for ${fmtShort(sd.date)}: up to ${inch(sd.maxIn)} hail${sd.states.length ? ` in ${sd.states.slice(0, 3).map(s => s.state).join(', ')}` : ''}`;
    res.send(page({
      title: `${title} | StormCheck Pro`,
      description: `Radar hail swath for ${fmtDate(sd.date)}. Largest hail ${inch(sd.maxIn)} (${sd.maxSizeName || 'n/a'}). ${sd.cities.length} cities hit across ${sd.states.length} state${sd.states.length === 1 ? '' : 's'}.`,
      path: `/hail-maps/${sd.date}`,
      noindex: !sd.cities.length,
      head: LEAFLET,
      jsonld: breadcrumbs([['Home', '/'], ['Hail maps', '/hail-maps'], [fmtShort(sd.date), `/hail-maps/${sd.date}`]]),
      body: `<section class="dark" style="padding:48px 0"><div class="wrap">
        <p class="crumbs"><a href="/hail-maps">Hail maps</a> / ${fmtShort(sd.date)}</p>
        <h1>Hail map: ${fmtDate(sd.date)}</h1>
        <div class="stats">
          <div class="stat"><b>${inch(sd.maxIn)}</b><span>Largest radar-estimated hail (${esc(sd.maxSizeName || '-')})</span></div>
          <div class="stat"><b>${sd.areaSqMi1in.toLocaleString()}</b><span>Square miles with 1"+ hail</span></div>
          <div class="stat"><b>${sd.cities.length}</b><span>Cities in the swath</span></div>
          <div class="stat"><b>${sd.groundReports.hail}</b><span>Ground hail reports</span></div>
        </div>
      </div></section>
      <section style="padding-top:40px"><div class="wrap">
        <div id="m" class="map" role="img" aria-label="Radar hail swath map"></div>
        <div class="legend" id="m-legend"></div>
        <p style="color:var(--muted-2);font-size:15px">Radar-estimated maximum hail size (NOAA MRMS MESH), 12:00 UTC ${fmtShort(sd.date)} to 12:00 UTC the next day. Radar estimates can differ from what fell at a given roof.</p>
      </div></section>
      <section class="white"><div class="wrap">
        <h2>States hit</h2>
        <div class="table-wrap"><table class="data"><thead><tr><th>State</th><th>Largest hail</th><th>Cities hit</th><th>Ground reports</th></tr></thead><tbody>
        ${sd.states.map(s => `<tr><td><a href="/hail-maps/${sd.date}/${s.state.toLowerCase()}">${esc(s.name)}</a></td><td>${inch(s.maxIn)}</td><td>${s.cities}</td><td>${s.reports || 0}</td></tr>`).join('') || '<tr><td colspan="4">No cities in the swath.</td></tr>'}
        </tbody></table></div>
      </div></section>
      <section><div class="wrap">
        <h2>Cities with the largest hail</h2>
        <div class="table-wrap"><table class="data"><thead><tr><th>City</th><th>Largest hail</th><th>Likely impact</th></tr></thead><tbody>
        ${sd.cities.slice(0, 40).map(c => `<tr><td><a href="/hail/${c.state.toLowerCase()}/${c.slug}">${esc(c.name)}, ${c.state}</a></td><td><strong>${inch(c.maxIn)}</strong> ${esc(sizeName(c.maxIn))}</td><td>${esc(severity(c.maxIn).level)}</td></tr>`).join('') || '<tr><td colspan="3">None.</td></tr>'}
        </tbody></table></div>
        <p style="margin-top:24px"><a class="btn btn-navy" href="/register">Check whether your address was hit</a></p>
      </div></section>
      ${mapScript('m', sd.date, bounds)}`,
    }));
  });

  // ── Storm day, one state ───────────────────────────────────────────────────
  app.get('/hail-maps/:date/:state', (req, res, next) => {
    const st = String(req.params.state).toUpperCase();
    if (!isDate(req.params.date) || !places.STATE_NAMES[st]) return next();
    const sd = stormDays.get(req.params.date);
    if (!sd) return res.status(404).send(notFound());
    const cities = sd.cities.filter(c => c.state === st);
    const zips = sd.zips.filter(z => z.state === st);
    const maxIn = cities.reduce((m, c) => Math.max(m, c.maxIn), 0);
    const name = places.STATE_NAMES[st];
    res.send(page({
      title: `${name} Hail Map ${fmtShort(sd.date)}: up to ${inch(maxIn)} | StormCheck Pro`,
      description: `Where hail fell in ${name} on ${fmtDate(sd.date)}: ${cities.length} cities and ${zips.length} ZIP codes in the radar swath, largest ${inch(maxIn)}.`,
      path: `/hail-maps/${sd.date}/${st.toLowerCase()}`,
      noindex: !cities.length,
      head: LEAFLET,
      jsonld: breadcrumbs([['Home', '/'], ['Hail maps', '/hail-maps'], [fmtShort(sd.date), `/hail-maps/${sd.date}`], [name, `/hail-maps/${sd.date}/${st.toLowerCase()}`]]),
      body: `<section class="dark" style="padding:48px 0"><div class="wrap">
        <p class="crumbs"><a href="/hail-maps">Hail maps</a> / <a href="/hail-maps/${sd.date}">${fmtShort(sd.date)}</a> / ${esc(name)}</p>
        <h1>${esc(name)} hail: ${fmtDate(sd.date)}</h1>
        <div class="stats">
          <div class="stat"><b>${inch(maxIn)}</b><span>Largest radar-estimated hail</span></div>
          <div class="stat"><b>${cities.length}</b><span>Cities in the swath</span></div>
          <div class="stat"><b>${zips.length}</b><span>ZIP codes in the swath</span></div>
        </div>
      </div></section>
      <section style="padding-top:40px"><div class="wrap">
        <div id="m" class="map" role="img" aria-label="Radar hail swath map"></div><div class="legend" id="m-legend"></div>
      </div></section>
      <section class="white"><div class="wrap">
        <h2>Cities hit</h2>
        <div class="table-wrap"><table class="data"><thead><tr><th>City</th><th>Largest hail</th><th>Likely impact</th></tr></thead><tbody>
        ${cities.slice(0, 80).map(c => `<tr><td><a href="/hail/${st.toLowerCase()}/${c.slug}">${esc(c.name)}</a></td><td><strong>${inch(c.maxIn)}</strong> ${esc(sizeName(c.maxIn))}</td><td>${esc(severity(c.maxIn).level)}</td></tr>`).join('') || '<tr><td colspan="3">No cities in this state.</td></tr>'}
        </tbody></table></div>
        ${zips.length ? `<h3 style="margin-top:32px">ZIP codes in the swath</h3><div class="chips">${zips.slice(0, 40).map(z => `<span class="chip">${z.zip} · ${inch(z.maxIn)}</span>`).join('')}</div>
        <p style="color:var(--muted)">${zips.length > 40 ? `Showing 40 of ${zips.length}. ` : ''}Subscribers can export the full ZIP list and swath boundaries for direct mail and canvassing.</p>` : ''}
        <p style="margin-top:24px"><a class="btn btn-navy" href="/register">Check a specific address</a></p>
      </div></section>
      ${mapScript('m', sd.date, boundsOf(cities.length ? cities : sd.cities))}`,
    }));
  });

  // ── State hub ──────────────────────────────────────────────────────────────
  app.get('/hail/:state', (req, res, next) => {
    const st = String(req.params.state).toUpperCase();
    const name = places.STATE_NAMES[st];
    if (!name) return next();
    const recent = stormDays.recent({ limit: 12, minIn: 1, state: st });
    const cities = places.citiesInState(st, 5000).slice(0, 120);
    res.send(page({
      title: `${name} Hail History & Recent Hail Storms | StormCheck Pro`,
      description: `Recent hail storms in ${name} from NOAA radar, plus hail history for ${cities.length} ${name} cities.`,
      path: `/hail/${st.toLowerCase()}`,
      jsonld: breadcrumbs([['Home', '/'], [name, `/hail/${st.toLowerCase()}`]]),
      body: `<section class="dark" style="padding:48px 0"><div class="wrap"><p class="crumbs"><a href="/hail-maps">Hail maps</a> / ${esc(name)}</p>
        <h1>${esc(name)} hail history</h1><p class="lede">Recent hail storms across ${esc(name)} and hail history for each city, from NOAA radar and National Weather Service records.</p></div></section>
      <section style="padding-top:48px"><div class="wrap"><h2>Recent ${esc(name)} hail storms</h2>${stormCards(recent.map(r => ({ ...r })))}</div></section>
      <section class="white"><div class="wrap"><h2>${esc(name)} cities</h2>
        <div class="chips">${cities.map(c => `<a class="chip" href="/hail/${st.toLowerCase()}/${c.slug}">${esc(c.name)}</a>`).join('')}</div></div></section>
      <section><div class="wrap narrow"><h2>Free ${esc(name)} hail alerts</h2>${freeAlertForm()}</div></section>`,
    }));
  });

  // ── City hail history ──────────────────────────────────────────────────────
  app.get('/hail/:state/:city', (req, res, next) => {
    const st = String(req.params.state).toUpperCase();
    const name = places.STATE_NAMES[st];
    const city = name && places.findCity(st, req.params.city);
    if (!city) return next();
    const since10 = new Date(Date.now() - 10 * 365.25 * 86400000).toISOString().slice(0, 10);
    const since5 = new Date(Date.now() - 5 * 365.25 * 86400000).toISOString().slice(0, 10);
    const radar = mesh.pointHistory(city.lat, city.lon, 5, { sinceDate: since10 }).filter(r => r.withinRadius >= 0.75);
    const nceiEnd = ncei.coverageEnd();
    const ground = [
      ...(nceiEnd ? ncei.eventsNear(city.lat, city.lon, 5, { sinceDate: since10, untilDate: nceiEnd }) : []),
      ...spc.eventsNear(city.lat, city.lon, 5, { sinceDate: since10, afterDate: nceiEnd || null }),
    ].filter(e => e.type === 'hail' && (e.mag || 0) >= 0.75);

    const byDate = new Map();
    for (const r of radar) byDate.set(r.date, { date: r.date, radarIn: r.withinRadius, reports: 0, reportMax: 0 });
    for (const e of ground) {
      const d = byDate.get(e.date) || { date: e.date, radarIn: 0, reports: 0, reportMax: 0 };
      d.reports++; d.reportMax = Math.max(d.reportMax, e.mag || 0); byDate.set(e.date, d);
    }
    const rows = [...byDate.values()].map(d => ({ ...d, best: Math.max(d.radarIn, d.reportMax) }));
    const damaging5 = rows.filter(r => r.best >= 1 && r.date >= since5).length;
    const largest = rows.reduce((m, r) => (r.best > (m ? m.best : 0) ? r : m), null);
    const latest = rows.filter(r => r.best >= 1).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    const top = [...rows].sort((a, b) => b.best - a.best || (a.date < b.date ? 1 : -1)).slice(0, 15);
    const nearby = places.citiesNear(city.lat, city.lon, 30).filter(c => c.slug !== city.slug && c.pop >= 2000).slice(0, 12);
    const radarCov = mesh.coverage();
    const thin = !rows.length;

    res.send(page({
      title: `${city.name}, ${st} Hail History & Recent Hail Storms | StormCheck Pro`,
      description: `${city.name}, ${name} hail history: ${damaging5} days with 1"+ hail within 5 miles in the last 5 years${largest ? `, largest ${inch(largest.best)} on ${fmtShort(largest.date)}` : ''}. From NOAA radar and NWS records.`,
      path: `/hail/${st.toLowerCase()}/${city.slug}`,
      noindex: thin,
      jsonld: breadcrumbs([['Home', '/'], [name, `/hail/${st.toLowerCase()}`], [city.name, `/hail/${st.toLowerCase()}/${city.slug}`]]),
      body: `<section class="dark" style="padding:48px 0"><div class="wrap">
        <p class="crumbs"><a href="/hail/${st.toLowerCase()}">${esc(name)}</a> / ${esc(city.name)}</p>
        <h1>${esc(city.name)}, ${st} hail history</h1>
        <p class="lede">Hail within 5 miles of ${esc(city.name)} over the last 10 years, from NOAA radar estimates and National Weather Service storm reports.</p>
        <div class="stats">
          <div class="stat"><b>${damaging5}</b><span>Days with 1"+ hail, last 5 years</span></div>
          <div class="stat"><b>${largest ? inch(largest.best) : '-'}</b><span>Largest hail${largest ? `, ${fmtShort(largest.date)}` : ''}</span></div>
          <div class="stat"><b>${latest ? fmtShort(latest.date) : '-'}</b><span>Most recent 1"+ hail day</span></div>
        </div>
      </div></section>
      <section><div class="wrap">
        <h2>Biggest hail days near ${esc(city.name)}</h2>
        ${top.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Date</th><th>Radar estimate (within 5 mi)</th><th>Ground reports</th><th>Likely impact</th></tr></thead><tbody>
        ${top.map(r => `<tr><td>${stormDays.get(r.date) ? `<a href="/hail-maps/${r.date}">${fmtShort(r.date)}</a>` : fmtShort(r.date)}</td><td>${r.radarIn ? inch(r.radarIn) : '-'}</td><td>${r.reports ? `${r.reports} (up to ${inch(r.reportMax)})` : '-'}</td><td>${esc(severity(r.best).level)}</td></tr>`).join('')}
        </tbody></table></div>` : `<p class="lede">No hail of 0.75" or larger has been recorded within 5 miles${radarCov.first ? ` since ${fmtShort(radarCov.first)}` : ''}. Our radar history is still loading; this page fills in as it does.</p>`}
        <p style="color:var(--muted-2);font-size:15px;margin-top:12px">City-level history covers a 5-mile radius around the city center. Results for a single address can be very different.</p>
        <p style="margin-top:20px"><a class="btn btn-navy" href="/register">Check your exact address</a></p>
      </div></section>
      ${nearby.length ? `<section class="white"><div class="wrap"><h2>Nearby cities</h2><div class="chips">${nearby.map(c => `<a class="chip" href="/hail/${c.state.toLowerCase()}/${c.slug}">${esc(c.name)}, ${c.state}</a>`).join('')}</div></div></section>` : ''}
      <section><div class="wrap narrow"><h2>Free hail alerts for ${esc(city.name)}</h2>${freeAlertForm()}</div></section>`,
    }));
  });

  // ── Sample report (live data for a fixed public location) ──────────────────
  app.get('/sample-report', (req, res) => {
    const lat = parseFloat(process.env.SAMPLE_LAT || '32.9343'), lon = parseFloat(process.env.SAMPLE_LON || '-97.0781');
    const label = process.env.SAMPLE_LABEL || 'Grapevine, TX (city center)';
    const r = report.buildReport(lat, lon, { years: 10 });
    const dates = r.stormDates.filter(s => s.bestEstimateIn >= 0.75).slice(0, 15);
    const badge = s => s.confidence === 'Verified' ? '<span class="badge badge-verified">Verified</span>'
      : s.confidence === 'Radar' ? '<span class="badge badge-radar">Radar</span>' : '<span class="badge badge-ground">Ground report</span>';
    res.send(page({
      title: 'Sample Storm Report | StormCheck Pro',
      description: 'See a live StormCheck Pro property report: radar hail at the property, verified storm dates, a ranked date-of-loss list and an impact score.',
      path: '/sample-report',
      body: `<section class="dark" style="padding:48px 0"><div class="wrap">
        <p class="eyebrow">Live sample</p>
        <h1>Sample report: ${esc(label)}</h1>
        <p class="lede">This is a real report run on live NOAA data for a public location. Your reports look the same, for any address you enter, with your company name and logo on paid plans.</p>
        <div class="stats">
          <div class="stat"><b>${r.score}/100</b><span>Impact score</span></div>
          <div class="stat"><b>${inch(r.stats.largestAtPropertyIn)}</b><span>Largest hail at the property</span></div>
          <div class="stat"><b>${r.stats.verifiedDays}</b><span>Verified hail days (radar + ground)</span></div>
          <div class="stat"><b>${r.stats.total}</b><span>Storm reports within 10 miles</span></div>
        </div>
      </div></section>
      <section><div class="wrap">
        <h2>Most likely dates of loss</h2>
        <div class="table-wrap"><table class="data"><thead><tr><th>Date</th><th>Hail at property</th><th>Confidence</th><th>Ground reports within 3 mi</th></tr></thead><tbody>
        ${r.dateOfLoss.map(s => `<tr><td>${fmtShort(s.date)}</td><td><strong>${inch(s.bestEstimateIn)}</strong> ${esc(s.sizeName || '')}</td><td>${badge(s)}</td><td>${s.groundReports.hailWithin3mi}</td></tr>`).join('') || '<tr><td colspan="4">No damaging storms in the period covered yet.</td></tr>'}
        </tbody></table></div>
        <h2 style="margin-top:48px">Every hail day at the property</h2>
        <div class="table-wrap"><table class="data"><thead><tr><th>Date</th><th>Radar at property</th><th>Radar within 1 mi</th><th>Radar within 3 mi</th><th>Severity</th></tr></thead><tbody>
        ${dates.map(s => `<tr><td>${fmtShort(s.date)}</td><td>${s.radar ? inch(s.radar.atPropertyIn) : '-'}</td><td>${s.radar ? inch(s.radar.within1miIn) : '-'}</td><td>${s.radar ? inch(s.radar.within3miIn) : '-'}</td><td>${esc(s.severity)}</td></tr>`).join('') || '<tr><td colspan="5">No hail days yet.</td></tr>'}
        </tbody></table></div>
        <p style="margin-top:28px"><a class="btn btn-accent" href="/register">Run your free report</a></p>
      </div></section>`,
    }));
  });

  // ── Sitemap & robots ──────────────────────────────────────────────────────
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /dashboard\nDisallow: /admin\nSitemap: ${baseUrl()}/sitemap.xml\n`);
  });

  app.get('/sitemap.xml', (req, res) => {
    const urls = ['/', '/hail-maps', '/alerts', '/sample-report'];
    for (const st of Object.keys(places.STATE_NAMES)) urls.push(`/hail/${st.toLowerCase()}`);
    const cutoff = new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10);
    for (const s of stormDays.recent({ limit: 2000, minIn: 1 })) {
      if (s.date < cutoff) continue;
      urls.push(`/hail-maps/${s.date}`);
      for (const st of s.states) urls.push(`/hail-maps/${s.date}/${st.toLowerCase()}`);
    }
    for (const st of Object.keys(places.STATE_NAMES)) {
      for (const c of places.citiesInState(st, 5000)) urls.push(`/hail/${st.toLowerCase()}/${c.slug}`);
    }
    const base = baseUrl();
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.slice(0, 50000).map(u => `<url><loc>${esc(base + u)}</loc></url>`).join('\n')}\n</urlset>`);
  });

  app.get(['/hail/*', '/hail-maps/*'], (req, res) => res.status(404).send(notFound()));

  function notFound() {
    return page({ title: 'Storm not found | StormCheck Pro', description: 'Storm not found', path: '/hail-maps', noindex: true,
      body: '<section><div class="wrap narrow"><h1>No hail map for that date.</h1><p class="lede">We only publish maps for days when radar showed hail. <a href="/hail-maps">See recent storms</a>.</p></div></section>' });
  }
};
