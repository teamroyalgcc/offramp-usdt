# Admin Guide

This guide is for the people who run Royal GCC day to day. You need no blockchain knowledge. Every screen tells you what to do.

## How money moves

1. **A user sends USDT to their deposit address in the app.** The system detects it within a few minutes and adds it to their balance, minus the processing fee. Nobody needs to approve it.
2. **The system moves that USDT to the company treasury wallet on its own**, usually within minutes.
3. **The user sells USDT for INR.** You pay the INR to their bank account and mark the order as paid.
4. **The user withdraws USDT.** You send it from the treasury wallet and mark it as sent.

Only steps 3 and 4 need you. Everything else is automatic, and anything that goes wrong shows up on the Dashboard.

## Daily routine (5 minutes)

1. Open **Dashboard**. Look at the **"Deposits: needs your attention"** panel.
   - A green "Nothing to do" message means you are done.
   - Otherwise, handle each item (see the table below).
2. Open **Sell Orders (INR)**. For each order with status **processing**:
   1. Open the order. The user's bank details and the exact INR amount are shown.
   2. Send the INR from the company bank account (IMPS/NEFT/UPI).
   3. Choose **Paid**, paste the **UTR / bank reference**, and click **Confirm paid**.
   4. If you cannot pay (wrong bank details, suspicious user), choose **Refund** and write the reason. The user's USDT goes back to their balance.
3. Open **USDT Withdrawals**. For each **pending** request:
   1. Copy the address and the **"Send this"** amount (the copy buttons are next to them).
   2. In the treasury wallet (TronLink), send exactly that amount of **USDT (TRC20)** to that address.
   3. Copy the transaction hash from TronLink. Click **Mark as sent**, paste it and confirm. The system checks the blockchain. If the amount or address is wrong, it tells you and nothing is marked.
   4. To refuse a request, click **Reject** and give a reason. The user is refunded.
4. Check **KYC** and approve or reject new users.

You also get an email every day there is something on the attention panel.

## The attention panel, item by item

| You see | What it means | What to do |
| --- | --- | --- |
| **Deposit below minimum (not credited yet)** | The user sent less than the minimum. | Click **Credit anyway** to add it to their balance (the fee is deducted), or contact the user first. |
| **Transfer to treasury failed**, with a **Retry transfer** button | The automatic move to treasury failed several times. The money is safe in the deposit address. | Read the explanation and click **Retry transfer**. If it says the fee is above your safety limit, ask the developer to raise `GASFREE_MAX_FEE_USDT`, or wait a day and retry. |
| **Transfer to treasury failed**, with no button | This should not happen and must not be retried. | Contact the developer. Do not touch anything. |
| **Transfer to treasury is taking longer than usual** | The system is still retrying on its own. | Nothing, unless it is still there after several hours. |
| **USDT received but not recorded** | A user sent USDT while their deposit screen was closed. | Click **Check again**. It finds and credits the deposit. |
| **Deposit address has less USDT than expected** | Something moved money in a way the system did not. | Contact the developer **immediately**. Pause sell-order and withdrawal payouts until it is explained. |

**Run check now** re-checks every deposit address against the blockchain. The check also runs by itself once a day.

## Before paying anyone: safety rules

- **Pay only what the order says**, to the bank account shown in the order.
- **Check that the money came in.** For a large or unusual order, confirm that the user's deposits appear in the Dashboard deposit list, marked **Credited** and **Moved to treasury**.
- **Never pay from a message.** Never pay because of an email, chat or phone call. Only pay orders and withdrawals shown in the admin panel.
- **Each staff member uses their own login.** Superadmins create accounts in **Role Management**. Delete accounts of people who leave.
- **Never ask a user for their transaction PIN.** Every sell order and withdrawal is confirmed with the user's 6-digit PIN. Staff cannot see or reset it. A user who forgot it taps **Forgot PIN?** in Profile → Transaction PIN and confirms with an email code. After 5 wrong PINs, selling and withdrawing are blocked for 15 minutes.

## Keys and wallets

| What | Who keeps it | Rules |
| --- | --- | --- |
| **Treasury wallet seed phrase** | Owner, on paper, in a safe. Optionally a hardware wallet. | Never type it into any website, chat or email. Never give it to a developer. The server does not need it. |
| **Deposit seed phrase** (`HD_MNEMONIC`) | Owner keeps a paper backup. A copy is in Render's settings. | Never change it in Render once users exist. The system will refuse to start if it changes. |
| **Treasury wallet in TronLink** | The person who sends USDT withdrawals. | Keep about 50 TRX in it for network fees, and use a strong wallet password. |
| **Admin panel passwords** | Each staff member. | Use strong, unique passwords. Change them when someone leaves. |
| **Render, Supabase, Cloudflare and GitHub logins** | Owner plus at most one technical person. | Two-factor authentication must be on for all of them. |

**Moving money from the treasury** (for example, to cold storage or an exchange to convert) is done by hand in TronLink or on the hardware wallet. The system never moves money out of the treasury.

## Settings you may want to change

A technical person changes these in Render → the service → Environment. The service restarts in about a minute.

| Setting | Default | Meaning |
| --- | --- | --- |
| `DEPOSIT_FEE_MARGIN_USDT` | 0.5 | Added to GasFree's live fee on each deposit. The user pays live fee plus this. |
| `DEPOSIT_PROCESSING_FEE_USDT` | 1.5 | Fallback fee, used only if GasFree cannot be reached. |
| `DEPOSIT_MIN_NET_USDT` | 10 | Deposits worth less than this after the fee wait for your approval. |
| `GASFREE_MAX_FEE_USDT` | 3 | The system refuses to pay more than this per transfer to treasury. |
| `ALERT_EMAIL` | none | Where the daily problem email goes. |

The exchange rate spread is changed in the admin panel under **Rates**. The minimum sell amount, withdrawal minimum, withdrawal fee, daily limits and the on/off switches for deposits, sell orders and withdrawals are in the `system_settings` table (Supabase → Table Editor). The backend reads them when it starts, so restart it after changing them.
