/* Admin → Storm Recaps: prospect list, settings, preview and send. */
(function () {
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var state = null;
  var box = 'background:#fff;border:1px solid var(--border);border-radius:10px;padding:18px';
  var h = function (t) { return '<div style="font-weight:700;color:var(--navy);font-size:1.05em;margin-bottom:6px">' + t + '</div>'; };
  var sub = function (t) { return '<div style="color:#5b6a80;font-size:0.88em;margin-bottom:12px;line-height:1.5">' + t + '</div>'; };
  var input = 'padding:8px;border:1.5px solid var(--border);border-radius:6px;font-size:0.9em';

  async function api(url, opts) {
    var r = await fetch(url, opts ? { method: opts.method || 'POST', headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined } : undefined);
    var d = {}; try { d = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error(d.error || 'Request failed');
    return d;
  }
  function msg(id, text, ok) {
    var el = document.getElementById(id); if (!el) return;
    el.style.display = text ? 'block' : 'none';
    el.className = 'alert ' + (ok ? 'alert-success' : 'alert-error');
    el.textContent = text || '';
  }

  window.loadRecaps = async function () {
    var root = document.getElementById('recapsRoot');
    try { state = await api('/api/admin/recaps'); } catch (e) { root.textContent = e.message; return; }
    var s = state.settings, c = state.counts;
    var days = state.recentDays.map(function (d) { return '<option value="' + d.date + '">' + d.date + (d.maxIn ? ' (max ' + d.maxIn.toFixed(2) + '")' : '') + '</option>'; }).join('');
    root.innerHTML =
      '<div style="' + box + '">' + h('Storm recap emails') +
        sub('After a storm, prospects whose area was hit get a short recap: a hail swath map, the hardest-hit cities, the largest hail and the radar severe hail probability, with a link to start a free trial. Free alert subscribers already get the same recap for their ZIP code. Unsubscribes are permanent and every email includes your mailing address, as U.S. law (CAN-SPAM) requires.') +
        '<div id="rcMsg" class="alert" style="display:none;margin-bottom:12px"></div>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px">' +
          '<label style="font-size:0.85em">Send automatically<br><select id="rcEnabled" style="' + input + ';width:100%"><option value="false">Off</option><option value="true">On, after each storm</option></select></label>' +
          '<label style="font-size:0.85em">Minimum hail size<br><select id="rcMin" style="' + input + ';width:100%">' + [0.75, 1, 1.25, 1.5, 1.75, 2].map(function (v) { return '<option value="' + v + '">' + v.toFixed(2) + '" and up</option>'; }).join('') + '</select></label>' +
          '<label style="font-size:0.85em">Distance from prospect<br><select id="rcRadius" style="' + input + ';width:100%">' + [10, 25, 35, 50, 75, 100].map(function (v) { return '<option value="' + v + '">' + v + ' miles</option>'; }).join('') + '</select></label>' +
          '<label style="font-size:0.85em">At most one recap every<br><select id="rcGap" style="' + input + ';width:100%">' + [1, 2, 3, 5, 7, 14].map(function (v) { return '<option value="' + v + '">' + v + ' day' + (v > 1 ? 's' : '') + '</option>'; }).join('') + '</select></label>' +
          '<label style="font-size:0.85em">Daily limit<br><input id="rcCap" type="number" min="1" max="5000" style="' + input + ';width:100%"></label>' +
        '</div>' +
        '<label style="font-size:0.85em;display:block;margin-top:12px">Business mailing address (shown in every recap)<br><input id="rcAddress" placeholder="Street, City, ST 00000" style="' + input + ';width:100%;max-width:520px"></label>' +
        (state.envAddress && !s.address ? '<div style="font-size:0.8em;color:#5b6a80;margin-top:4px">Using BUSINESS_ADDRESS from the server settings.</div>' : '') +
        '<div style="margin-top:12px"><button class="btn btn-primary btn-sm" id="rcSave">Save settings</button></div>' +
      '</div>' +

      '<div style="' + box + '">' + h('Preview and send') +
        sub('Pick a storm day. Preview shows the email a prospect in that ZIP code would get. "Count" shows how many prospects are in the hit area before you send.') +
        '<div id="rcSendMsg" class="alert" style="display:none;margin-bottom:12px"></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
          '<select id="rcDate" style="' + input + '">' + days + '</select>' +
          '<input id="rcDateOther" type="date" style="' + input + '" title="Or pick another date">' +
          '<input id="rcZip" placeholder="ZIP to preview" inputmode="numeric" maxlength="5" style="' + input + ';width:130px">' +
          '<button class="btn btn-outline btn-sm" id="rcPreview">Preview</button>' +
          '<button class="btn btn-outline btn-sm" id="rcTest">Email me a test</button>' +
          '<button class="btn btn-outline btn-sm" id="rcCount">Count recipients</button>' +
          '<button class="btn btn-primary btn-sm" id="rcSend">Send to prospects</button>' +
        '</div>' +
        '<div id="rcPreviewBox" style="margin-top:14px;display:none"><div id="rcSubject" style="font-weight:700;margin-bottom:8px"></div><iframe id="rcFrame" title="Email preview" style="width:100%;max-width:680px;height:760px;border:1px solid var(--border);border-radius:8px;background:#f5f7fa"></iframe></div>' +
      '</div>' +

      '<div style="' + box + '">' + h('Prospect list') +
        sub('<strong>' + c.active + '</strong> active · ' + c.unsubscribed + ' unsubscribed. Upload a CSV with an <code>email</code> column and either <code>zip</code> or <code>city</code> + <code>state</code>. Optional: <code>name</code>, <code>company</code>. People who unsubscribed are never re-added, and paying customers are skipped automatically. Only upload contacts you have a legitimate business reason to email.') +
        '<div id="rcImportMsg" class="alert" style="display:none;margin-bottom:12px"></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
          '<input type="file" id="rcFile" accept=".csv,text/csv" style="font-size:0.85em">' +
          '<button class="btn btn-primary btn-sm" id="rcImport">Upload list</button>' +
          '<a class="btn btn-outline btn-sm" href="/api/admin/recaps/prospects.csv">Download list</a>' +
        '</div>' +
        '<div style="overflow-x:auto;margin-top:14px"><table><thead><tr><th>Email</th><th>Name</th><th>Company</th><th>Area</th><th>Status</th><th>Recaps</th><th>Last</th><th></th></tr></thead><tbody>' +
          (state.prospects.length ? state.prospects.map(function (p) {
            return '<tr><td>' + esc(p.email) + '</td><td>' + esc(p.name) + '</td><td>' + esc(p.company) + '</td><td>' + esc(p.label) + '</td><td>' + (p.active ? 'Active' : '<span style="color:#b91c1c">Unsubscribed</span>') + '</td><td>' + p.recaps + '</td><td>' + esc(p.lastRecapDate || '—') + '</td><td><button class="btn btn-outline btn-sm" data-del="' + esc(p._id) + '">Remove</button></td></tr>';
          }).join('') : '<tr><td colspan="8" style="text-align:center;color:#5b6a80;padding:16px">No prospects yet. Upload a CSV to start.</td></tr>') +
        '</tbody></table></div>' +
        (c.active + c.unsubscribed > state.prospects.length ? '<div style="font-size:0.8em;color:#5b6a80;margin-top:6px">Showing the newest ' + state.prospects.length + '. Download the list for everyone.</div>' : '') +
      '</div>' +

      '<div style="' + box + '">' + h('Recent sends') +
        (state.runs.length ? '<table><thead><tr><th>When</th><th>Storm day</th><th>Sent</th><th>In hit area</th><th>Skipped (sent recently)</th><th>Failed</th><th>How</th></tr></thead><tbody>' + state.runs.map(function (r) {
          return '<tr><td>' + esc(new Date(r.at).toLocaleString()) + '</td><td>' + esc(r.date) + '</td><td>' + r.sent + '</td><td>' + r.inArea + '</td><td>' + r.skippedRecent + '</td><td>' + r.failed + '</td><td>' + (r.manual ? 'Manual' : 'Automatic') + '</td></tr>';
        }).join('') + '</tbody></table>' : sub('Nothing sent yet.')) +
      '</div>';

    document.getElementById('rcEnabled').value = String(!!s.enabled);
    document.getElementById('rcMin').value = String(s.minIn);
    document.getElementById('rcRadius').value = String(s.radiusMi);
    document.getElementById('rcGap').value = String(s.minDaysBetween);
    document.getElementById('rcCap').value = s.dailyCap;
    document.getElementById('rcAddress').value = s.address || '';
    bind();
  };

  function pickedDate() { return document.getElementById('rcDateOther').value || document.getElementById('rcDate').value; }

  function bind() {
    document.getElementById('rcSave').onclick = async function () {
      try {
        await api('/api/admin/recaps/settings', { body: {
          enabled: document.getElementById('rcEnabled').value === 'true',
          minIn: document.getElementById('rcMin').value, radiusMi: document.getElementById('rcRadius').value,
          minDaysBetween: document.getElementById('rcGap').value, dailyCap: document.getElementById('rcCap').value,
          address: document.getElementById('rcAddress').value,
        } });
        msg('rcMsg', 'Settings saved.', true);
      } catch (e) { msg('rcMsg', e.message, false); document.getElementById('rcEnabled').value = 'false'; }
    };

    async function preview(send) {
      msg('rcSendMsg', '');
      try {
        var d = await api('/api/admin/recaps/preview', { body: { date: pickedDate(), zip: document.getElementById('rcZip').value, send: !!send } });
        var pb = document.getElementById('rcPreviewBox');
        if (d.none) { pb.style.display = 'none'; msg('rcSendMsg', d.message, false); return; }
        pb.style.display = 'block';
        document.getElementById('rcSubject').textContent = 'Subject: ' + d.subject;
        document.getElementById('rcFrame').srcdoc = '<body style="margin:0;padding:16px;background:#f5f7fa">' + d.html + '</body>';
        if (d.sentTo) msg('rcSendMsg', 'Test sent to ' + d.sentTo + '.', true);
      } catch (e) { msg('rcSendMsg', e.message, false); }
    }
    document.getElementById('rcPreview').onclick = function () { preview(false); };
    document.getElementById('rcTest').onclick = function () { preview(true); };

    document.getElementById('rcCount').onclick = async function () {
      try {
        var d = await api('/api/admin/recaps/send', { body: { date: pickedDate(), dryRun: true } });
        if (d.skipped) return msg('rcSendMsg', 'Not ready: ' + d.skipped + '.', false);
        msg('rcSendMsg', d.inArea + ' prospect' + (d.inArea === 1 ? '' : 's') + ' would get this recap' + (d.skippedRecent ? ' (' + d.skippedRecent + ' skipped because they got one recently)' : '') + '.', true);
      } catch (e) { msg('rcSendMsg', e.message, false); }
    };

    document.getElementById('rcSend').onclick = async function () {
      var date = pickedDate();
      if (!confirm('Send the ' + date + ' storm recap to every prospect in the hit area?')) return;
      try {
        await api('/api/admin/recaps/send', { body: { date: date } });
        msg('rcSendMsg', 'Sending now. Results appear under Recent sends in a few minutes.', true);
      } catch (e) { msg('rcSendMsg', e.message, false); }
    };

    document.getElementById('rcImport').onclick = async function () {
      var f = document.getElementById('rcFile').files[0];
      if (!f) return msg('rcImportMsg', 'Choose a CSV file first.', false);
      try {
        var d = await api('/api/admin/recaps/import', { body: { csv: await f.text() } });
        var t = d.added + ' added, ' + d.updated + ' updated' + (d.skipped ? ', ' + d.skipped + ' skipped (unsubscribed)' : '') + '.';
        if (d.errorCount) t += ' ' + d.errorCount + ' row' + (d.errorCount === 1 ? '' : 's') + ' not imported: ' + d.errors.slice(0, 5).join('; ') + (d.errorCount > 5 ? '…' : '');
        await window.loadRecaps();
        msg('rcImportMsg', t, !d.errorCount || d.added + d.updated > 0);
      } catch (e) { msg('rcImportMsg', e.message, false); }
    };

    document.querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = async function () {
        if (!confirm('Remove this prospect?')) return;
        await api('/api/admin/recaps/prospects/' + encodeURIComponent(b.getAttribute('data-del')), { method: 'DELETE' });
        window.loadRecaps();
      };
    });
  }
})();
