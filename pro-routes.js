/**
 * Find a Pro: public directory of public adjusters, appraisers and attorneys.
 *
 * - Listings are free. Anyone can apply; an admin reviews, verifies the
 *   license and publishes.
 * - Sponsored placement (top of a state, labeled "Sponsored") is built in but
 *   OFF until enabled on Admin → Find a Pro. It is meant to be sold as a flat
 *   monthly ad fee, never per lead or per referral.
 * - Every page shows the ownership disclosure, because the site owner's own
 *   firms are listed.
 */
const places = require('./lib/places');
const fs = require('fs');
const { dataPath } = require('./lib/paths');
const { sendMail, layout, baseUrl } = require('./lib/mailer');
const { page, rateLimited, esc } = require('./public-pages');

const CATS = {
  'public-adjusters': { key: 'public-adjuster', label: 'Public Adjusters', one: 'public adjuster',
    blurb: 'Licensed adjusters who work for the property owner, not the insurance company, to document and negotiate a claim.' },
  appraisers: { key: 'appraiser', label: 'Appraisers & Umpires', one: 'appraiser',
    blurb: 'Independent appraisers and umpires for the insurance appraisal process when you and the insurer disagree on the amount of loss.' },
  attorneys: { key: 'attorney', label: 'Attorneys', one: 'attorney',
    blurb: 'Lawyers who handle property insurance disputes, denied claims and bad-faith cases.' },
};
const SLUG_OF = Object.fromEntries(Object.entries(CATS).map(([slug, c]) => [c.key, slug]));

const DEFAULT_SETTINGS = {
  sponsoredEnabled: false,
  disclosure: 'StormCheck Pro is owned by the founder of First Call Public Adjusters and First Call Appraisal, which are listed in this directory.',
};
const SETTINGS = () => dataPath('pro-settings.json');
function settings() { try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS(), 'utf8')) }; } catch { return { ...DEFAULT_SETTINGS }; } }
function saveSettings(p) {
  const cur = settings();
  const next = {
    sponsoredEnabled: p.sponsoredEnabled != null ? !!p.sponsoredEnabled : cur.sponsoredEnabled,
    disclosure: p.disclosure != null ? String(p.disclosure).trim().slice(0, 400) : cur.disclosure,
  };
  fs.writeFileSync(SETTINGS(), JSON.stringify(next));
  return next;
}

// Owner's own firms, added once on first start (edit or remove them on the admin page).
const SEED = [
  {
    category: 'public-adjuster', company: 'First Call Public Adjusters', website: 'https://thepublicadjustertx.com',
    phone: '(817) 618-9884', states: ['TX', 'OK', 'CO'], areas: 'Dallas–Fort Worth, Waco and statewide',
    license: 'TX #1921679', showLicense: true, verified: true, operatorOwned: true, status: 'active',
    description: 'Licensed public adjusters who represent property owners on hail, wind, water and fire claims, with Haag-certified roof inspection.',
  },
  {
    category: 'appraiser', company: 'First Call Appraisal', website: 'https://firstcallappraisal.com',
    phone: '', states: ['TX'], areas: 'Texas', license: '', showLicense: false, verified: true, operatorOwned: true, status: 'active',
    description: 'Insurance appraisal for disputed property claims: policyholder appraiser and umpire services.',
  },
];

const STATES = places.STATE_NAMES;
const cleanStates = list => [...new Set((Array.isArray(list) ? list : String(list || '').split(/[\s,]+/))
  .map(s => String(s).trim().toUpperCase()).filter(s => STATES[s]))].slice(0, 51);
const cleanUrl = u => {
  u = String(u || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.toString().slice(0, 200) : ''; } catch { return ''; }
};

