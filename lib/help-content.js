/**
 * One source for in-app help: the Help page, the "What's new" popup and the
 * AI assistant's knowledge all come from here. Update RELEASE when shipping
 * something users should hear about (a new id shows the popup again).
 */

const RELEASE = {
  id: '2026-10-25',
  title: "What's new in StormCheck Pro",
  items: [
    { title: 'Street View on every report', text: 'Each report now shows the property in Street View (or a one-click link), so you can confirm it is the right house before relying on the hail data.', link: '/dashboard' },
    { title: 'Find a Pro directory', text: 'A public directory of public adjusters, appraisers and attorneys by state. Reports with damaging storm dates link to it.', link: '/find-a-pro' },
    { title: 'Severe hail probability', text: 'Reports and alerts now show the National Weather Service radar hail algorithm\'s probability of 1"+ hail, next to the radar hail size.', link: '/dashboard' },
    { title: 'Alert radius and probability', text: 'Pick a radius for each territory and only get alerts when the severe hail probability reaches the level you choose.', link: '/alert-settings' },
    { title: 'Hail size at the property', text: 'Reports now show NOAA radar-estimated hail at the address itself, mark dates Verified when a ground report confirms the radar, and rank the most likely dates of loss.', link: '/dashboard' },
    { title: 'Hail swath map & storm playback', text: 'See exactly where hail fell, adjust the layer transparency, and play a storm back hour by hour.', link: '/hailmap' },
    { title: 'Lead lists from the swath', text: 'Every ZIP code and city inside the hail swath at the size you pick, exported for EDDM, mapping or canvassing apps.', link: '/leads' },
    { title: 'Portfolio monitoring', text: 'Upload the properties you serve. We check them against radar every day and email you when one is hit.', link: '/watchlist' },
    { title: 'CRM integrations', text: 'Connect JobNimbus or AccuLynx to load customers automatically and get hail hits written back as notes. ClaimWizard and other CRMs connect through Zapier.', link: '/integrations' },
    { title: 'New report types', text: 'A one-page Storm Disclosure for realtors and buyers, plus meteorologist-reviewed reports for disputed claims.', link: '/dashboard' },
    { title: 'Put it on your phone', text: 'Add StormCheck Pro to your home screen and it opens like an app. Look for the Install button on your phone, or see the steps.', link: '/install' },
    { title: 'Ask the assistant', text: 'Questions about any feature? Use the chat button in the bottom-right corner.', link: '/help' },
  ],
};

