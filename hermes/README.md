# Hermes (free hosting edition)

Hermes = web app + server + MT5 sync program. This edition runs on Render's FREE plan, with accounts and journals stored in free Upstash Redis and verification emails sent through free Brevo.

## Step 1: Free database (Upstash)
1. Sign up at upstash.com, click Create Database, choose Redis, name it hermes, any region, Free plan.
2. On the database page open the REST API section. Copy the two values: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.

## Step 2: Free email sender (Brevo)
1. Sign up at brevo.com (free plan, 300 emails/day).
2. Add your Gmail as a Sender and confirm it using the email Brevo sends you.
3. Go to SMTP & API > API Keys, create a key, copy it (this is BREVO_API_KEY).
Codes sent from a Gmail address can land in spam at first. Tell users to check Spam.

## Step 3: Put the code on GitHub
Create a free GitHub account and a PRIVATE repository. Upload everything from inside this folder (server.js, Dockerfile, package.json, public, mt5, README.md) so server.js is at the top level.

## Step 4: Deploy on Render (Free)
1. render.com > New > Web Service > connect your GitHub repo.
2. Language: Docker. Instance type: Free.
3. Add these environment variables:
   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, BREVO_API_KEY,
   BREVO_SENDER (your verified Gmail), SUPPORT_EMAIL (your Gmail), ADMIN_EMAIL (your Gmail)
4. Deploy. Your app is at the https://....onrender.com address Render shows.
Free Render apps sleep after 15 idle minutes; the first visit afterwards takes up to a minute to wake. Optional: a free uptime monitor (for example UptimeRobot) pinging https://YOUR-APP.onrender.com/healthz every 5 minutes keeps it awake.

## Step 5: Connect MT5 (automatic journaling)
1. In Hermes create a journal, open it, click Connect MT5, copy the URL and key.
2. Copy mt5/HermesSync.mq5 to MT5 (File > Open Data Folder > MQL5 > Experts) and compile it (F7).
3. MT5: Tools > Options > Expert Advisors > Allow WebRequest for listed URL, add your Render address.
4. Attach HermesSync to a chart, enable Algo Trading, paste the URL and key. If the app was asleep, the trade is retried within 5 minutes automatically.

## Optional: run on your own computer
Install Node.js 18+, run `node server.js`, open http://localhost:3000. Without the Upstash and Brevo variables it saves to a local file and prints email codes in the window.
