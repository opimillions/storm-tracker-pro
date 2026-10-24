/* "Put StormCheck Pro on your phone" prompt.
 * Android/Chrome: shows an Install button (uses the browser's install prompt).
 * iPhone/iPad Safari: shows a one-time tip: Share → Add to Home Screen.
 * Hidden when already installed, on desktop, or after the user closes it. */
(function () {
  if (window.__scpInstall) return;
  window.__scpInstall = true;
  var KEY = 'scpInstallDismissed';
  var standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  var ua = navigator.userAgent || '';
  var isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isIOSSafari = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|GSA/.test(ua);
  var mobile = window.matchMedia('(max-width: 900px)').matches;
  function dismissed() { try { return Date.now() - Number(localStorage.getItem(KEY) || 0) < 30 * 86400000; } catch (e) { return false; } }
  function dismiss() { try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {} }

  var deferred = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    document.querySelectorAll('[data-install-button]').forEach(function (b) { b.hidden = false; });
    if (mobile && !standalone && !dismissed()) show('android');
  });
  window.addEventListener('appinstalled', function () { var b = document.getElementById('scpInstallBar'); if (b) b.remove(); document.body.classList.remove('scp-installbar'); });

  // Any page can call this (e.g. the /install page's button).
  window.scpInstall = function () {
    if (deferred) { deferred.prompt(); deferred.userChoice.finally(function () { deferred = null; }); return true; }
    return false;
  };

  var css = document.createElement('style');
  css.textContent =
    '#scpInstallBar{position:fixed;left:12px;right:12px;bottom:12px;z-index:1150;background:#172235;color:#fff;border-radius:14px;padding:14px 14px 14px 16px;box-shadow:0 12px 32px rgba(0,0,0,.3);display:flex;gap:12px;align-items:center;font-size:15px;line-height:1.4}' +
    '#scpInstallBar b{display:block;font-size:15px}#scpInstallBar span{color:#C7D0DC;font-size:13.5px}' +
    '#scpInstallBar button{border:0;border-radius:10px;min-height:44px;font-weight:700;cursor:pointer;font-family:inherit}' +
    '#scpInstallBar .go{background:#F2A93B;color:#172235;padding:0 16px;white-space:nowrap}' +
    '#scpInstallBar .x{background:transparent;color:#fff;font-size:22px;min-width:44px}' +
    '.scp-installbar .scp-fab{bottom:118px}.scp-installbar .scp-chat{bottom:188px}' +
    '@media (min-width:901px){#scpInstallBar{display:none}}';
  document.head.appendChild(css);

  function show(kind) {
    if (document.getElementById('scpInstallBar') || !document.body) return;
    var bar = document.createElement('div');
    bar.id = 'scpInstallBar'; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Install the app');
    var share = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/></svg>';
    bar.innerHTML = kind === 'android'
      ? '<div style="flex:1"><b>Put StormCheck Pro on your phone</b><span>Opens like an app from your home screen.</span></div><button class="go" type="button">Install</button><button class="x" type="button" aria-label="Close">&times;</button>'
      : '<div style="flex:1"><b>Put StormCheck Pro on your phone</b><span>Tap ' + share + ' Share below, then <strong>Add to Home Screen</strong>.</span></div><button class="x" type="button" aria-label="Close">&times;</button>';
    document.body.appendChild(bar);
    document.body.classList.add('scp-installbar');
    var close = function () { document.body.classList.remove('scp-installbar'); bar.remove(); };
    var go = bar.querySelector('.go');
    if (go) go.addEventListener('click', function () { window.scpInstall(); dismiss(); close(); });
    bar.querySelector('.x').addEventListener('click', function () { dismiss(); close(); });
  }

  function start() {
    if (standalone || dismissed() || !mobile) return;
    if (isIOSSafari) setTimeout(function () { show('ios'); }, 2500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