const GUIDES = [
  {
    id: 'getting-started', title: 'Getting started', link: '/dashboard',
    summary: 'The four things to do in your first ten minutes.',
    steps: [
      'Run a lookup: on the Lookup tab, enter a full property address (street, city, state and ZIP) and click Search.',
      'Add the properties you care about on the Portfolio tab (upload a CSV or connect your CRM on the Integrations tab) so we can alert you when they are hit.',
      'Set your alerts on the Alerts tab: minimum hail size, and the areas (territories) you work.',
      'Add your company name and logo in Settings so they appear on the reports you share.',
    ],
  },
  {
    id: 'phone', title: 'Put StormCheck Pro on your phone', link: '/install',
    summary: 'Add it to your home screen so it opens like an app. No app store needed.',
    steps: [
      'iPhone or iPad: open the site in Safari, tap the Share button (a square with an arrow), scroll down, tap "Add to Home Screen", then tap Add.',
      'Android: open the site in Chrome, tap the three-dot menu at the top right, tap "Install app" (or "Add to Home screen"), then tap Install.',
      'On a phone, StormCheck Pro also offers an Install button or tip at the bottom of the screen.',
      'To get hail alerts as phone notifications, open the installed app, tap "Enable Alerts" on the Lookup page and allow notifications.',
    ],
    tips: ['Step-by-step page with pictures of where to tap: /install'],
  },
  {
    id: 'lookup', title: 'Property lookup & storm report', link: '/dashboard',
    summary: 'What hit a property, when, and how big.',
    steps: [
      'Enter the full address including city, state and ZIP, choose how many years to search, and click Search. Reports come back in a few seconds.',
      'The impact score (0–100) reflects the largest hail at the property, how recent it was and how often damaging hail has hit.',
      '"Most likely dates of loss" ranks storm dates by estimated hail size at the property, with wind and tornado activity included. Click a date to see that storm\'s hail swath on the map.',
      'Each date has a confidence label: Verified (radar shows 0.75"+ hail at the property and a ground report within 3 miles agrees), Radar (radar estimate only), Ground report (a spotter report within a mile), Nearby (activity in the area but not at the property).',
      'The Impact Summary table shows radar-estimated hail at the property and within 1, 3 and 10 miles for every storm date. Detailed View lists each individual storm report with distance, source and the National Weather Service description.',
      'Use the radius buttons (1, 3, 10 mi, All) and the date picker to filter the map and table.',
    ],
    tips: ['Storm history covers the last 5 years.', 'Radar estimates are on a roughly 1 km grid; what fell on a specific roof can differ, so pair the report with an inspection.'],
  },
  {
    id: 'reports', title: 'Printing & sharing reports', link: '/dashboard',
    summary: 'Full reports, Storm Disclosure, and meteorologist reviews.',
    steps: [
      'After a lookup, click "Print / Save as PDF" for the full report (dates of loss, radar by date, every storm report within 10 miles).',
      'Click "Storm Disclosure report" for a one-page storm history built for listings, buyers and due diligence.',
      'In the print window choose "Save as PDF" as the printer to get a PDF file.',
      'Your company name (Pro), logo (Team) or full white-label branding (Enterprise) appear automatically. Set them in Settings.',
      '"Request meteorologist review" orders a report where a meteorologist reviews one date of loss and signs off on it. Pick the date, add notes such as the claim number, and submit. You will be emailed a quote or the finished report.',
      '"Copy report link" copies a link that reopens this report for anyone on your account.',
    ],
  },
  {
    id: 'hailmap', title: 'Hail Map & storm playback', link: '/hailmap',
    summary: 'See where hail fell on any day.',
    steps: [
      'Search a city, ZIP or address, or pan and zoom the map to your area.',
      'The left panel lists every day with hail in the current map view. Use the size filter (0.75"+, 1"+, 1.5"+, 2"+) to narrow it.',
      'Click a day to draw its hail swath. Colors run from yellow (small) to purple (3"+); the key is at the bottom of the panel.',
      'Drag the Transparency slider to see streets under the swath. Toggle "Ground reports" to show spotter hail, wind and tornado reports as dots.',
      'Click "Play storm" to animate the storm hour by hour (Pro plan and above, storms since October 2020).',
      'Click "Lead list for this view" to jump to Lead Lists with that storm and area filled in.',
    ],
  },
  {
    id: 'leads', title: 'Post-storm lead lists', link: '/leads',
    summary: 'ZIP codes and cities inside the hail swath.',
    steps: [
      'Pan the map to your territory (up to about 16 degrees across), pick a storm date and the minimum hail size, then click "Find affected areas".',
      'You get every ZIP code and city inside the swath at that size, ranked by largest hail, with a priority (HIGH 1.75"+, MEDIUM 1.25"+, STANDARD).',
      'Download the ZIP list as CSV for EDDM or direct mail.',
      'Download the swath boundary as GeoJSON or KML to load into Google Earth, mapping or canvassing apps.',
    ],
    tips: ['No ZIPs? Lower the hail size or widen the map view.'],
  },
  {
    id: 'portfolio', title: 'Portfolio monitoring', link: '/watchlist',
    summary: 'Get told when properties you serve are hit.',
    steps: [
      'Add one property with "Add Single Contact", or click "Upload CSV" to import many at once. Download the template to see the columns: name, address, city, state, zip, phone, email.',
      'Addresses are located on the map automatically, usually within a few minutes for large imports. The page refreshes itself while it works.',
      'Each card shows the last hail hit and the largest hail in the past 3 years. Click "Full report" for the full storm report on that property.',
      'If an address can\'t be found, click "Fix address" and enter the full street, city, state and ZIP.',
      'Use "Remove duplicates" to clear repeated addresses, or "Delete all" (type DELETE to confirm) to start over.',
      '"Download storm summary (CSV)" exports every property with its hail history.',
      'We check every property against radar each morning and against storm reports every 15 minutes, and send one email listing the properties hit, at or above the hail size set on the Alerts tab.',
    ],
  },
  {
    id: 'alerts', title: 'Alerts', link: '/alert-settings',
    summary: 'Choose what you are alerted about and where.',
    steps: [
      'On the Alerts tab, set the minimum hail size, which event types you want (hail, wind, tornado) and whether to receive email.',
      'Optionally set a minimum severe hail probability (30% to 90%). Territory alerts then only go out when the National Weather Service radar hail algorithm gave at least that chance of 1"+ hail.',
      'Add territories: search a city or area, choose a radius (10 to 150 miles) and add it. You get an email when radar shows hail of your size inside a territory, with the areas hit, how close it came to the center and the severe hail probability.',
      'Portfolio alerts use the same minimum hail size.',
      'Team and Enterprise plans also get a heads-up email when the National Weather Service issues a hail or tornado warning covering your properties or territories, before the storm arrives.',
      'To get alerts on your phone, open StormCheck Pro on that device and tap "Enable Alerts" on the Lookup page.',
    ],
  },
  {
    id: 'integrations', title: 'CRM integrations', link: '/integrations',
    summary: 'JobNimbus, AccuLynx, ClaimWizard and more.',
    steps: [
      'JobNimbus: on the Integrations tab, paste a JobNimbus API key (JobNimbus Settings → API) and click Connect. Your contacts with addresses load into Portfolio and resync every 6 hours. When one is hit, a note is added to that contact in JobNimbus.',
      'AccuLynx: paste an AccuLynx API key (an admin creates one per location in Account Settings → API Keys). Your jobs load into Portfolio by job address, cancelled jobs skipped. Hits are posted as a message on the job.',
      'ClaimWizard and other CRMs: use Zapier or Make. Paste a Zapier "Catch Hook" URL under "Send hail hits" to send every hit to your CRM, and post new clients to your private inbound link to add them to Portfolio. Step-by-step ClaimWizard instructions are on the Integrations page.',
      'Click "Sync now" any time, or Disconnect to stop (you can choose to keep or remove the imported properties).',
    ],
    tips: ['Integrations are included with paid plans.', 'Zapier webhooks require a paid Zapier plan.'],
  },
  {
    id: 'storms', title: 'Storms tab', link: '/storms',
    summary: 'Recent storm reports in your states.',
    steps: [
      'Shows recent hail, wind and tornado reports in the states you watch, on a map and as a list.',
      'Pick the time range at the top. Change your watched states with the Edit link.',
    ],
  },
  {
    id: 'settings', title: 'Settings & branding', link: '/settings',
    summary: 'Your company details, logo and plan.',
    steps: [
      'Add your company name, phone, license numbers and a report footer. They appear on printed reports.',
      'Upload your logo (Team plan and above) and choose an accent color.',
      'Enterprise plans can turn on full white-label to remove StormCheck Pro branding from reports.',
      'Your current plan is shown here; click Upgrade to change plans.',
    ],
  },
];

