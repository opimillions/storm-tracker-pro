/**
 * Storm Alert Monitor — StormCheck Pro
 * - NWS active alerts: every 5 minutes
 * - NOAA MRMS radar hail detection: every 5 minutes
 * - Push notifications + email on detection
 */
const cron = require('node-cron');
const axios = require('axios');

const WATCH_POINTS = [
  { name: 'DFW Metroplex',  lat: 32.7767, lon: -96.7970 },
  { name: 'Southlake TX',   lat: 32.9440, lon: -97.1341 },
  { name: 'Fort Worth TX',  lat: 32.7555, lon: -97.3308 },
  { name: 'Oklahoma City',  lat: 35.4676, lon: -97.5164 },
  { name: 'Denver CO',      lat: 39.7392, lon: -104.9903 },
];

const firedAlerts = new Set();
const firedMRMSAlerts = new Set(); // prevent duplicate MRMS alerts
const MRMS_MIN_HAIL_IN = 0.75; // minimum hail size to alert (inches)

// ── Push notification store (in-memory, keyed by subscription endpoint) ──────
let pushSubscriptions = []; // filled by server registration

async function sendStormEmail(subject, html) {
  if (!require('./lib/mailer').isConfigured() || !process.env.ADMIN_EMAIL) {
    console.log('Storm alert (no SMTP):', subject);
    return;
  }
  try {
    const t = { sendMail: o => require('./lib/mailer').deliver(o), verify: async () => true };
    const recipients = [process.env.ADMIN_EMAIL];
    if (process.env.ALERT_PHONE_EMAIL) recipients.push(process.env.ALERT_PHONE_EMAIL);
    await t.sendMail({
      to: recipients.join(','),
      subject,
      text: subject, // plain text for SMS delivery
      html
    });
    console.log('Storm alert email sent:', subject);
  } catch (err) { console.error('Storm email error:', err.message); }
}

async function sendPushNotifications(title, body, url) {
  if (!pushSubscriptions.length) return;
  try {
    const webpush = require('web-push');
    const payload = JSON.stringify({ title, body, url });
    const results = await Promise.allSettled(
      pushSubscriptions.map(sub => webpush.sendNotification(sub, payload))
    );
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed) console.log(`Push: ${results.length - failed} sent, ${failed} failed`);
    // Remove failed subscriptions
    pushSubscriptions = pushSubscriptions.filter((_, i) => results[i].status !== 'rejected');
  } catch (err) { console.error('Push notification error:', err.message); }
}

// ── MRMS Radar Hail Detection ─────────────────────────────────────────────────
// NOAA MRMS MESH (Maximum Expected Size of Hail) updates every 2 minutes
async function checkMRMSHail() {
  for (const pt of WATCH_POINTS) {
    try {
      // MRMS point query via Iowa State Mesonet (free, no key)
      const url = `https://mesonet.agron.iastate.edu/json/mrms_rx.py?lat=${pt.lat}&lon=${pt.lon}`;
      const r = await axios.get(url, {
        timeout: 8000,
        headers: { 'User-Agent': 'StormCheckPro/1.0 (stormcheckpro.thepublicadjustertx.com)' }
      });

      if (!r.data || !r.data.values) continue;

      // MRMS MESH value is in mm — convert to inches
      const meshMM = r.data.values?.['MESH'] || r.data.values?.['Q3MESH'] || 0;
      const meshIn = (meshMM / 25.4).toFixed(2);

      if (meshMM > 0 && meshIn >= MRMS_MIN_HAIL_IN) {
        const alertKey = `mrms-${pt.name}-${new Date().toISOString().slice(0,13)}`; // unique per hour
        if (firedMRMSAlerts.has(alertKey)) continue;
        firedMRMSAlerts.add(alertKey);

        console.log(`MRMS HAIL DETECTED: ${pt.name} — ${meshIn}" estimated`);

        const sizeDesc = meshIn >= 2.0 ? 'Egg' : meshIn >= 1.75 ? 'Golf Ball' : meshIn >= 1.5 ? 'Ping Pong' : meshIn >= 1.0 ? 'Quarter' : 'Penny';
        const baseUrl = process.env.BASE_URL || 'https://stormcheckpro.thepublicadjustertx.com';
        const subject = `🌨️ HAIL ALERT: ${meshIn}" (${sizeDesc}) — ${pt.name}`;
        const body = `${meshIn}" hail detected by NOAA radar at ${pt.name}. Act now.`;

        // Send push notification (fastest — shows on phone immediately)
        await sendPushNotifications(
          `🌨️ Hail Detected — ${pt.name}`,
          `${meshIn}" (${sizeDesc}) detected by radar. Open StormCheck Pro to generate lead list.`,
          `${baseUrl}/storms`
        );

        // Send email
        await sendStormEmail(subject, `
          <div style="font-family:Arial,sans-serif;max-width:600px">
            <div style="background:#1565C0;color:white;padding:20px;border-radius:8px 8px 0 0">
              <h2 style="margin:0">🌨️ Radar-Detected Hail Alert</h2>
            </div>
            <div style="padding:20px;background:#f9f9f9;border:1px solid #ddd;border-top:none">
              <p><strong>Location:</strong> ${pt.name}</p>
              <p><strong>Estimated Size:</strong> ${meshIn}" (${sizeDesc})</p>
              <p><strong>Source:</strong> NOAA MRMS Radar</p>
              <p><strong>Time:</strong> ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CDT</p>
              <p style="color:#c0392b"><strong>This is radar-estimated data. Ground reports may differ.</strong></p>
              <p><a href="${baseUrl}/storms" style="background:#c0392b;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold">View Storm Map →</a></p>
            </div>
            <div style="background:#1a1a2e;color:rgba(255,255,255,0.6);padding:12px 20px;font-size:0.8em;border-radius:0 0 8px 8px">
              StormCheck Pro · First Call Public Adjusters · (817) 618-9884
            </div>
          </div>
        `);
      }
    } catch (err) { /* silent — MRMS may be temporarily unavailable */ }
  }
}

