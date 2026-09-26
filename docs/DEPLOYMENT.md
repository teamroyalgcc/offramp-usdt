# Production Deployment Runbook

Follow these steps in order. Everything runs on free tiers. The only money you need is about 20 USDT for the live test.

| Piece | Repo | Host | Cost |
| --- | --- | --- | --- |
| Database and file storage | none | Supabase | Free |
| Backend API and worker | `teamroyalgcc/offramp-usdt` | Render web service | Free |
| Keep-awake pinger | none | cron-job.org | Free |
| Admin panel | `teamroyalgcc/offramp_royalGCC_admin_pannel` | Cloudflare Pages | Free |
| Landing page | `teamroyalgcc/royal_gcc_landing_page` | Cloudflare Pages | Free |
| Android app (APK) | `teamroyalgcc/royal_gcc_forex_mobile_app` | EAS Build | Free plan (monthly build quota) |
| Email (OTP and alerts) | none | Brevo | Free, 300 emails/day |

Merge the `plan/gasfree-sweep-architecture` branch (backend) and the `production-ready` branches (admin, app, landing) into `main` before you start.

Use one password manager entry per value below. You will paste them into Render, Cloudflare and EAS.

---

## Step 0. Security basics (10 min)

1. Turn on two-factor authentication on **GitHub**, **Supabase**, **Render**, **Cloudflare** and **Expo**.
2. Treat every secret that was ever in git as leaked, including `.env` in old commits and the GitHub token pasted in chat. You do **not** need to edit the repo. New values go only into the hosting dashboards. What to do:
   - **Revoke** the GitHub personal access token (GitHub → Settings → Developer settings → Tokens).
   - The old `SYSTEM_PRIVATE_KEY` wallet: move any funds out and never use it again. The new setup does not need it.
   - `JWT_SECRET` and `TRON_PRO_API_KEY` get **new** values below. The old Supabase projects are gone, so their keys are dead.

## Step 1. Wallets (15 min, offline where possible)

You need three different wallets. Never reuse one for another.

1. **Treasury wallet.** All user USDT ends up here.
   - Create it in TronLink or on a hardware wallet (Ledger).
   - Write the seed phrase on paper and keep it with the client. It never goes to any server.
   - Note the **address** (starts with `T`). This is `TREASURY_ADDRESS`.
   - Keep about 50 TRX in it. That TRX is used only when an admin sends USDT withdrawals by hand.
2. **Deposit seed** (`HD_MNEMONIC`). Every user's deposit address is derived from it.
   - Generate a new phrase on a trusted computer:

     ```bash
     cd offramp-usdt && npm ci
     node -e "import('ethers').then(e => console.log(e.Wallet.createRandom().mnemonic.phrase))"
     ```

   - Write it on paper and keep it with the client as a backup. It goes into Render in Step 4.
   - **Rule:** set it once, before the first real user, and never change it. The backend refuses to start if it is changed after addresses exist.
3. **Operating wallet** (`OPERATING_WALLET_PRIVATE_KEY`). A small hot wallet that holds **TRX only, never USDT**. It pays the fallback when Netts cannot rent energy (it sends TRX to a deposit address, which burns it to move the USDT).
   - Create a new account in TronLink → export its **private key**. It goes into Render in Step 4 only.
   - Fund it with about 100 TRX. The daily check emails `ALERT_EMAIL` when it drops below `OPERATING_WALLET_MIN_TRX` (default 50).

## Step 2. Supabase database (15 min)

One Supabase project serves everything. Only the backend talks to it; the app and admin panel talk to the backend.

1. In Supabase, create a new project `offramp-usdt-prod`, region **Southeast Asia (Singapore)**. Save the database password in the password manager before clicking Create. Security settings:
   - **Enable Data API:** on (the backend uses it).
   - **Automatically expose new tables:** off.
   - **Enable automatic RLS:** on.

   The schema grants the backend's role access explicitly, so turning off auto-expose is safe.