const FAQ = [
  { q: 'Where does the storm data come from?', a: 'Three NOAA sources: MRMS radar estimates of maximum hail size (about a 1 km grid), the National Weather Service Storm Events Database (official records with descriptions), and Storm Prediction Center spotter reports for the most recent months.' },
  { q: 'What does "Verified" mean?', a: 'Radar estimated hail of 0.75" or larger at the property, and at least one ground hail report was filed within 3 miles on the same day. Two independent sources agreeing is much stronger than either alone.' },
  { q: 'What is "Severe hail chance" or severe hail probability?', a: 'The National Weather Service runs a hail detection algorithm (developed by the National Severe Storms Laboratory) on every radar scan. For each storm cell it estimates the probability of severe hail, meaning 1 inch or larger. Reports show the highest probability for storm cells within 3 miles of the property on each storm date. A dash means no storm cell nearby reached 10%; "…" means that date is still loading.' },
  { q: 'How do I know the report is for the right house?', a: 'Every report shows the property in Street View, or an "Open Street View" button that opens Google Street View at that location. If it is the wrong house, click "Wrong house?" and enter the full address with house number, street, city, state and ZIP.' },
  { q: 'How do I turn on two-step sign-in?', a: 'Go to Settings → Security and click "Turn on". Scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator or 1Password), enter the 6-digit code, and save the backup codes somewhere safe. After that, signing in asks for your password and a code.' },
  { q: 'I lost my phone and can\'t sign in.', a: 'Enter one of your backup codes in place of the 6-digit code. Then go to Settings → Security to make new backup codes, or turn two-step sign-in off and back on with your new phone. If you have no backup codes, contact support.' },
  { q: 'Is my data secure?', a: 'Passwords are stored scrambled (bcrypt), connections are encrypted (HTTPS), card payments are handled by Stripe, CRM keys are encrypted, sign-ins lock after repeated wrong passwords, two-step sign-in is available in Settings → Security, and account data is backed up nightly with encryption. Each account only sees its own properties and reports.' },
  { q: 'What is Find a Pro?', a: 'A public directory at /find-a-pro of public adjusters, insurance appraisers and attorneys who handle storm claims, by state. Professionals can apply for a free listing at /find-a-pro/get-listed; every listing is reviewed and licenses are checked before it goes live.' },
  { q: 'How accurate is the radar hail size?', a: 'Radar estimates the largest hail in each roughly 1 km cell and tends to run a little high. It is very good at showing where hail fell and the relative size; what fell on one specific roof can differ, so use it alongside an inspection.' },
  { q: 'How far back does the history go?', a: 'Storm history covers the last 5 years.' },
  { q: 'How often is the data updated?', a: 'Each day\'s radar hail is added the next morning. Ground storm reports are checked every 15 minutes, and NWS hail warnings every 5 minutes.' },
  { q: 'Why does it say "Address not found"?', a: 'Enter the full address with street, city, state and ZIP code. For Portfolio properties, click "Fix address" on the card. New-construction addresses sometimes are not in the public address databases yet; try the nearest known address.' },
  { q: 'Does it work outside Texas?', a: 'Yes, anywhere in the United States. Radar hail estimates cover the lower 48 states; storm records cover every state. Starter plans cover one state; Pro and above are nationwide.' },
  { q: 'Why can\'t I play back a storm?', a: 'Storm playback is included with Pro and above, and works for storms since October 2020. Zoom in to the storm first; playback covers an area up to about 8 degrees across.' },
  { q: 'My lead list is empty.', a: 'Lower the minimum hail size, or zoom the map out so the storm\'s swath is inside the view, then click "Find affected areas" again.' },
  { q: 'I\'m not getting alert emails.', a: 'Check your spam folder and the Alerts tab (email must be on, and the minimum hail size may be higher than the storm). If you still get nothing, contact support.' },
  { q: 'How do I reset my password?', a: 'Click "Forgot password" on the sign-in page and follow the link in the email. The link expires after one hour.' },
  { q: 'Can I put my logo on reports?', a: 'Pro adds your company name, Team adds your logo, and Enterprise is fully white-labeled with your colors. Set them in Settings.' },
  { q: 'Is the report an inspection or proof of coverage?', a: 'No. It shows what storms are likely to have hit the property based on NOAA data. It is not an inspection, an engineering assessment or a coverage decision. For disputed claims you can order a meteorologist-reviewed report.' },
  { q: 'Does it connect to my CRM?', a: 'Yes. JobNimbus and AccuLynx connect directly on the Integrations tab. ClaimWizard, HubSpot, SPOTIO and others connect through Zapier or Make.' },
  { q: 'How many people can use my account?', a: 'Starter and Pro include 1 user, Team includes up to 5, and Enterprise is unlimited.' },
  { q: 'Is there a phone app?', a: 'Yes. Add StormCheck Pro to your home screen from Safari (iPhone) or Chrome (Android) and it opens like an app. Step-by-step instructions are at /install.' },
  { q: 'How do I cancel?', a: 'Plans are month to month. Contact support to cancel; you keep access until the end of the billing period.' },
];

