# Production Deployment Runbook

Follow these steps in order. Everything runs on free tiers. The only money you need is about 20 USDT for the live test.

| Piece | Repo | Host | Cost |
| --- | --- | --- | --- |
| Database and file storage | none | Supabase | Free |
| Backend API and worker | `teamroyalgcc/offramp-usdt` | Render web service | Free |
| Keep-awake pinger | none | cron-job.org | Free |
| Admin panel | `teamroyalgcc/offramp_royalGCC_admin_pannel` | Cloudflare Worker (static assets) | Free |
| Landing page | `teamroyalgcc/royal_gcc_landing_page` | Cloudflare Worker (static assets) | Free |
| Domain and DNS | none | GoDaddy (registrar), Cloudflare (DNS) | Domain renewal only |

Live addresses:

- API: `https://api.royalgccforex.com`, a CNAME to `offramp.onrender.com` (DNS only, grey cloud)
- Admin panel: `https://admin.royalgccforex.com`
- Landing page: `https://royalgccforex.com` and `https://www.royalgccforex.com`

Running it day to day: [OPERATING_MANUAL.md](OPERATING_MANUAL.md).
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
3. **Operating wallet** (`OPERATING_WALLET_PRIVATE_KEY`). A small hot wallet that holds **TRX only, never USDT**. When Netts cannot rent energy, it pays TronNRG (about 4 TRX per transfer, no account needed), and as a last resort sends TRX to the deposit address to burn (about 7.5 TRX). It also pays the one-time activation (about 1.1 TRX) of a new deposit address when Netts is not used.
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
   - API → IP whitelist. Netts accepts **single IPs only** (no ranges), at most 5 per key, and checks every request. Render's outbound traffic leaves from shared ranges (`74.220.52.0/24` and `74.220.60.0/24` in Singapore), and an entry like `74.220.52.0` does **not** cover the range. So: after Step 4, read the IP the server actually uses from its startup log (`netts ok` or `netts FAILED: whitelist this egress IP in Netts`, field `egress`) and whitelist that exact IP. Today it is `74.220.52.132`.
   - The backend sends that same IP in the `X-Real-IP` header on every Netts call (Netts requires it). Nothing to configure.
   - If Render later leaves from a different IP, Netts calls fail and sweeps fall back to TronNRG or burn (more expensive). The next startup log and the daily alert email name the new IP: add it in Netts.
   - Never paste the key anywhere except Render.
3. **Brevo (email).**
   - Go to <https://www.brevo.com> → sign up.
   - Senders & domains → authenticate the domain `royalgccforex.com`. Brevo gives DNS records (`brevo1._domainkey`, `brevo2._domainkey`, a `brevo-code` TXT, DMARC). Add them in Cloudflare DNS as **DNS only** (grey cloud). Email records must never be proxied.
   - The sender is `no-reply@royalgccforex.com`. This is `EMAIL_FROM`.
   - SMTP & API → **API Keys** → Generate. This is `BREVO_API_KEY`.
4. **Google sign-in (optional; email OTP works without it).** While `GOOGLE_CLIENT_ID` is unset, the backend refuses Google sign-in (fail closed).
   - Go to <https://console.cloud.google.com> → APIs & Services → Credentials → Create **OAuth client ID** → type **Web application**. This is `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` (app).
   - Create a second OAuth client of type **Android**, with package `com.royalgccforex.app` and the SHA-1 from Step 9.3. This is `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`.
   - Backend `GOOGLE_CLIENT_ID` = both IDs, comma-separated with no spaces: `<web id>,<android id>`. Only tokens issued to one of these IDs, with a verified email, are accepted. **If it is unset, Google sign-in fails for everyone.**
   - The OAuth consent screen must be **published** (not in Testing), or only listed test users can sign in.
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
   - Region: **Singapore**
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
   | `OPERATING_WALLET_MIN_TRX` | `50` (optional; the daily email warns below this) |
   | `BREVO_API_KEY` | from Step 3 |
   | `EMAIL_FROM` | `no-reply@royalgccforex.com` |
   | `ALERT_EMAIL` | the client's email for daily problem alerts |
   | `GOOGLE_CLIENT_ID` | from Step 3: `<web id>,<android id>` (optional; unset = Google sign-in off) |

   Do **not** set `SYSTEM_PRIVATE_KEY`. It is no longer used.