/** Normalize listing fields from a form or the admin API. */
function sanitize(b, { admin = false } = {}) {
  const out = {
    category: CATS[SLUG_OF[b.category]] ? b.category : 'public-adjuster',
    company: String(b.company || '').trim().slice(0, 100),
    contactName: String(b.contactName || '').trim().slice(0, 80),
    phone: String(b.phone || '').replace(/[^\d()+\-.\s x]/g, '').trim().slice(0, 30),
    email: String(b.email || '').trim().toLowerCase().slice(0, 120),
    website: cleanUrl(b.website),
    states: cleanStates(b.states),
    areas: String(b.areas || '').trim().slice(0, 140),
    license: String(b.license || '').trim().slice(0, 60),
    showLicense: b.showLicense !== false && b.showLicense !== 'false',
    description: String(b.description || '').trim().slice(0, 400),
  };
  if (admin) {
    if (b.status != null) out.status = ['active', 'pending', 'hidden'].includes(b.status) ? b.status : 'pending';
    if (b.verified != null) out.verified = !!b.verified;
    if (b.operatorOwned != null) out.operatorOwned = !!b.operatorOwned;
    if (b.sponsored != null) out.sponsored = !!b.sponsored;
    if (b.sponsorStates != null) out.sponsorStates = cleanStates(b.sponsorStates);
    if (b.sponsorUntil != null) out.sponsorUntil = /^\d{4}-\d{2}-\d{2}$/.test(b.sponsorUntil) ? b.sponsorUntil : '';
    if (b.notes != null) out.notes = String(b.notes).slice(0, 1000);
  }
  return out;
}

const today = () => new Date().toISOString().slice(0, 10);
function isSponsoredIn(p, st, cfg) {
  return cfg.sponsoredEnabled && p.sponsored && (!p.sponsorUntil || p.sponsorUntil >= today())
    && (!p.sponsorStates || !p.sponsorStates.length || p.sponsorStates.includes(st));
}

/** Listings for a category serving a state: sponsored first (if on), then verified, then A–Z. */
function arrange(list, st, cfg) {
  const serving = list.filter(p => (p.states || []).includes(st));
  const sponsored = serving.filter(p => isSponsoredIn(p, st, cfg));
  // Rotate sponsors daily so paying listings share the top spot fairly.
  const day = Math.floor(Date.now() / 86400000);
  sponsored.sort((a, b) => a.company.localeCompare(b.company));
  const rot = sponsored.length ? day % sponsored.length : 0;
  const top = sponsored.slice(rot).concat(sponsored.slice(0, rot));
  const rest = serving.filter(p => !top.includes(p))
    .sort((a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0) || a.company.localeCompare(b.company));
  return { top, rest };
}

// ── Rendering ───────────────────────────────────────────────────────────────
const CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

const STYLE = `<style>
.pro-grid{display:grid;gap:16px}
.pro{background:#fff;border:1px solid var(--line);border-radius:14px;padding:20px 22px;display:grid;gap:8px}
.pro.sp{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.pro h3{margin:0;font-size:21px}
.pro .meta{color:var(--muted-2);font-size:15px}
.pro .tags{display:flex;flex-wrap:wrap;gap:6px}
.tag{display:inline-flex;align-items:center;gap:4px;font-size:13px;font-weight:700;border-radius:999px;padding:3px 10px;background:var(--blue-bg);color:var(--blue)}
.tag.ok{background:#E3F4EA;color:#17603A}.tag.sp{background:#FDF0DB;color:#7A4A06}
.pro .acts{display:flex;flex-wrap:wrap;gap:10px;margin-top:4px}
.pro .acts .btn{min-height:44px;padding:8px 16px;font-size:16px}
.btn-line{border-color:var(--line);color:var(--ink);background:#fff}
.disc{font-size:14px;color:var(--muted-2);background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px 14px}
.cats{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
.cat{background:#fff;border:1px solid var(--line);border-radius:14px;padding:22px;text-decoration:none;color:var(--ink);display:block}
.cat:hover{border-color:var(--blue)}
.cat b{font-family:Archivo,sans-serif;font-size:22px;display:block;margin-bottom:6px}
.cat span{color:var(--muted);font-size:16px}
.states-pick{display:flex;flex-wrap:wrap;gap:8px}
.states-pick a{background:#fff;border:1px solid var(--line);border-radius:8px;padding:6px 10px;text-decoration:none;font-size:15px}
.find{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}
.find .field{display:flex;flex-direction:column;gap:4px;font-weight:600;font-size:15px}
.find select,.find input{min-height:48px;border:1px solid var(--line);border-radius:10px;padding:0 12px;font:inherit;font-size:16px;background:#fff}
.dark .find .field{color:#fff}
</style>`;

