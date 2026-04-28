# Storm Tracker Pro — PWA

A Progressive Web App for OPI Millions investors to look up hail history on any U.S. property.

## What It Does
- Search any U.S. address or ZIP code
- Pulls real hail event data from NOAA SPC storm reports (free, no API key)
- Calculates a claim potential score (High / Medium / Low)
- Shows storm history: date, hail size, distance from property
- Gives OPI-specific recommendations
- Exports a text report
- Saves recent searches locally
- Works as a home screen app on iPhone and Android

## How to Deploy (Free Options)

### Option A — GitHub Pages (free, instant)
1. Push this folder to a GitHub repo
2. Go to repo Settings → Pages → Deploy from main branch
3. Your app is live at `https://yourusername.github.io/storm-tracker-pro`

### Option B — Netlify (free, custom domain)
1. Go to netlify.com → New site from Git
2. Connect your repo
3. Deploy — done
4. Add your custom domain (e.g. stormtrackerpro.com)

### Option C — Vercel (free)
1. vercel.com → Import project
2. Connect repo → Deploy

## How Users Install It (No App Store Needed)

### iPhone:
1. Open the URL in Safari
2. Tap the Share button (box with arrow)
3. Tap "Add to Home Screen"
4. App icon appears on home screen

### Android:
1. Open the URL in Chrome
2. Tap the menu (3 dots)
3. Tap "Add to Home Screen" or "Install App"
4. App icon appears on home screen

## Icons Needed
Create two icon files and place in `/icons/`:
- `icon-192.png` — 192x192px
- `icon-512.png` — 512x512px

Use the OPI Millions logo or a storm/lightning bolt icon.

## Data Source
NOAA Storm Prediction Center: https://www.spc.noaa.gov/climo/reports/
Free, public data. No API key required.

## Next Steps / Future Features
- [ ] Interactive storm map view
- [ ] Save/sync reports to account
- [ ] Stripe subscription gate (trial → paid)
- [ ] Push notifications for new storms in watched areas
- [ ] Integration with measuring tool
- [ ] PDF report export
