/* Admin → Security & Backups: setup checklist and encrypted backups. */
(function () {
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var box = 'background:#fff;border:1px solid var(--border);border-radius:10px;padding:18px';
  var size = function (b) { return b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB'; };

  window.loadSecurity = async function () {
    var root = document.getElementById('securityRoot');
    var r = await fetch('/api/admin/security');
    if (!r.ok) { root.textContent = 'Could not load.'; return; }
    var d = await r.json();
    var good = d.checks.filter(function (c) { return c.ok; }).length;
    var last = d.lastRun;
    root.innerHTML =
      '<div style="' + box + '"><div style="font-weight:700;color:var(--navy);font-size:1.05em;margin-bottom:4px">Security checklist · ' + good + ' of ' + d.checks.length + ' done</div>' +
      '<div style="color:#5b6a80;font-size:0.88em;margin-bottom:10px">Settings marked with a fix are made in Railway → your service → Variables, then redeploy.</div>' +
      d.checks.map(function (c) {
        return '<div style="display:flex;gap:10px;padding:8px 0;border-top:1px solid var(--border)"><div style="font-size:1.1em;width:22px">' + (c.ok ? '✅' : '⚠️') + '</div><div><div style="font-weight:600">' + esc(c.label) + '</div>' +
          (c.ok ? '' : '<div style="font-size:0.88em;color:#5b6a80">' + esc(c.fix) + '</div>') + '</div></div>';
      }).join('') + '</div>' +
      '<div style="' + box + '"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center">' +
        '<div><div style="font-weight:700;color:var(--navy);font-size:1.05em">Encrypted backups</div><div style="color:#5b6a80;font-size:0.88em">Accounts, portfolios, settings, integrations, prospects and directory listings, every night at about 3:30 AM Central. The 30 newest are kept. Storm data is not included; it reloads from NOAA.</div></div>' +
        '<button class="btn btn-primary btn-sm" id="bkNow">Back up now</button></div>' +
        '<div id="bkMsg" class="alert" style="display:none;margin-top:10px"></div>' +
        (last ? '<div style="font-size:0.88em;margin-top:10px">Last backup: ' + esc(new Date(last.at).toLocaleString()) + ' · ' + last.files + ' files · ' + size(last.bytes) + ' · off-server copy: <strong>' + esc(last.offsite) + '</strong>' + (last.keyFromEnv ? '' : ' · <span style="color:#b45309">BACKUP_KEY not set</span>') + '</div>' : '') +
        '<div style="overflow-x:auto;margin-top:10px"><table><thead><tr><th>Backup</th><th>Made</th><th>Size</th><th></th></tr></thead><tbody>' +
          (d.backups.length ? d.backups.map(function (b) { return '<tr><td style="font-family:monospace;font-size:0.85em">' + esc(b.name) + '</td><td>' + esc(new Date(b.at).toLocaleString()) + '</td><td>' + size(b.bytes) + '</td><td><a class="btn btn-outline btn-sm" href="/api/admin/backups/' + encodeURIComponent(b.name) + '">Download</a></td></tr>'; }).join('')
            : '<tr><td colspan="4" style="text-align:center;color:#5b6a80;padding:14px">No backups yet.</td></tr>') +
        '</tbody></table></div>' +
        '<div style="font-size:0.82em;color:#5b6a80;margin-top:8px">Downloads stay encrypted. To restore: <code>BACKUP_KEY=… node scripts/restore-backup.js file.bin</code>.</div>' +
      '</div>';
    document.getElementById('bkNow').onclick = async function () {
      var b = this; b.disabled = true; b.textContent = 'Backing up…';
      var m = document.getElementById('bkMsg');
      try {
        var res = await fetch('/api/admin/backups/run', { method: 'POST' }); var j = await res.json();
        if (!res.ok) throw new Error(j.error || 'Backup failed');
        await window.loadSecurity();
        m = document.getElementById('bkMsg'); m.className = 'alert alert-success'; m.style.display = 'block';
        m.textContent = 'Backup made: ' + j.files + ' files, ' + size(j.bytes) + '. Off-server copy: ' + j.offsite + '.';
      } catch (e) { m.className = 'alert alert-error'; m.style.display = 'block'; m.textContent = e.message; b.disabled = false; b.textContent = 'Back up now'; }
    };
  };
})();
