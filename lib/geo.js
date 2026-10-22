/**
 * Geometry helpers shared by the data stores.
 *
 * Grid convention: the MRMS grid is 0.01° cells. A cell is identified by the
 * integer coordinates of its south-west corner in hundredths of a degree
 * (latC, lonC). Tiles are 1° x 1°, keyed by floor(lat), floor(lon).
 */
const EARTH_MI = 3958.8;

function distanceMiles(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return EARTH_MI * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Shortest distance from a point to a line segment (for tornado paths), in miles.
function distanceToSegmentMiles(lat, lon, lat1, lon1, lat2, lon2) {
  if (lat2 == null || lon2 == null || (lat1 === lat2 && lon1 === lon2)) return distanceMiles(lat, lon, lat1, lon1);
  const kx = Math.cos(lat * Math.PI / 180);
  const ax = (lon1 - lon) * kx, ay = lat1 - lat;
  const bx = (lon2 - lon) * kx, by = lat2 - lat;
  const dx = bx - ax, dy = by - ay;
  let t = -(ax * dx + ay * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  const px = ax + t * dx, py = ay + t * dy;
  return Math.sqrt(px * px + py * py) * 69.0;
}

function cellOf(lat, lon) {
  return { latC: Math.floor(lat * 100 + 1e-9), lonC: Math.floor(lon * 100 + 1e-9) };
}

function cellCenter(latC, lonC) {
  return { lat: (latC + 0.5) / 100, lon: (lonC + 0.5) / 100 };
}

function tileOfCell(latC, lonC) {
  const tLat = Math.floor(latC / 100);
  const tLon = Math.floor(lonC / 100);
  return { tLat, tLon, key: `${tLat}_${tLon}`, offset: (latC - tLat * 100) * 100 + (lonC - tLon * 100) };
}

function tileKey(lat, lon) {
  return `${Math.floor(lat)}_${Math.floor(lon)}`;
}

// Every 1° tile touched by a circle of radius `mi` around (lat, lon).
function tilesAround(lat, lon, mi) {
  const dLat = mi / 69.0;
  const dLon = mi / (69.0 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  return tilesInBBox(lon - dLon, lat - dLat, lon + dLon, lat + dLat);
}

function tilesInBBox(w, s, e, n) {
  const keys = [];
  for (let la = Math.floor(s); la <= Math.floor(n); la++) {
    for (let lo = Math.floor(w); lo <= Math.floor(e); lo++) keys.push(`${la}_${lo}`);
  }
  return keys;
}

const mmToIn = mm => Math.round((mm / 25.4) * 100) / 100;

module.exports = {
  distanceMiles, distanceToSegmentMiles, cellOf, cellCenter, tileOfCell,
  tileKey, tilesAround, tilesInBBox, mmToIn,
};
