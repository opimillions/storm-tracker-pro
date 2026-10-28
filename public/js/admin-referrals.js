/* Admin → Referrals & Partners: every referral, and free partner invite links. */
(function () {
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var box = 'background:#fff;border:1px solid var(--border);border-radius:10px;padding:18px';
  var input = 'padding:8px;border:1.5px solid var(--border);border-radius:6px;font-size:0.9em';
  async function api(url, method, body) {
    var r = await fetch(url, { method: method || 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    var d = {}; try { d = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error(d.error || 'Request failed');
    return d;
  }
  window.loadReferrals = async function () {
    var root = document.getElementById('referralsRoot');
    var d; try { d = await api('/api/admin/referrals'); } catch (e) { root.textContent = e.message; return; }
    var opts = function (cur) { return Object.entries(d.statuses).map(function (e) { return '<option value="' + e[0] + '"' + (e[0] === cur ? ' selected' : '') + '>' + esc(e[1]) + '</option>'; }).join(''); };
    var counts = {}; d.referrals.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });
    root.innerHTML =
      '<div style="' + box + '"><div style="font-weight:700;color:var(--navy);font-size:1.05em;margin-bottom:4px">Free partner invite links</div>' +
        '<div style="color:#5b6a80;font-size:0.88em;margin-bottom:10px">Anyone who signs up through a link gets a free Partner account (Pro features, no card). ' + d.partners + ' partner account' + (d.partners === 1 ? '' : 's') + ' so far. Keep free access independent of referrals: no quotas, and never take it away for not sending work.</div>' +
        '<div id="invMsg" class="alert" style="display:none;margin-bottom:10px"></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
          '<input id="invCode" placeholder="Code, e.g. DFW-ROOFERS" style="' + input + ';width:190px;text-transform:uppercase">' +
          '<input id="invLabel" placeholder="Note shown on sign-up (optional)" style="' + input + ';width:250px">' +
          '<input id="invMax" type="number" min="0" placeholder="Max sign-ups (0 = no limit)" style="' + input + ';width:200px">' +
          '<input id="invExp" type="date" title="Expires (optional)" style="' + input + '">' +
          '<button class="btn btn-primary btn-sm" id="invAdd">Create link</button></div>' +
        '<div style="overflow-x:auto;margin-top:12px"><table><thead><tr><th>Link</th><th>Note</th><th>Sign-ups</th><th>Limit</th><th>Expires</th><th>Status</th><th></th></tr></thead><tbody>' +
          (d.invites.length ? d.invites.map(function (i) {
            return '<tr><td><code style="font-size:0.85em">' + esc(i.link) + '</code> <button class="btn btn-outline btn-sm" data-copy="' + esc(i.link) + '">Copy</button></td><td>' + esc(i.label || '') + '</td><td>' + i.signups + '</td><td>' + (i.maxUses || '—') + '</td><td>' + esc(i.expiresAt || '—') + '</td><td>' + (i.active ? 'Active' : 'Off') + '</td>' +
              '<td><button class="btn btn-outline btn-sm" data-inv="' + esc(i._id) + '" data-on="' + (i.active ? '0' : '1') + '">' + (i.active ? 'Turn off' : 'Turn on') + '</button></td></tr>';
          }).join('') : '<tr><td colspan="7" style="text-align:center;color:#5b6a80;padding:14px">No links yet.</td></tr>') +
        '</tbody></table></div></div>' +
      '<div style="' + box + '"><div style="font-weight:700;color:var(--navy);font-size:1.05em;margin-bottom:4px">All referrals · ' + d.referrals.length + '</div>' +
        '<div style="color:#5b6a80;font-size:0.88em;margin-bottom:10px">' + Object.entries(counts).map(function (e) { return esc(d.statuses[e[0]] || e[0]) + ': ' + e[1]; }).join(' · ') + '</div>' +
        '<div style="overflow-x:auto"><table><thead><tr><th>Sent</th><th>Homeowner</th><th>Property</th><th>From</th><th>To</th><th>Status</th></tr></thead><tbody>' +
          (d.referrals.length ? d.referrals.map(function (r) {
            return '<tr><td>' + esc(new Date(r.createdAt).toLocaleDateString()) + '</td>' +
              '<td><strong>' + esc(r.homeownerName) + '</strong><div style="font-size:0.8em;color:#5b6a80">' + esc(r.homeownerPhone || '') + ' ' + esc(r.homeownerEmail || '') + '</div></td>' +
              '<td>' + esc(r.address) + '<div style="font-size:0.8em;color:#5b6a80">' + esc(d.reasons[r.reason] || '') + (r.carrier ? ' · ' + esc(r.carrier) : '') + '</div></td>' +
              '<td>' + esc(r.contractorCompany || r.contractorName) + '<div style="font-size:0.8em;color:#5b6a80">' + esc(r.contractorEmail) + '</div></td>' +
              '<td>' + esc(r.proName) + '<div style="font-size:0.8em"><a href="' + esc(r.statusLink) + '" target="_blank">status page</a></div></td>' +
              '<td><select data-ref="' + esc(r._id) + '" style="' + input + '">' + opts(r.status) + '</select></td></tr>';
          }).join('') : '<tr><td colspan="6" style="text-align:center;color:#5b6a80;padding:14px">No referrals yet.</td></tr>') +
        '</tbody></table></div></div>';

    document.getElementById('invAdd').onclick = async function () {
      var m = document.getElementById('invMsg');
      try {
        await api('/api/admin/invites', 'POST', { code: document.getElementById('invCode').value, label: document.getElementById('invLabel').value, maxUses: document.getElementById('invMax').value, expiresAt: document.getElementById('invExp').value });
        await window.loadReferrals();
      } catch (e) { m.className = 'alert alert-error'; m.style.display = 'block'; m.textContent = e.message; }
    };
    root.querySelectorAll('[data-copy]').forEach(function (b) { b.onclick = function () { try { navigator.clipboard.writeText(b.getAttribute('data-copy')); b.textContent = 'Copied'; } catch (e) {} }; });
    root.querySelectorAll('[data-inv]').forEach(function (b) { b.onclick = async function () { await api('/api/admin/invites/' + b.getAttribute('data-inv'), 'PATCH', { active: b.getAttribute('data-on') === '1' }); window.loadReferrals(); }; });
    root.querySelectorAll('[data-ref]').forEach(function (s) { s.onchange = async function () { try { await api('/api/admin/referrals/' + s.getAttribute('data-ref'), 'PATCH', { status: s.value }); } catch (e) { alert(e.message); } }; });
  };
})();
