# StormCheck Pro — Deployment Guide
## stormcheckpro.thepublicadjustertx.com

This repo (storm-tracker-pro) now holds the full StormCheck Pro app. The old
one-page Storm Tracker PWA for OPI Millions investors lives in `pwa/`.

---

## 1. Point Railway at this repo

1. Railway → your StormCheck Pro service → Settings → Source → connect
   `opimillions/storm-tracker-pro` (branch `master` after this PR merges).
2. Keep the existing **volume** attached. User accounts, lookups and all storm
   data live on it (`RAILWAY_VOLUME_MOUNT_PATH`), not in the repo.
3. Start command stays `node server.js` (see `Procfile`).

## 2. Environment variables

See `.env.example`. New or changed:

| Variable | Why |
|---|---|
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | **Required now.** The hardcoded default admin password was removed. |
| `STRIPE_PRICE_ID_STARTER/PRO/TEAM/ENTERPRISE` | One price per plan. |
| `STRIPE_WEBHOOK_SECRET` | Webhook now verifies correctly (it was failing before, so paid users were never upgraded automatically). |
| `STRIPE_PRICE_ID_REVIEW` | Optional one-time price for meteorologist reviewed reports. |
| `SMTP_*` | Needed for portfolio, territory, free and warning alerts. |
| `MESH_BACKFILL_FROM` | Oldest radar day to load. Default `2020-10-15`. |
| `NCEI_FROM_YEAR` | Oldest NWS Storm Events year. Default `1996`. |
| `RETENTION_YEARS` | Years of storm data to keep. Default `5`. Older radar days, NWS events, SPC reports, storm pages and playback frames are deleted at startup and daily, and never backfilled. Overrides the two settings above. `off` keeps everything. |
| `META_PIXEL_ID`, `GA4_MEASUREMENT_ID` | Optional ad tracking (Facebook/Instagram pixel, Google Analytics). Off until set. Sign-ups and paid upgrades are reported as conversions. |
| `GOOGLE_ADS_ID` + `_SIGNUP_LABEL`/`_PURCHASE_LABEL`, `LINKEDIN_PARTNER_ID` + conversion IDs | Optional Google Ads and LinkedIn conversion tracking. |
| `BUSINESS_ADDRESS` | Postal address printed in storm recap emails (required by CAN-SPAM before recaps can send). Can also be set on Admin → Storm Recaps. |
| `GOOGLE_MAPS_EMBED_KEY` | Optional. Shows Street View of the property on each report. In Google Cloud, enable the **Maps Embed API**, create an API key and restrict it to HTTP referrers `stormcheckpro.thepublicadjustertx.com/*`. Embed API use is free. Without a key, reports show an "Open Street View" button. |
| `MAP_TILE_URL` | Optional base map tiles for recap map images. Defaults to OpenStreetMap. |

## 3. First start: data loads itself

On boot the server, in the background:

1. Fetches the last 30 days of SPC storm reports (minutes).
2. Loads the most recent radar hail days.
3. Ingests NWS Storm Events from `NCEI_FROM_YEAR` to now (roughly 30–60 min).
4. Backfills two years of SPC reports and radar hail back to
   `MESH_BACKFILL_FROM` (about 2,200 days, one every few seconds: allow ~3–4 hours).

Until enough data is loaded, address lookups fall back to the old live SPC scan,
so nothing breaks during the backfill. Watch progress in **Admin → Data Pipeline**.

Disk: radar + storm events + summaries use roughly 1–3 GB. Make sure the volume
has at least 5 GB.

Memory: decoding a radar day peaks around 200 MB. 512 MB+ recommended.

### Manual commands

```bash
node scripts/data.js status
node scripts/data.js mesh 2024-05-28            # one radar day
node scripts/data.js mesh 2024-03-01 2024-09-30 # range
node scripts/data.js ncei 1996
node scripts/data.js spc 730
node scripts/data.js summaries                  # rebuild public storm pages
```

## 4. Ongoing schedule (automatic)

| When | Job |
|---|---|
| Every 5 min | NWS hail/tornado warnings → heads-up emails (Team, Enterprise) |
| Every 15 min | SPC reports for today/yesterday → portfolio hit check |
| Hourly :25 | New radar day (posts ~12:10 UTC) → storm page + portfolio, territory and free alerts |
| Sundays 08:00 UTC | NWS Storm Events revisions |

## 5. Stripe webhook

Endpoint: `https://stormcheckpro.thepublicadjustertx.com/api/stripe/webhook`
Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`.

## 6. After deploy, check

- `/` landing page, `/hail-maps`, `/hail/tx/grapevine`, `/sample-report`, `/sitemap.xml`
- Admin → Data Pipeline shows radar days and NWS years increasing
- Run a lookup: it should return in about a second with "Most likely dates of loss"
- Submit the sitemap in Google Search Console

## Data sources

- NOAA MRMS MESH (radar-estimated maximum hail size), AWS Open Data `noaa-mrms-pds`;
  Iowa Environmental Mesonet archive as fallback
- NOAA NCEI Storm Events Database (bulk CSV)
- NOAA SPC daily storm reports
- NWS active alerts API (warnings)
- Census geocoder (addresses), bundled city and ZIP gazetteers
