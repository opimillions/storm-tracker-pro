/* Radar hail swath layer for Leaflet. Cells are [latC, lonC, inches], where
 * latC/lonC are the south-west corner of a 0.01° cell in hundredths of a degree. */
(function () {
  var STOPS = [
    [3.0, '#3b0764'], [2.5, '#6d28d9'], [2.0, '#9d174d'], [1.75, '#b91c1c'], [1.5, '#dc2626'],
    [1.25, '#ea580c'], [1.0, '#f59e0b'], [0.75, '#fbbf24'], [0, '#fde68a']
  ];
  function hailColor(inches) {
    for (var i = 0; i < STOPS.length; i++) if (inches >= STOPS[i][0]) return STOPS[i][1];
    return STOPS[STOPS.length - 1][1];
  }
  window.hailColor = hailColor;
  window.HAIL_LEGEND = [[0.5, '0.5"'], [0.75, '0.75"'], [1.0, '1"'], [1.25, '1.25"'], [1.5, '1.5"'], [1.75, '1.75"'], [2.0, '2"'], [2.5, '2.5"'], [3.0, '3"+']]
    .map(function (s) { return { color: hailColor(s[0]), label: s[1] }; });

  L.SwathLayer = L.GridLayer.extend({
    options: { opacity: 0.7, minIn: 0, zIndex: 300 },
    initialize: function (cells, options) {
      L.setOptions(this, options);
      this.setCells(cells || [], true);
    },
    setCells: function (cells, silent) {
      this._buckets = {};
      for (var k = 0; k < cells.length; k++) {
        var c = cells[k];
        var key = Math.floor(c[0] / 100) + '_' + Math.floor(c[1] / 100);
        (this._buckets[key] = this._buckets[key] || []).push(c);
      }
      this._count = cells.length;
      if (!silent && this._map) this.redraw();
      return this;
    },
    setMinIn: function (v) { this.options.minIn = v; if (this._map) this.redraw(); },
    createTile: function (coords) {
      var tile = document.createElement('canvas');
      var size = this.getTileSize();
      tile.width = size.x; tile.height = size.y;
      if (!this._count) return tile;
      var ctx = tile.getContext('2d');
      var map = this._map, z = coords.z;
      var nwPx = coords.scaleBy(size);
      var nw = map.unproject(nwPx, z), se = map.unproject(nwPx.add(size), z);
      var minIn = this.options.minIn || 0;
      for (var la = Math.floor(se.lat); la <= Math.floor(nw.lat); la++) {
        for (var lo = Math.floor(nw.lng); lo <= Math.floor(se.lng); lo++) {
          var b = this._buckets[la + '_' + lo];
          if (!b) continue;
          for (var i = 0; i < b.length; i++) {
            var c = b[i];
            if (c[2] < minIn) continue;
            var s = c[0] / 100, w = c[1] / 100;
            if (s > nw.lat || s + 0.01 < se.lat || w > se.lng || w + 0.01 < nw.lng) continue;
            var p1 = map.project([s + 0.01, w], z).subtract(nwPx);
            var p2 = map.project([s, w + 0.01], z).subtract(nwPx);
            ctx.fillStyle = hailColor(c[2]);
            ctx.fillRect(Math.floor(p1.x), Math.floor(p1.y), Math.max(1, Math.ceil(p2.x - p1.x)), Math.max(1, Math.ceil(p2.y - p1.y)));
          }
        }
      }
      return tile;
    }
  });

  window.cellsBounds = function (cells) {
    if (!cells.length) return null;
    var s = 90, n = -90, w = 180, e = -180;
    cells.forEach(function (c) {
      var la = c[0] / 100, lo = c[1] / 100;
      if (la < s) s = la; if (la + 0.01 > n) n = la + 0.01;
      if (lo < w) w = lo; if (lo + 0.01 > e) e = lo + 0.01;
    });
    return L.latLngBounds([s, w], [n, e]);
  };

  window.renderHailLegend = function (el) {
    el.innerHTML = window.HAIL_LEGEND.map(function (l) {
      return '<span><i style="background:' + l.color + '"></i>' + l.label + '</span>';
    }).join('');
  };
})();
