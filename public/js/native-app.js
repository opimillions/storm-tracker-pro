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
  css.textContent = [
    'a[href^="/upgrade"]', 'a[href*="#pricing"]', 'a[href^="/pricing"]', 'a[href^="/affiliate"]',
    'a[href^="/install"]', '[data-install-button]', '.upgrade-banner', '#upgradeBanner', '[data-hide-in-app]',
  ].map(function (s) { return 'html.native-app ' + s; }).join(',') + '{display:none!important}';
  (document.head || root).appendChild(css);

  // The app is free: strip any price or upgrade wording that pages or server
  // messages put on screen (purchases happen only on the website).
  var PRICE = /\s*(starting at|from)?\s*\$\s?\d[\d,]*(\.\d+)?\s*(\/|per)\s*(mo|month|yr|year)\b\)?/gi;
  var UPSELL = /\s*(→\s*)?\b(Upgrade|Subscribe)\b[^.!?\n]*[.!?→]?/g;
  function scrubText(node) {
    var t = node.nodeValue;
    if (!t || (t.indexOf('$') < 0 && !/Upgrade|Subscribe/.test(t))) return;
    var n = t.replace(PRICE, '').replace(UPSELL, '').replace(/\(\s*\)/g, '');
    if (n !== t) node.nodeValue = n;
  }
  function scrub(rootNode) {
    if (!rootNode) return;
    if (rootNode.nodeType === 3) return scrubText(rootNode);
    if (rootNode.nodeType !== 1 || /^(SCRIPT|STYLE|TEXTAREA|INPUT)$/.test(rootNode.nodeName)) return;
    var w = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT, null);
    var x; while ((x = w.nextNode())) scrubText(x);
  }
  function start() {
    scrub(document.body);
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        if (m.type === 'characterData') scrubText(m.target);
        m.addedNodes && m.addedNodes.forEach(scrub);
      });
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

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
