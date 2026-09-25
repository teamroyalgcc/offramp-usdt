# USDT Deposits, Sweeps and Payouts: How It Works

Date: 2026-09-25. Branch: `plan/gasfree-sweep-architecture`.

This is the design reference for the money flow. For deploying the system, see [DEPLOYMENT.md](DEPLOYMENT.md). For day-to-day operation, see [ADMIN_GUIDE.md](ADMIN_GUIDE.md).

## 1. The product in one paragraph

A user signs in to the mobile app, completes KYC and adds a bank account. They send USDT (TRC20) to their personal deposit address. The backend detects the transfer, waits until it is final, and credits their balance minus a processing fee. It then moves the USDT to the company treasury wallet through GasFree, so nobody has to top up deposit addresses with TRX. The user sells USDT for INR in the app. An admin pays the INR by bank transfer and marks the order as paid in the admin panel. Users can also withdraw USDT; an admin sends it by hand from the treasury wallet.

## 2. System map

| Repo | What it is | Hosted on |
| --- | --- | --- |
| `offramp-usdt` | Backend API plus the background worker (one Node process). | Render (free web service) |
| `offramp_royalGCC_admin_pannel` | Admin panel (Next.js, static export). | Cloudflare Pages |
| `royal_gcc_forex_mobile_app` | User app (Expo / React Native). | Android APK via EAS Build |
| `royal_gcc_landing_page` | Marketing site with the APK download link. | Cloudflare Pages |
| `royal_gcc_forex_backend` | Older fork of this backend. **Not used.** | none |
| `royalgcc-react-native-app` | Early prototype app. **Not used.** | none |

The database is Supabase Postgres (free tier). No custom smart contract is involved: GasFree's controller contract is already deployed on TRON, and the backend only signs transfer permits for it.

## 3. Money flow

### Deposit

1. **The app opens the deposit screen.** It calls `POST /api/wallet/generate-address`. Each user has one permanent address. The first call derives it from `HD_MNEMONIC` (path `m/44'/195'/0'/0/<n>`) and resolves the matching GasFree address on-chain from GasFree's controller contract. Every call also starts a one-hour **watch window** for that address.
2. **The worker checks the address every 15 seconds** during the watch window. Outside it, the address is not polled at all. When the user opens the deposit screen again (or taps "Check again"), the worker rescans everything since its last check, so a late transfer is still found. The daily audit (section 5) catches anything sent while nobody was watching.
3. **Only final USDT counts.** A transfer is credited only when the solidity node reports it as successful, and only for the pinned USDT contract (`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`). TRX and any other token sent to the address are ignored completely.
4. **Credit happens in one database transaction.** The `record_deposit` function records the on-chain event, credits the gross amount and debits the processing fee as a separate ledger entry, then opens a sweep. The same event can never be credited twice. The key is `(network, tx_id, log_index)`.
5. **Small deposits are held.** If the amount minus the fee is below `DEPOSIT_MIN_NET_USDT`, the deposit is recorded but not credited. It shows up in the admin panel with a "Credit anyway" button.
6. **The app sees the result.** It polls `GET /api/wallet/deposits` while the deposit screen is open and shows a "Deposit received" message.

### Sweep to treasury

1. The worker asks GasFree for the address state, the fee quote and the nonce. It refuses to continue if GasFree reports a different address than ours, or if the fee is above `GASFREE_MAX_FEE_USDT`.
2. It signs a TIP-712 permit for the whole balance minus the fee, and checks the signature by recovering the signer.
3. It records the attempt before submitting, then submits once. GasFree's nonce makes a signed permit usable at most once.
4. It follows the GasFree trace until the transfer is final. It then checks on-chain that exactly that amount arrived at `TREASURY_ADDRESS`.
5. It retries with backoff. After 5 failed attempts the sweep is marked `failed`, and the admin panel shows a plain-language explanation with a Retry button when a retry is safe.

The funds at a deposit address can only leave through a GasFree permit signed by our key. There is no TRX funding and no fallback path.

### Sell order (USDT to INR)

1. The user places an order of at least `min_exchange_usdt` (default 10, in `system_settings`). `create_exchange_order` moves the USDT from available to locked, and the order is `PROCESSING`.
2. The admin pays the INR to the user's bank account by hand.
3. The admin opens the order and marks it **Paid**, entering the UTR. `complete_exchange_order` then spends the locked USDT. Alternatively, the admin chooses **Refund**, which moves the USDT back to available. Each order can complete only once.

