/**
 * Production feature list (from StormCheck Pro's routes and plan features)
 * and which checks cover each one.
 */
module.exports = [
  { feature: 'Sign in', checks: ['wf.signin'] },
  { feature: 'Address search / property lookup', checks: ['wf.search'] },
  { feature: 'Property history & date of loss', checks: ['wf.history', 'feed.ncei', 'feed.spc', 'feed.mesh'] },
  { feature: 'Hail map swath', checks: ['wf.swath', 'feed.mesh'] },
  { feature: 'Radar playback (Pro+)', checks: ['wf.playback', 'feed.frames'] },
  { feature: 'PDF report', checks: ['wf.pdf'] },
  { feature: 'Saved-property (portfolio) alerts', checks: ['wf.alert', 'feed.mesh', 'feed.spc'], note: 'Delivery path tested; storm-matching path not yet' },
  { feature: 'Storm list (recent reports)', checks: ['feed.spc'] },
  { feature: 'NWS warning heads-up emails (Team+)', checks: ['feed.nws'] },
  { feature: 'Radar hail probability in reports', checks: ['feed.hailsig'] },
  { feature: 'Your live watch-point hail alerts', checks: ['feed.live'] },
  { feature: 'Storm Disclosure report', checks: [] },
  { feature: 'Territory alerts & storm recaps (email)', checks: [] },
  { feature: 'Free ZIP-code alert sign-up', checks: [] },
  { feature: 'Public hail maps & city pages', checks: [], note: 'Your hourly external website check' },
  { feature: 'Lead areas from a swath', checks: [] },
  { feature: 'Portfolio upload (bulk CSV)', checks: [] },
  { feature: 'CRM integrations (JobNimbus, AccuLynx, webhooks)', checks: [] },
  { feature: 'Meteorologist review orders', checks: [] },
  { feature: 'Billing, upgrade & yearly plans (Stripe)', checks: [] },
  { feature: 'Two-step sign-in', checks: [] },
  { feature: 'Push notifications', checks: [] },
  { feature: 'Referrals, affiliates & Find a Pro', checks: [] },
  { feature: 'Help search', checks: [] },
];
