# Deposit and sweep design

How user deposits arrive, how they move to the treasury, who holds which key, and where fees come from. For daily operations, read [OPERATING_MANUAL.md](OPERATING_MANUAL.md). For the cost research behind the energy choice, read [SWEEP_COST_COMPARISON.md](SWEEP_COST_COMPARISON.md).

## 1. The product in one paragraph

A user deposits USDT (TRC-20) to their own deposit address, which is derived from `HD_MNEMONIC`. The backend credits the full amount to their in-app balance; there is no deposit fee. The backend then moves ("sweeps") that USDT to the client's treasury wallet. A USDT transfer on TRON needs **energy**, so the backend rents energy first. The user can then sell USDT for INR, which the admin pays by bank transfer by hand, or withdraw USDT, which the admin sends by hand from the treasury.

## 2. System map

```
 User's phone (Android app)
        |
        v
 api.royalgccforex.com  --(CNAME, DNS only)-->  Render: backend API + deposit worker (one process)
        |                                             |            |             |
        v                                             v            v             v
 Supabase Postgres (balances, orders)           TronGrid      Netts API     Brevo (email)
                                               (TRON chain)  (energy rental)
 admin.royalgccforex.com  (Cloudflare Worker, static admin panel)  --> same API
 royalgccforex.com        (Cloudflare Worker, landing page + APK link)
```

## 3. Money flows

### Deposit

1. **The app opens the deposit screen** and calls `POST /api/wallet/generate-address`. Each user has one permanent address. The first call derives it from `HD_MNEMONIC` (path `m/44'/195'/0'/0/<n>`). The address is a plain TRON wallet.
2. **The worker watches the address.**
   - Every 15 seconds while the deposit screen is open.
   - Then every 6 hours for 7 days.
   - After that, only when the user opens the deposit screen again, or when an admin clicks "Check again".
   - The daily audit (section 6) catches anything sent while nobody was watching.
3. **Only final USDT counts.** A transfer is credited only when the solidity node reports it as successful, and only for the official USDT contract `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`. TRX and other tokens sent to the address are ignored.
4. **Credit happens in one database transaction.** `record_deposit` records the on-chain event, credits the **full amount**, and opens a sweep. The same event can never be credited twice; the key is `(network, tx_id, log_index)`.
5. **Small deposits are held.** Below `DEPOSIT_MIN_USDT` (10), the deposit is recorded but not credited. It shows on the admin Dashboard with a "Credit anyway" button.

### Sweep to treasury (`src/workers/depositWorker.ts`, `src/tron/energy.ts`)

1. **Timing.** An address holding at least `SWEEP_IMMEDIATE_USDT` (100) is swept at once. Smaller balances wait up to 24 hours, so several small deposits share one sweep cost.
2. **Estimate.** The worker asks the chain how much energy the transfer needs (about 64,000 when the treasury already holds USDT, about 130,000 when it is empty).
3. **Get energy**, cheapest first, stopping at the first that works:
   1. **Netts**: rents energy for 5 minutes (`POST /order5m`, estimate + 5%, minimum 61,000), paid from the prepaid Netts balance. Needs the server's IP whitelisted on the Netts key; each call sends that IP in `X-Real-IP`.
   2. **TronNRG**: the operating wallet pays TRX on-chain (16,250 energy per TRX, minimum 4 TRX), and TronNRG delegates energy. No IP whitelist.
   3. **Burn**: the operating wallet sends the deposit address enough TRX (about 6.5 to 7.5 TRX) to pay for its own energy. Most expensive; last resort.

   Before TronNRG or burn, a brand-new address must be activated: the operating wallet sends it 0.1 TRX (about 1.1 TRX in total, once per address).
4. **Cost cap.** The total TRX spent on one sweep never exceeds `SWEEP_MAX_COST_TRX` (10). If it would, the sweep stops as `failed` with `cost_cap`, and the money stays safely in the deposit address.
5. **Send.** The worker signs a normal USDT `transfer` to the treasury with the address's key. The key is derived in memory at that moment and never stored. The transaction id is saved before broadcasting.
6. **Confirm.** The worker waits for the solidity node, then checks that exactly that amount arrived at `TREASURY_ADDRESS`. It records `sweeps.provider` (`netts`, `tronnrg`, `burn`, or `activate`) and `sweeps.cost_trx`.
7. **Retries.**
   - Normal failures retry with backoff. After 5 attempts the sweep becomes `failed`, and an admin can click Retry.
   - Unexpected errors (for example, TronGrid down) back off from 1 minute up to 1 hour. After 10 in a row, an alert email goes out. These keep retrying.

A sweep can only ever send to the treasury. The treasury address is pinned in the database on first start (section 4).

### Sell order (USDT to INR)

1. The user needs approved KYC, a bank account of their own, and their 6-digit PIN. The minimum is `min_exchange_usdt` (10).
2. The rate comes from `src/services/marketRate.ts`:
   - The **market rate** is the **lowest** bid of CoinDCX, WazirX and ZebPay.
   - The **user rate** is the market rate minus the spread (1.5%).
   - Sells pause if the sources disagree by more than 3% or are more than 2 minutes old.
   - An admin can set a fixed rate for 24 hours. It can never be above the live market, and it is used alone if the live sources are down.
3. `create_exchange_order` moves the USDT from available to locked. The order is `PROCESSING`.
4. The admin pays the INR by bank transfer, then marks the order **Paid** with the UTR. `complete_exchange_order` spends the locked USDT. Or the admin chooses **Refund**, which returns the USDT. Each order completes only once.

### USDT withdrawal

