# StormCheck Pro: iPhone app

A native iPhone shell (Capacitor 8) around the live StormCheck Pro site. It adds:

- **Native hail alerts** through Apple Push Notifications (APNs). Server side: `lib/apns.js`; tokens are saved by `/api/push/register-native`.
- **App Store rules:** inside the app (user agent `StormCheckProApp/`), pricing and upgrade links are hidden, `/upgrade` shows a plain plan note, and Stripe checkout is refused. Plans are sold on the website only. Ad and analytics tags don't load in the app.
- **Account deletion** (Settings → Delete account) and a **privacy policy** at `/privacy`. Apple requires both.

Bundle ID: `com.thepublicadjustertx.stormcheckpro` · iPhone only · offline fallback page in `www/`.

## Build without a Mac

GitHub → **Actions** → **iOS → TestFlight** → **Run workflow**. A GitHub-hosted Mac builds the app, signs it and uploads it to TestFlight.

One-time setup:

1. **App Store Connect → Apps → +** to create a new app named StormCheck Pro with bundle ID `com.thepublicadjustertx.stormcheckpro`. If the bundle ID isn't in the list yet, run the workflow once and it will register the ID.
2. **App Store Connect → Users and Access → Integrations → Team Keys:** create a key with the **Admin** role. Download the `.p8` file and copy the Key ID and Issuer ID.
3. **GitHub → repo Settings → Secrets and variables → Actions:** add `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_KEY_P8` (the full text of the `.p8` file).
4. **developer.apple.com → Keys → +:** enable **Apple Push Notifications service (APNs)** and download that `.p8`. In Railway, set `APNS_KEY_ID`, `APNS_TEAM_ID` and `APNS_KEY` (the full `.p8` text). Optionally set `APNS_ENV=sandbox` for debug builds; TestFlight and the App Store use production.

## Change the native project

```bash
cd ios-app && npm ci && npx cap sync ios
```

The app icon source is `icon.svg`. The 1024px PNG lives in `ios/App/App/Assets.xcassets/AppIcon.appiconset/`.
