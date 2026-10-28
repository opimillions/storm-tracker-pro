/**
 * Referrals: "Ask a public adjuster" / "Ask an appraiser".
 *
 * A contractor sends a homeowner's claim (with the homeowner's OK) to a public
 * adjuster or appraiser from the Find a Pro directory. The pro gets an email
 * with a private link to update the status; the contractor sees the status on
 * the Referrals tab. Pros join the list through /find-a-pro/get-listed.
 *
 * Partner invites: /join/<CODE> gives a free Partner account. Free access is
 * never tied to sending referrals (no quotas), which keeps it from looking
 * like payment for referrals.
 */
const path = require('path');
const fs = require('fs');
const { dataPath } = require('./lib/paths');
const { sendMail, layout, baseUrl, escapeHtml: esc } = require('./lib/mailer');

const CATS = { 'public-adjuster': 'public adjuster', appraiser: 'appraiser' };
const STATUSES = {
  new: 'New', contacted: 'Contacted homeowner', inspection: 'Inspection scheduled',
  signed: 'Signed / working the claim', 'not-a-fit': 'Not a fit', closed: 'Closed',
};
const REASONS = {
  'help-filing': 'Needs help filing a claim',
  denied: 'Claim denied',
  underpaid: 'Claim underpaid / low estimate',
  'appraisal': 'Disagreement on the amount (appraisal)',
  'supplement': 'Supplement or scope dispute',
  other: 'Other',
};

const SETTINGS = () => dataPath('referral-settings.json');
const DEFAULT_SETTINGS = { programName: 'Partner Program', note: '' };
function settings() { try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS(), 'utf8')) }; } catch { return { ...DEFAULT_SETTINGS }; } }

const clean = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const isEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

