/**
 * Weather for the ticker: current conditions, 7-day forecast and active warnings
 * from the National Weather Service (api.weather.gov — free, no key, U.S. only).
 */
const axios = require('axios');

const UA = 'StormCheckPro/1.0 (stormcheckpro.thepublicadjustertx.com, firstcallpublicadjusters@gmail.com)';
const TTL_MS = 30 * 60 * 1000;
const cache = new Map(); // "lat,lon" -> { at, data }

async function getJson(url, http) {
  const r = await http.get(url, { headers: { 'User-Agent': UA, Accept: 'application/geo+json' }, timeout: 10000 });
  return r.data;
}

// Day/night forecast periods -> one row per day with high, low, sky and rain chance.
function toDays(periods) {
  const days = [];
  for (const p of periods || []) {
    const key = String(p.startTime || '').slice(0, 10);
    let d = days.find((x) => x.date === key);
    if (!d) {
      if (days.length >= 7) continue;
      d = { date: key, name: p.isDaytime ? p.name : String(p.name || '').replace(/\s+Night$/i, '') || p.name, high: null, low: null, sky: '', rain: null };
      days.push(d);
    }
    const pop = p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value;
    if (pop != null) d.rain = Math.max(d.rain || 0, pop);
    if (p.isDaytime) { d.high = p.temperature; d.sky = p.shortForecast || d.sky; }
    else { d.low = p.temperature; if (!d.sky) d.sky = p.shortForecast || ''; }
  }
  return days.slice(0, 7);
}

async function forecast(lat, lon, http = axios) {
  lat = Number(lat); lon = Number(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('bad location');
  const key = lat.toFixed(2) + ',' + lon.toFixed(2);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const point = await getJson(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, http);
  const pp = point.properties || {};
  const rel = pp.relativeLocation && pp.relativeLocation.properties;
  const [daily, hourly, alerts] = await Promise.all([
    getJson(pp.forecast, http),
    pp.forecastHourly ? getJson(pp.forecastHourly, http).catch(() => null) : null,
    getJson(`https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`, http).catch(() => null),
  ]);
  const now = hourly && hourly.properties && hourly.properties.periods && hourly.properties.periods[0];
  const data = {
    place: rel ? `${rel.city}, ${rel.state}` : null,
    now: now ? { temp: now.temperature, sky: now.shortForecast, wind: [now.windSpeed, now.windDirection].filter(Boolean).join(' ') } : null,
    days: toDays(daily && daily.properties && daily.properties.periods),
    alerts: ((alerts && alerts.features) || []).map((f) => f.properties || {})
      .map((a) => ({ event: a.event, severity: a.severity, ends: a.ends || a.expires || null }))
      .filter((a) => a.event).slice(0, 3),
    updated: new Date().toISOString(),
  };
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return data;
}

module.exports = { forecast, toDays, _cache: cache };