const SUPPORT = 'Call or text (817) 618-9884.';

// What a prospect on the public website asks before signing up.
const PUBLIC_FAQ = [
  { q: 'What is StormCheck Pro?', a: 'A web app that shows hail, wind and tornado history for any U.S. address, using NOAA radar and National Weather Service records. Enter an address and in seconds you see the hail size estimated at the property, which storm dates are verified by ground reports, and the most likely date of loss.' },
  { q: 'How do I find a public adjuster, appraiser or attorney?', a: 'Use the Find a Pro directory at /find-a-pro. Pick the type of professional and your state or ZIP code. Professionals can get listed free at /find-a-pro/get-listed.' },
  { q: 'Who is it for?', a: 'Roofing contractors, public adjusters, insurance agents, realtors, property managers and real estate investors: anyone who needs to know what storms hit a property.' },
  { q: 'How much does it cost?', a: 'Starter $39/mo (unlimited reports in 1 state). Pro $79/mo (nationwide, storm playback, portfolio and territory alerts, company name on reports). Team $149/mo (adds hail-warning heads-up alerts, your logo, up to 5 users). Enterprise from $199/mo (white-label, unlimited users). Every plan includes unlimited reports.' },
  { q: 'Is there a free trial?', a: 'Yes. Create a free account and run one full property report, no credit card needed. Free hail alerts by ZIP code are free forever at /alerts.' },
  { q: 'Where does the data come from?', a: 'NOAA MRMS radar estimates of maximum hail size on about a 1 km grid, the National Weather Service radar hail algorithm (probability of severe hail), the National Weather Service Storm Events Database, and Storm Prediction Center spotter reports.' },
  { q: 'What does "Verified" mean?', a: 'Radar estimated hail of 0.75" or larger at the property and at least one ground hail report was filed within 3 miles the same day. Two independent sources agreeing is stronger evidence than either alone.' },
  { q: 'Does it work in my state?', a: 'It works anywhere in the United States. Radar hail estimates cover the lower 48 states. Starter covers one state; Pro and above are nationwide.' },
  { q: 'How far back does the history go?', a: 'The last 5 years of storms.' },
  { q: 'Does it connect to my CRM?', a: 'Yes. JobNimbus and AccuLynx connect directly: your customers load in automatically and hail hits are added as notes on the customer or job. ClaimWizard, HubSpot, SPOTIO and other CRMs connect through Zapier or Make.' },
  { q: 'Can I get leads after a storm?', a: 'Yes. Lead Lists give you every ZIP code and city inside the hail swath at the size you choose, exported for EDDM or direct mail, plus the swath boundary for canvassing and mapping apps.' },
  { q: 'Can I monitor my customers\' properties?', a: 'Yes. Upload your customer or property list (or connect your CRM) and we email you when any of them is hit.' },
  { q: 'Can I brand the reports?', a: 'Pro adds your company name, Team adds your logo, and Enterprise is fully white-labeled with your colors.' },
  { q: 'How is it different from HailTrace or other hail maps?', a: 'Unlimited address reports on every plan instead of paying per report, radar hail at the property combined with ground reports into Verified dates, a ranked date-of-loss list, lead lists from the swath, portfolio monitoring and CRM integrations, starting at $39/mo.' },
  { q: 'Is a report an inspection?', a: 'No. It shows what storms likely hit the property based on NOAA data. Pair it with a roof inspection. For disputed claims, customers can order a meteorologist-reviewed report.' },
  { q: 'Can I cancel anytime?', a: 'Yes. Plans are month to month with no contract.' },
  { q: 'Is there a phone app?', a: 'Yes. Add StormCheck Pro to your iPhone or Android home screen and it opens like an app, no app store needed. Steps: /install' },
];