2. **Create the schema.** Open SQL Editor → New query → paste the whole of `db/schema.sql` → **Run**. It is safe to run again. It creates:
   - all tables, with row-level security on;
   - the settings row;
   - the private `KYC-DOCUMENTS` storage bucket.
3. **Create the first admin** with your own password. There is no default login. Run in the SQL Editor:

   ```sql
   INSERT INTO admins (username, password_hash, role)
   VALUES ('owner@yourcompany.com', crypt('A-LONG-UNIQUE-PASSWORD', gen_salt('bf', 10)), 'superadmin');
   ```

   Then clear the SQL Editor tab so the password is not left in the query history.
4. **Collect these values.**
   - `SUPABASE_URL`: Project Settings → API → Project URL.
   - `SUPABASE_SERVICE_ROLE_KEY`: Project Settings → API keys → the **secret** key (or legacy `service_role`). Never put it in the app or admin panel.
   - `DATABASE_URL`: click **Connect** → **Session pooler** → copy the URI, and replace `[YOUR-PASSWORD]`. Use the session pooler: the direct connection is IPv6-only, and Render cannot reach it.
5. To hand over later: Project Settings → General → **Transfer project** to the client's Supabase organization.

## Step 3. API keys (20 min)

1. **TronGrid.** Go to <https://www.trongrid.io> → sign up → Dashboard → **Create API Key**. The key is `TRON_PRO_API_KEY`. The free tier is plenty.
2. **Netts (energy rental).** Go to <https://www.netts.io/workspace/> → register. An API key is issued automatically: this is `NETTS_API_KEY`.
   - Wallet → deposit about 50 TRX (prepaid balance; one sweep costs about 2 to 4 TRX).
   - API → IP whitelist: add Render's outbound IPs (Render → your service → **Connect** → **Outbound**). Do this after Step 4 creates the service.
   - Never paste the key anywhere except Render.
3. **Brevo (email).**
   - Go to <https://www.brevo.com> → sign up.
   - Senders → add and verify the sender address, for example `support@yourdomain.com` or a Gmail address. This is `EMAIL_FROM`.
   - SMTP & API → **API Keys** → Generate. This is `BREVO_API_KEY`.
4. **Google sign-in (optional; email OTP works without it).**
   - Go to <https://console.cloud.google.com> → APIs & Services → Credentials → Create **OAuth client ID** → type **Web application**. Its client ID is both `GOOGLE_CLIENT_ID` (backend) and `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` (app).
   - Create a second OAuth client of type **Android**, with package `com.fintech_v3` and the SHA-1 from Step 9.3. This is `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`.
5. **Generate the login secret:**

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # JWT_SECRET
   ```

## Step 4. Backend on Render (15 min)

1. Go to <https://render.com> → New → **Web Service** → connect GitHub → pick `teamroyalgcc/offramp-usdt`, branch `main`.
2. Use these settings:
   - Runtime: **Node**
   - Build command: `npm ci --include=dev && npm run build`
   - Start command: `npm start`
   - Instance type: **Free**
   - Advanced → Health check path: `/health`
3. **Environment variables.** Add all of these:

   | Key | Value |
   | --- | --- |
   | `NODE_ENV` | `production` |
   | `NODE_VERSION` | `22` |
   | `TRON_NETWORK` | `mainnet` |
   | `SUPABASE_URL` | from Step 2 |
   | `SUPABASE_SERVICE_ROLE_KEY` | from Step 2 |
   | `DATABASE_URL` | session pooler URI from Step 2 |
   | `JWT_SECRET` | from Step 3 |
   | `TRON_PRO_API_KEY` | from Step 3 |
   | `NETTS_API_KEY` | from Step 3 |
   | `HD_MNEMONIC` | the deposit seed phrase from Step 1 |
   | `TREASURY_ADDRESS` | treasury **address** from Step 1 (pinned in the database on first start; the server refuses to start if it later differs) |
   | `OPERATING_WALLET_PRIVATE_KEY` | operating wallet private key from Step 1 |
   | `DEPOSIT_MIN_USDT` | `10` (smaller deposits are held for admin review) |
   | `SWEEP_IMMEDIATE_USDT` | `100` (at or above: moved to treasury at once; below: within 24 h) |
   | `SWEEP_MAX_COST_TRX` | `10` (safety limit per transfer to treasury) |
   | `BREVO_API_KEY` | from Step 3 |
   | `EMAIL_FROM` | verified Brevo sender |
   | `ALERT_EMAIL` | the client's email for daily problem alerts |
   | `GOOGLE_CLIENT_ID` | from Step 3 (optional) |

   Do **not** set `SYSTEM_PRIVATE_KEY`. It is no longer used.
4. **Deploy.** In the logs, wait for:
   - `🚀 Server running`
   - a JSON line with `"msg":"started"`, showing the treasury, `"netts":true` and the operating wallet address.

   If the server stops with `TREASURY_ADDRESS ... differs from the pinned treasury`, the env var has a typo; fix it. Opening `https://<your-service>.onrender.com/health` should return `status: ok`.
