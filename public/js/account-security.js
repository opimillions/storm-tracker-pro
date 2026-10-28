/* Settings → Security: two-step sign-in and sign out of all devices. */
(function () {
  var body = document.getElementById('secBody');
  if (!body) return;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var input = 'padding:9px 10px;border:1.5px solid var(--border);border-radius:6px;font-size:1em';
  async function api(url, b) {
    var r = await fetch(url, b === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
    var d = {}; try { d = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error(d.error || 'Something went wrong.');
    return d;
  }
  function msg(text, ok) { var m = document.getElementById('secMsg'); if (m) { m.className = 'alert ' + (ok ? 'alert-success' : 'alert-error'); m.textContent = text; m.style.display = text ? 'block' : 'none'; } }
  function codesHtml(codes) {
    return '<div style="background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:12px;margin-top:10px">' +
      '<strong>Save these backup codes now.</strong> Each one works once if you lose your phone. They will not be shown again.' +
      '<pre style="font-size:1.05em;margin:10px 0 6px;columns:2">' + codes.map(esc).join('\n') + '</pre>' +
      '<button type="button" class="btn btn-outline btn-sm" id="secCopy">Copy codes</button></div>';
  }

  async function render() {
    var s;
    try { s = await api('/api/account/security'); } catch (e) { body.textContent = e.message; return; }
    body.innerHTML = '<div id="secMsg" class="alert" style="display:none;margin-bottom:10px"></div>' +
      '<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">' +
        '<div><div style="font-weight:600">Two-step sign-in ' + (s.twoFactor ? '<span style="color:#17603A">· On</span>' : '<span style="color:#b45309">· Off</span>') + '</div>' +
        '<div style="color:var(--muted);font-size:0.9em">' + (s.twoFactor ? 'Signing in needs your password and a code from your authenticator app. ' + s.backupCodesLeft + ' backup code' + (s.backupCodesLeft === 1 ? '' : 's') + ' left.' : 'Ask for a code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password) when you sign in.' + (s.isAdmin ? ' <strong>Strongly recommended for admin accounts.</strong>' : '')) + '</div></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' + (s.twoFactor
          ? '<button class="btn btn-outline btn-sm" id="secNewCodes">New backup codes</button><button class="btn btn-outline btn-sm" id="secOff">Turn off</button>'
          : '<button class="btn btn-primary btn-sm" id="secSetup">Turn on</button>') + '</div>' +
      '</div>' +
      '<div id="secPanel"></div>' +
      '<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;padding:10px 0">' +
        '<div><div style="font-weight:600">Sign out of all devices</div><div style="color:var(--muted);font-size:0.9em">Ends every session, including this one. Use it if you signed in on a shared computer or think someone else has your password.</div></div>' +
        '<button class="btn btn-outline btn-sm" id="secAll">Sign out everywhere</button>' +
      '</div>';
    var panel = document.getElementById('secPanel');

    var setup = document.getElementById('secSetup');
    if (setup) setup.onclick = async function () {
      try {
        var d = await api('/api/account/2fa/setup', {});
        panel.innerHTML = '<div style="padding:14px 0;border-bottom:1px solid var(--border);display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start">' +
          '<div style="width:200px;height:200px;background:#fff">' + d.qrSvg + '</div>' +
          '<div style="flex:1;min-width:220px"><ol style="margin:0 0 10px 18px;padding:0;line-height:1.6">' +
            '<li>Open your authenticator app and add an account.</li><li>Scan this QR code, or enter the key: <code style="font-size:0.95em;background:#f1f5f9;padding:2px 6px;border-radius:4px">' + esc(d.key) + '</code></li><li>Enter the 6-digit code it shows.</li></ol>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap"><input id="secCode" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123456" style="' + input + ';width:130px"><button class="btn btn-primary btn-sm" id="secEnable">Turn on</button></div></div></div>';
        document.getElementById('secCode').focus();
        document.getElementById('secEnable').onclick = async function () {
          try {
            var r = await api('/api/account/2fa/enable', { code: document.getElementById('secCode').value });
            await render();
            msg('Two-step sign-in is on. Other devices will need a code the next time they sign in.', true);
            document.getElementById('secPanel').innerHTML = codesHtml(r.backupCodes);
            bindCopy(r.backupCodes);
          } catch (e) { msg(e.message, false); }
        };
      } catch (e) { msg(e.message, false); }
    };

    var off = document.getElementById('secOff');
    if (off) off.onclick = function () {
      panel.innerHTML = '<div style="padding:12px 0;border-bottom:1px solid var(--border);display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
        '<input type="password" id="secPw" placeholder="Your password" autocomplete="current-password" style="' + input + '">' +
        '<input id="secOffCode" placeholder="Code" inputmode="numeric" style="' + input + ';width:130px">' +
        '<button class="btn btn-outline btn-sm" id="secOffGo">Turn off two-step sign-in</button></div>';
      document.getElementById('secOffGo').onclick = async function () {
        try { await api('/api/account/2fa/disable', { password: document.getElementById('secPw').value, code: document.getElementById('secOffCode').value }); await render(); msg('Two-step sign-in is off.', true); }
        catch (e) { msg(e.message, false); }
      };
    };

    var nc = document.getElementById('secNewCodes');
    if (nc) nc.onclick = function () {
      panel.innerHTML = '<div style="padding:12px 0;border-bottom:1px solid var(--border);display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
        '<input id="secNcCode" placeholder="Code from your app" inputmode="numeric" style="' + input + ';width:170px"><button class="btn btn-outline btn-sm" id="secNcGo">Make new backup codes</button></div>';
      document.getElementById('secNcGo').onclick = async function () {
        try { var r = await api('/api/account/2fa/backup-codes', { code: document.getElementById('secNcCode').value }); panel.innerHTML = codesHtml(r.backupCodes); bindCopy(r.backupCodes); msg('Old backup codes no longer work.', true); }
        catch (e) { msg(e.message, false); }
      };
    };

    document.getElementById('secAll').onclick = async function () {
      if (!confirm('Sign out of StormCheck Pro on every device, including this one?')) return;
      try { await api('/api/auth/logout-all', {}); location.href = '/login'; } catch (e) { msg(e.message, false); }
    };
  }
  function bindCopy(codes) {
    var b = document.getElementById('secCopy');
    if (b) b.onclick = function () { try { navigator.clipboard.writeText(codes.join('\n')); b.textContent = 'Copied'; } catch (e) {} };
  }
  render();
})();
