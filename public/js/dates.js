/* Date display used across the app: month first, MM-DD-YYYY, regardless of
 * the browser's language setting (a UK-set browser was showing 13/11/2026). */
(function () {
  function parts(v) {
    var d = v instanceof Date ? v : new Date(v);
    if (isNaN(d)) return null;
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return { d: d, mdy: p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' + d.getFullYear() };
  }
  // 11-13-2026
  window.mdy = function (v) { var x = parts(v); return x ? x.mdy : '-'; };
  // 11-13-2026 4:46 PM
  window.mdyTime = function (v) {
    var x = parts(v); if (!x) return '-';
    return x.mdy + ' ' + x.d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  };
  // A stored storm day ('2026-11-13') without a time zone shift: 11-13-2026
  window.mdyDay = function (iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? m[2] + '-' + m[3] + '-' + m[1] : '-';
  };
})();