6. Now whitelist the service's outbound IPs in Netts (Step 3.2).
5. Your API base is `https://<your-service>.onrender.com`. The app uses it with `/api` appended; the admin panel uses it without.

> **Run exactly one instance.** The worker is inside the API process. Never scale this service above one instance.

## Step 5. Keep it awake (5 min)

Free Render services sleep after 15 minutes idle, and free Supabase projects pause after a week idle. One pinger fixes both.

1. Go to <https://cron-job.org> → sign up → Create cronjob.
2. URL: `https://<your-service>.onrender.com/health`. Schedule: every 10 minutes. Save.

One always-on service uses about 744 of Render's 750 free hours per month, so run **only this one** free service in the workspace.

## Step 6. Admin panel on Cloudflare Pages (10 min)

1. Go to <https://dash.cloudflare.com> → Workers & Pages → Create → **Pages** → connect GitHub → `teamroyalgcc/offramp_royalGCC_admin_pannel`, branch `main`.
2. Build settings:
   - Framework preset: **Next.js (Static HTML Export)**
   - Build command: `npm run build`
   - Output directory: `out`
3. Environment variables:
   - `NEXT_PUBLIC_API_URL` = `https://<your-service>.onrender.com` (no `/api`)
   - `NODE_VERSION` = `22`
4. Deploy, then open the `*.pages.dev` URL. Optionally add a custom domain such as `admin.yourdomain.com`.
5. Log in with the admin you created in Step 2.3. Create one account per staff member under **Role Management**.

## Step 7. Landing page on Cloudflare Pages (5 min)

1. Create a new Pages project from `teamroyalgcc/royal_gcc_landing_page`, branch `main`.
   - Build command: `npm run build`
   - Output directory: `dist`
2. Environment variable `VITE_APK_URL` = the APK download link from Step 9. Update it and redeploy for every new app build.

## Step 8. Live mainnet test (30 min, about 20 USDT)

There is no testnet step on purpose; see GASFREE_SWEEP_IMPLEMENTATION.md §7. Use a test user account.

1. In the app: sign in, complete KYC and add a bank account. In the admin panel: approve the KYC.
   - Profile → **Transaction PIN** → set a 6-digit PIN. Try selling before setting it: the app must send you to the PIN screen first.
2. **Deposit.** Open Deposit in the app. It shows processing fee **Free** and minimum deposit **10**. Send **20 USDT (TRC20)** from any wallet or exchange to the address shown.
   - Within about 1 to 3 minutes the app shows "Deposit received", and the balance becomes exactly **20**.
   - In the admin Dashboard, the deposit appears as **Credited**. It stays **In progress** for up to 24 h, because balances under `SWEEP_IMMEDIATE_USDT` (100) are moved to treasury once a day.
   - To test the transfer now, set `SWEEP_IMMEDIATE_USDT` to `10` in Render for this test (the service restarts), then set it back to `100`.