// ── NWS Active Alerts ─────────────────────────────────────────────────────────
async function checkNWSAlerts(alertOps) {
  for (const pt of WATCH_POINTS) {
    try {
      const r = await axios.get(`https://api.weather.gov/alerts/active?point=${pt.lat},${pt.lon}`, {
        headers: { 'User-Agent': 'StormCheckPro/1.0 (stormcheckpro.thepublicadjustertx.com)' },
        timeout: 10000
      });
      const severe = (r.data.features || []).filter(a => {
        const ev = (a.properties.event || '').toLowerCase();
        return (a.properties.severity === 'Severe' || a.properties.severity === 'Extreme') &&
          (ev.includes('hail') || ev.includes('thunderstorm') || ev.includes('tornado') || ev.includes('wind'));
      });
      for (const alert of severe) {
        const id = alert.properties.id;
        if (firedAlerts.has(id)) continue;
        firedAlerts.add(id);
        const event = alert.properties.event;
        const headline = alert.properties.headline || event;
        const baseUrl = process.env.BASE_URL || 'https://stormcheckpro.thepublicadjustertx.com';
        const time = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });

        console.log(`NWS ALERT: ${pt.name} — ${event}`);

        // Push notification
        await sendPushNotifications(
          `⚠️ ${event} — ${pt.name}`,
          headline,
          `${baseUrl}/storms`
        );

        // Email
        await sendStormEmail(
          `⚠️ ${event} — ${pt.name}`,
          `<div style="font-family:Arial,sans-serif;max-width:600px">
            <div style="background:#c0392b;color:white;padding:20px;border-radius:8px 8px 0 0"><h2 style="margin:0">⚠️ Storm Alert — ${pt.name}</h2></div>
            <div style="padding:20px;background:#f9f9f9;border:1px solid #ddd;border-top:none">
              <p><strong>${headline}</strong></p>
              <p>Severity: ${alert.properties.severity} | Detected: ${time} CDT</p>
              <p><a href="${baseUrl}/dashboard" style="background:#c0392b;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold">Open StormCheck Pro →</a></p>
            </div>
            <div style="background:#1a1a2e;color:rgba(255,255,255,0.6);padding:12px 20px;font-size:0.8em;border-radius:0 0 8px 8px">StormCheck Pro · First Call Public Adjusters · (817) 618-9884</div>
          </div>`
        );

        if (alertOps) {
          await alertOps.upsert({ alertId: id, area: pt.name, eventType: event, hailSize: null, severity: alert.properties.severity, onset: alert.properties.onset }).catch(() => {});
        }
      }
    } catch (err) { /* silent */ }
  }
}

// ── Start Monitor ─────────────────────────────────────────────────────────────
function startStormMonitor(alertOps, subscriptions) {
  if (subscriptions) pushSubscriptions = subscriptions;

  console.log('Storm monitor started: NWS + MRMS radar, every 5 minutes');

  // Run every 5 minutes (was 30)
  cron.schedule('*/5 * * * *', async () => {
    await checkNWSAlerts(alertOps);
    await checkMRMSHail();
  }, { timezone: 'America/Chicago' });

  // Run immediately on startup
  setTimeout(async () => {
    await checkNWSAlerts(alertOps);
    await checkMRMSHail();
  }, 3000);
}

module.exports = { startStormMonitor, sendPushNotifications, get pushSubscriptions() { return pushSubscriptions; } };
