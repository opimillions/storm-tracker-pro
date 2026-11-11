/* Weather ticker under the app tabs: current conditions, 7-day forecast and any
 * active NWS warnings for the customer's home area. Scrolls; pauses on hover/tap;
 * holds still for people who turn off motion. */
(function () {
  var css = document.createElement('style');
  css.textContent =
    '.wx-bar{background:#0f1a2b;color:#e6ecf5;font-size:.88em;display:flex;align-items:center;min-height:38px;border-bottom:1px solid rgba(255,255,255,.08);overflow:hidden;position:relative}' +
    '.wx-bar .wx-place{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:0 12px;height:38px;background:#172235;font-weight:700;white-space:nowrap;z-index:1;box-shadow:6px 0 10px #0f1a2b}' +
    '.wx-bar .wx-place button{background:none;border:1px solid rgba(255,255,255,.3);color:#cfd8e6;border-radius:6px;font-size:.8em;padding:4px 8px;min-height:28px;cursor:pointer}' +
    '.wx-bar .wx-track{flex:1;overflow:hidden;white-space:nowrap;mask-image:linear-gradient(90deg,transparent,#000 24px,#000 calc(100% - 24px),transparent)}' +
    '.wx-bar .wx-run{display:inline-block;padding-left:100%;animation:wx-scroll var(--wx-dur,60s) linear infinite}' +
    '.wx-bar:hover .wx-run,.wx-bar.paused .wx-run{animation-play-state:paused}' +
    '.wx-bar .wx-item{display:inline-block;margin-right:28px}' +
    '.wx-bar .wx-day{color:#F2A93B;font-weight:700;margin-right:6px}' +
    '.wx-bar .wx-hi{color:#fff;font-weight:700}' +
    '.wx-bar .wx-lo{color:#9fb0c8}' +
    '.wx-bar .wx-rain{color:#7cc4ff}' +
    '.wx-bar .wx-alert{background:#c0392b;color:#fff;border-radius:6px;padding:2px 8px;font-weight:700}' +
    '.wx-bar .wx-msg{padding:0 12px;color:#cfd8e6}' +
    '.wx-bar .wx-place{gap:6px}' +
    '@media (max-width:600px){.wx-bar .wx-place{padding:0 8px;font-size:.92em}.wx-bar .wx-label{max-width:92px;overflow:hidden;text-overflow:ellipsis}.wx-bar .wx-place button{padding:4px 6px}}' +
        '@keyframes wx-scroll{from{transform:translateX(0)}to{transform:translateX(-100%)}}' +
    '@media (prefers-reduced-motion:reduce){.wx-bar .wx-track{overflow-x:auto}.wx-bar .wx-run{animation:none;padding-left:12px}}';
  document.head.appendChild(css);

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function icon(sky) {
    var s = String(sky || '').toLowerCase();
    if (/hail/.test(s)) return '🧊';
    if (/thunder|t-storm/.test(s)) return '⛈️';
    if (/snow|sleet|flurr|ice/.test(s)) return '🌨️';
    if (/rain|shower|drizzle/.test(s)) return '🌧️';
    if (/fog|haze|smoke/.test(s)) return '🌫️';
    if (/wind|breezy|blustery/.test(s)) return '💨';
    if (/partly|mostly sunny|mostly clear/.test(s)) return '⛅';
    if (/cloud|overcast/.test(s)) return '☁️';
    if (/sun|clear|fair/.test(s)) return '☀️';
    return '🌡️';
  }
  function dayLabel(d, i) {
    if (i === 0) return 'Today';
    var dt = new Date(d.date + 'T12:00:00');
    return isNaN(dt) ? d.name : dt.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' + (dt.getMonth() + 1) + '/' + dt.getDate();
  }

  function bar() {
    var el = document.getElementById('wxBar');
    if (el) return el;
    var nav = document.getElementById('appNav');
    if (!nav || !nav.parentNode) return null;
    el = document.createElement('div');
    el.id = 'wxBar'; el.className = 'wx-bar'; el.setAttribute('role', 'region'); el.setAttribute('aria-label', 'Weather for your area');
    nav.parentNode.insertBefore(el, nav.nextSibling);
    el.addEventListener('click', function (e) { if (!e.target.closest('button')) el.classList.toggle('paused'); });
    return el;
  }

  // Phone / browser location: asked once, then saved as the home area.
  function useMyLocation() {
    if (!navigator.geolocation) { alert('This device cannot share its location. Enter a ZIP code instead.'); return changeArea(); }
    navigator.geolocation.getCurrentPosition(function (pos) {
      fetch('/api/weather/home', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lat: pos.coords.latitude, lon: pos.coords.longitude }) })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (d.error) alert(d.error); else load(); });
    }, function () {
      alert('Location is turned off for this site. Allow location in your browser settings, or enter a ZIP code instead.');
    }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60 * 1000 });
  }

  function changeArea() {
    var zip = window.prompt('Enter the ZIP code for your home area:');
    if (zip == null) return;
    fetch('/api/weather/home', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zip: zip.trim() }) })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d.error) alert(d.error); else load(); });
  }

  function show(d) {
    var el = bar(); if (!el) return;
    if (d.needsArea) {
      el.innerHTML = '<div class="wx-place">🌤️ Weather <button type="button" id="wxLoc">📍 Use my location</button><button type="button" id="wxSet">Enter ZIP</button></div><div class="wx-msg">See your local forecast here.</div>';
    } else if (d.error) {
      el.innerHTML = '<div class="wx-place">🌤️ Weather <button type="button" id="wxSet">Change area</button></div><div class="wx-msg">' + esc(d.error) + '</div>';
    } else {
      var items = [];
      (d.alerts || []).forEach(function (a) { items.push('<span class="wx-item"><span class="wx-alert">⚠️ ' + esc(a.event) + '</span></span>'); });
      if (d.now) items.push('<span class="wx-item"><span class="wx-day">Now</span>' + icon(d.now.sky) + ' <span class="wx-hi">' + esc(d.now.temp) + '°</span> ' + esc(d.now.sky) + (d.now.wind ? ' · Wind ' + esc(d.now.wind) : '') + '</span>');
      (d.days || []).forEach(function (day, i) {
        items.push('<span class="wx-item"><span class="wx-day">' + esc(dayLabel(day, i)) + '</span>' + icon(day.sky) + ' ' +
          (day.high != null ? '<span class="wx-hi">' + esc(day.high) + '°</span>' : '') + (day.high != null && day.low != null ? ' / ' : '') +
          (day.low != null ? '<span class="wx-lo">' + esc(day.low) + '°</span>' : '') + ' ' + esc(day.sky) +
          (day.rain ? ' <span class="wx-rain">💧' + esc(day.rain) + '%</span>' : '') + '</span>');
      });
      el.innerHTML = '<div class="wx-place"><span class="wx-label">' + esc((d.area && d.area.label) || 'Your area') + '</span><button type="button" id="wxLoc" title="Use my location" aria-label="Use my location">📍</button><button type="button" id="wxSet" title="Enter a ZIP code">ZIP</button></div>' +
        '<div class="wx-track"><span class="wx-run">' + items.join('') + '</span></div>';
      var run = el.querySelector('.wx-run');
      if (run) run.style.setProperty('--wx-dur', Math.max(30, items.length * 7) + 's');
    }
    var b = document.getElementById('wxSet'); if (b) b.addEventListener('click', changeArea);
    var g = document.getElementById('wxLoc'); if (g) g.addEventListener('click', useMyLocation);
  }

  function load() {
    fetch('/api/weather/home').then(function (r) { return r.json(); }).then(show).catch(function () { show({ error: 'Weather is unavailable right now.' }); });
  }

  function start() { if (bar()) { load(); setInterval(load, 30 * 60 * 1000); } }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