3. **Check the transfer to treasury.** The deposit shows **Moved to treasury**. On <https://tronscan.org>, the treasury received the full 20 USDT. In Supabase, the `sweeps` row shows `provider` (`netts`, or `burn` if Netts was unavailable) and `cost_trx` (about 2 to 4 TRX with Netts, including the one-time activation of the new address).
4. **Sell order.** The minimum sell is 10 USDT (`system_settings.min_exchange_usdt`). With the balance from step 2 (20 USDT):
   - Sell 10 USDT. Admin → Sell Orders → open the order → choose **Refund**. The balance returns to what it was.
   - Sell 10 USDT again. Send the INR to the bank shown → choose **Paid**, enter the UTR and confirm. The order shows as completed in the app, and the balance drops by 10.
   - **PIN checks.** Enter a wrong PIN: the order is refused ("Wrong PIN. 4 attempts left."). Five wrong PINs lock sells and withdrawals for 15 minutes. **Forgot PIN?** on the PIN screen sends an email code and lets you set a new PIN without the old one.
5. **Withdrawal (optional).** Request a 20 USDT withdrawal.
   - Admin → USDT Withdrawals → send the "Send this" amount from the treasury in TronLink → **Mark as sent** → paste the tx hash. A wrong hash or amount is refused with a clear message.
6. **Statement.** History → **Statement** lists every change: Deposit, Processing fee, Sell order (locked), Sell order refunded, Withdrawal (locked), Withdrawal refunded. The top row's balance equals the app balance.
7. Admin Dashboard → **Run check now**. It should say "Nothing to do".

## Step 9. Android app (APK) with EAS (30 to 60 min)

1. Install the tools and prepare the project:

   ```bash
   npm i -g eas-cli
   cd royal_gcc_forex_mobile_app && npm ci
   eas login        # Expo account, ideally the client's
   eas init         # links the project and writes the projectId into app.json
   ```

2. Set the build variables. In expo.dev → project → Environment variables, add these for the **preview** and **production** environments:
   - `EXPO_PUBLIC_API_URL` = `https://<your-service>.onrender.com/api`
   - `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID` (only if you use Google sign-in)
3. Run `eas credentials` → Android → let EAS create a keystore → copy its **SHA-1** into the Google Android OAuth client from Step 3.4.
4. Build the APK:

   ```bash
   eas build -p android --profile preview
   ```

   It produces a downloadable `.apk` link. Put that link in `VITE_APK_URL` (Step 7).
5. **Play Store later.** Run `eas build -p android --profile production` (produces an AAB), then `eas submit`. This needs a Google Play developer account (one-time USD 25).

## Step 10. Handover checklist

- [ ] The client holds on paper: the treasury seed and the `HD_MNEMONIC` backup.
- [ ] The client owns or is an admin on: the GitHub org, Supabase (project transferred), Render, Cloudflare, Expo, Brevo, Netts, TronGrid and cron-job.org. Two-factor authentication is on everywhere.
- [ ] The seed admin password is changed, and each staff member has their own admin login.
- [ ] `ALERT_EMAIL` points to the client.
- [ ] The client has read [ADMIN_GUIDE.md](ADMIN_GUIDE.md).
- [ ] Your own access is removed after the handover period, and the GitHub token is revoked.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Render log: `HD_MNEMONIC does not match the existing deposit addresses` | The phrase was changed. Restore the original phrase. Never replace it once users exist. |
| Render log: `TREASURY_ADDRESS is required` or `HD_MNEMONIC is not set` | Add the missing environment variable. |
| OTP email never arrives | Check `BREVO_API_KEY`, that `EMAIL_FROM` is a verified sender, and Brevo → Logs. |
| App says network error | `EXPO_PUBLIC_API_URL` must end in `/api`, and the Render service must be awake. |
| Admin panel login fails with a network error | `NEXT_PUBLIC_API_URL` must have **no** `/api`. Redeploy Pages after changing it. |
| `/health` says degraded | Supabase is paused or the key is wrong. In Supabase, click Restore on the project and check `SUPABASE_SERVICE_ROLE_KEY`. |
| Deposit not showing | In the app, tap "Check again" on the Deposit screen. In the admin panel, click Run check now, then "Check again" on the item. |
