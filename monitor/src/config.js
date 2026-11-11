/** Monitor settings, all from environment variables. */
const env = (k, d = '') => (process.env[k] ?? d).trim();
const num = (k, d) => (Number.isFinite(+process.env[k]) && process.env[k] !== '' ? +process.env[k] : d);

const appUrl = env('STORMCHECK_URL', 'https://stormcheckpro.thepublicadjustertx.com').replace(/\/$/, '');

module.exports = {
  appUrl,
  monitorToken: env('MONITOR_TOKEN'),          // same value as MONITOR_TOKEN on the StormCheck service
  statusToken: env('STATUS_TOKEN'),            // Billy Bob sends this to read /api/status
  dataDir: env('DATA_DIR', './data'),
  port: num('PORT', 8080),

  // Dedicated test account (non-admin, no 2FA, tier "client" or Pro).
  testEmail: env('TEST_EMAIL'),
  testPassword: env('TEST_PASSWORD'),

  // Known historical storm used for the customer workflow test.
  knownStorm: {
    address: env('KNOWN_STORM_ADDRESS', '100 E Southlake Blvd, Southlake, TX 76092'),
    date: env('KNOWN_STORM_DATE', '2024-03-14'),
    minInches: num('KNOWN_STORM_MIN_IN', 1.0),
  },

  // Test inbox that receives the controlled saved-property alert (IMAP).
  inbox: {
    host: env('TEST_INBOX_IMAP_HOST'),
    port: num('TEST_INBOX_IMAP_PORT', 993),
    user: env('TEST_INBOX_IMAP_USER'),
    pass: env('TEST_INBOX_IMAP_PASS'),
  },

  // Where incidents and recoveries go. Any or all; the panel always shows them.
  notify: {
    // Mission Control (command.thepublicadjustertx.com): incidents become urgent StormCheck tasks for Billy Bob.
    missionControlUrl: env('MISSION_CONTROL_URL', 'https://command.thepublicadjustertx.com'),
    missionControlPassword: env('MISSION_CONTROL_PASSWORD'), // Railway reference to animated-office's ADMIN_PASSWORD
    slackWebhook: env('ALERT_SLACK_WEBHOOK'),
    smtpHost: env('ALERT_SMTP_HOST'),
    smtpPort: num('ALERT_SMTP_PORT', 587),
    smtpUser: env('ALERT_SMTP_USER'),
    smtpPass: env('ALERT_SMTP_PASS'),
    smtpFrom: env('ALERT_SMTP_FROM'),
    to: env('ALERT_TO'),
  },

  intervals: {
    feedsMin: num('FEED_INTERVAL_MIN', 10),
    workflowMin: num('WORKFLOW_INTERVAL_MIN', 60),
    alertTestHours: num('ALERT_TEST_HOURS', 24),
    retryDelaySec: num('RETRY_DELAY_SEC', 20),
  },
  incidentAfter: num('INCIDENT_AFTER_FAILURES', 2), // consecutive failed runs (each already retried once)
  panelUrl: env('PANEL_URL', 'https://billy-bob-ceo-production.up.railway.app/stormcheck'),
};
