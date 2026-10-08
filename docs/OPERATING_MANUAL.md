# Royal GCC operating manual

This manual is the client's single entry point to running Royal GCC. It is written for non-technical owners and admins. Where a step needs a technical person, it says so.

The other docs:

- [DEPLOYMENT.md](DEPLOYMENT.md): how the system was set up, step by step. Use it to rebuild any part from scratch.
- [SWEEP_DESIGN.md](SWEEP_DESIGN.md): how deposits, sweeps, keys and fees work.
- [SWEEP_COST_COMPARISON.md](SWEEP_COST_COMPARISON.md): why energy is rented from Netts.

**Golden rules**

- Seed phrases and private keys go on paper or into Render's Environment page. Never into chat, email, git, screenshots or a document.
- Never give a seed phrase to anyone, including a developer. The server never needs the treasury seed.
- Two-factor authentication on every account in section 1.

Contents:

1. What you own
2. Secrets: where each one lives
3. Handover: replace the test wallets and rotate every secret
4. Admin daily routine
5. Alert emails: what each means and what to do
6. Top-ups
7. Releasing a new app version
8. Incident playbook
9. Free-tier limits
10. Compliance (not legal advice)
11. Pending / known gaps
12. Settings reference

---

## 1. What you own

```
 Users' Android phones (Royal GCC app)
        |
        v
 api.royalgccforex.com ──(Cloudflare DNS, CNAME, DNS only)──> Render service "offramp"
                                                              (API + deposit worker, one process)
                                                                |      |       |        |
                                                                v      v       v        v
                                                          Supabase  TronGrid  Netts   Brevo
                                                          (database) (TRON)  (energy) (email)
 admin.royalgccforex.com ── Cloudflare Worker "royalgcc-admin" (admin panel) ──> same API
 royalgccforex.com, www ── Cloudflare Worker "royal-gcc-landing-page" (website + APK download)

 Treasury wallet (offline, client)   <── sweeps send all deposits here
 Operating wallet (hot, TRX only)    ──> pays activations, TronNRG energy, burn fallback
```

| Service | What it is for | Account / name | If it lapses or is deleted |
| --- | --- | --- | --- |
| **GoDaddy** | Owns the domain `royalgccforex.com`. Nameservers point to Cloudflare. | Client | Domain expires: the app, admin panel, website and emails all stop. **Turn on auto-renew.** |
| **Cloudflare** (Free) | DNS for the domain, plus the admin panel and landing page Workers. | `Team.royalgcc@gm...` | DNS stops: everything on the domain stops. |
| **Render** (Free) | Runs the backend API and the deposit worker. Holds all server secrets. | Service `offramp`, region Singapore | The app stops working. Deposits are not detected or swept until it is back (no money is lost; the worker catches up). |
| **Supabase** (Free) | The database: users, balances, orders, KYC. | Project `offramp-usdt-prod` (ref `jyxpisnldtsoyigdjqse`) | Everything stops. A free project **pauses after about 7 days without activity**; the cron pinger prevents that. Deleting the project loses all balances. |
| **cron-job.org** (Free) | Calls `https://api.royalgccforex.com/health` every 10 minutes so Render does not sleep. | Client | Render sleeps after 15 min idle: first request takes about a minute, and deposits are not watched while asleep. |
| **GitHub** org `teamroyalgcc` | Source code. Render and Cloudflare build from the `main` branches. | Org owners | Code is safe on GitHub; deleting a repo breaks future deploys. |
| **Netts** (prepaid) | Rents energy for sweeps (cheapest). | netts.io account + API key | Balance 0 or IP not whitelisted: sweeps fall back to TronNRG/burn, paid from the operating wallet (more expensive). |
| **TronNRG** | Energy rental fallback, paid on-chain by the operating wallet. No account. | none | Falls back to burning TRX. |
| **TronGrid** (Free) | Access to the TRON blockchain. | trongrid.io API key | Without a key, requests are rate-limited and the worker may slow down or fail. |
| **Brevo** (Free) | Sends login codes, PIN codes and alert emails from `no-reply@royalgccforex.com`. | Brevo account; DNS records in Cloudflare | Users cannot log in by email code or reset their PIN; alerts stop. |
| **Expo / EAS** | Builds the Android app. **Holds the app's signing key.** | Expo account that owns the project | Losing the project's signing key means no update can install over the existing app (section 7). |
| **Google Cloud** | Google sign-in client IDs (web and Android), OAuth consent screen. | Project that owns client `292256227067-...` | Google sign-in stops; email login still works. |
| **Treasury wallet** | Receives all swept USDT; pays USDT withdrawals (by hand). | Client, offline | Lost seed = lost funds. Paper backup in a safe. |
| **Operating wallet** | Small TRX-only wallet for sweep costs. | Key in Render | Empty: sweeps that need TronNRG/burn fail until topped up. |

