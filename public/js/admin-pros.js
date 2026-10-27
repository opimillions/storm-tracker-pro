/* Admin → Find a Pro: review applications, edit listings, sponsored placement. */
(function () {
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var box = 'background:#fff;border:1px solid var(--border);border-radius:10px;padding:18px';
  var input = 'padding:8px;border:1.5px solid var(--border);border-radius:6px;font-size:0.9em;width:100%';
  var data = null, editing = null;
  var CAT = { 'public-adjuster': 'Public adjuster', appraiser: 'Appraiser', attorney: 'Attorney' };
  var SLUG = { 'public-adjuster': 'public-adjusters', appraiser: 'appraisers', attorney: 'attorneys' };

  async function api(url, method, body) {
    var r = await fetch(url, { method: method || 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    var d = {}; try { d = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error(d.error || 'Request failed');
    return d;
  }
  function note(text, ok) {
    var el = document.getElementById('proMsg'); if (!el) return;
    el.style.display = text ? 'block' : 'none'; el.className = 'alert ' + (ok ? 'alert-success' : 'alert-error'); el.textContent = text || '';
  }

  window.loadPros = async function () {
    var root = document.getElementById('prosRoot');
    try { data = await api('/api/admin/pros'); } catch (e) { root.textContent = e.message; return; }
    var s = data.settings;
    var pending = data.listings.filter(function (l) { return l.status === 'pending'; });
    var row = function (l) {
      var sp = l.sponsored ? '<span style="color:#7A4A06;font-weight:700">Sponsored' + (l.sponsorUntil ? ' to ' + esc(l.sponsorUntil) : '') + '</span>' : '';
      return '<tr><td><strong>' + esc(l.company) + '</strong>' + (l.operatorOwned ? ' <span style="font-size:0.75em;color:#5b6a80">(yours)</span>' : '') + '<div style="font-size:0.8em;color:#5b6a80">' + esc(l.contactName || '') + ' ' + esc(l.email || '') + '</div></td>' +
        '<td>' + esc(CAT[l.category] || l.category) + '</td><td>' + esc((l.states || []).join(', ')) + '</td>' +
        '<td>' + esc(l.license || '—') + (l.verified ? ' <span style="color:#17603A">✓</span>' : '') + '</td>' +
        '<td>' + (l.status === 'active' ? 'Live' : l.status === 'pending' ? '<strong style="color:#b45309">Needs review</strong>' : 'Hidden') + (sp ? '<br>' + sp : '') + '</td>' +
        '<td style="font-size:0.85em">' + (l.views || 0) + ' views<br>' + (l.clicks || 0) + ' site · ' + (l.calls || 0) + ' calls</td>' +
        '<td style="white-space:nowrap"><button class="btn btn-outline btn-sm" data-edit="' + esc(l._id) + '">Edit</button>' +
        (l.status === 'active' && l.states && l.states[0] ? ' <a class="btn btn-outline btn-sm" target="_blank" href="/find-a-pro/' + SLUG[l.category] + '/' + l.states[0].toLowerCase() + '">View</a>' : '') + '</td></tr>';
    };
    root.innerHTML =
      '<div style="' + box + '">' +
        '<div style="font-weight:700;color:var(--navy);font-size:1.05em;margin-bottom:6px">Find a Pro directory</div>' +
        '<div style="color:#5b6a80;font-size:0.88em;line-height:1.5;margin-bottom:12px">Public pages: <a href="/find-a-pro" target="_blank">/find-a-pro</a>. Pros apply at <a href="/find-a-pro/get-listed" target="_blank">/find-a-pro/get-listed</a>; check their license with the state before approving. ' +
        'Sponsored placement puts a listing at the top of its states with a "Sponsored" label. Sell it as a flat monthly fee, never per lead or per referral, and have an attorney review the program before the first sale.</div>' +
        '<div id="proMsg" class="alert" style="display:none;margin-bottom:12px"></div>' +
        '<label style="font-size:0.88em;display:flex;gap:8px;align-items:center"><input type="checkbox" id="proSpOn"' + (s.sponsoredEnabled ? ' checked' : '') + '> Show sponsored placements</label>' +
        '<label style="font-size:0.85em;display:block;margin-top:10px">Ownership disclosure (shown on every directory page)<textarea id="proDisc" rows="2" style="' + input + ';margin-top:4px">' + esc(s.disclosure) + '</textarea></label>' +
        '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-primary btn-sm" id="proSaveSet">Save</button><button class="btn btn-outline btn-sm" id="proAdd">+ Add listing</button></div>' +
      '</div>' +
      '<div id="proEditor"></div>' +
      (pending.length ? '<div style="' + box + ';border-color:#f59e0b"><div style="font-weight:700;margin-bottom:8px">' + pending.length + ' listing' + (pending.length > 1 ? 's' : '') + ' waiting for review</div><div style="overflow-x:auto"><table><thead><tr><th>Company</th><th>Type</th><th>States</th><th>License</th><th>Status</th><th>Results</th><th></th></tr></thead><tbody>' + pending.map(row).join('') + '</tbody></table></div></div>' : '') +
      '<div style="' + box + '"><div style="font-weight:700;margin-bottom:8px">All listings</div><div style="overflow-x:auto"><table><thead><tr><th>Company</th><th>Type</th><th>States</th><th>License</th><th>Status</th><th>Results</th><th></th></tr></thead><tbody>' +
        (data.listings.length ? data.listings.map(row).join('') : '<tr><td colspan="7" style="text-align:center;color:#5b6a80;padding:16px">No listings yet.</td></tr>') +
      '</tbody></table></div></div>';

    document.getElementById('proSaveSet').onclick = async function () {
      try { await api('/api/admin/pros/settings', 'POST', { sponsoredEnabled: document.getElementById('proSpOn').checked, disclosure: document.getElementById('proDisc').value }); note('Saved.', true); }
      catch (e) { note(e.message, false); }
    };
    document.getElementById('proAdd').onclick = function () { edit({ category: 'public-adjuster', states: [], status: 'active', showLicense: true }); };
    document.querySelectorAll('[data-edit]').forEach(function (b) {
      b.onclick = function () { edit(data.listings.find(function (l) { return l._id === b.getAttribute('data-edit'); })); };
    });
    if (editing) edit(editing);
  };

  function field(label, html) { return '<label style="font-size:0.85em;display:block">' + label + '<div style="margin-top:4px">' + html + '</div></label>'; }
  function txt(id, v, ph) { return '<input id="' + id + '" value="' + esc(v || '') + '" placeholder="' + esc(ph || '') + '" style="' + input + '">'; }

  function edit(l) {
    editing = l;
    var el = document.getElementById('proEditor');
    var isNew = !l._id;
    el.innerHTML = '<div style="' + box + ';border-color:var(--navy)">' +
      '<div style="font-weight:700;margin-bottom:12px">' + (isNew ? 'Add listing' : 'Edit ' + esc(l.company)) + '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">' +
        field('Type', '<select id="pe-cat" style="' + input + '">' + Object.keys(CAT).map(function (k) { return '<option value="' + k + '"' + (l.category === k ? ' selected' : '') + '>' + CAT[k] + '</option>'; }).join('') + '</select>') +
        field('Company', txt('pe-company', l.company)) +
        field('Contact name', txt('pe-contact', l.contactName)) +
        field('Email (private)', txt('pe-email', l.email)) +
        field('Phone', txt('pe-phone', l.phone)) +
        field('Website', txt('pe-web', l.website, 'https://')) +
        field('States served (e.g. TX, OK)', txt('pe-states', (l.states || []).join(', '))) +
        field('Main areas', txt('pe-areas', l.areas)) +
        field('License or bar number', txt('pe-lic', l.license)) +
        field('Status', '<select id="pe-status" style="' + input + '"><option value="active"' + (l.status === 'active' ? ' selected' : '') + '>Live</option><option value="pending"' + (l.status === 'pending' ? ' selected' : '') + '>Needs review</option><option value="hidden"' + (l.status === 'hidden' ? ' selected' : '') + '>Hidden</option></select>') +
      '</div>' +
      field('<span style="display:block;margin-top:12px">Description (400 characters)</span>', '<textarea id="pe-desc" maxlength="400" rows="3" style="' + input + '">' + esc(l.description || '') + '</textarea>') +
      '<div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:12px;font-size:0.88em">' +
        '<label><input type="checkbox" id="pe-showlic"' + (l.showLicense !== false ? ' checked' : '') + '> Show license number</label>' +
        '<label><input type="checkbox" id="pe-verified"' + (l.verified ? ' checked' : '') + '> License checked</label>' +
        '<label><input type="checkbox" id="pe-owned"' + (l.operatorOwned ? ' checked' : '') + '> My own firm</label>' +
      '</div>' +
      '<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)"><div style="font-weight:600;font-size:0.9em;margin-bottom:8px">Sponsored placement</div>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;align-items:end">' +
          '<label style="font-size:0.88em"><input type="checkbox" id="pe-sp"' + (l.sponsored ? ' checked' : '') + '> Sponsored</label>' +
          field('Sponsored in states (blank = all its states)', txt('pe-spstates', (l.sponsorStates || []).join(', '))) +
          field('Paid through', '<input type="date" id="pe-spuntil" value="' + esc(l.sponsorUntil || '') + '" style="' + input + '">') +
        '</div>' +
        '<div style="font-size:0.8em;color:#5b6a80;margin-top:6px">Shows only while "Show sponsored placements" is on.</div>' +
      '</div>' +
      (l.notes != null || !isNew ? field('<span style="display:block;margin-top:12px">Private notes</span>', '<textarea id="pe-notes" rows="2" style="' + input + '">' + esc(l.notes || '') + '</textarea>') : '') +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px"><button class="btn btn-primary btn-sm" id="pe-save">' + (isNew ? 'Add listing' : 'Save') + '</button>' +
        '<button class="btn btn-outline btn-sm" id="pe-cancel">Cancel</button>' +
        (isNew ? '' : '<button class="btn btn-outline btn-sm" id="pe-del" style="margin-left:auto;color:#b91c1c">Delete</button>') + '</div>' +
    '</div>';
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    var v = function (id) { var x = document.getElementById(id); return x ? x.value : undefined; };
    var c = function (id) { return document.getElementById(id).checked; };
    document.getElementById('pe-cancel').onclick = function () { editing = null; el.innerHTML = ''; };
    document.getElementById('pe-save').onclick = async function () {
      var body = {
        category: v('pe-cat'), company: v('pe-company'), contactName: v('pe-contact'), email: v('pe-email'), phone: v('pe-phone'),
        website: v('pe-web'), states: v('pe-states'), areas: v('pe-areas'), license: v('pe-lic'), status: v('pe-status'),
        description: v('pe-desc'), showLicense: c('pe-showlic'), verified: c('pe-verified'), operatorOwned: c('pe-owned'),
        sponsored: c('pe-sp'), sponsorStates: v('pe-spstates'), sponsorUntil: v('pe-spuntil'), notes: v('pe-notes'),
      };
      try {
        if (isNew) await api('/api/admin/pros', 'POST', body); else await api('/api/admin/pros/' + encodeURIComponent(l._id), 'PATCH', body);
        editing = null; await window.loadPros(); note('Listing saved.', true);
      } catch (e) { note(e.message, false); }
    };
    var del = document.getElementById('pe-del');
    if (del) del.onclick = async function () {
      if (!confirm('Delete ' + l.company + '?')) return;
      await api('/api/admin/pros/' + encodeURIComponent(l._id), 'DELETE');
      editing = null; window.loadPros();
    };
  }

  // Links like /admin#pros (from the new-listing email) open this tab.
  function fromHash() { var t = location.hash.slice(1); if ((t === 'pros' || t === 'recaps' || t === 'security') && window.switchTab) window.switchTab(t); }
  // After every admin script has loaded (they define the tab loaders).
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fromHash); else setTimeout(fromHash, 0);
  window.addEventListener('hashchange', fromHash);
})();