### USDT withdrawal

1. The user requests a withdrawal. The amount is locked and the request is `pending`. The user receives the amount minus `usdt_withdrawal_fee`.
2. The admin sends that USDT from the treasury wallet (for example TronLink) and pastes the transaction hash into the admin panel.
3. The backend accepts the hash only if the transaction is final and pays exactly the right amount to the user's address, and only if the hash has not been used before. **Reject** refunds the user.

The backend never holds the treasury key. The old auto-send worker (`withdrawalWorker`, using `SYSTEM_PRIVATE_KEY`) has been deleted.

## 4. Keys: what exists and who holds it

| Secret | What it controls | Where it lives |
| --- | --- | --- |
| **Treasury wallet seed phrase** | All swept funds. | Offline with the client, for example a hardware wallet or TronLink with a paper backup. **Never on the server.** The backend only knows the address (`TREASURY_ADDRESS`). |
| **`HD_MNEMONIC`** (deposit seed phrase) | Every user's deposit address. It holds money only for the minutes between arrival and sweep. | A Render environment variable, plus an offline backup with the client. |
| `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` | The whole database, including balances. | Render environment variables. |
| `JWT_SECRET` | Anyone holding it can sign in as any user. | Render environment variable. |
| Admin passwords | Paying INR and USDT out. | The admins. |

**Plug and play.** The client generates their own `HD_MNEMONIC` and treasury wallet at handover, then pastes the phrase and the treasury **address** into Render. That is all. The rule is to set `HD_MNEMONIC` before the first real user and never change it afterwards. Every existing deposit address comes from it. The backend refuses to start if the phrase no longer matches the addresses already issued, so a mistaken swap fails loudly instead of losing funds.

**Why not AWS KMS (production view).** KMS protects the deposit seed from someone who can read the server's environment. For launch it adds cost and setup, and it protects only the small amount that is in flight between arrival and sweep. The treasury is never on the server anyway. What matters more:

- Two-factor authentication on Render, Supabase and GitHub.
- At most two people with dashboard access.
- The seed never in git or chat.

Revisit KMS or a separate signing service when deposits in flight regularly exceed an amount you would not want to lose, or when more people get access to the hosting accounts.

**"Once the sweep is done, is a hack almost impossible?"** For the treasury itself, yes, as long as its seed stays offline. The realistic risk moves to the **payout side**. Someone with an admin password, the service-role key or `JWT_SECRET` could fake balances or orders, and an admin could then pay INR or send USDT for them. So:

- Protect those three secrets.
- Give each admin their own login and a strong password. There is no default admin; the first one is created by SQL with the owner's own password.
- Before paying an order, check that the user's deposit is visible in the admin panel's deposit list.
- Use **Freeze** in the admin panel for any suspicious account. A frozen or banned user is refused on every app request.

## 5. Monitoring for a non-technical admin

- **Needs-your-attention panel** (admin Dashboard). This panel lists failed transfers to treasury, deposits held for review and slow transfers. It also lists issues from the last balance check. Each item says what happened in plain language and offers the one safe button, if there is one:
  - Retry transfer
  - Credit anyway
  - Check again

  Items marked "contact the developer" have no button on purpose.
- **Daily balance check.** Once a day the worker compares each deposit address's on-chain USDT with our records: everything received minus everything swept, fees included.
  - **More on chain than expected** means a deposit was not recorded. "Check again" rescans the full history and credits it.
  - **Less than expected with no transfer running** is escalated to the developer.

  The admin can also click "Run check now".
- **Email alert.** If the daily check finds anything, it emails `ALERT_EMAIL`.

## 6. Fees

GasFree charges per transfer, in USDT, taken from the swept amount. There is also a one-time activation fee the first time an address is swept. Since each user keeps one address, each user pays activation only once.

Real numbers seen in 2026 wallets range from about **1 to 1.5 USDT per transfer**, plus **about 1 to 1.5 USDT once for activation**. When GasFree launched in early 2025, the activation and transfer fees were each about 10 USDT, which is why the hard cap exists. Prices vary by provider and change over time. The worker logs the live quote at startup (`activateFee`, `transferFee` in the `started` log line), and every sweep stores the real fee charged in `sweeps.actual_fee_raw`.

Settings:

- **Processing fee (live).** Each deposit is charged GasFree's live `transferFee` for that address, plus `activateFee` on the address's first credited deposit (the first sweep pays activation), plus **`DEPOSIT_FEE_MARGIN_USDT`** (default 0.5). The Deposit screen shows the same live quote before the user sends. It is quoted when the deposit is credited; the margin absorbs small moves before the sweep. Two deposits before one sweep each pay a transfer fee, and the platform keeps the difference.
- **`DEPOSIT_PROCESSING_FEE_USDT`** (default 1.5). Fallback only: used when the GasFree API cannot be reached at credit time, so deposits are never blocked.
- **`GASFREE_MAX_FEE_USDT`** (default 3). This is a safety cap per sweep. If GasFree asks for more, nothing moves and the admin sees "fee above your safety limit".
- **`DEPOSIT_MIN_NET_USDT`** (default 10). Deposits worth less than this after the fee are held for review.

## 7. Decisions taken for launch

| Topic | Decision | Why |
| --- | --- | --- |
| Testnet (Nile) | **Skipped. Test with a small mainnet deposit.** | GasFree itself recommends Nile only for integration debugging, and Nile addresses differ from mainnet addresses, so a Nile run proves little about mainnet. The parts that could lose money were already verified read-only on mainnet: address derivation, the GasFree address from the controller, and our permit hash matching the controller's own hash byte for byte. What remains (the authenticated GasFree calls) is covered by one deposit of about 15 USDT. If that sweep failed, the USDT would stay safely in the deposit address, and only our key can move it. |
| Deposit address | One permanent address per user | Activation is paid once per user, and there is no expiry or late-deposit handling. |
| Fee presentation | "Processing fee", deducted from each deposit | Same economics as a network fee, with better presentation. |
| Wrong tokens | Ignored | Only the USDT contract is ever credited or swept. |
| Hosting | API and worker in one free Render service | Render background workers are paid. The watch-window design means nothing is lost while the service sleeps. A free pinger keeps it awake (see DEPLOYMENT.md). |
| Email | Brevo HTTPS API | Render's free tier blocks SMTP ports. |
| USDT withdrawals | Sent by hand by an admin, with the tx hash verified on-chain | No treasury key on the server. |
| AML screening of senders | Not in this phase | Out of scope for launch. |

## 8. Code map

| Path | Purpose |
| --- | --- |
| `db/schema.sql` | The whole database for a fresh project: users, KYC, banks, ledger, deposits, sweeps, orders, withdrawals, and every money function. Row-level security is on for all tables. Apply it with the SQL Editor or `npm run migrate`. |
| `src/workers/gasfreeWorker.ts` | Watch-window polling, credit, sweep state machine, daily audit and alert email. |
| `src/tron/` | `usdt.ts` (exact 6-decimal amounts), `hd.ts` (derivation), `seed.ts` (`HD_MNEMONIC`), `gasfree.ts` (API client and TIP-712 signer), `chain.ts` (TronGrid reads, solidified data only). |
| `src/services/adminService.ts` | Deposit list, deposit health, the safe admin actions, and order completion. |
| `src/services/withdrawalService.ts` | Manual USDT withdrawals with on-chain verification. |
| `src/tron/*.test.ts` | `npm test`: amounts, derivation, permit signatures, and `db/schema.sql` on an empty in-process Postgres (credit, dedupe, hold/credit-anyway, sweeps, orders paid/refunded exactly once, withdrawals locked/sent/refunded, ledger matches balances). |

## 9. Known limits

- **Run exactly one backend instance.** A second one would not double-spend, but it would waste TronGrid quota. The OTP attempt counter is also in memory.
- **A crash between two Transfer logs of the same multi-transfer transaction** would skip the second log until the daily audit flags it. "Check again" then records it.
- **Transaction PIN.** Sell orders and USDT withdrawals need the user's 6-digit PIN (`users.transaction_pin_hash`, bcrypt). Five wrong PINs lock money-out for 15 minutes (in memory, one instance). Forgot PIN: a fresh email-code login allows a new PIN without the old one for 10 minutes (`users.pin_reset_until`). Admins never see PIN hashes.
- **Statement.** `GET /api/wallet/statement` returns the user's `available` ledger rows, newest first, with a readable label and the balance after each change. The app shows it under History → Statement.
- **After launch:** invite code / team commissions (the rules are not defined yet) and splitting a payout across banks.