---

## 2. Secrets: where each one lives

All server secrets live **only** in Render → service `offramp` → Environment. Full table of every variable: [DEPLOYMENT.md Step 4](DEPLOYMENT.md#step-4-backend-on-render-15-min).

| Secret | Paper backup? | What leaking it means |
| --- | --- | --- |
| Treasury seed phrase | **Yes** (never on any server) | All swept funds can be stolen. |
| `HD_MNEMONIC` (deposit seed) | **Yes** | Unswept deposits can be stolen. |
| `OPERATING_WALLET_PRIVATE_KEY` | Optional | The small TRX balance can be stolen. |
| `NETTS_API_KEY` | No (create a new one) | The Netts balance can be spent on energy (only from whitelisted IPs). |
| `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` | No | Full database access: balances can be faked. |
| `JWT_SECRET` | No | Anyone can sign in as any user or admin. |
| `BREVO_API_KEY` | No | Emails can be sent in your name. |
| Admin panel passwords | Each admin's password manager | Payouts can be approved. |

---

## 3. Handover: replace the test wallets and rotate every secret

The system is currently running with the **developer's test wallets**:

- treasury `TExQU3qEet84uFZu2fEvLmx4mZP5o1JuGq`
- operating wallet `TSqnzJg2zyQPx3NKfW4XqULaq3h5vuKr65`

The developer also knows every secret in Render. Do this whole section **once, before real users**, in this order: 3.1 → 3.2 → 3.3 → 3.4 → 3.5. Budget about two hours, with the developer on a call if possible (but they must not see your new seeds).

**How to run SQL:** Supabase → project `offramp-usdt-prod` → **SQL Editor** → New query → paste → **Run**. Delete the query text afterwards.

**How to change a Render variable:** Render → service `offramp` → **Environment** → edit the value → **Save, rebuild, and deploy**. Then open **Logs** and wait for `🚀 Server running` and `"msg":"started"`.

### 3.1 New treasury wallet

1. On a clean phone or a hardware wallet, create a **new** TRON wallet (TronLink, or Ledger/Trezor with TronLink). Write the seed phrase on paper, twice. Store both copies in different safe places. Never photograph it.
2. Copy the new wallet's **address** (starts with `T`, 34 characters). Only the address goes to the server.
3. Send 1 USDT and about 50 TRX to the new treasury. The first USDT arriving makes later sweeps cheaper (64,000 energy instead of 130,000), and the TRX pays for the withdrawals you will send from it.
4. Check that no sweep is in the middle of sending. Run:
   ```sql
   SELECT id, status, created_at FROM sweeps WHERE status = 'submitted';
   ```
   If any rows come back, wait a few minutes and run it again until it returns nothing.
5. Pin the new treasury in the database. Replace `<NEW_TREASURY_ADDRESS>` with the address from step 2 (keep the quotes):
   ```sql
   UPDATE system_settings SET pinned_treasury_address = '<NEW_TREASURY_ADDRESS>' WHERE id = 1;
   SELECT pinned_treasury_address FROM system_settings WHERE id = 1;
   ```
6. **Immediately** change `TREASURY_ADDRESS` in Render to the same address, then **Save, rebuild, and deploy**.
7. In Logs, check that `"msg":"started"` shows `"treasury":"<your new address>"`.
   - If the log says `TREASURY_ADDRESS ... differs from the pinned treasury ...`, the two values do not match exactly. Fix the one with the typo; the server will not start until they match. This check is there on purpose: it stops anyone from silently redirecting sweeps.
8. Ask the developer to send any test USDT/TRX left in the old treasury to your new treasury, and give you the tx hash.

### 3.2 New deposit seed (`HD_MNEMONIC`) and clearing test data

Every user's deposit address is derived from `HD_MNEMONIC`. The server **refuses to start** if the phrase no longer matches the deposit addresses already in the database (log: `HD_MNEMONIC does not match the existing deposit addresses. Restore the original phrase.`). So a new phrase is only possible when the `deposit_addresses` table is empty.

**Never do this once real users have deposit addresses.** Their addresses would stop working, and money sent to them later could not be swept. After launch, the phrase must never change.

1. Check whether any deposit addresses exist:
   ```sql
   SELECT COUNT(*) AS addresses FROM deposit_addresses;
   ```
   If it says `0`, skip to step 5.
2. Check that every test deposit has been swept. This must return **no rows**:
   ```sql
   SELECT s.id, s.status, a.tron_address
     FROM sweeps s JOIN deposit_addresses a ON a.id = s.deposit_address_id
    WHERE s.status <> 'confirmed';
   ```
   Then open each address on [tronscan.org](https://tronscan.org) and check that its USDT balance is 0:
   ```sql
   SELECT tron_address FROM deposit_addresses;
   ```
   - If any address still holds USDT, the sweep is not finished. In the admin panel → Dashboard, click Retry on it, wait for it to be confirmed, and check again.
   - Leftover TRX in a test address (a few TRX from burns) is lost after this step. The developer can move it out with the old phrase first if it is worth it.
3. Check that no test user still has a balance or an open order that matters:
   ```sql
   SELECT u.email, l.available_balance, l.locked_balance
     FROM ledger_accounts l JOIN users u ON u.id = l.user_id
    WHERE l.available_balance > 0 OR l.locked_balance > 0;
   SELECT id, status FROM exchange_orders WHERE status = 'PROCESSING';
   SELECT id, status FROM usdt_withdrawals WHERE status IN ('pending', 'processing');
   ```
   These balances are test money that is already in the (old) treasury. Settle with the developer if needed; the clear-out below deletes the records.
4. **Clear all test users and their data.** This deletes **every** app user, balance, order, KYC record and deposit record. It keeps admin logins, `system_settings` (rates, limits, the pinned treasury) and the audit log. It is permanent. Run it as one block:
   ```sql
   BEGIN;
   DELETE FROM sweeps;
   DELETE FROM deposits;
   DELETE FROM deposit_addresses;
   DELETE FROM ledger_entries;
   DELETE FROM ledger_accounts;
   DELETE FROM exchange_orders;
   DELETE FROM usdt_withdrawals;
   DELETE FROM bank_accounts;
   DELETE FROM kyc_records;
   DELETE FROM referral_history;
   UPDATE users SET referred_by = NULL;
   DELETE FROM users;
   DELETE FROM audit_reports;
   ALTER SEQUENCE deposit_derivation_index_seq RESTART WITH 0;
   COMMIT;
   ```
   If any line fails, the whole block is undone. Copy the error and send it to the developer (it contains no secrets).
   - Test KYC documents may also be stored as files. Check Supabase → Storage → bucket `KYC-DOCUMENTS` and delete the test uploads there.
5. Create the new phrase **offline**. A technical person runs this on their own computer, inside the `offramp-usdt` folder (not on a shared screen):
   ```
   node -e "import('ethers').then(e => console.log(e.Wallet.createRandom().mnemonic.phrase))"
   ```
   Write the 12 words on paper, twice, and store them like the treasury seed. This must be a different phrase from the treasury's. Close the terminal.
6. Paste the phrase into Render → Environment → `HD_MNEMONIC` → **Save, rebuild, and deploy**.
7. Check Logs for `"msg":"started"`. Then open the app, sign up, and open the Deposit screen: a new address is created from the new phrase.

### 3.3 New operating wallet

1. Create a new TronLink wallet (a different one from the treasury). Back up its seed on paper.
2. Send it about 100 TRX. It must **never** hold USDT.
3. Export its private key (TronLink → wallet → Export private key) and paste it straight into Render → `OPERATING_WALLET_PRIVATE_KEY` → **Save, rebuild, and deploy**. Do not save it anywhere else.
4. Check Logs: `"msg":"started"` shows `"operatingWallet":"<your new address>"`.
5. Ask the developer to send the TRX left in the old operating wallet (`TSqnzJg2zyQPx3NKfW4XqULaq3h5vuKr65`) to your new one.

### 3.4 Rotate the other secrets

Do each one, then **Save, rebuild, and deploy** once at the end. Then check Logs and `https://api.royalgccforex.com/health`.

| Secret | How to rotate | Side effects |
| --- | --- | --- |
| `JWT_SECRET` | A technical person runs `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and pastes the output into Render. | Everyone (users and admins) is logged out and logs in again. |
| `NETTS_API_KEY` and whitelist | Best: open **your own** Netts account, top it up, and create an API key. In the key's IP whitelist, add the IP from the last `netts ok` / `netts FAILED` line in Render Logs (currently `74.220.52.132`). Put the key in Render. Delete the old key (or ask the developer to delete theirs). | After the deploy, Logs must show `netts ok`. If it shows `netts FAILED: whitelist this egress IP in Netts`, add the `egress` IP from that line. |
| `BREVO_API_KEY` | Brevo → SMTP & API → API keys → create a new key → Render. Then delete the old key in Brevo. | None. Test by requesting a login code in the app. |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API Keys → create a new **secret** key → Render. After the deploy works, delete the old key. | None if done in that order. |
| Database password (`DATABASE_URL`) | Supabase → Database → Settings → **Reset database password**. Then Supabase → **Connect** → **Session pooler** URI, with the new password, → Render `DATABASE_URL`. | The server cannot reach the DB between the reset and the deploy (a minute or two). Do it at a quiet time. |
| `TRON_PRO_API_KEY` | trongrid.io → your account → create a key → Render. | None. |
| Admin passwords | First admin: Supabase SQL (below). Others: **Role Management** (superadmin) creates and deletes staff accounts. A superadmin changes their own login in **Settings**. | Delete any admin account the developer used. |

Reset an admin's password in SQL (type the new password only into the SQL Editor; delete the query afterwards):

```sql
UPDATE admins SET password_hash = crypt('<NEW_LONG_PASSWORD>', gen_salt('bf', 10)) WHERE username = '<admin email>';
SELECT username, role FROM admins;
```

### 3.5 Remove the developer's access

First make sure **you** are an owner or admin in each place, with two-factor on. Then remove the developer. If an account is in the developer's own name, ask them to transfer it to you rather than deleting it.

1. **GitHub** (`teamroyalgcc`): Org → People. Make sure two client people are Owners. Remove the developer, or set them to read-only. Turn on branch protection for `main` on `offramp-usdt` (Settings → Branches → require a pull request review), because Render deploys whatever lands on `main`.
2. **Render**: Workspace → Members. If the service lives in the developer's workspace, have them invite you as an Owner, then remove them. Otherwise, recreate the service in your own account ([DEPLOYMENT.md Step 4](DEPLOYMENT.md#step-4-backend-on-render-15-min)) and point the `api` CNAME in Cloudflare to the new `*.onrender.com` name.
3. **Supabase**: Organization → Team. Remove the developer. Rotate the service role key and DB password (3.4) after removing them.
4. **Cloudflare**: Manage account → Members. Remove anyone who is not the client. Also check GitHub → Settings → Applications: the Cloudflare Workers Builds app should be installed on the `teamroyalgcc` org, not a personal account.
5. **Netts**: use your own account and key (3.4). The developer deletes their key.
6. **Expo**: the EAS project should belong to the client's Expo account or organization. Ask the developer to transfer the project (it carries the **Android signing key**). Then download a backup of the keystore yourself: a technical person runs `eas credentials` → Android → production → **Download keystore**. Store the file and its passwords in a password manager.
7. **Google Cloud**: IAM → remove the developer from the project that owns the Google sign-in client IDs.
8. **Brevo, cron-job.org, TronGrid, GoDaddy**: if any were created under the developer's email, change the login email to yours, or create your own and update Render.
9. Remove the developer from any shared password manager, and from the bank account used for INR payouts.

---

## 4. Admin daily routine (about 5 minutes)

Log in at `https://admin.royalgccforex.com`.

**How money moves**

1. **A user sends USDT to their deposit address in the app.** The system detects it and adds the **full amount** to their balance; there is no deposit fee. Nobody needs to approve it, except deposits under 10 USDT.
2. **The system moves that USDT to the treasury on its own.** Amounts of 100 USDT or more move within minutes; smaller amounts move within 24 hours.
3. **The user sells USDT for INR.** You pay the INR to their bank and mark the order paid.
4. **The user withdraws USDT.** You send it from the treasury in TronLink and mark it sent.

Only steps 3 and 4 need you.

### Every day

1. Open **Dashboard** and look at the **"Deposits need your attention"** panel.
   - "Nothing to do" means you are done with deposits.
   - Otherwise, handle each item (table below).
   - Below it, **Transfers to treasury** lists each move of deposits to the treasury: status, the energy paid (Netts order or TronNRG/burn tx, in TRX), and the tx link. Its cards show the Netts balance, the operating wallet TRX and the treasury. Top up when a card is low (section 6).
   - **Sweep now** on a waiting row moves it at once instead of waiting up to 24 hours (amounts under 100 USDT). It costs one energy rental (about 2.6 TRX). Click it once; it greys out while it starts.
2. Open **Sell Orders (INR)**. For each order with status **processing**:
   1. Open the order. It shows the user's bank details, the exact INR amount, and the **KYC name**. If the KYC name does not match the bank account holder, it shows in red: do not pay; refund instead and contact the user.
   2. Send the INR from the company bank account (IMPS, NEFT or UPI).
   3. Choose **Paid**, paste the **UTR / bank reference**, and click **Confirm paid**.
   4. If you cannot pay (wrong details, suspicious user), choose **Refund** and write the reason. The USDT goes back to the user's balance.
3. Open **USDT Withdrawals**. For each **pending** request:
   1. Copy the address and the **"Send this"** amount (use the copy buttons).
   2. In the treasury wallet (TronLink), send exactly that amount of **USDT (TRC20)** to that address. TronLink burns TRX for the network fee (about 2 to 3 USD of TRX, more if the address has never held USDT). There is **no "Rent energy" button**; that feature is not built.
   3. Copy the transaction hash. Click **Mark as sent**, paste it, and click **Confirm sent**. The system checks the blockchain; if the amount or address is wrong, it says so and nothing is marked.
   4. To refuse, click **Reject** and give a reason. The user is refunded.
4. Open **KYC** and approve or reject new users. Users without approved KYC cannot sell, withdraw, or add a bank account.
5. Open **Rates** and check that the user rate looks sensible. You can set a fixed rate for 24 hours. It must be within 10% under the live market, so it can only be set while the live rate works; if the live sources go down later, the fixed rate keeps sells running until it expires.

### The attention panel, item by item

| You see | What it means | What to do |
| --- | --- | --- |
| **Deposit below minimum (not credited yet)** | The user sent less than 10 USDT. | Click **Credit anyway** to add the full amount to their balance, or contact the user first. |
| **Transfer to treasury failed**, with a **Retry transfer** button | The automatic move to treasury failed. The money is safe in the deposit address. | Read the explanation. If it mentions energy or the cost limit, top up Netts and the operating wallet (section 6) first. Then click **Retry transfer**. Retry starts a fresh cost limit; the TRX already spent stays listed under Transfers to treasury. |
| **Transfer to treasury failed**, no button | Unexpected result. Must not be retried. | Contact the developer. Do not touch anything. |
| **Transfer to treasury is taking longer than usual** | Still retrying on its own. | Nothing, unless it stays for several hours. Then check the alert emails. |
| **USDT received but not recorded** | USDT arrived while the deposit screen was closed. | Click **Check again**. It finds and credits it. |
| **Deposit address has less USDT than expected** | Money left a deposit address in a way the system did not make. | **Stop all payouts** and contact the developer immediately (section 8, "Missing funds"). |

**Run check now** re-checks every deposit address against the blockchain. It also runs by itself once a day.

### Safety rules before paying anyone

- **Pay only what the order says**, to the bank account shown in the order, and only when the holder matches the KYC name.
- **For a large or unusual order**, check under **Users** that the user's deposits are there and credited.
- **Never pay because of an email, chat or phone call.** Only orders and withdrawals shown in the admin panel.
- **Each staff member has their own login.** Superadmins manage accounts in **Role Management**. Delete accounts of people who leave.
- **Never ask a user for their transaction PIN.** Staff cannot see or reset it. A user who forgot it taps **Forgot PIN?** (Profile → Transaction PIN) and confirms with an email code. After a reset, sells and withdrawals are blocked for 24 hours. Five wrong PINs block them for 15 minutes.
- **Freeze** a suspicious account under **Users**. A frozen user is refused on every request.

### Moving money out of the treasury

Converting treasury USDT to INR (for example, on an exchange), or moving it to cold storage, is done by hand in TronLink or on the hardware wallet. The system never moves money out of the treasury.

---

## 5. Alert emails

All alerts go to `ALERT_EMAIL` (set in Render) from `no-reply@royalgccforex.com`. Every subject starts with `[Royal GCC]`. The emails say "Open the admin panel > Deposits"; that panel is on the **Dashboard**.

| Subject | What it means | What to do |
| --- | --- | --- |
| **N deposit item(s) need attention** (daily) | The daily check found items. The body lists sweeps stuck over 36 h, and low funds, e.g. `Operating wallet T... has 12 TRX. Top it up.` or `Netts balance is 3 TRX. Top it up at netts.io.` | Open Dashboard and handle each item (section 4). Top up as asked (section 6). |
| Daily email says **Could not read the Netts balance ... add <IP> in Netts > API > IP Whitelist** | Render now leaves from a different IP, which Netts blocks. Sweeps still work through TronNRG/burn, but cost more. | Netts → API → IP Whitelist → add the IP in the email (max 5; replace an old one if full). |
| **sweep stuck: repeated errors** | One sweep failed 10 times in a row for an unexpected reason (often TronGrid or Netts down). It keeps retrying, up to once an hour. | Wait a few hours. If it repeats or the item stays on the Dashboard, send the email to the developer. |
| **sweep failed permanently** | One sweep gave up after 5 attempts. Money is safe in the deposit address. | Top up Netts and the operating wallet, then Dashboard → **Retry transfer**. |
| **sweep cost above cap, funds left in place** | Getting energy would cost more than `SWEEP_MAX_COST_TRX` (10 TRX). Usually Netts is empty and burning TRX is expensive. | Top up Netts, then **Retry transfer**. Only if that keeps failing, ask a technical person to raise `SWEEP_MAX_COST_TRX` in Render. |
| **TronNRG paid but delegation not confirmed** | The operating wallet paid TronNRG but no energy arrived. The email has the payment tx (`paymentTx`). | Usually it sorts itself out on the next try. If TRX was lost, contact TronNRG support with the `paymentTx` hash. |
| **sweep tx succeeded but did not move the expected amount to the treasury** | A sweep went through but the result did not match. Should never happen. | **Stop payouts.** Do not retry. Contact the developer. |

The Render logs also show `ALERT` lines (for example `tick failed`, `audit found issues`). They need action only if they repeat; the emails above cover the important ones.

---

## 6. Top-ups

Check balances weekly, and whenever the daily email asks.

| What | Keep at least | How to top up | How to check |
| --- | --- | --- | --- |
| **Netts balance** | 50 TRX (warning below 20) | netts.io → Balance → deposit TRX to the address shown | Admin → Dashboard → Transfers to treasury, the netts.io dashboard, or `netts ok` lines in Render Logs (`balanceTrx`) |
| **Operating wallet** | 100 TRX (warning below `OPERATING_WALLET_MIN_TRX` = 50) | Send TRX from the treasury or an exchange to the operating wallet address (shown in Admin → Dashboard → Transfers to treasury, and in Render Logs at `"msg":"started"`) | Same card, or tronscan.org |
| **Treasury TRX** (for sending withdrawals) | 50 TRX | Send TRX from an exchange | TronLink |
| **Company bank account** (INR payouts) | Enough for a day of sell orders | Convert treasury USDT on an exchange and withdraw INR | Bank |

Cost per sweep: about 2 to 4 TRX with Netts, about 4 to 5 TRX with TronNRG, about 7 TRX by burning, plus about 1.1 TRX once per new deposit address (Netts activates new addresses itself). While the treasury holds no USDT, a sweep needs about twice the energy (about 2.6 TRX with Netts, 9 TRX with TronNRG).

---

## 7. Releasing a new app version

The app is built with **EAS** (Expo) from the `royal_gcc_forex_mobile_app` repo, branch `production-ready`. The API address and Google IDs are already set in `eas.json`.

### Rules that matter

- **Same signing key.** Android installs an update only if it is signed with the same key as the installed app. EAS holds that key (section 3.5, step 6). Never delete the EAS project or its credentials.
- **Higher version.** Each release needs a higher `versionCode`, and a new `version` (for example `1.0.1`) for humans. Today `app.json` has `"version": "1.0.0"` and no `versionCode`. Before the second release, a technical person sets `"android": { "versionCode": 2 }` in `app.json` (or turns on `"autoIncrement": true` in `eas.json` with `"appVersionSource": "remote"`).

### Direct APK (download from the website)

1. A technical person bumps the version (above), commits, then runs:
   ```
   eas build --platform android --profile preview
   ```
   The `preview` profile produces an **APK**. EAS shows a download link when it finishes.
2. Install it on a test phone over the old version and check: login, deposit screen, sell, withdraw.
3. Host the APK at a **permanent link**, so the website does not need rebuilding each time. EAS download links expire. Options:
   - Cloudflare **R2** (free tier): a public bucket on a subdomain such as `download.royalgccforex.com`. Upload each release as the same file name, e.g. `royalgcc.apk`. Recommended.
   - Google Drive (what the site uses today): replace the file's contents with **Manage versions** so the link stays the same.
   - Not the landing page itself: Cloudflare Workers static files are limited to 25 MB, and the APK is bigger.
4. Point the website at it once: Cloudflare → Workers → `royal-gcc-landing-page` → Settings → **Build** → Variables → `VITE_APK_URL` = the permanent link → then **Retry/redeploy** the latest build. (Vite reads it at build time, so a redeploy is required after changing it.)
5. Tell existing users to download and install again from the website. The app has no "update available" prompt.

### Google Play Store

1. Create a **Google Play Console** developer account (one-time 25 USD). Use an **organization** account if possible: it needs a D-U-N-S number, but new **personal** accounts must first run a closed test with at least 12 testers for 14 days before going public.
2. Build an **AAB** (Play's format):
   ```
   eas build --platform android --profile production
   ```
3. Upload it in Play Console. Let Google manage the app signing key (Play App Signing). The app's package name is `com.royalgccforex.app`.
4. Fill in the store listing (name, icon, screenshots, description) and these required forms:
   - privacy policy URL: `https://royalgccforex.com/privacy`
   - Data safety: what data is collected (email, phone, KYC/Aadhaar, bank details) and why
   - content rating
   - target audience (18+)
   - financial features declaration
5. **Crypto policy.** Google Play has a specific policy for cryptocurrency exchanges and wallets, which may require proof of local registration (in India, FIU-IND; section 10). Check the current policy before submitting.
6. Optional: `eas submit --platform android` uploads builds automatically after the first manual upload.

**Note:** an APK installed from the website and the Play Store version may be signed with different keys. A user may need to uninstall one to install the other. Balances are on the server, so nothing is lost.

---

## 8. Incident playbook

**First check:** open `https://api.royalgccforex.com/health`.

- `ok`: the backend is up.
- `503`: the database is down, or the worker is stuck.
- No answer: Render is down or asleep.

**Pausing money-out.** In Supabase SQL (takes effect at once; the database checks the switches on every new order):

```sql
UPDATE system_settings SET exchanges_enabled = false, withdrawals_enabled = false WHERE id = 1;
```

Resume with `true`. Orders already placed stay in the admin panel: simply do not pay them until the issue is clear.

| Situation | What to do |
| --- | --- |
| **App says "something went wrong" everywhere** | Check `/health` and Render → Logs. If Render shows a failed deploy, click **Rollback** to the last good deploy. If Supabase shows "paused", click **Restore**. |
| **Sells show "rate unavailable / sells paused"** | The price sources disagree by more than 3%, or fewer than two of CoinDCX / WazirX / ZebPay answer. Wait 10 minutes; it clears by itself when they recover. A fixed rate cannot be set while the live rate is down. |
| **Netts FAILED in logs / Netts balance unreadable** | Add the egress IP from the log or email to the Netts whitelist (section 5). |
| **Many failed sweeps** | Top up Netts and the operating wallet, then Retry each. |
| **Users don't receive login or PIN codes** | Brevo dashboard: check the daily limit (300/day on Free) and that the domain is still authenticated. In Cloudflare, Brevo's DNS records must stay **DNS only** (grey cloud), never proxied. |
| **Suspicious user** | **Freeze** them under Users. Refund or hold their open orders. |
| **"Deposit address has less USDT than expected", or "sweep tx ... did not move the expected amount"** | Pause money-out (SQL above). Do not retry. Contact the developer with the address and the time. |
| **Admin password leaked** | Delete or reset that admin (3.4). Rotate `JWT_SECRET` to log everyone out. Review recent paid orders. |
| **`JWT_SECRET`, service role key or DB password leaked** | Rotate it at once (3.4). Pause money-out until done. |
| **Operating wallet key leaked** | Send its TRX to a safe wallet, then do 3.3 with a new wallet. |
| **Treasury seed leaked** | Move all funds to a brand-new wallet **immediately**, then follow 3.1 with that wallet. |
| **`HD_MNEMONIC` leaked** | Pause deposits by telling users not to deposit, and get the developer. Unswept money is at risk. The phrase cannot simply be replaced while addresses exist (3.2), so this needs a planned migration. |
| **Render moved to another region or account** | Update the `api` CNAME in Cloudflare and whitelist the new egress IP in Netts. The app needs no update, because it uses `api.royalgccforex.com`. |

---

## 9. Free-tier limits

Numbers change; check each provider's pricing page once a year.

| Service | Free limit (approximate) | What happens at the limit | When to upgrade |
| --- | --- | --- | --- |
| Render Free | 750 instance hours/month (enough for one service); sleeps after 15 min idle; slow cold start; limited build minutes | Service sleeps or stops for the month | When you have daily users: Starter (about 7 USD/month) never sleeps |
| Supabase Free | 500 MB database, 1 GB file storage, 5 GB egress; pauses after about 7 days idle; no point-in-time backups | Read-only or paused | Before launch, consider Pro (25 USD/month) for **daily backups** |
| Cloudflare Workers Free | 100,000 requests/day (static files are free) | Requests fail for the rest of the day | Unlikely to matter |
| Brevo Free | 300 emails/day | Login and PIN codes stop for the day | When signups pass about 200/day |
| TronGrid Free | About 100,000 requests/day per key | Worker slows or errors | Only with many active deposit addresses |
| cron-job.org | Free | n/a | n/a |
| EAS Free | A limited number of Android builds per month, in a slower queue | Wait for next month or pay per build | Only if you release often |

**Backups:** the Free Supabase plan has no downloadable backups you control. Upgrade to Pro, or have a technical person run a weekly `pg_dump` with `DATABASE_URL` and store it encrypted.

---

## 10. Compliance (not legal advice)

These are items to confirm with the client's CA and lawyer **before launch**. The software does not handle them.

- **TDS under Section 194S.** 1% TDS may apply when the platform buys users' USDT (a transfer of a virtual digital asset). The code does not deduct or report TDS.
- **FIU-IND registration.** Since March 2023, virtual digital asset service providers in India fall under the PMLA and must register with FIU-IND. This includes AML/KYC policies, a principal officer, and suspicious transaction reports. Google Play may also ask for proof of registration.
- **KYC record retention.** PMLA rules generally require keeping KYC and transaction records for at least **5 years** after the relationship ends. Do not delete real users' records (section 3.2 is for test data only). Aadhaar numbers are stored masked.
- **Privacy.** The landing page has a privacy policy at `/privacy`. Keep it accurate to what the app collects (email, phone, Aadhaar/KYC, bank details).
- **GST** on the platform's spread or fees: ask the CA.

---

## 11. Pending / known gaps

Items that are known and not done. Owner in brackets.

**Before real users**

- [ ] Section 3 handover: new treasury, new `HD_MNEMONIC`, new operating wallet, clear test data, rotate secrets, remove developer access. [client + developer]
- [ ] First superadmin exists and can log in ([DEPLOYMENT.md Step 2](DEPLOYMENT.md#step-2-supabase-database-15-min)). [client]
- [ ] cron-job.org pinger on `https://api.royalgccforex.com/health` every 10 min, confirmed running. [client]
- [ ] Netts topped up (about 50 TRX) and showing `netts ok` in Logs. [client]
- [ ] Live test ([DEPLOYMENT.md Step 8](DEPLOYMENT.md#step-8-live-mainnet-test-30-min-about-20-usdt)) passed with real USDT. [developer + client]
- [ ] `VITE_APK_URL` set to a permanent APK link (section 7). Until then, the website falls back to an old Google Drive link. [client]
- [ ] TDS / FIU-IND confirmed with the CA (section 10). [client]
- [ ] Branch protection on `offramp-usdt` `main`. [client]
- [ ] Delete the old GasFree API key in the GasFree dashboard. [client]
- [ ] Supabase backups decided (section 9). [client]
- [ ] `ALERT_EMAIL` set in Render to an inbox someone reads daily. [client]

**Not built (known)**

- **"Rent energy" for withdrawals** and a live withdrawal fee quote. Withdrawals use a flat 5 USDT fee, and TronLink burns TRX for each send.
- **Deposit pause switch.** `system_settings.deposits_enabled` exists but nothing checks it. To stop deposits, tell users and remove the deposit option in an app update.
- **App update prompt.** Users of the APK are not told a new version exists.
- **App `versionCode`** is not set (section 7). Set it before the second release.
- **Invite codes / team commissions.** A referral code exists in the backend, but it is not linked at signup and has no app screen. The client must define the rules first.
- **Splitting one payout across several bank accounts.**
- **TDS deduction and reporting** (section 10).
- **Netts whitelist is single-IP.** Render's outbound IP can change within its shared ranges. The daily email names the new IP; add it in Netts.

---

## 12. Settings reference

**In the admin panel**

- **Rates** page: spread (0 to 10%, currently 1.5%), and the 24 h fixed-rate override. Changes apply immediately.

**In Supabase** (`system_settings` table, one row):

| Column | Default | Meaning |
| --- | --- | --- |
| `exchange_spread_percent` | 1.5 | Taken off the market rate (use the Rates page) |
| `min_exchange_usdt` | 10 | Minimum sell |
| `min_usdt_withdrawal` | 20 | Minimum USDT withdrawal |
| `usdt_withdrawal_fee` | 5 | Flat fee per USDT withdrawal |
| `daily_exchange_usdt` | 10000 | Per user per day (India time), USDT sold |
| `daily_withdrawal_inr` | 500000 | Per user per day, INR paid out |
| `daily_withdrawal_usdt` | 50000 | Per user per day, USDT withdrawn |
| `exchanges_enabled`, `withdrawals_enabled` | true | Pause switches (section 8) |
| `deposits_enabled` | true | Not used (section 11) |
| `pinned_treasury_address` | set on first start | Must equal `TREASURY_ADDRESS` (section 3.1) |
| `manual_rate_inr`, `manual_rate_expires_at` | empty | The Rates page override |

Example: raise the minimum sell to 20 USDT:

```sql
UPDATE system_settings SET min_exchange_usdt = 20, updated_at = NOW() WHERE id = 1;
```

**In Render** (Environment; saving restarts the service in about a minute):

| Variable | Value | Meaning |
| --- | --- | --- |
| `DEPOSIT_MIN_USDT` | 10 | Smaller deposits wait for admin approval |
| `SWEEP_IMMEDIATE_USDT` | 100 | At or above: swept at once; below: within 24 h |
| `SWEEP_MAX_COST_TRX` | 10 | Most TRX one sweep may cost |
| `OPERATING_WALLET_MIN_TRX` | 50 | Daily email warns below this |
| `ALERT_EMAIL` | client inbox | Where alerts go |
