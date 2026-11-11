const test = require('node:test');
const assert = require('node:assert');
const weather = require('../lib/weather');

function period(name, start, isDaytime, temperature, shortForecast, pop) {
  return { name, startTime: start, isDaytime, temperature, shortForecast, probabilityOfPrecipitation: { value: pop } };
}

test('day and night periods become 7 days with high, low and rain chance', () => {
  const periods = [period('Tonight', '2026-11-10T18:00:00-06:00', false, 48, 'Clear', 0)];
  for (let i = 11; i <= 17; i++) {
    periods.push(period('Day' + i, `2026-11-${i}T06:00:00-06:00`, true, 60 + i, i === 12 ? 'Chance Thunderstorms' : 'Sunny', i === 12 ? 60 : 5));
    periods.push(period('Day' + i + ' Night', `2026-11-${i}T18:00:00-06:00`, false, 40 + i, 'Clear', 0));
  }
  const days = weather.toDays(periods);
  assert.strictEqual(days.length, 7);
  assert.deepStrictEqual(days[0], { date: '2026-11-10', name: 'Tonight', high: null, low: 48, sky: 'Clear', rain: 0 });
  assert.strictEqual(days[2].high, 72);
  assert.strictEqual(days[2].low, 52);
  assert.strictEqual(days[2].rain, 60);
  assert.strictEqual(days[2].sky, 'Chance Thunderstorms');
});

test('forecast reads place, current conditions and warnings, and caches', async () => {
  weather._cache.clear();
  let calls = 0;
  const http = {
    get: async (url) => {
      calls++;
      if (url.includes('/points/')) return { data: { properties: { forecast: 'F', forecastHourly: 'H', relativeLocation: { properties: { city: 'Southlake', state: 'TX' } } } } };
      if (url === 'F') return { data: { properties: { periods: [period('Today', '2026-11-10T06:00:00-06:00', true, 71, 'Sunny', 0)] } } };
      if (url === 'H') return { data: { properties: { periods: [{ temperature: 68, shortForecast: 'Mostly Sunny', windSpeed: '10 mph', windDirection: 'S' }] } } };
      if (url.includes('/alerts/')) return { data: { features: [{ properties: { event: 'Severe Thunderstorm Warning', severity: 'Severe' } }] } };
      throw new Error('unexpected ' + url);
    },
  };
  const w = await weather.forecast(32.94, -97.13, http);
  assert.strictEqual(w.place, 'Southlake, TX');
  assert.deepStrictEqual(w.now, { temp: 68, sky: 'Mostly Sunny', wind: '10 mph S' });
  assert.strictEqual(w.days[0].high, 71);
  assert.strictEqual(w.alerts[0].event, 'Severe Thunderstorm Warning');
  const before = calls;
  await weather.forecast(32.94, -97.13, http);
  assert.strictEqual(calls, before, 'second call within 30 minutes comes from cache');
});
