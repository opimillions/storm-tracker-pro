/* StormCheck Pro: shareable storm map (public page /storm/:date).
 * Public data only, except the signed-in viewer's own "My properties" list,
 * which is fetched separately and never written into the share link. */
(function () {
  'use strict';
  var S = window.STORM;
  if (!S) { location.replace('/hail-maps'); return; }

  var $ = function (id) { return document.getElementById(id); };
  var TZ = S.tz || 'America/Chicago';
  var SWATH_MIN = S.swathMinIn || 0.75;
  var LEGEND = [[0.75, '0.75', 'Penny'], [1, '1', 'Quarter'], [1.25, '1.25', 'Half dollar'], [1.5, '1.5', 'Ping pong'],
    [1.75, '1.75', 'Golf ball'], [2, '2', 'Hen egg'], [2.5, '2.5', 'Tennis ball'], [3, '3+', 'Baseball+']];

  // ── Formatting ───────────────────────────────────────────────────────────
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function tzName(iso) {
    try { return (new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'short' }).formatToParts(new Date(iso)).filter(function (p) { return p.type === 'timeZoneName'; })[0] || {}).value || ''; }
    catch (e) { return ''; }
  }
  function t(iso) { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ }); }
  function tz(iso) { return t(iso) + ' ' + tzName(iso); }
  function localDay(iso, long) { return new Date(iso).toLocaleDateString('en-US', long ? { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: TZ } : { weekday: 'short', month: 'short', day: 'numeric', timeZone: TZ }); }
  function sameLocalDay(a, b) { return localDay(a, true) === localDay(b, true); }
  // "Apr 25, 7:00 AM – Apr 26, 7:00 AM CDT"
  function span(a, b) {
    var da = localDay(a), db = localDay(b);
    if (da === db) return da + ', ' + t(a) + '–' + t(b) + ' ' + tzName(b);
    return da + ', ' + t(a) + ' – ' + db + ', ' + t(b) + ' ' + tzName(b);
  }
  // "6:00–7:00 PM CDT" for a window on one day
  function hourSpan(a, b) {
    var ta = t(a), tb = t(b);
    var pa = ta.slice(-2), pb = tb.slice(-2);
    return (pa === pb ? ta.slice(0, -3) : ta) + '–' + tb + ' ' + tzName(b);
  }
  function inch(v) { return Number(v || 0).toFixed(2) + '"'; }
  function sizeName(v) {
    var n = [[4.5, 'Grapefruit'], [4, 'Softball'], [2.75, 'Baseball'], [2.5, 'Tennis ball'], [2, 'Hen egg'], [1.75, 'Golf ball'],
      [1.5, 'Ping pong ball'], [1.25, 'Half dollar'], [1, 'Quarter'], [0.88, 'Nickel'], [0.75, 'Penny'], [0.5, 'Marble']];
    for (var i = 0; i < n.length; i++) if (v >= n[i][0]) return n[i][1];
    return 'Pea';
  }
  var period = S.period;
  var periodText = span(period.start, period.end);
  var stormDayLabel = new Date(S.date + 'T18:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

  function toast(msg, ms) {
    var el = $('toast'); el.innerHTML = msg; el.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(function () { el.hidden = true; }, ms || 3800);
  }

  // ── Map ──────────────────────────────────────────────────────────────────
  var map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([S.center.lat, S.center.lon], S.center.z || 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors', maxZoom: 18 }).addTo(map);
  map.attributionControl.addAttribution('Hail: NOAA MRMS · Reports: NOAA SPC');
  map.createPane('radar'); map.getPane('radar').style.zIndex = 250;
  var swath = new L.SwathLayer([], { opacity: 0.7, minIn: SWATH_MIN, zIndex: 300 }).addTo(map);
  var reportsLayer = L.layerGroup().addTo(map);
  var propsLayer = L.layerGroup().addTo(map);
  var radarLayer = null, radarTime = null;
  var pin = null;
  var view = null;          // last /api/public/storm response
  var dayCells = [];        // full-day cells for the current view
  var frames = null, frameIdx = null, playTimer = null;
  var user = null;

  // Legends
  function renderLegends() {
    $('mapLegend').innerHTML = LEGEND.map(function (l) {
      return '<span class="ml"><i style="background:' + hailColor(l[0]) + '"></i>' + l[1] + '</span>';
    }).join('') + '<span class="unit">in</span>';
    $('legendFull').innerHTML = LEGEND.map(function (l) {
      return '<span><i style="background:' + hailColor(l[0]) + '"></i>' + l[1] + '" <span class="muted">' + l[2] + '</span></span>';
    }).join('');
  }
  renderLegends();

  // ── Header: date and local time ─────────────────────────────────────────
  function setHeader() {
    var place = view && view.place ? view.place : S.place;
    $('stormKicker').textContent = 'Hail storm' + (place ? ' · near ' + place.name + ', ' + place.state : '');
    var tm = view && view.timing;
    if (!S.hasRadar && !(tm)) {
      $('stormDate').textContent = stormDayLabel;
      $('stormTime').innerHTML = 'Radar hail data isn&rsquo;t available for this date.';
      return;
    }
    if (tm) {
      // Local date of the hail itself (a storm after midnight belongs to the next calendar day).
      $('stormDate').textContent = localDay(tm.start, true);
      // When that differs from NOAA's storm-day label, say which NOAA day this is.
      if (localDay(tm.start, true) !== new Date(S.date + 'T18:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })) {
        $('stormKicker').textContent += ' · NOAA storm day ' + stormDayLabel.replace(/^\w+, /, '');
      }
      var radarTimed = /hourly/i.test(tm.source);
      var when = sameLocalDay(tm.start, tm.end) ? hourSpan(tm.start, tm.end) : span(tm.start, tm.end);
      $('stormTime').innerHTML = (radarTimed ? 'Hail fell about <b>' + esc(when) + '</b><span class="tarea"> in this area</span>' : 'Hail reported <b>' + esc(when) + '</b>') +
        '<span class="tsrc"> · ' + (radarTimed ? 'hourly radar' : 'ground report times') + '</span>';
    } else {
      $('stormDate').textContent = stormDayLabel;
      $('stormTime').innerHTML = 'NOAA storm day <b>' + esc(periodText) + '</b>';
    }
    document.title = $('stormDate').textContent + ' hail storm' + (place ? ' near ' + place.name + ', ' + place.state : '') + ' | StormCheck Pro';
  }

  // ── Source labels (every layer says where it came from and when) ────────
  function setSources() {
    if (!S.hasRadar) $('srcHail').textContent = 'No radar hail data for this date.';
    else if (frames && frameIdx != null && frameIdx < frames.length) {
      $('srcHail').textContent = 'NOAA MRMS radar (MESH) · hail so far, through ' + tz(frames[frameIdx].time) + ' · hourly';
    } else {
      $('srcHail').textContent = 'NOAA MRMS radar (MESH) · daily maximum, ' + periodText;
    }
    if (radarTime) {
      var live = Date.now() - radarTime.getTime() < 15 * 60000;
      $('srcRadar').innerHTML = (live ? '<span class="live">LIVE</span>' : '') + 'NEXRAD reflectivity mosaic · Iowa Environmental Mesonet · ' + (live ? 'updated ' : 'snapshot ') + esc(tz(radarTime.toISOString()));
    } else {
      $('srcRadar').textContent = 'NEXRAD reflectivity mosaic · Iowa Environmental Mesonet';
    }
    var r = view && view.reports ? view.reports.hail : [];
    if (!view) $('srcReports').textContent = 'NOAA SPC preliminary storm reports';
    else if (!r.length) $('srcReports').textContent = 'NOAA SPC preliminary reports · none in this view';
    else {
      var times = r.map(function (x) { return x.time; }).filter(Boolean).sort();
      $('srcReports').textContent = 'NOAA SPC preliminary reports · ' + r.length + ' hail report' + (r.length === 1 ? '' : 's') + ' in view' +
        (times.length ? ', ' + (sameLocalDay(times[0], times[times.length - 1]) ? hourSpan(times[0], times[times.length - 1]) : span(times[0], times[times.length - 1])) : '');
    }
  }

  function setPeek() {
    var max = view ? view.maxIn : 0;
    var n = view && view.reports ? view.reports.hail.length : 0;
    $('peekSum').innerHTML = (S.hasRadar ? '<span class="chip"><i style="background:' + hailColor(max) + '"></i>' + (max >= SWATH_MIN ? 'Up to ' + inch(max) + ' in view' : 'No 0.75"+ hail in view') + '</span>' : '<span class="chip">No radar data</span>') +
      '<span class="chip">' + n + ' hail report' + (n === 1 ? '' : 's') + '</span>';
    measurePeek();
  }

  // ── Load the storm for the visible area ─────────────────────────────────
  function viewBox(maxDeg) {
    var b = map.getBounds(), c = map.getCenter();
    var w = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
    if (e - w > maxDeg) { w = c.lng - maxDeg / 2; e = c.lng + maxDeg / 2; }
    if (n - s > maxDeg) { s = c.lat - maxDeg / 2; n = c.lat + maxDeg / 2; }
    // A little margin so panning doesn't show bare edges.
    var pw = Math.min((e - w) * 0.15, 0.3), ph = Math.min((n - s) * 0.15, 0.3);
    w = Math.max(w - pw, -134.9); e = Math.min(e + pw, -55.1); s = Math.max(s - ph, 15.1); n = Math.min(n + ph, 59.9);
    if (e - w > maxDeg) { var mx = (w + e) / 2; w = mx - maxDeg / 2; e = mx + maxDeg / 2; }
    if (n - s > maxDeg) { var my = (s + n) / 2; s = my - maxDeg / 2; n = my + maxDeg / 2; }
    var r = function (v) { return v.toFixed(3); };
    return 'w=' + r(w) + '&s=' + r(s) + '&e=' + r(e) + '&n=' + r(n);
  }

  var loadSeq = 0, pollTimer = null, polls = 0;
  function loadView() {
    var seq = ++loadSeq;
    fetch('/api/public/storm/' + S.date + '?' + viewBox(4.9)).then(function (r) { return r.json(); }).then(function (d) {
      if (seq !== loadSeq || d.error) return;
      view = d; dayCells = d.cells || [];
      if (frameIdx == null || !frames) swath.setCells(dayCells);
      drawReports();
      setHeader(); setSources(); setPeek();
      if (!radarTime) setRadarTime(defaultRadarTime());
      // Hourly timing is built once per storm in the background; pick it up when ready.
      clearTimeout(pollTimer);
      if ((d.hourly === 'building' || d.hourly === 'pending') && polls < 12) { polls++; pollTimer = setTimeout(loadView, 15000); }
    }).catch(function () { /* keep the last view */ });
  }
  var moveT;
  map.on('moveend', function () { clearTimeout(moveT); moveT = setTimeout(loadView, 300); });

  function drawReports() {
    reportsLayer.clearLayers();
    if (!view || !$('lyrReports').checked) return;
    var r = view.reports;
    r.hail.forEach(function (h) {
      L.circleMarker([h.lat, h.lon], { radius: Math.max(5, Math.min(11, 3 + h.sizeIn * 3)), color: '#172235', weight: 2, fillColor: '#fff', fillOpacity: 1 })
        .bindPopup('<b>' + inch(h.sizeIn) + ' hail</b> (' + esc(sizeName(h.sizeIn)) + ')<br>' + (h.time ? esc(localDay(h.time)) + ', ' + esc(tz(h.time)) + '<br>' : '') + esc(h.loc) + (h.state ? ', ' + esc(h.state) : '') +
          (h.remarks ? '<br><small>' + esc(h.remarks) + '</small>' : '') + '<br><small class="muted">Ground report · NOAA SPC (preliminary)</small>')
        .addTo(reportsLayer);
    });
    r.wind.forEach(function (w) {
      L.circleMarker([w.lat, w.lon], { radius: 4, color: '#1D4E89', weight: 1.5, fillColor: '#93C5FD', fillOpacity: 1 })
        .bindPopup('<b>Wind' + (w.mph ? ' ' + w.mph + ' mph' : '') + '</b><br>' + (w.time ? esc(tz(w.time)) + '<br>' : '') + esc(w.loc) + '<br><small class="muted">Ground report · NOAA SPC</small>').addTo(reportsLayer);
    });
    r.tornado.forEach(function (x) {
      L.circleMarker([x.lat, x.lon], { radius: 7, color: '#581C87', weight: 2, fillColor: '#C084FC', fillOpacity: 1 })
        .bindPopup('<b>Tornado ' + esc(x.ef || '') + '</b><br>' + (x.time ? esc(tz(x.time)) + '<br>' : '') + esc(x.loc) + '<br><small class="muted">Ground report · NOAA SPC</small>').addTo(reportsLayer);
    });
  }

  // ── Layers ───────────────────────────────────────────────────────────────
  $('lyrHail').addEventListener('change', function () { if (this.checked) swath.addTo(map); else map.removeLayer(swath); });
  $('lyrReports').addEventListener('change', drawReports);
  $('lyrRadar').addEventListener('change', function () { if (this.checked) { setRadarTime(radarTime || defaultRadarTime()); } else if (radarLayer) { map.removeLayer(radarLayer); } setSources(); });
  $('opacity').addEventListener('input', function () { swath.setOpacity(this.value / 100); $('opacityOut').textContent = this.value + '%'; });

  // Reflectivity snapshot: at the hour of the biggest hail in view, or the
  // playback frame being shown. IEM archives the mosaic every 5 minutes.
  function defaultRadarTime() {
    var tm = view && view.timing;
    if (tm && tm.peak) return new Date(Date.parse(tm.peak.end) - 30 * 60000);
    if (tm) return new Date((Date.parse(tm.start) + Date.parse(tm.end)) / 2);
    return new Date(Date.parse(period.start) + 11 * 3600000); // 23Z: evening in the US
  }
  function setRadarTime(d) {
    var now = Date.now();
    var ms = Math.min(d.getTime(), now - 5 * 60000);
    var r = new Date(Math.floor(ms / 300000) * 300000);
    radarTime = r;
    if (!$('lyrRadar').checked) { setSources(); return; }
    var live = now - r.getTime() < 15 * 60000;
    var stamp = r.toISOString().replace(/[-:T]/g, '').slice(0, 12);
    var url = live
      ? 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png'
      : 'https://mesonet.agron.iastate.edu/c/tile.py/1.0.0/ridge::USCOMP-N0Q-' + stamp + '/{z}/{x}/{y}.png';
    if (radarLayer) radarLayer.setUrl(url);
    else radarLayer = L.tileLayer(url, { pane: 'radar', opacity: 0.6, maxNativeZoom: 10, maxZoom: 18, attribution: 'Radar: Iowa Environmental Mesonet' });
    if (!map.hasLayer(radarLayer)) radarLayer.addTo(map);
    setSources();
  }

  // ── Playback ─────────────────────────────────────────────────────────────
  var slider = $('frameSlider');
  function setPlayIcon(playing) {
    $('playIcon').innerHTML = playing ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/>' : '<path d="M7 4.5v15l13-7.5z" fill="currentColor"/>';
    $('playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play storm');
  }
  function lockPlayback(msg) {
    $('playBtn').classList.add('locked');
    $('frameLabel').innerHTML = msg;
  }
  function loadFrames() {
    if (!S.hasRadar || S.date < S.playbackFrom) { lockPlayback('Playback isn&rsquo;t available for this date'); return Promise.reject(); }
    if (!user) {
      lockPlayback('Playback is a Pro feature · <a href="/login?next=' + encodeURIComponent(location.pathname + location.search) + '">Sign in</a>');
      toast('Storm playback is included with Pro. <a href="/register?next=' + encodeURIComponent(location.pathname + location.search) + '" style="color:#F2C77A">Start free</a> or sign in.');
      return Promise.reject();
    }
    $('frameLabel').textContent = 'Loading hourly radar…';
    return fetch('/api/mesh/frames?date=' + S.date + '&' + viewBox(7.9)).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) { lockPlayback(esc(j.error || 'Playback unavailable') + (j.upgrade ? ' · <a href="/upgrade">Upgrade</a>' : '')); throw new Error(); }
        frames = j.frames;
        slider.max = frames.length; slider.value = frames.length; slider.disabled = false;
        return frames;
      });
    });
  }
  function showFrame(i) {
    frameIdx = i;
    slider.value = i;
    if (!frames || i >= frames.length) {
      frameIdx = null; swath.setCells(dayCells);
      $('frameLabel').textContent = 'Full storm day · ' + periodText;
      if ($('lyrRadar').checked) setRadarTime(defaultRadarTime());
      setSources(); return;
    }
    var acc = new Map();
    for (var k = 0; k <= i; k++) frames[k].cells.forEach(function (c) { var key = c[0] + '_' + c[1]; var p = acc.get(key); if (!p || p[2] < c[2]) acc.set(key, c); });
    swath.setCells(Array.from(acc.values()));
    var f = frames[i];
    $('frameLabel').textContent = localDay(f.time) + ', hail through ' + tz(f.time) + (f.cells.length ? '' : ' · none this hour');
    if ($('lyrRadar').checked) setRadarTime(new Date(Date.parse(f.time) - 5 * 60000));
    setSources();
  }
  function stop() { clearInterval(playTimer); playTimer = null; setPlayIcon(false); }
  $('playBtn').addEventListener('click', function () {
    if (playTimer) { stop(); return; }
    (frames ? Promise.resolve(frames) : loadFrames()).then(function () {
      var i = (frameIdx == null || frameIdx >= frames.length - 1) ? 0 : frameIdx + 1;
      setPlayIcon(true); showFrame(i);
      playTimer = setInterval(function () {
        i++;
        if (i > frames.length) { stop(); return; }
        showFrame(i);
      }, 650);
    }).catch(function () {});
  });
  slider.addEventListener('input', function () { stop(); showFrame(+this.value); });
  $('frameLabel').textContent = S.hasRadar ? 'Full storm day · ' + periodText : 'No radar data for this date';

  // ── Address check ────────────────────────────────────────────────────────
  var pinIcon = L.divIcon({ className: 'pin', iconSize: [30, 40], iconAnchor: [15, 39], html: '<svg width="30" height="40" viewBox="0 0 30 40" aria-hidden="true"><path d="M15 1C7.3 1 1 7.2 1 14.8 1 25 15 39 15 39s14-14 14-24.2C29 7.2 22.7 1 15 1z" fill="#172235" stroke="#fff" stroke-width="2"/><circle cx="15" cy="15" r="5.5" fill="#F2A93B"/></svg>' });
  function placePin(lat, lon, label) {
    if (pin) pin.setLatLng([lat, lon]); else pin = L.marker([lat, lon], { icon: pinIcon, zIndexOffset: 1000, keyboard: false }).addTo(map);
    pin.bindTooltip(esc(label), { direction: 'top', offset: [0, -36] });
    focusOn(lat, lon, Math.max(map.getZoom(), 13));
  }
  // Center a point in the part of the map the panel isn't covering.
  function focusOn(lat, lon, z) {
    map.setView([lat, lon], z, { animate: false });
    var p = $('panel');
    if (isPhone()) {
      var covered = p.getBoundingClientRect().top;
      var h = $('map').getBoundingClientRect();
      var visibleMid = (covered - h.top) / 2;
      map.panBy([0, h.height / 2 - visibleMid], { animate: false });
    }
  }

  var current = null; // { lat, lon, label, gps }
  $('addrForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var q = $('addrInput').value.trim();
    if (!q) return;
    showResult('<div class="rhead"><div class="raddr">Finding ' + esc(q) + '…</div></div>');
    fetch('/api/public/geocode?q=' + encodeURIComponent(q)).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }).then(function (x) {
      if (!x.ok) { showResult('<div class="rhead"><div class="raddr">' + esc(x.j.error || 'Address not found.') + '</div></div>'); return; }
      current = { lat: x.j.lat, lon: x.j.lon, label: x.j.address };
      $('addrInput').value = x.j.address;
      $('addrInput').blur();
      setSheet('half');
      afterSheet(function () { placePin(current.lat, current.lon, current.label); });
      checkPoint();
    }).catch(function () { showResult('<div class="rhead"><div class="raddr">Search is unavailable right now. Try again.</div></div>'); });
  });
  $('gpsBtn').addEventListener('click', function () {
    if (!('geolocation' in navigator)) { toast('This browser can&rsquo;t share your location. Type the address instead.'); return; }
    $('gpsBtn').disabled = true;
    navigator.geolocation.getCurrentPosition(function (pos) {
      $('gpsBtn').disabled = false;
      var lat = pos.coords.latitude, lon = pos.coords.longitude;
      current = { lat: lat, lon: lon, label: 'Your location', gps: true };
      setSheet('half');
      afterSheet(function () { placePin(lat, lon, 'Your location'); });
      checkPoint();
      if (user) fetch('/api/reverse-geocode?lat=' + lat.toFixed(6) + '&lon=' + lon.toFixed(6)).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
        if (d && d.address && current && current.gps) { current.label = d.address; $('addrInput').value = d.address; renderResult(lastPoint); }
      }).catch(function () {});
    }, function () { $('gpsBtn').disabled = false; toast('Couldn&rsquo;t get your location. Type the address instead.'); }, { enableHighAccuracy: true, timeout: 12000 });
  });

  var lastPoint = null;
  function checkPoint(retry) {
    if (!current) return;
    if (!retry) showResult('<div class="rhead"><div class="raddr">' + esc(current.label) + '</div><div class="muted">Checking this storm…</div></div>');
    fetch('/api/public/storm/' + S.date + '/point?lat=' + current.lat.toFixed(5) + '&lon=' + current.lon.toFixed(5)).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { showResult('<div class="rhead"><div class="raddr">' + esc(d.error) + '</div></div>'); return; }
      lastPoint = d; renderResult(d);
      // Hourly timing may still be building; refresh once it is.
      if (d.status === 'in-swath' && !d.hourly && view && (view.hourly === 'building' || view.hourly === 'pending') && (retry || 0) < 8) setTimeout(function () { if (lastPoint === d) checkPoint((retry || 0) + 1); }, 15000);
    }).catch(function () { showResult('<div class="rhead"><div class="raddr">Couldn&rsquo;t check this address. Try again.</div></div>'); });
  }

  function reportHref(withDate) {
    var q = new URLSearchParams({ address: current.label === 'Your location' ? 'Location ' + current.lat.toFixed(5) + ', ' + current.lon.toFixed(5) : current.label, lat: current.lat.toFixed(6), lon: current.lon.toFixed(6) });
    if (withDate) q.set('date', S.date);
    var dest = '/dashboard?' + q.toString();
    return user ? dest : '/register?next=' + encodeURIComponent(dest);
  }

  function renderResult(d) {
    if (!d || !current) return;
    var st = d.status === 'in-swath' ? '<span class="status in">Inside the mapped hail swath</span>'
      : d.status === 'outside' ? '<span class="status out">Outside the mapped hail swath</span>'
        : '<span class="status na">Radar data unavailable</span>';
    var h = '<div class="rhead"><div class="raddr">' + esc(current.label) + '</div>' + st + '</div>';

    // 1. Radar estimate at the property (its own block, never mixed with reports)
    h += '<div class="ev"><div class="elabel">Radar estimate at this address</div>';
    if (d.status === 'unavailable') {
      h += '<div class="enote">There&rsquo;s no radar hail data for ' + esc(stormDayLabel) + ', so we can&rsquo;t say whether hail fell here. This is different from &ldquo;no hail.&rdquo;</div>';
    } else {
      var v = d.radar.inches;
      h += v >= 0.5 ? '<div class="eval">' + inch(v) + ' <small>' + esc(sizeName(v)) + '</small></div>' : '<div class="eval"><small>No hail estimated at this spot</small></div>';
      if (d.status === 'outside') {
        h += '<div class="enote">' + (d.nearestSwathMi ? 'The mapped swath (0.75"+) comes within <b>' + d.nearestSwathMi.miles + ' mi</b>, where radar estimated up to ' + inch(d.nearestSwathMi.inches) + '.' : 'No mapped hail (0.75"+) within 10 miles.') + '</div>';
      }
      h += '<div class="esrc">' + esc(d.radar.source) + ' · ' + esc(span(d.radar.period.start, d.radar.period.end)) + '</div>';
    }
    h += '</div>';

    // 2. When, if hourly radar supports it
    if (d.hourly) {
      h += '<div class="ev"><div class="elabel">When it fell here</div><div class="eval">' + esc(hourSpan(d.hourly.windowStart, d.hourly.windowEnd)) + '</div>' +
        '<div class="enote">' + esc(localDay(d.hourly.windowEnd, true)) + '. Largest hourly estimate ' + inch(d.hourly.inches) + (d.hourly.hoursWithHail.length > 1 ? ', ' + d.hourly.hoursWithHail.length + ' hours with hail' : '') + '.</div>' +
        '<div class="esrc">' + esc(d.hourly.source) + '</div></div>';
    } else if (d.status === 'in-swath') {
      h += '<div class="ev"><div class="elabel">When it fell here</div><div class="enote">The daily radar total only says sometime between ' + esc(periodText) + '. Hourly timing for this storm is loading.</div></div>';
    }

    // 3. Ground report: separate, with its distance
    var nr = d.nearestReport;
    h += '<div class="ev"><div class="elabel">Nearest ground report</div>';
    if (nr) {
      var far = nr.distanceMi > 0.25;
      h += '<div class="eval">' + inch(nr.sizeIn) + ' <small>' + (far ? nr.distanceMi + ' mi ' + esc(nr.bearing) + ' of this address' : 'at this location') + '</small></div>' +
        '<div class="enote">' + (nr.time ? 'Reported ' + esc(localDay(nr.time)) + ', ' + esc(tz(nr.time)) : 'Time not given') + (nr.loc ? ' near ' + esc(nr.loc) + (nr.state ? ', ' + esc(nr.state) : '') : '') + '.' +
        (far ? ' This report describes hail ' + nr.distanceMi + ' mi away, not at this address.' : '') + '</div>' +
        '<div class="esrc">' + esc(nr.source) + (d.reportsWithin1mi > 1 ? ' · ' + d.reportsWithin1mi + ' reports within 1 mi' : '') + '</div>';
    } else {
      h += '<div class="enote">No hail reports within 10 miles on this storm day.</div>';
    }
    h += '</div>';

    h += '<div class="cta"><a class="btn btn-accent" href="' + esc(reportHref(true)) + '">Check this property</a>' +
      '<p>' + (user ? 'Opens the full property report with ' + esc(stormDayLabel) + ' selected.' : 'Your first property report is free. Create an account to open it.') + '</p></div>';
    showResult(h);
  }
  function showResult(html) { var el = $('result'); el.innerHTML = html; el.hidden = false; }

  // ── Signed-in: my properties in this storm (private) ────────────────────
  var myData = null, activeProp = null;
  function loadMine(retry) {
    if (!user) return;
    $('mySec').hidden = false;
    fetch('/api/storm/' + S.date + '/my-properties', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { $('myBody').textContent = d.error; return; }
      myData = d; renderMine();
      if (d.inside.length && d.hourly !== 'ready' && (retry || 0) < 8) setTimeout(function () { loadMine((retry || 0) + 1); }, 20000);
    }).catch(function () { $('myBody').textContent = 'Couldn&rsquo;t load your properties.'; });
  }
  function propTime(p) {
    if (p.hourly) return 'About ' + hourSpan(p.hourly.windowStart, p.hourly.windowEnd) + ' · hourly radar';
    return 'Sometime ' + periodText + ' · daily radar maximum';
  }
  function renderMine() {
    var d = myData, b = $('myBody');
    propsLayer.clearLayers();
    if (!d.total) {
      b.innerHTML = '<p class="mysum">You haven&rsquo;t saved any properties yet. Add your customers to your Portfolio and they&rsquo;ll show up here when a storm hits them.</p><a class="btn btn-line" href="/watchlist">Open Portfolio</a>';
      return;
    }
    if (!d.hasRadar) { b.innerHTML = '<p class="mysum">Radar hail data isn&rsquo;t available for this date, so we can&rsquo;t check your properties against a swath.</p>'; return; }
    var pending = d.total - d.located;
    var sum = d.inside.length
      ? '<b>' + d.inside.length + '</b> of your ' + d.total + ' saved propert' + (d.total === 1 ? 'y is' : 'ies are') + ' inside this storm&rsquo;s hail swath, largest first.'
      : 'None of your ' + d.total + ' saved propert' + (d.total === 1 ? 'y is' : 'ies are') + ' inside this storm&rsquo;s hail swath (0.75"+).';
    if (pending) sum += ' ' + pending + ' still being located.';
    var h = '<p class="mysum">' + sum + '</p>';
    if (d.inside.length) {
      h += '<ul class="plist">' + d.inside.map(function (p, i) {
        return '<li><button class="prow' + (activeProp === i ? ' active' : '') + '" type="button" data-i="' + i + '">' +
          '<span class="psize" style="background:' + hailColor(p.inches) + '">' + p.inches.toFixed(2) + '"</span>' +
          '<span><span class="pname">' + esc(p.name || 'Saved property') + '</span><br><span class="paddr">' + esc(p.address) + '</span>' +
          '<span class="ptime" style="display:block">' + esc(propTime(p)) + '</span>' +
          (p.nearestReport ? '<span class="ptime" style="display:block">Ground report ' + inch(p.nearestReport.sizeIn) + ', ' + p.nearestReport.distanceMi + ' mi ' + esc(p.nearestReport.bearing) + (p.nearestReport.time ? ' at ' + esc(tz(p.nearestReport.time)) : '') + '</span>' : '') +
          '</span></button>' +
          (activeProp === i ? '<div class="pactions"><a class="btn btn-line" href="' + esc(propHref(p, false)) + '">View property history</a><a class="btn btn-navy" href="' + esc(propHref(p, true)) + '">Open storm report</a></div>' : '') +
          '</li>';
      }).join('') + '</ul>';
      h += '<div class="mytools"><button class="btn btn-line" id="emailMine" type="button">Email me this list</button><a class="btn btn-line" href="/watchlist">Portfolio</a></div>';
      d.inside.forEach(function (p, i) {
        L.marker([p.lat, p.lon], { icon: L.divIcon({ className: '', iconSize: [16, 16], html: '<div class="prop-dot" style="background:' + hailColor(p.inches) + '"></div>' }) })
          .bindTooltip(esc(p.name || p.address) + ' · ' + p.inches.toFixed(2) + '"')
          .on('click', function () { selectProp(i); })
          .addTo(propsLayer);
      });
    }
    b.innerHTML = h;
    b.querySelectorAll('.prow').forEach(function (btn) { btn.addEventListener('click', function () { selectProp(+btn.dataset.i); }); });
    var em = $('emailMine');
    if (em) em.addEventListener('click', function () {
      em.disabled = true;
      fetch('/api/storm/' + S.date + '/my-properties/email', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (j) {
        em.disabled = false;
        toast(j.success ? 'Sent ' + j.count + ' propert' + (j.count === 1 ? 'y' : 'ies') + ' to ' + esc(j.to) + '.' : esc(j.error || 'Could not send.'));
      }).catch(function () { em.disabled = false; toast('Could not send.'); });
    });
  }
  function propHref(p, withDate) {
    var q = new URLSearchParams({ address: p.address, lat: p.lat, lon: p.lon });
    if (withDate) q.set('date', S.date);
    return '/dashboard?' + q.toString();
  }
  function selectProp(i) {
    activeProp = i;
    var p = myData.inside[i];
    renderMine();
    setSheet('half');
    afterSheet(function () { focusOn(p.lat, p.lon, 15); });
    var row = document.querySelector('.prow[data-i="' + i + '"]');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  // ── Share (storm and map area only: no address, no customers) ───────────
  $('shareBtn').addEventListener('click', function () {
    var c = map.getCenter();
    var url = location.origin + '/storm/' + S.date + '?lat=' + c.lat.toFixed(4) + '&lon=' + c.lng.toFixed(4) + '&z=' + map.getZoom();
    var title = $('stormDate').textContent + ' hail storm';
    var note = 'Link copied. It opens this storm and map area only. No addresses or customer information are included.';
    if (navigator.share && isPhone()) {
      navigator.share({ title: title, url: url }).catch(function () {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(function () { toast(note, 5000); }, function () { prompt('Copy this link:', url); });
    } else { prompt('Copy this link:', url); }
  });

  // ── Panel: collapsible on desktop, bottom sheet on a phone ──────────────
  function isPhone() { return window.matchMedia('(max-width: 760px)').matches; }
  var panel = $('panel');
  $('collapseBtn').addEventListener('click', function () {
    panel.classList.toggle('collapsed');
    var collapsed = panel.classList.contains('collapsed');
    this.setAttribute('aria-label', collapsed ? 'Show panel' : 'Hide panel');
    setTimeout(function () { map.invalidateSize(); }, 260);
  });
  function measurePeek() {
    var h = $('grab').offsetHeight + panel.querySelector('.peek').offsetHeight;
    panel.style.setProperty('--peek-h', h + 'px');
  }
  var SHEETS = ['peek', 'half', 'full'];
  function afterSheet(fn) { if (isPhone()) setTimeout(fn, 280); else fn(); }
  function setSheet(s) {
    if (!isPhone()) return;
    panel.dataset.sheet = s;
    $('grab').setAttribute('aria-label', s === 'full' ? 'Show less' : 'Show more storm details');
  }
  $('grab').addEventListener('click', function () {
    if (dragMoved) return;
    var i = SHEETS.indexOf(panel.dataset.sheet);
    setSheet(i >= 2 ? 'peek' : SHEETS[i + 1]);
  });
  // Drag the sheet by its handle or the playback strip.
  var dragY = null, dragStart = 0, dragMoved = false;
  function onDown(e) {
    if (!isPhone() || e.target.closest('input, button.play-btn, a')) return;
    dragY = e.clientY; dragMoved = false;
    dragStart = panel.getBoundingClientRect().top - panel.parentElement.getBoundingClientRect().top;
    panel.style.transition = 'none';
  }
  function onMove(e) {
    if (dragY == null) return;
    var dy = e.clientY - dragY;
    if (Math.abs(dy) > 6) dragMoved = true;
    if (!dragMoved) return;
    var stageH = panel.parentElement.getBoundingClientRect().height;
    var top = Math.max(stageH - panel.offsetHeight, Math.min(stageH - 60, dragStart + dy));
    panel.style.transform = 'translateY(' + (top - (stageH - panel.offsetHeight)) + 'px)';
  }
  function onUp(e) {
    if (dragY == null) return;
    var dy = e.clientY - dragY;
    dragY = null; panel.style.transition = ''; panel.style.transform = '';
    if (!dragMoved) return;
    var i = SHEETS.indexOf(panel.dataset.sheet);
    if (dy < -40) setSheet(SHEETS[Math.min(2, i + 1)]);
    else if (dy > 40) setSheet(SHEETS[Math.max(0, i - 1)]);
    setTimeout(function () { dragMoved = false; }, 0);
  }
  ['grab'].forEach(function (id) { $(id).addEventListener('pointerdown', onDown); });
  panel.querySelector('.peek').addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('resize', function () { measurePeek(); map.invalidateSize(); });

  // ── Start ────────────────────────────────────────────────────────────────
  measurePeek();
  setHeader(); setSources(); setPeek();
  $('dayLink').href = '/hail-maps/' + S.date;
  loadView();
  fetch('/api/me', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (me) {
    user = me && (me.user || me);
    if (!user || !user.email) { user = null; return; }
    $('acctLink').textContent = 'Dashboard'; $('acctLink').href = '/dashboard';
    loadMine();
  }).catch(function () {});
  if (!S.hasRadar || S.date < S.playbackFrom) lockPlayback(S.hasRadar ? 'Playback isn&rsquo;t available for this date' : 'No radar data for this date');
})();
