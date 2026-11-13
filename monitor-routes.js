/**
 * Read-only pipeline status for the external StormCheck monitor (Billy Bob).
 *
 * GET /api/monitor/pipeline   header: x-monitor-token: <MONITOR_TOKEN>
 *
 * Reports what each NOAA feed has actually imported (dates, fetch times,
 * counts) and the last attempt / success / error of each scheduled job.
 * Returns 404 when MONITOR_TOKEN is not set, so nothing is exposed by default.
 * No customer data is included.
 */
const fs = require('fs');
const crypto = require('crypto');
const { dataPath } = require('./lib/paths');
const mesh = require('./lib/mesh-store');
const spc = require('./lib/spc-store');
const ncei = require('./lib/ncei-store');
const hailsig = require('./lib/hailsig-store');
const dataJobs = require('./lib/data-jobs');

const ds = d => d.toISOString().slice(0, 10);
const shift = (date, n) => ds(new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000));

function tokenOk(req) {
  const want = process.env.MONITOR_TOKEN;
  const got = String(req.get('x-monitor-token') || '');
  if (!want || want.length < 24) return false;
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

function framesCache(limit = 6) {
  let files = [];
  try { files = fs.readdirSync(dataPath('frames')).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-limit); } catch { /* none */ }
  return files.map(f => {
    const file = dataPath('frames', f);
    try {
      const frames = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        date: f.slice(0, 10),
        builtAt: fs.statSync(file).mtime.toISOString(),
        frames: frames.length,
        withCells: frames.filter(x => x.cells && x.cells.length).length,
        errors: frames.filter(x => x.error).length,
      };
    } catch (e) { return { date: f.slice(0, 10), error: e.message }; }
  });
}

function pipeline() {
  const spcToday = spc.today();
  const spcDays = {};
  for (let i = 0; i < 3; i++) { const d = shift(spcToday, -i); spcDays[d] = spc.dayMeta(d); }

  const meshDays = mesh.ingestedDays().slice(-5).reverse().map(d => {
    const { tiles, ...info } = mesh.dayInfo(d) || {};
    return { date: d, ...info };
  });

  const years = ncei.yearInfo();
  const recentYears = Object.keys(years).sort().slice(-3);

  const sigDays = {};
  const lastRadar = mesh.coverage().last;
  if (lastRadar) for (let i = -4; i <= 1; i++) { const d = shift(lastRadar, i); sigDays[d] = hailsig.utcDayInfo(d); }

  return {
    now: new Date().toISOString(),
    jobsEnabled: dataJobs.jobsEnabled(),
    startedAt: dataJobs.getStatus().startedAt,
    runs: dataJobs.getRuns(),
    spc: { convectiveToday: spcToday, coverage: spc.coverage(), days: spcDays },
    mesh: { expectedThrough: dataJobs.lastCompleteDay(), coverage: mesh.coverage(), recent: meshDays },
    ncei: { coverage: ncei.coverage(), years: Object.fromEntries(recentYears.map(y => [y, years[y]])) },
    hailsig: { coverage: hailsig.coverage(), days: sigDays },
    frames: framesCache(),
    portfolioRuns: dataJobs.getPortfolioRuns(),
  };
}

const alerts = require('./lib/alerts');
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

module.exports = function monitorRoutes(app) {
  // Dry run of the saved-property alert rule at one point. Sends nothing, stores nothing.
  app.get('/api/monitor/portfolio-match', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!process.env.MONITOR_TOKEN) return res.status(404).json({ error: 'Not found' });
    if (!tokenOk(req)) return res.status(401).json({ error: 'Monitor token required' });
    const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon), min = parseFloat(req.query.min || '1');
    if (!isDate(req.query.date) || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(min)) return res.status(400).json({ error: 'date, lat, lon and min required' });
    try { res.json({ date: req.query.date, lat, lon, min, ...alerts.matchPoint(req.query.date, lat, lon, min) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/monitor/pipeline', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!process.env.MONITOR_TOKEN) return res.status(404).json({ error: 'Not found' });
    if (!tokenOk(req)) return res.status(401).json({ error: 'Monitor token required' });
    try { res.json(pipeline()); } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
module.exports._pipeline = pipeline;
