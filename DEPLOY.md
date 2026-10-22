# HailCheck Pro — Deployment Guide
## hailcheck.thepublicadjustertx.com

---

## Step 1: Install dependencies (on your server/machine)
```bash
cd C:\Users\ryanc\.openclaw\workspace\firstcall\hailcheck-app
npm install
```

## Step 2: Set up environment variables
```bash
copy .env.example .env
```
Edit `.env` and fill in:
- `JWT_SECRET` — any long random string (e.g. 64 random characters)
- `ADMIN_EMAIL` — your email
- `ADMIN_PASSWORD` — your admin password
- `STRIPE_SECRET_KEY` — from dashboard.stripe.com (after setting up Stripe)
- `STRIPE_PRICE_ID` — create a $99/mo recurring product in Stripe first

## Step 3: Test locally
```bash
node server.js
```
Open http://localhost:3000 — you should see the landing page.
Login at http://localhost:3000/login with your admin email/password.

## Step 4: Set up Stripe (for $99/mo subscriptions)
1. Go to https://dashboard.stripe.com
2. Create a product: "HailCheck Pro" at $99/month recurring
3. Copy the Price ID (starts with `price_`) → add to .env as STRIPE_PRICE_ID
4. Copy Secret Key → STRIPE_SECRET_KEY
5. Copy Publishable Key → STRIPE_PUBLISHABLE_KEY
6. For webhooks: go to Stripe Webhooks → Add endpoint → URL: https://hailcheck.thepublicadjustertx.com/api/stripe/webhook
   Events: checkout.session.completed, customer.subscription.deleted, customer.subscription.updated
   Copy webhook secret → STRIPE_WEBHOOK_SECRET

## Step 5: Deploy to the internet

### Option A — Railway (recommended, easy)
1. Go to https://railway.app
2. New project → Deploy from GitHub (push this folder to GitHub first)
   OR New project → Deploy from local
3. Add environment variables in Railway dashboard
4. Railway gives you a URL — point hailcheck.thepublicadjustertx.com to it via CNAME in your DNS

### Option B — Run on your existing Windows server
1. Install Node.js on the server
2. Copy the hailcheck-app folder to the server
3. Use PM2 to keep it running:
   ```
   npm install -g pm2
   pm2 start server.js --name hailcheck
   pm2 save
   pm2 startup
   ```
4. Use nginx as reverse proxy on port 3000
5. Point hailcheck.thepublicadjustertx.com DNS to your server IP

### Option C — Render.com (free tier available)
1. Go to https://render.com
2. New → Web Service → Connect GitHub repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add environment variables
6. Free tier sleeps after 15min inactivity (fine for low traffic start)

## Step 6: DNS setup (for hailcheck.thepublicadjustertx.com)
In your domain registrar (wherever thepublicadjustertx.com is registered):
- Add a CNAME record: `hailcheck` → your Railway/Render URL
- OR an A record: `hailcheck` → your server's IP address

---

## User Tiers
- **trial** — 10 free lookups, 14 days
- **pro** — unlimited lookups, $99/mo via Stripe
- **client** — unlimited lookups, free (your First Call clients)
- **admin** — full access + admin panel
- **suspended** — blocked from logging in

## Admin Panel
Go to: hailcheck.thepublicadjustertx.com/admin
- Add users manually (set their tier to 'client' for free access to your PA clients)
- Suspend users instantly
- See all lookups and storm alerts
- See subscription stats

---

## Notes
- The hail lookup takes 1-3 minutes per search (scanning NOAA data)
- For faster results, consider caching results in the DB (future enhancement)
- SQLite database stored at: hailcheck-app/data/hailcheck.db
- Logs: none currently (add Winston logger as a future enhancement)