function card(p, { sponsored = false, slug }) {
  const phone = p.phone ? `<a class="btn btn-navy" href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}" data-pro="${esc(p._id)}" data-kind="call">Call ${esc(p.phone)}</a>` : '';
  const site = p.website ? `<a class="btn btn-line" href="/find-a-pro/go/${esc(p._id)}" target="_blank" rel="${sponsored ? 'sponsored ' : ''}nofollow noopener">Website</a>` : '';
  const tags = [
    sponsored ? '<span class="tag sp">Sponsored</span>' : '',
    p.verified ? `<span class="tag ok">${CHECK} License checked</span>` : '',
    p.operatorOwned ? '<span class="tag">Owned by StormCheck Pro\'s founder</span>' : '',
  ].join('');
  return `<article class="pro${sponsored ? ' sp' : ''}">
    ${tags.trim() ? `<div class="tags">${tags}</div>` : ''}
    <h3>${esc(p.company)}</h3>
    <div class="meta">${esc(CATS[slug].one.replace(/^./, c => c.toUpperCase()))} · Serves ${esc((p.states || []).join(', '))}${p.areas ? ` · ${esc(p.areas)}` : ''}</div>
    ${p.description ? `<p style="margin:0">${esc(p.description)}</p>` : ''}
    ${p.showLicense && p.license ? `<div class="meta">License ${esc(p.license)}</div>` : ''}
    ${phone || site ? `<div class="acts">${phone}${site}</div>` : ''}
  </article>`;
}

function findForm(slug, st = '', dark = false) {
  const opts = Object.entries(CATS).map(([s, c]) => `<option value="${s}"${s === slug ? ' selected' : ''}>${esc(c.label)}</option>`).join('');
  const stOpts = Object.entries(STATES).map(([ab, n]) => `<option value="${ab.toLowerCase()}"${ab === st ? ' selected' : ''}>${esc(n)}</option>`).join('');
  return `<form class="find" action="/find-a-pro/search" method="get">
    <label class="field">Looking for<select name="cat">${opts}</select></label>
    <label class="field">ZIP code<input name="zip" inputmode="numeric" pattern="[0-9]{5}" maxlength="5" placeholder="76092" style="width:130px"></label>
    <label class="field">or state<select name="state"><option value="">Choose…</option>${stOpts}</select></label>
    <button class="btn btn-accent" type="submit">Find</button>
  </form>${dark ? '' : ''}`;
}

const disclosure = cfg => cfg.disclosure ? `<p class="disc">${esc(cfg.disclosure)} Listings are not endorsements; check any professional's license with your state before hiring.${cfg.sponsoredEnabled ? ' Listings marked "Sponsored" are paid advertising.' : ''}</p>` : '';