function publicText() {
  const f = PUBLIC_FAQ.map(x => `Q: ${x.q}\nA: ${x.a}`).join('\n\n');
  const feats = GUIDES.filter(g => !['getting-started', 'settings', 'storms'].includes(g.id)).map(g => `- ${g.title}: ${g.summary}`).join('\n');
  return `# About StormCheck Pro\n\n${f}\n\n# Features\n${feats}\n\nSign up / free report: /register. Sample report: /sample-report. Recent hail maps: /hail-maps. Free hail alerts: /alerts. Pricing: /#pricing. Contact: ${SUPPORT}`;
}

function asText() {
  const g = GUIDES.map(x => `## ${x.title} (${x.link})\n${x.summary}\n${x.steps.map(s => '- ' + s).join('\n')}${x.tips ? '\nTips:\n' + x.tips.map(t => '- ' + t).join('\n') : ''}`).join('\n\n');
  const f = FAQ.map(x => `Q: ${x.q}\nA: ${x.a}`).join('\n\n');
  const plans = 'Plans: Starter $39/mo (unlimited reports in 1 state, 1 user). Pro $79/mo (nationwide, storm playback, territory and portfolio alerts, company name on reports, 1 user). Team $149/mo (everything in Pro, hail warning heads-up, logo on reports, up to 5 users). Enterprise from $199/mo (white-label, unlimited users, priority support). One free report to start.';
  return `# StormCheck Pro guide\n\n${g}\n\n# FAQ\n\n${f}\n\n# Plans\n${plans}\n\nSupport: ${SUPPORT}`;
}