4. **Deploy.** In the logs, wait for:
   - `🚀 Server running`
   - a JSON line with `"msg":"started"`, showing the treasury, `"netts":true` and the operating wallet address.

   - a line `netts ok`, or `netts FAILED: whitelist this egress IP in Netts` with an `egress` IP. On FAILED, add that IP in Netts (Step 3.2) and restart (Manual Deploy → Restart service).

   If the server stops with `TREASURY_ADDRESS ... differs from the pinned treasury`, the env var has a typo; fix it. Opening `https://offramp.onrender.com/health` should return `status: ok`.
5. **Custom domain.** Render → service → Settings → Custom Domains → add `api.royalgccforex.com`. In Cloudflare DNS, add `CNAME api → offramp.onrender.com`, **DNS only** (grey cloud; Render issues the certificate). Wait for Render to show Verified and Certificate Issued.
6. The API base is `https://api.royalgccforex.com`. The app uses it with `/api` appended; the admin panel uses it without. Both point at the custom domain, so the backend can move to another host without an app update.

> **Run exactly one instance.** The worker is inside the API process. Never scale this service above one instance.

## Step 5. Keep it awake (5 min)

Free Render services sleep after 15 minutes idle, and free Supabase projects pause after a week idle. One pinger fixes both.

1. Go to <https://cron-job.org> → sign up → Create cronjob.
2. URL: `https://api.royalgccforex.com/health`. Schedule: every 10 minutes. Save.
3. Turn on failure notifications, so you get an email when the backend is down.

One always-on service uses about 744 of Render's 750 free hours per month, so run **only this one** free service in the workspace.

## Step 6. Admin panel on a Cloudflare Worker (10 min)

Both front ends are served as a **Worker with static assets** (Workers Builds), not as a Pages project. Each repo has a `wrangler.jsonc` that tells Cloudflare which folder to serve.

0. Move the domain's DNS to Cloudflare first (once): add the site `royalgccforex.com` in Cloudflare (Free plan), then set the two Cloudflare nameservers in GoDaddy → Domain → Nameservers. Keep Brevo's email records **DNS only**.
1. Go to <https://dash.cloudflare.com> → Workers & Pages → Create → **Worker** → **Import a repository** → `teamroyalgcc/offramp_royalGCC_admin_pannel`, branch `main`.
2. Settings:
   - Project name: `royalgcc-admin` (must match `name` in `wrangler.jsonc`)
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy`
   - `wrangler.jsonc` serves `./out` (the Next.js static export).
3. Build variables (optional): `NEXT_PUBLIC_API_URL` = `https://api.royalgccforex.com` (no `/api`). This is already the default in `src/lib/axios.ts`. Also `NODE_VERSION` = `22`.
4. Deploy. Then Worker → Settings → **Domains & Routes** → add custom domain `admin.royalgccforex.com`, and turn **off** the `workers.dev` route.
5. Log in with the admin you created in Step 2.3. Create one account per staff member under **Role Management**.

## Step 7. Landing page on a Cloudflare Worker (5 min)

