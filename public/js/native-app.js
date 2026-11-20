/* StormCheck Pro iPhone app (App Store build). Loaded on every page; does
 * nothing in a normal browser. Plans are bought on the website only, so the
 * app hides upgrade / pricing links (Apple rule 3.1.3), and tapping a hail
 * alert opens the page the alert points to. */
(function () {
  var inApp = /StormCheckProApp\//.test(navigator.userAgent || '');
  if (!inApp) return;
  var root = document.documentElement;
  root.classList.add('native-app');
  var css = document.createElement('style');
  css.textContent = 'html.native-app a[href^="/upgrade"],html.native-app a[href$="#pricing"],html.native-app a[href^="/install"],html.native-app [data-install-button]{display:none!important}';
  (document.head || root).appendChild(css);

  function wire() {
    var Cap = window.Capacitor;
    if (!Cap || !Cap.isNativePlatform || !Cap.isNativePlatform()) return;
    var PN = (Cap.Plugins && Cap.Plugins.PushNotifications) || (Cap.registerPlugin && Cap.registerPlugin('PushNotifications'));
    if (!PN || window.__scpTapWired) return;
    window.__scpTapWired = true;
    PN.addListener('pushNotificationActionPerformed', function (a) {
      var url = a && a.notification && a.notification.data && a.notification.data.url;
      if (url && url.charAt(0) === '/' && url.charAt(1) !== '/') location.href = url;
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