module.exports = function referralRoutes(app, { db, requireAuth, requireAdmin, geocodeAddress }) {
  const { referralOps, inviteOps, proOps, userOps } = db;

  /** Pros a contractor can send to: your own firm first, then verified, then A–Z. */
  async function prosFor(category, state) {
    const list = (await proOps.active(category)).filter(p => !state || (p.states || []).includes(state));
    return list.sort((a, b) => (b.operatorOwned ? 1 : 0) - (a.operatorOwned ? 1 : 0)
      || (b.verified ? 1 : 0) - (a.verified ? 1 : 0) || a.company.localeCompare(b.company));
  }
  const recipientFor = p => (p.email && isEmail(p.email) ? p.email : (process.env.ADMIN_EMAIL || null));

  // ── Contractor side ───────────────────────────────────────────────────────
  app.get('/referrals', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'referrals.html')));

  app.get('/api/referrals/pros', requireAuth, async (req, res) => {
    const category = CATS[req.query.category] ? req.query.category : 'public-adjuster';
    const st = /^[A-Z]{2}$/.test(String(req.query.state || '').toUpperCase()) ? String(req.query.state).toUpperCase() : null;
    let list = await prosFor(category, st);
    if (!list.length && st) list = await prosFor(category, null); // nobody serves that state yet: show everyone
    res.json({
      pros: list.map(p => ({ id: p._id, company: p.company, areas: p.areas || '', states: p.states || [], verified: !!p.verified, yours: !!p.operatorOwned, phone: p.phone || '', website: p.website || '' })),
      reasons: REASONS,
    });
  });

  app.get('/api/referrals', requireAuth, async (req, res) => {
    const list = await referralOps.forUser(req.user._id);
    res.json({
      statuses: STATUSES, reasons: REASONS,
      referrals: list.map(r => ({
        id: r._id, category: r.category, proName: r.proName, homeownerName: r.homeownerName, address: r.address,
        reason: r.reason, status: r.status, statusLabel: STATUSES[r.status] || r.status, createdAt: r.createdAt,
        updatedAt: r.updatedAt || r.createdAt, lastNote: ((r.history || []).filter(h => h.note).slice(-1)[0] || {}).note || '',
      })),
    });
  });

  const sendLimit = new Map();
  app.post('/api/referrals', requireAuth, async (req, res) => {
    const b = req.body || {};
    const category = CATS[b.category] ? b.category : null;
    if (!category) return res.status(400).json({ error: 'Choose public adjuster or appraiser.' });
    const r = {
      homeownerName: clean(b.homeownerName, 80), homeownerPhone: clean(b.homeownerPhone, 30).replace(/[^\d()+\-.\s x]/g, ''),
      homeownerEmail: clean(b.homeownerEmail, 120).toLowerCase(), address: clean(b.address, 200),
      carrier: clean(b.carrier, 80), claimNumber: clean(b.claimNumber, 60),
      dateOfLoss: /^\d{4}-\d{2}-\d{2}$/.test(b.dateOfLoss) ? b.dateOfLoss : '',
      reason: REASONS[b.reason] ? b.reason : 'other', notes: clean(b.notes, 1500),
    };
    if (!r.homeownerName || !r.address) return res.status(400).json({ error: 'Enter the homeowner\'s name and the property address.' });
    if (!r.homeownerPhone && !isEmail(r.homeownerEmail)) return res.status(400).json({ error: 'Enter the homeowner\'s phone or email so the pro can reach them.' });
    if (r.homeownerEmail && !isEmail(r.homeownerEmail)) return res.status(400).json({ error: 'The homeowner\'s email doesn\'t look right.' });
    if (b.consent !== true) return res.status(400).json({ error: 'Confirm the homeowner agreed to be contacted.' });
    const id = String(req.user._id), now = Date.now();
    const recent = (sendLimit.get(id) || []).filter(t => now - t < 86400000);
    if (recent.length >= 25) return res.status(429).json({ error: 'You can send 25 referrals a day. Contact support if you need more.' });

    const pro = b.proId ? await proOps.get(String(b.proId)) : null;
    if (!pro || pro.status !== 'active' || pro.category !== category) return res.status(400).json({ error: 'Choose who to send it to.' });
    const to = recipientFor(pro);
    if (!to) return res.status(500).json({ error: 'That professional has no email on file. Choose another or contact support.' });

    let lat = parseFloat(b.lat), lon = parseFloat(b.lon), state = String(b.state || '').toUpperCase().slice(0, 2);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      try { const g = await geocodeAddress(r.address); if (g) { lat = g.lat; lon = g.lon; state = g.state || state; r.address = g.formattedAddress || r.address; } } catch { /* optional */ }
    }
    recent.push(now); sendLimit.set(id, recent);
    const u = req.user;
    const doc = await referralOps.create({
      ...r, category, proId: pro._id, proName: pro.company, sentTo: to,
      lat: Number.isFinite(lat) ? lat : null, lon: Number.isFinite(lon) ? lon : null, state: state || null,
      userId: u._id, contractorName: u.name || '', contractorCompany: u.company || '', contractorEmail: u.email, contractorPhone: u.phone || '',
      consent: true,
    });

    const link = `${baseUrl()}/referral/${doc.token}`;
    const report = Number.isFinite(lat) && Number.isFinite(lon) ? `${baseUrl()}/dashboard?address=${encodeURIComponent(r.address)}&lat=${lat}&lon=${lon}` : null;
    const row = (k, v) => v ? `<tr><td style="padding:6px 10px 6px 0;color:#5b6a80;vertical-align:top;white-space:nowrap">${k}</td><td style="padding:6px 0">${v}</td></tr>` : '';
    await sendMail({
      to,
      subject: `New ${CATS[category]} referral: ${r.homeownerName}, ${r.address}`,
      html: layout(`Referral from ${esc(u.company || u.name || 'a contractor')}`, `
        <p><strong>${esc(u.name || '')}</strong>${u.company ? ` (${esc(u.company)})` : ''} sent you a homeowner who asked for a ${CATS[category]}. The homeowner agreed to be contacted.</p>
        <table style="font-size:14px;border-collapse:collapse;margin:10px 0">
          ${row('Homeowner', esc(r.homeownerName))}
          ${row('Phone', r.homeownerPhone ? `<a href="tel:${esc(r.homeownerPhone.replace(/[^\d+]/g, ''))}">${esc(r.homeownerPhone)}</a>` : '')}
          ${row('Email', r.homeownerEmail ? `<a href="mailto:${esc(r.homeownerEmail)}">${esc(r.homeownerEmail)}</a>` : '')}
          ${row('Property', esc(r.address))}
          ${row('Situation', esc(REASONS[r.reason]))}
          ${row('Insurance company', esc(r.carrier))}
          ${row('Claim number', esc(r.claimNumber))}
          ${row('Date of loss', esc(r.dateOfLoss))}
          ${row('Notes', esc(r.notes))}
          ${row('Contractor', `${esc(u.name || '')} · <a href="mailto:${esc(u.email)}">${esc(u.email)}</a>`)}
        </table>
        <p><a href="${link}" style="background:#172235;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Update the status</a>
        ${report ? `&nbsp; <a href="${report}">Storm history for this property</a>` : ''}</p>
        <p style="color:#5b6a80;font-size:13px">The contractor sees the status you set. Keep this link private.</p>`),
    });
    sendMail({
      to: u.email,
      subject: `Referral sent to ${pro.company}`,
      html: layout('Referral sent', `<p>${esc(pro.company)} has ${esc(r.homeownerName)}'s details for ${esc(r.address)}. You'll see their updates on the <a href="${baseUrl()}/referrals">Referrals tab</a>.</p>`),
    }).catch(() => {});
    res.json({ success: true, id: doc._id, proName: pro.company });
  });

  // ── Pro side: private status link (no account needed) ─────────────────────
  app.get('/referral/:token', async (req, res) => {
    const r = await referralOps.byToken(req.params.token);
    if (!r) return res.status(404).send(statusPage('Referral not found', '<p>This link is not valid. Check the email you received.</p>'));
    res.send(statusPage(`Referral: ${r.homeownerName}`, `
      <p><strong>${esc(r.homeownerName)}</strong> · ${esc(r.address)}<br>
      ${r.homeownerPhone ? `<a href="tel:${esc(r.homeownerPhone.replace(/[^\d+]/g, ''))}">${esc(r.homeownerPhone)}</a> · ` : ''}${r.homeownerEmail ? `<a href="mailto:${esc(r.homeownerEmail)}">${esc(r.homeownerEmail)}</a>` : ''}</p>
      <p style="color:#5b6a80">${esc(REASONS[r.reason] || '')}${r.carrier ? ` · ${esc(r.carrier)}` : ''}${r.dateOfLoss ? ` · Date of loss ${esc(r.dateOfLoss)}` : ''}</p>
      ${r.notes ? `<p style="background:#f8fafc;border-radius:8px;padding:10px 12px">${esc(r.notes)}</p>` : ''}
      <p>From ${esc(r.contractorName)}${r.contractorCompany ? ` (${esc(r.contractorCompany)})` : ''} · <a href="mailto:${esc(r.contractorEmail)}">${esc(r.contractorEmail)}</a></p>
      <form id="st" style="display:grid;gap:10px;margin-top:16px">
        <label style="font-weight:700">Status
          <select name="status" style="display:block;width:100%;min-height:46px;margin-top:4px;padding:0 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:16px">
            ${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}"${k === r.status ? ' selected' : ''}>${esc(v)}</option>`).join('')}
          </select></label>
        <label style="font-weight:700">Note for the contractor (optional)
          <textarea name="note" rows="3" maxlength="500" style="display:block;width:100%;margin-top:4px;padding:10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit"></textarea></label>
        <button style="min-height:48px;border:0;border-radius:8px;background:#172235;color:#fff;font-weight:700;font-size:16px;cursor:pointer">Save status</button>
        <p id="m" role="status"></p>
      </form>
      <p style="color:#5b6a80;font-size:14px">History: ${(r.history || []).map(h => `${esc(STATUSES[h.status] || h.status)} (${esc(h.at.slice(0, 10))})`).join(' → ')}</p>
      <script>
      document.getElementById('st').addEventListener('submit', async function (e) {
        e.preventDefault(); var f = e.target, m = document.getElementById('m');
        var r = await fetch(location.pathname + '/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(f))) });
        m.textContent = r.ok ? 'Saved. The contractor can see the new status.' : 'Could not save. Try again.';
      });
      </script>`));
  });

  app.post('/referral/:token/status', async (req, res) => {
    const r = await referralOps.byToken(req.params.token);
    if (!r) return res.status(404).json({ error: 'Not found' });
    const status = STATUSES[req.body && req.body.status] ? req.body.status : null;
    if (!status) return res.status(400).json({ error: 'Choose a status.' });
    const note = clean(req.body.note, 500);
    if (status === r.status && !note) return res.json({ success: true });
    await referralOps.setStatus(r._id, status, 'pro', note);
    sendMail({
      to: r.contractorEmail,
      subject: `Referral update: ${r.homeownerName} is "${STATUSES[status]}"`,
      html: layout('Referral update', `<p>${esc(r.proName)} updated ${esc(r.homeownerName)} (${esc(r.address)}) to <strong>${esc(STATUSES[status])}</strong>.</p>${note ? `<p>"${esc(note)}"</p>` : ''}<p><a href="${baseUrl()}/referrals">See all your referrals</a></p>`),
    }).catch(() => {});
    res.json({ success: true });
  });

  // ── Partner invites ───────────────────────────────────────────────────────
  app.get('/join/:code', async (req, res) => {
    const inv = await inviteOps.usable(req.params.code);
    if (!inv) return res.redirect('/register?invite=expired');
    res.cookie('scp_invite', inv.code, { maxAge: 30 * 86400000, httpOnly: true, sameSite: 'lax', secure: !!req.secure });
    res.redirect(`/register?invite=${encodeURIComponent(inv.code)}`);
  });
  app.get('/api/invites/:code', async (req, res) => {
    const inv = await inviteOps.usable(req.params.code);
    res.json(inv ? { valid: true, label: inv.label || '', program: settings().programName } : { valid: false });
  });

  // ── Admin ─────────────────────────────────────────────────────────────────
  const admin = [requireAuth, requireAdmin];
  app.get('/api/admin/referrals', ...admin, async (req, res) => {
    const [list, inv] = await Promise.all([referralOps.all(), inviteOps.all()]);
    const users = await userOps.getAll();
    res.json({
      statuses: STATUSES, reasons: REASONS, settings: settings(), base: baseUrl(),
      referrals: list.map(r => ({ ...r, token: undefined, statusLink: `${baseUrl()}/referral/${r.token}` })),
      invites: inv.map(i => ({ ...i, link: `${baseUrl()}/join/${i.code}`, signups: users.filter(u => u.invitedBy === i.code).length })),
      partners: users.filter(u => u.tier === 'partner').length,
    });
  });
  app.patch('/api/admin/referrals/:id', ...admin, async (req, res) => {
    const status = STATUSES[req.body && req.body.status] ? req.body.status : null;
    if (!status) return res.status(400).json({ error: 'Choose a status.' });
    res.json({ referral: await referralOps.setStatus(req.params.id, status, 'admin', clean(req.body.note, 500)) });
  });
  app.post('/api/admin/invites', ...admin, async (req, res) => {
    const code = String((req.body && req.body.code) || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 30);
    if (code.length < 4) return res.status(400).json({ error: 'Use a code of at least 4 letters or numbers, like DFW-ROOFERS.' });
    if (await inviteOps.usable(code)) return res.status(400).json({ error: 'That code already exists.' });
    try {
      res.json({ invite: await inviteOps.create({
        code, label: clean(req.body.label, 80), maxUses: Math.max(0, parseInt(req.body.maxUses, 10) || 0),
        expiresAt: /^\d{4}-\d{2}-\d{2}$/.test(req.body.expiresAt) ? req.body.expiresAt : null,
      }) });
    } catch { res.status(400).json({ error: 'That code already exists.' }); }
  });
  app.patch('/api/admin/invites/:id', ...admin, async (req, res) => {
    await inviteOps.update(req.params.id, { active: !!(req.body && req.body.active) });
    res.json({ success: true });
  });
  app.post('/api/admin/referral-settings', ...admin, (req, res) => {
    const next = { ...settings(), programName: clean(req.body.programName, 60) || DEFAULT_SETTINGS.programName, note: clean(req.body.note, 300) };
    fs.writeFileSync(SETTINGS(), JSON.stringify(next));
    res.json({ settings: next });
  });
};

function statusPage(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} | StormCheck Pro</title></head>
<body style="margin:0;background:#f4f6f9;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#172235;font-size:16px;line-height:1.5">
<div style="background:#172235;color:#fff;padding:16px 20px;font-weight:800">Storm<span style="color:#F2A93B">Check</span> Pro · Referral</div>
<main style="max-width:640px;margin:20px auto;padding:0 16px"><div style="background:#fff;border-radius:12px;padding:20px 22px;box-shadow:0 2px 8px rgba(0,0,0,.06)">
<h1 style="font-size:22px;margin:0 0 10px">${esc(title)}</h1>${body}</div></main></body></html>`;
}

module.exports.STATUSES = STATUSES;
