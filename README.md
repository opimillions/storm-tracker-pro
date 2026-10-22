# StormCheck Pro

Hail, wind and tornado history for any U.S. address, for roofers, public
adjusters, insurance agents, realtors, property managers and real estate investors.

Live: https://stormcheckpro.thepublicadjustertx.com

## What it does

- **Property reports**: radar-estimated hail at the property (NOAA MRMS MESH),
  official NWS storm records with narratives (NCEI), and recent spotter reports
  (SPC), combined into verified storm dates, a ranked date-of-loss list and an
  impact score. Printable full report and one-page Storm Disclosure.
- **Hail swath maps**: by day, with transparency control, ground reports and
  hourly storm playback.
- **Lead lists**: every ZIP and city inside the swath at a chosen size, with CSV,
  GeoJSON and KML exports.
- **Portfolio monitoring**: alerts when any monitored property is hit.
- **Alerts**: territory alerts, free ZIP-code alerts, and NWS hail-warning heads-ups.
- **Public SEO pages**: daily storm maps, state and city hail history, sitemap.
- **Meteorologist reviewed reports**: order flow and admin queue.

## Run locally

```bash
npm install
cp .env.example .env   # set ADMIN_EMAIL, ADMIN_PASSWORD, JWT_SECRET at minimum
DATA_JOBS=off npm start   # skip background downloads
npm test
```

Data commands: `npm run data -- status` (see `scripts/data.js`).
Deployment: see `DEPLOY.md`.

## Layout

| Path | What |
|---|---|
| `server.js` | Express app, auth, lookups, Stripe |
| `platform-routes.js` | Swath, playback, lead, portfolio, review and admin APIs |
| `public-pages.js` | Public storm/city pages, free alerts, sitemap |
| `lib/grib2.js` | GRIB2 decoder for MRMS radar files |
| `lib/mesh-store.js`, `ncei-store.js`, `spc-store.js` | Tiled local data stores |
| `lib/report-engine.js` | Combines sources into the property report |
| `lib/alerts.js`, `lib/data-jobs.js` | Alerts and scheduled data jobs |
| `public/` | Web app pages |
| `pwa/` | The original one-page Storm Tracker PWA (OPI Millions) |
