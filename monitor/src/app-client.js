/**
 * Talks to StormCheck Pro two ways:
 *  - the monitor endpoint (what the importers stored), with MONITOR_TOKEN
 *  - the customer APIs, signed in as the dedicated test account (what customers are served)
 */
const config = require('./config');

let token = null;

async function call(path, { method = 'GET', body, auth = true, monitor = false, timeout = 30000 } = {}) {
  const headers = { 'User-Agent': 'StormCheckMonitor/1.0', Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (monitor) headers['x-monitor-token'] = config.monitorToken;
  if (auth && token) headers.Cookie = `token=${token}`;
  const r = await fetch(config.appUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout), redirect: 'manual' });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, headers: r.headers };
}

async function signIn() {
  if (!config.testEmail || !config.testPassword) throw Object.assign(new Error('Test account not configured (TEST_EMAIL / TEST_PASSWORD)'), { setup: true });
  const r = await call('/api/auth/login', { method: 'POST', body: { email: config.testEmail, password: config.testPassword }, auth: false });
  if (r.status !== 200 || !r.json || !r.json.success) {
    if (r.json && r.json.twoFactor) throw new Error('The test account has two-step sign-in turned on; the monitor needs it off');
    throw new Error(`Test account sign-in failed (HTTP ${r.status}${r.json && r.json.error ? `: ${r.json.error}` : ''})`);
  }
  const m = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || '']).join(';').match(/(?:^|[;,]\s*)token=([^;]+)/);
  if (!m) throw new Error('Sign-in succeeded but no session cookie came back');
  token = m[1];
  return true;
}

/** Customer API call as the test account; signs in again once if the session expired. */
async function customer(path, opts = {}) {
  if (!token) await signIn();
  let r = await call(path, opts);
  if (r.status === 401) { await signIn(); r = await call(path, opts); }
  return r;
}

async function pipeline() {
  if (!config.monitorToken) throw Object.assign(new Error('MONITOR_TOKEN not set on the monitor'), { setup: true });
  const r = await call('/api/monitor/pipeline', { monitor: true, auth: false });
  if (r.status === 404) throw Object.assign(new Error('StormCheck Pro does not expose /api/monitor/pipeline yet (deploy the endpoint and set MONITOR_TOKEN)'), { setup: true });
  if (r.status !== 200 || !r.json) throw new Error(`Pipeline status answered HTTP ${r.status}`);
  return r.json;
}

const hasCredentials = () => !!(config.testEmail && config.testPassword);

module.exports = { call, customer, signIn, pipeline, hasCredentials, _reset: () => { token = null; } };