1. Same as Step 6, with `teamroyalgcc/royal_gcc_landing_page`, branch `main`.
   - Project name: `royal-gcc-landing-page` (matches `wrangler.jsonc`)
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy`
   - `wrangler.jsonc` serves `./dist`, with single-page-app fallback (so `/privacy` works).
   - Build variable `NODE_VERSION` = `22`.
2. Custom domains: `royalgccforex.com` and `www.royalgccforex.com`. Turn off `workers.dev`.
3. Build variable `VITE_APK_URL` = a **permanent** APK link (see [OPERATING_MANUAL.md](OPERATING_MANUAL.md) section 7). Vite reads it at build time, so redeploy after changing it. Until it is set, the site falls back to an old Google Drive link in `src/app/config.ts`.

## Step 8. Live mainnet test (30 min, about 20 USDT)

There is no testnet step on purpose: Netts and TronNRG run on mainnet only. See [SWEEP_DESIGN.md](SWEEP_DESIGN.md). Use a test user account.

1. In the app: sign in, complete KYC and add a bank account. In the admin panel: approve the KYC.
   - Profile → **Transaction PIN** → set a 6-digit PIN. Try selling before setting it: the app must send you to the PIN screen first.
2. **Deposit.** Open Deposit in the app. It shows processing fee **Free** and minimum deposit **10**. Send **20 USDT (TRC20)** from any wallet or exchange to the address shown.
   - Within about 1 to 3 minutes the app shows "Deposit received", and the balance becomes exactly **20**.
   - In the admin Dashboard, the deposit appears as **Credited**. It stays **In progress** for up to 24 h, because balances under `SWEEP_IMMEDIATE_USDT` (100) are moved to treasury once a day.
   - To test the transfer now, set `SWEEP_IMMEDIATE_USDT` to `10` in Render for this test (the service restarts), then set it back to `100`.
3. **Check the transfer to treasury.** The deposit shows **Moved to treasury**. On <https://tronscan.org>, the treasury received the full 20 USDT. In Supabase, the `sweeps` row shows `provider` (`netts`; `tronnrg` or `burn` if Netts was unavailable; `activate` means the address was activated and the sweep continued) and `cost_trx` (about 2 to 4 TRX with Netts, plus about 1.1 TRX for the one-time activation when TronNRG or burn is used).
4. **Sell order.** The minimum sell is 10 USDT (`system_settings.min_exchange_usdt`). With the balance from step 2 (20 USDT):
   - Sell 10 USDT. Admin → Sell Orders → open the order → choose **Refund**. The balance returns to what it was.
   - Sell 10 USDT again. Send the INR to the bank shown → choose **Paid**, enter the UTR and confirm. The order shows as completed in the app, and the balance drops by 10.
   - **PIN checks.** Enter a wrong PIN: the order is refused ("Wrong PIN. 4 attempts left."). Five wrong PINs lock sells and withdrawals for 15 minutes. **Forgot PIN?** on the PIN screen sends an email code and lets you set a new PIN without the old one.
5. **Withdrawal (optional).** Request a 20 USDT withdrawal.
   - Admin → USDT Withdrawals → send the "Send this" amount from the treasury in TronLink → **Mark as sent** → paste the tx hash. A wrong hash or amount is refused with a clear message.
6. **Statement.** History → **Statement** lists every change: Deposit, Sell order (locked), Sell order refunded, Withdrawal (locked), Withdrawal refunded. The top row's balance equals the app balance.
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
   - `EXPO_PUBLIC_API_URL` = `https://api.royalgccforex.com/api` (already set in `eas.json`)
   - `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID` (only if you use Google sign-in)
3. Run `eas credentials` → Android → let EAS create a keystore → copy its **SHA-1** into the Google Android OAuth client from Step 3.4.
4. Build the APK:

   ```bash
   eas build -p android --profile preview
   ```

   It produces a downloadable `.apk` link. That link expires, so copy the file to a permanent place and put that link in `VITE_APK_URL` (Step 7). Details, versioning and the Play Store: [OPERATING_MANUAL.md](OPERATING_MANUAL.md) section 7.
5. **Play Store later.** Run `eas build -p android --profile production` (produces an AAB), then `eas submit`. This needs a Google Play developer account (one-time USD 25).

## Step 10. Handover checklist

- [ ] The client holds on paper: the treasury seed and the `HD_MNEMONIC` backup.
- [ ] The client owns or is an admin on: the GitHub org, Supabase (project transferred), Render, Cloudflare, Expo, Brevo, Netts, TronGrid and cron-job.org. Two-factor authentication is on everywhere.
- [ ] The seed admin password is changed, and each staff member has their own admin login.
- [ ] `ALERT_EMAIL` points to the client.
- [ ] The client has read [OPERATING_MANUAL.md](OPERATING_MANUAL.md).
- [ ] The test wallets are replaced and every secret is rotated ([OPERATING_MANUAL.md](OPERATING_MANUAL.md) section 3).
- [ ] Your own access is removed after the handover period, and the GitHub token is revoked.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Render log: `HD_MNEMONIC does not match the existing deposit addresses` | The phrase was changed. Restore the original phrase. Never replace it once users exist. |
| Render log: `TREASURY_ADDRESS is required` or `HD_MNEMONIC is not set` | Add the missing environment variable. |
| OTP email never arrives | Check `BREVO_API_KEY`, that `EMAIL_FROM` is a verified sender, and Brevo → Logs. |
| App says network error | `EXPO_PUBLIC_API_URL` must end in `/api`, and the Render service must be awake. |
| Admin panel login fails with a network error | `NEXT_PUBLIC_API_URL` must have **no** `/api`. Redeploy the Worker after changing it. |
| Render log: `netts FAILED: whitelist this egress IP in Netts` | Add the `egress` IP from that line in Netts → API → IP Whitelist (single IPs, max 5). |
| Google sign-in fails | `GOOGLE_CLIENT_ID` must be set to `<web id>,<android id>`, and the OAuth consent screen must be published. |
| `/health` says degraded | Supabase is paused or the key is wrong. In Supabase, click Restore on the project and check `SUPABASE_SERVICE_ROLE_KEY`. |
| Deposit not showing | In the app, tap "Check again" on the Deposit screen. In the admin panel, click Run check now, then "Check again" on the item. |