// Keyword search used when the AI assistant is not configured.
function search(query, limit = 3, { publicOnly = false } = {}) {
  const words = String(query || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  const stop = new Set(['the', 'a', 'an', 'is', 'to', 'how', 'do', 'i', 'my', 'what', 'of', 'and', 'or', 'in', 'on', 'for', 'can', 'it', 'does', 'why', 'with', 'you', 'me', 'be', 'are', 'this', 'that', 'your', 'we', 'our', 'get', 'use', 'work', 'works', 'there', 'any', 'if']);
  const terms = [...new Set(words.filter(w => !stop.has(w) && w.length > 1))];
  if (!terms.length) return [];
  const docs = (publicOnly
    ? PUBLIC_FAQ.map(f => ({ title: f.q, text: f.a, link: '/register' }))
    : [
      ...FAQ.map(f => ({ title: f.q, text: f.a, link: '/help#faq' })),
      ...GUIDES.map(g => ({ title: g.title, text: g.summary + ' ' + g.steps.join(' '), link: g.link })),
    ]).map(d => ({ ...d, tWords: new Set(d.title.toLowerCase().match(/[a-z0-9]+/g) || []), bWords: new Set((d.title + ' ' + d.text).toLowerCase().match(/[a-z0-9]+/g) || []) }));
  // Whole-word matches, weighted so rare words (e.g. "jobnimbus") count more than common ones.
  const stem = w => w.replace(/(ies|es|s)$/, '');
  const has = (set, t) => set.has(t) || [...set].some(w => stem(w) === stem(t));
  const idf = Object.fromEntries(terms.map(t => [t, Math.log(1 + docs.length / (1 + docs.filter(d => has(d.bWords, t)).length))]));
  return docs.map(d => {
    const score = terms.reduce((sc, t) => sc + (has(d.bWords, t) ? idf[t] * (has(d.tWords, t) ? 2 : 1) : 0), 0);
    return { title: d.title, text: d.text, link: d.link, score };
  }).filter(d => d.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

module.exports = { RELEASE, GUIDES, FAQ, PUBLIC_FAQ, SUPPORT, asText, publicText, search };
