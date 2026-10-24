/**
 * Ad and analytics tracking (off until IDs are set in the environment).
 *
 *   META_PIXEL_ID                 Facebook / Instagram pixel
 *   GA4_MEASUREMENT_ID            Google Analytics 4 (G-XXXX)
 *   GOOGLE_ADS_ID                 Google Ads (AW-XXXX), with optional
 *   GOOGLE_ADS_SIGNUP_LABEL, GOOGLE_ADS_PURCHASE_LABEL
 *   LINKEDIN_PARTNER_ID           LinkedIn Insight Tag, with optional
 *   LINKEDIN_SIGNUP_CONVERSION_ID, LINKEDIN_PURCHASE_CONVERSION_ID
 *
 * /js/tracking.js loads only the tags that are configured and exposes
 * window.scpTrack('signup' | 'subscribe', {plan, value}). It also keeps the
 * visitor's first UTM tags in a cookie so sign-ups record where they came from.
 */
const ok = (v, re) => (v && re.test(v) ? v : null);

function config() {
  return {
    meta: ok(process.env.META_PIXEL_ID, /^\d{5,20}$/),
    ga4: ok(process.env.GA4_MEASUREMENT_ID, /^G-[A-Z0-9]{4,15}$/),
    ads: ok(process.env.GOOGLE_ADS_ID, /^AW-\d{5,15}$/),
    adsSignup: ok(process.env.GOOGLE_ADS_SIGNUP_LABEL, /^[A-Za-z0-9_-]{3,40}$/),
    adsPurchase: ok(process.env.GOOGLE_ADS_PURCHASE_LABEL, /^[A-Za-z0-9_-]{3,40}$/),
    li: ok(process.env.LINKEDIN_PARTNER_ID, /^\d{3,12}$/),
    liSignup: ok(process.env.LINKEDIN_SIGNUP_CONVERSION_ID, /^\d{3,15}$/),
    liPurchase: ok(process.env.LINKEDIN_PURCHASE_CONVERSION_ID, /^\d{3,15}$/),
  };
}

const PRICES = { starter: 39, pro: 79, team: 149, enterprise: 199 };

function script(c) {
  return `(function () {
  var C = ${JSON.stringify(c)}, PRICES = ${JSON.stringify(PRICES)};
  // Remember the first UTM tags / referrer for 90 days (read at sign-up).
  try {
    var q = new URLSearchParams(location.search), utm = {};
    ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','ref'].forEach(function (k) { if (q.get(k)) utm[k] = q.get(k).slice(0, 100); });
    if (Object.keys(utm).length && document.cookie.indexOf('scp_utm=') === -1) {
      utm.landing = location.pathname.slice(0, 100);
      if (document.referrer) utm.referrer = document.referrer.slice(0, 200);
      document.cookie = 'scp_utm=' + encodeURIComponent(JSON.stringify(utm)) + ';path=/;max-age=' + (90 * 86400) + ';samesite=lax';
    }
  } catch (e) {}
  function load(src) { var s = document.createElement('script'); s.async = true; s.src = src; document.head.appendChild(s); }
  if (C.meta) {
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];}(window,document);
    load('https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', C.meta); fbq('track', 'PageView');
  }
  if (C.ga4 || C.ads) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { dataLayer.push(arguments); };
    load('https://www.googletagmanager.com/gtag/js?id=' + (C.ga4 || C.ads));
    gtag('js', new Date());
    if (C.ga4) gtag('config', C.ga4);
    if (C.ads) gtag('config', C.ads);
  }
  if (C.li) {
    window._linkedin_partner_id = C.li;
    window._linkedin_data_partner_ids = window._linkedin_data_partner_ids || [];
    window._linkedin_data_partner_ids.push(C.li);
    window.lintrk = window.lintrk || function (a, b) { (window.lintrk.q = window.lintrk.q || []).push([a, b]); };
    load('https://snap.licdn.com/li.lms-analytics/insight.min.js');
  }
  window.scpTrack = function (event, data) {
    data = data || {};
    var value = data.value != null ? data.value : (PRICES[data.plan] || 0);
    try {
      if (event === 'signup') {
        if (C.meta && window.fbq) fbq('track', 'CompleteRegistration');
        if (C.ga4 && window.gtag) gtag('event', 'sign_up', { method: 'email' });
        if (C.ads && C.adsSignup && window.gtag) gtag('event', 'conversion', { send_to: C.ads + '/' + C.adsSignup });
        if (C.li && C.liSignup && window.lintrk) lintrk('track', { conversion_id: Number(C.liSignup) });
      } else if (event === 'subscribe') {
        if (C.meta && window.fbq) fbq('track', 'Subscribe', { value: value, currency: 'USD', predicted_ltv: value * 12 });
        if (C.ga4 && window.gtag) gtag('event', 'purchase', { value: value, currency: 'USD', items: [{ item_name: 'StormCheck Pro ' + (data.plan || '') }] });
        if (C.ads && C.adsPurchase && window.gtag) gtag('event', 'conversion', { send_to: C.ads + '/' + C.adsPurchase, value: value, currency: 'USD' });
        if (C.li && C.liPurchase && window.lintrk) lintrk('track', { conversion_id: Number(C.liPurchase) });
      }
    } catch (e) {}
  };
})();`;
}

/** UTM tags captured on the visitor's first landing (cookie set by tracking.js). */
function readUtm(req) {
  try {
    const raw = req.cookies && req.cookies.scp_utm;
    if (!raw) return null;
    const j = JSON.parse(raw);
    const out = {};
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ref', 'landing', 'referrer']) {
      if (j[k]) out[k] = String(j[k]).slice(0, 200);
    }
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

module.exports = function trackingRoutes(app) {
  app.get('/js/tracking.js', (req, res) => {
    res.type('application/javascript');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(script(config()));
  });
};
module.exports.readUtm = readUtm;
module.exports._script = script;
module.exports._config = config;