module.exports = function proRoutes(app, { db, requireAuth, requireAdmin }) {
  const { proOps } = db;

  // Seed the owner's own listings once.
  (async () => {
    try { if ((await proOps.count()) === 0) for (const s of SEED) await proOps.create({ ...s, seeded: true }); }
    catch (e) { console.error('[pros] seed:', e.message); }
  })();

  // ── Public pages ──────────────────────────────────────────────────────────
  app.get('/find-a-pro', async (req, res) => {
    // From a report: ?lat=&lon= → that state's public adjusters.
    const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const c = places.nearestCity(lat, lon);
      const slug = CATS[req.query.cat] ? req.query.cat : 'public-adjusters';
      if (c && c.state) return res.redirect(302, `/find-a-pro/${slug}/${c.state.toLowerCase()}`);
    }
    const cfg = settings();
    res.send(page({
      title: 'Find a Public Adjuster, Appraiser or Attorney | StormCheck Pro',
      description: 'Find a licensed public adjuster, insurance appraiser or property insurance attorney near you for a hail or storm damage claim.',
      path: '/find-a-pro',
      head: STYLE,
      body: `<section class="dark" style="padding:56px 0"><div class="wrap">
          <h1>Find a pro for your storm claim</h1>
          <p class="lede">Public adjusters, appraisers and attorneys who handle hail and wind damage claims, by state.</p>
          ${findForm('public-adjusters')}
        </div></section>
        <section style="padding-top:48px"><div class="wrap">
          <div class="cats">${Object.entries(CATS).map(([s, c]) => `<a class="cat" href="/find-a-pro/${s}"><b>${esc(c.label)}</b><span>${esc(c.blurb)}</span></a>`).join('')}</div>
          <div style="margin-top:28px">${disclosure(cfg)}</div>
          <p style="margin-top:24px">Are you a public adjuster, appraiser or attorney? <a href="/find-a-pro/get-listed">Get listed free</a>.</p>
        </div></section>`,
    }));
  });

  app.get('/find-a-pro/search', (req, res) => {
    const slug = CATS[req.query.cat] ? req.query.cat : 'public-adjusters';
    let st = String(req.query.state || '').toUpperCase();
    const z = req.query.zip ? places.zipInfo(String(req.query.zip).trim()) : null;
    if (z) st = z.state;
    if (!STATES[st]) return res.redirect(302, `/find-a-pro/${slug}`);
    res.redirect(302, `/find-a-pro/${slug}/${st.toLowerCase()}`);
  });

  app.get('/find-a-pro/get-listed', (req, res) => {
    const stBoxes = Object.entries(STATES).map(([ab]) => `<label style="display:inline-flex;gap:4px;align-items:center;font-weight:400;font-size:15px;min-width:64px"><input type="checkbox" name="states" value="${ab}">${ab}</label>`).join(' ');
    res.send(page({
      title: 'Get Listed in Find a Pro | StormCheck Pro',
      description: 'Public adjusters, insurance appraisers and attorneys: get a free listing in the StormCheck Pro directory.',
      path: '/find-a-pro/get-listed',
      head: STYLE,
      body: `<section><div class="wrap narrow">
        <p class="crumbs"><a href="/find-a-pro">Find a pro</a> / Get listed</p>
        <h1>Get listed free</h1>
        <p class="lede">Basic listings are free. We review every listing and check licenses before it goes live, usually within two business days. Listed public adjusters and appraisers also appear on the Referrals tab, where contractors using StormCheck Pro can send you homeowners who ask for help. No referral fees, either way.</p>
        <form id="apply" style="display:grid;gap:14px">
          <div class="form-row">
            <div class="field"><label for="a-cat">Type</label><select id="a-cat" name="category">${Object.values(CATS).map(c => `<option value="${c.key}">${esc(c.one.replace(/^./, x => x.toUpperCase()))}</option>`).join('')}</select></div>
            <div class="field" style="flex:2 1 260px"><label for="a-co">Company or firm name</label><input id="a-co" name="company" required maxlength="100"></div>
          </div>
          <div class="form-row">
            <div class="field"><label for="a-name">Your name</label><input id="a-name" name="contactName" required maxlength="80" autocomplete="name"></div>
            <div class="field"><label for="a-email">Email</label><input id="a-email" name="email" type="email" required autocomplete="email"></div>
            <div class="field"><label for="a-phone">Business phone</label><input id="a-phone" name="phone" type="tel" autocomplete="tel"></div>
          </div>
          <div class="form-row">
            <div class="field" style="flex:2 1 260px"><label for="a-web">Website</label><input id="a-web" name="website" placeholder="https://"></div>
            <div class="field"><label for="a-lic">License or bar number</label><input id="a-lic" name="license" placeholder="e.g. TX #1234567" maxlength="60"></div>
          </div>
          <fieldset style="border:1px solid var(--line);border-radius:10px;padding:12px 14px"><legend style="font-weight:700;padding:0 6px">States you're licensed in and serve</legend>${stBoxes}</fieldset>
          <div class="field"><label for="a-areas">Main cities or areas (optional)</label><input id="a-areas" name="areas" maxlength="140" placeholder="Dallas–Fort Worth, Austin"></div>
          <div class="field"><label for="a-desc">Short description (400 characters max)</label><textarea id="a-desc" name="description" maxlength="400" rows="3" style="border:1px solid var(--line);border-radius:10px;padding:10px;font:inherit"></textarea></div>
          <label style="display:flex;gap:10px;align-items:flex-start;font-size:15px"><input type="checkbox" name="attest" required style="margin-top:4px">I am licensed and in good standing in the states selected, and the information above is accurate.</label>
          <div><button class="btn btn-accent" type="submit">Submit listing</button></div>
          <p data-msg role="status" style="margin:0"></p>
        </form>
        <script>
        document.getElementById('apply').addEventListener('submit', async function (e) {
          e.preventDefault(); var f = e.target, msg = f.querySelector('[data-msg]'), btn = f.querySelector('button');
          var data = Object.fromEntries(new FormData(f)); data.states = Array.from(f.querySelectorAll('input[name=states]:checked')).map(function (x) { return x.value; });
          if (!data.states.length) { msg.className = 'notice err'; msg.textContent = 'Choose at least one state.'; return; }
          btn.disabled = true; msg.className = ''; msg.textContent = 'Sending…';
          try {
            var r = await fetch('/api/public/pros/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
            var d = await r.json();
            msg.className = 'notice ' + (r.ok ? 'ok' : 'err');
            msg.textContent = r.ok ? 'Thanks! We will review your listing and email you when it is live.' : (d.error || 'Something went wrong.');
            if (r.ok) f.reset();
          } catch (err) { msg.className = 'notice err'; msg.textContent = 'Network error. Try again.'; }
          btn.disabled = false;
        });
        </script>
      </div></section>`,
    }));
  });

  app.get('/find-a-pro/:cat', async (req, res, next) => {
    const slug = req.params.cat;
    const cat = CATS[slug];
    if (!cat) return next();
    const counts = {};
    for (const p of await proOps.active(cat.key)) for (const s of p.states || []) counts[s] = (counts[s] || 0) + 1;
    const cfg = settings();
    res.send(page({
      title: `Find ${cat.label} by State | StormCheck Pro`,
      description: `${cat.blurb} Choose your state to see ${cat.label.toLowerCase()} who handle storm damage claims.`,
      path: `/find-a-pro/${slug}`,
      head: STYLE,
      body: `<section class="dark" style="padding:56px 0"><div class="wrap">
          <p class="crumbs"><a href="/find-a-pro">Find a pro</a> / ${esc(cat.label)}</p>
          <h1>${esc(cat.label)}</h1><p class="lede">${esc(cat.blurb)}</p>${findForm(slug)}
        </div></section>
        <section style="padding-top:40px"><div class="wrap">
          <h2>Choose a state</h2>
          <div class="states-pick">${Object.entries(STATES).map(([ab, n]) => `<a href="/find-a-pro/${slug}/${ab.toLowerCase()}">${esc(n)}${counts[ab] ? ` (${counts[ab]})` : ''}</a>`).join('')}</div>
          <div style="margin-top:28px">${disclosure(cfg)}</div>
        </div></section>`,
    }));
  });

  app.get('/find-a-pro/:cat/:state', async (req, res, next) => {
    const slug = req.params.cat, cat = CATS[slug];
    const st = String(req.params.state).toUpperCase();
    if (!cat || !STATES[st]) return next();
    const cfg = settings();
    const { top, rest } = arrange(await proOps.active(cat.key), st, cfg);
    const all = [...top, ...rest];
    proOps.bump(all.map(p => p._id), 'views').catch(() => {});
    const name = STATES[st];
    const others = Object.entries(CATS).filter(([s]) => s !== slug).map(([s, c]) => `<a href="/find-a-pro/${s}/${st.toLowerCase()}">${esc(c.label)} in ${esc(name)}</a>`).join(' · ');
    res.send(page({
      title: `${cat.label} in ${name} for Storm Damage Claims | StormCheck Pro`,
      description: `${all.length ? `${all.length} ` : ''}${cat.label.toLowerCase()} serving ${name} for hail, wind and storm damage insurance claims.`,
      path: `/find-a-pro/${slug}/${st.toLowerCase()}`,
      noindex: !all.length,
      head: STYLE,
      body: `<section class="dark" style="padding:48px 0"><div class="wrap">
          <p class="crumbs"><a href="/find-a-pro">Find a pro</a> / <a href="/find-a-pro/${slug}">${esc(cat.label)}</a> / ${esc(name)}</p>
          <h1>${esc(cat.label)} in ${esc(name)}</h1><p class="lede">${esc(cat.blurb)}</p>${findForm(slug, st)}
        </div></section>
        <section style="padding-top:36px"><div class="wrap narrow">
          ${disclosure(cfg)}
          <div class="pro-grid" style="margin-top:18px">
            ${all.length ? all.map(p => card(p, { sponsored: top.includes(p), slug })).join('')
              : `<div class="pro"><h3>No ${esc(cat.label.toLowerCase())} listed in ${esc(name)} yet</h3><p style="margin:0">Are you one? <a href="/find-a-pro/get-listed">Get listed free</a>.</p></div>`}
          </div>
          <p style="margin-top:24px">Also in ${esc(name)}: ${others}</p>
          <p>Wondering whether hail hit a property? <a href="/register">Run a free storm report</a>. Are you ${/^[aeiou]/i.test(cat.one) ? 'an' : 'a'} ${esc(cat.one)}? <a href="/find-a-pro/get-listed">Get listed free</a>.</p>
        </div></section>
        <script>
        document.querySelectorAll('[data-kind=call]').forEach(function (a) {
          a.addEventListener('click', function () { try { navigator.sendBeacon('/find-a-pro/call/' + a.getAttribute('data-pro')); } catch (e) {} });
        });
        </script>`,
    }));
  });

  // Website clicks and calls are counted so listings can see their results.
  app.get('/find-a-pro/go/:id', async (req, res) => {
    const p = await proOps.get(req.params.id);
    if (!p || p.status !== 'active' || !p.website) return res.redirect(302, '/find-a-pro');
    proOps.bump([p._id], 'clicks').catch(() => {});
    res.redirect(302, p.website);
  });
  app.post('/find-a-pro/call/:id', async (req, res) => {
    proOps.bump([String(req.params.id)], 'calls').catch(() => {});
    res.status(204).end();
  });

  app.post('/api/public/pros/apply', async (req, res) => {
    if (rateLimited(req.ip, 5)) return res.status(429).json({ error: 'Too many requests. Try again later.' });
    const b = req.body || {};
    if (!b.attest) return res.status(400).json({ error: 'Please confirm you are licensed.' });
    const p = sanitize(b);
    if (!p.company || !p.contactName) return res.status(400).json({ error: 'Enter your company and name.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!p.states.length) return res.status(400).json({ error: 'Choose at least one state.' });
    const doc = await proOps.create({ ...p, status: 'pending', verified: false, source: 'application' });
    const admin = process.env.ADMIN_EMAIL;
    if (admin) {
      sendMail({
        to: admin,
        subject: `New Find a Pro listing: ${p.company}`,
        html: layout('New directory listing to review', `<p><strong>${esc(p.company)}</strong> (${esc(CATS[SLUG_OF[p.category]].one)}) applied to be listed.</p>
          <p>${esc(p.contactName)} · ${esc(p.email)} · ${esc(p.phone)}<br>States: ${esc(p.states.join(', '))}<br>License: ${esc(p.license || 'not given')}</p>
          <p><a href="${baseUrl()}/admin#pros">Review it on the admin page</a></p>`),
      }).catch(() => {});
    }
    res.json({ success: true, id: doc._id });
  });

  // ── Admin ─────────────────────────────────────────────────────────────────
  const admin = [requireAuth, requireAdmin];
  app.get('/api/admin/pros', ...admin, async (req, res) => {
    res.json({ settings: settings(), listings: await proOps.all(), categories: Object.values(CATS).map(c => ({ key: c.key, label: c.label })) });
  });
  app.post('/api/admin/pros/settings', ...admin, (req, res) => res.json({ settings: saveSettings(req.body || {}) }));
  app.post('/api/admin/pros', ...admin, async (req, res) => {
    const p = sanitize(req.body || {}, { admin: true });
    if (!p.company) return res.status(400).json({ error: 'Company name is required.' });
    if (!p.states.length) return res.status(400).json({ error: 'Choose at least one state.' });
    res.json({ listing: await proOps.create({ status: 'active', ...p }) });
  });
  app.patch('/api/admin/pros/:id', ...admin, async (req, res) => {
    const cur = await proOps.get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Not found' });
    const p = sanitize({ ...cur, ...req.body }, { admin: true });
    const wasLive = cur.status === 'active';
    await proOps.update(cur._id, p);
    if (!wasLive && p.status === 'active' && cur.source === 'application' && cur.email) {
      sendMail({
        to: cur.email,
        subject: 'Your StormCheck Pro listing is live',
        html: layout('Your listing is live', `<p>${esc(p.company)} is now listed in the StormCheck Pro Find a Pro directory.</p>
          <p><a href="${baseUrl()}/find-a-pro/${SLUG_OF[p.category]}/${(p.states[0] || '').toLowerCase()}">See your listing</a></p>`),
      }).catch(() => {});
    }
    res.json({ listing: await proOps.get(cur._id) });
  });
  app.delete('/api/admin/pros/:id', ...admin, async (req, res) => { await proOps.remove(req.params.id); res.json({ success: true }); });
};

module.exports._arrange = arrange;
module.exports._sanitize = sanitize;
module.exports.CATS = CATS;
