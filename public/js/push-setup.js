/* Phone / browser hail alerts: enable, disable, test, and the Lookup-page banner.
 * Notifications are for the user's own portfolio, territories and warnings.
 * iPhone needs the app on the home screen first (iOS 16.4+). */
(function () {
  var supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  var ua = navigator.userAgent || '';
  var isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  function b64ToBytes(s) {
    var pad = '='.repeat((4 - s.length % 4) % 4);
    var raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  async function registration() { return navigator.serviceWorker.register('/sw.js'); }
  async function save(sub) {
    var r = await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub) });
    if (!r.ok) { var d = {}; try { d = await r.json(); } catch (e) {} throw new Error(d.error || 'Could not save this device.'); }
  }

  /** 'unsupported' | 'needs-install' | 'denied' | 'on' | 'off' */
  async function state() {
    if (!supported) return isIOS && !standalone ? 'needs-install' : 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    try {
      var reg = await navigator.serviceWorker.getRegistration('/');
      var sub = reg && await reg.pushManager.getSubscription();
      if (sub) { save(sub.toJSON()).catch(function () {}); return 'on'; } // re-save so the server always has it
    } catch (e) {}
    return 'off';
  }

  async function enable() {
    if (!supported) throw new Error(isIOS ? 'On iPhone, add StormCheck Pro to your home screen first, then open it from there.' : 'This browser does not support notifications.');
    var perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications are blocked. Allow them in your phone or browser settings, then try again.');
    var reg = await registration();
    await navigator.serviceWorker.ready;
    var k = await (await fetch('/api/push/vapid-key')).json();
    var sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(k.publicKey) });
    await save(sub.toJSON());
    return true;
  }

  async function disable() {
    var reg = await navigator.serviceWorker.getRegistration('/');
    var sub = reg && await reg.pushManager.getSubscription();
    if (!sub) return;
    await fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) });
    await sub.unsubscribe();
  }

  async function test() {
    var r = await fetch('/api/push/test', { method: 'POST' });
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Could not send.');
    return d.sent;
  }

  window.scpPush = { state: state, enable: enable, disable: disable, test: test, isIOS: isIOS, standalone: standalone };

  // ── Lookup page banner ──────────────────────────────────────────────────
  var KEY = 'scpPushBannerHidden';
  function hiddenRecently() { try { return Date.now() - Number(localStorage.getItem(KEY) || 0) < 30 * 86400000; } catch (e) { return false; } }
  async function banner() {
    var el = document.getElementById('pushBanner');
    if (!el || hiddenRecently()) return;
    var s = await state();
    if (s === 'on' || s === 'denied' || s === 'unsupported') return;
    var install = s === 'needs-install';
    el.innerHTML = '<div><div style="font-weight:700;font-size:0.95em">Get hail alerts on this ' + (isIOS || /Android/.test(ua) ? 'phone' : 'device') + '</div>' +
      '<div style="font-size:0.82em;opacity:0.8;margin-top:2px">' + (install
        ? 'On iPhone, add StormCheck Pro to your home screen first, then open it from there and turn on alerts.'
        : 'A notification when radar shows hail on your properties or territories, even when the app is closed.') + '</div></div>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
      (install ? '<a class="btn btn-primary btn-sm" href="/install">How to add it</a>' : '<button class="btn btn-primary btn-sm" type="button" id="pushEnableBtn">Turn on alerts</button>') +
      '<button type="button" id="pushLater" style="background:none;border:0;color:#fff;opacity:.75;cursor:pointer;font:inherit;font-size:0.85em;min-height:44px">Not now</button></div>';
    el.style.display = 'flex';
    document.getElementById('pushLater').onclick = function () { try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {} el.style.display = 'none'; };
    var btn = document.getElementById('pushEnableBtn');
    if (btn) btn.onclick = async function () {
      btn.disabled = true; btn.textContent = 'Turning on…';
      try {
        await enable();
        el.innerHTML = '<div style="font-weight:700">Hail alerts are on for this device.</div><a href="/alert-settings" style="color:#F2A93B;font-weight:700">Alert settings</a>';
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Turn on alerts';
        if (window.showAlert) window.showAlert(e.message, 'error'); else alert(e.message);
      }
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', banner); else banner();
})();