1. The user needs KYC and their PIN. The minimum is `min_usdt_withdrawal` (20). The fee is a flat `usdt_withdrawal_fee` (5 USDT). The amount is locked.
2. The admin sends the net amount from the treasury wallet (TronLink) and pastes the transaction hash.
3. The backend accepts the hash only if the transaction is final, pays exactly the right amount to the right address, and was not used before. **Reject** refunds the user.

The backend never holds the treasury key.

## 4. Keys: what exists and who holds it

| Secret | What it controls | Where it lives |
| --- | --- | --- |
| **Treasury seed phrase** | All swept funds. | Offline with the client (hardware wallet, or TronLink plus a paper backup). **Never on the server.** The backend knows only the address (`TREASURY_ADDRESS`). |
| **`HD_MNEMONIC`** | Every user's deposit address. Money sits there only until it is swept (minutes, or up to 24 h for small amounts). | Render environment variable, plus a paper backup. Never the treasury seed. |
| **`OPERATING_WALLET_PRIVATE_KEY`** | A small TRX-only wallet that pays activations, TronNRG and burns. | Render environment variable. Keep about 100 to 200 TRX in it; never USDT. |
| `NETTS_API_KEY` | The prepaid Netts balance (energy only, cannot withdraw to others). | Render environment variable. Locked to whitelisted IPs. |
| `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` | The whole database, including balances. | Render environment variables. |
| `JWT_SECRET` | Anyone holding it can sign in as any user or admin. | Render environment variable. |
| Admin passwords | Paying INR and USDT out. | Each admin. |

**Safety checks at startup** (the server refuses to start rather than risk funds):

- `HD_MNEMONIC does not match the existing deposit addresses. Restore the original phrase.`: the phrase was changed after addresses were issued. Changing it is safe only before any deposit address exists ([OPERATING_MANUAL.md](OPERATING_MANUAL.md) section 3.2).
- `TREASURY_ADDRESS ... differs from the pinned treasury ...`: the env var no longer matches `system_settings.pinned_treasury_address`. To change the treasury on purpose, update both ([OPERATING_MANUAL.md](OPERATING_MANUAL.md) section 3.1).

**Why not AWS KMS.** KMS would protect the deposit seed from someone who can read the server's environment. It adds cost and setup, and it protects only money in flight before a sweep; the treasury is never on the server. More important:

- Two-factor authentication on Render, Supabase, GitHub and Cloudflare.
- At most two people with dashboard access.
- Seeds and keys never in git or chat.

Revisit KMS when money in flight regularly exceeds what you could afford to lose.

**Where the real risk is: payouts.** Someone with an admin password, the service role key or `JWT_SECRET` could fake balances or orders, and an admin might then pay for them. So:

- Protect those secrets.
- Give each admin their own login.
- Before a large payout, check that the user's deposit is visible.
- Freeze suspicious accounts. Frozen or banned users are refused on every request.

## 5. Fees and who pays

| Cost | Who pays | How it is recovered |
| --- | --- | --- |
| Sweep energy (about 0.64 to 1.00 USD with Netts, up to about 2.2 USD by burning) | Platform: the Netts balance or the operating wallet | The 1.5% sell spread |
| Address activation (about 1.1 TRX, once per address) | Operating wallet | The sell spread |
| USDT withdrawal (sent by the admin from TronLink, which burns about 2.2 USD of TRX or uses the treasury's own energy) | Treasury TRX | Flat 5 USDT fee charged to the user |
| Deposit | Nobody | No deposit fee |

## 6. Monitoring

- **Dashboard → "Deposits need attention"** lists failed sweeps (with a plain explanation and a Retry button when it is safe), deposits below the minimum, slow sweeps, and the last audit's findings. The "Run check now" button runs the audit at once.
- **Daily audit.** Once a day the worker compares each deposit address's on-chain USDT with the records.
  - It records and credits USDT sent while nobody was watching (`unrecorded_funds`).
  - It flags addresses holding less than expected (`balance_short`). Escalate to the developer at once.
- **Emails to `ALERT_EMAIL`**: see [OPERATING_MANUAL.md](OPERATING_MANUAL.md) section 5.
- **`/health`** returns 503 if the database is unreachable or the worker has not finished a cycle in 10 minutes.

## 7. Code map

| File | Role |
| --- | --- |
| `src/workers/depositWorker.ts` | Polling, crediting, the sweep state machine, the daily audit, alerts, the startup checks |
| `src/tron/energy.ts` | Netts and TronNRG calls, energy and burn maths, sweep timing, egress IP |
| `src/tron/hd.ts`, `src/tron/seed.ts` | Address derivation from `HD_MNEMONIC` |
| `src/tron/chain.ts`, `src/tron/usdt.ts` | TronGrid reads and broadcasts, USDT amounts |
| `src/services/marketRate.ts` | INR market rate and the spread |
| `src/services/adminService.ts` | The attention panel, Retry, Credit anyway |
| `db/schema.sql` | `record_deposit`, `sweeps`, `audit_reports`, `system_settings` |

## 8. Known limits

- **Run exactly one backend instance.** A second one would not double-spend, but it would waste TronGrid quota.
- **A crash between two Transfer logs of the same transaction** could skip the second one until the daily audit flags it. "Check again" then records it.
- **Transaction PIN.** Sell orders and withdrawals need the user's 6-digit PIN.
  - Five wrong guesses lock money-out for 15 minutes (counter in the database).
  - Setting the first PIN, or resetting a forgotten one, needs an emailed code (valid 10 minutes).
  - A reset blocks sells and withdrawals for 24 hours.
  - Admins never see PINs or PIN hashes.
- **Statement.** `GET /api/wallet/statement` returns the user's balance history; the app shows it under History → Statement.
- **Not built:** a withdrawal fee quote based on live cost, and a "Rent energy" button for withdrawals. Withdrawals use the flat 5 USDT fee, and the admin's TronLink burns TRX.
