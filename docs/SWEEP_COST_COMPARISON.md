# Sweep cost comparison (deposit address → treasury)

Status: **decided 2026-09-26: rented energy via Netts (<https://doc.netts.io/>), GasFree dropped, users pay the real-time sweep cost as the processing fee.** Implementation plan: `work/CLAUDE.md` → NEXT. The code on `main` still uses GasFree until that lands.

**The problem.** The user already paid a network fee to send USDT to their deposit address. A second transfer (the sweep to treasury) should not cost them again. The platform paying GasFree's 1.5 USDT per sweep is too heavy. We need a cheaper way to sweep.

## Live inputs (measured 2026-09-26)

| Input | Value | Source |
| --- | --- | --- |
| TRX price | **$0.3376** | CoinGecko |
| Energy price (burn) | **100 sun** per energy | `getchainparameters` → `getEnergyFee` |
| Bandwidth price (burn) | **1000 sun** per byte | `getTransactionFee` |
| Free bandwidth | **600 bytes/day** per activated account | `getFreeNetLimit` |
| Activate a new account | **1 TRX** + 0.1 TRX bandwidth, paid by the sender of its first TRX | `getCreateNewAccountFeeInSystemContract`, `getCreateAccountFee` |
| USDT transfer to an address that holds USDT (our treasury) | **64,285 energy** (includes 49,635 dynamic-energy penalty) | `triggerconstantcontract` estimate |
| USDT transfer to an empty address | 130,285 energy | same |
| USDT `approve` | 99,764 energy | same |
| USDT transfer size | ~340 bytes (fits in the 600 free bandwidth) | built tx |
| TRX transfer size | ~267 bytes | standard |
| Staking yield | 180B energy/day ÷ 18.9B TRX staked = **~9.5 energy per staked TRX per day** | `getaccountresource` |
| GasFree (mainnet API) | transfer **1.5 USDT**, activation **1.5 USDT** once per address | GasFree `/config/token/all`, `/address/{eoa}` |
| Energy rental market | **29 to 44 sun** per energy (1 h), so 65k energy = **1.9 to 2.9 TRX** | Netts, TronEnergyRent, APITRX (links below) |

A plain (non-GasFree) deposit address receiving USDT is **not activated**. It must receive TRX once (1.1 TRX) before it can sign anything, including receiving delegated energy.

## Cost per sweep

| Approach | First sweep of an address | Every later sweep | Per 100 USDT deposit |
| --- | --- | --- | --- |
| **GasFree** (built now) | 3.0 USDT ($3.00) | 1.5 USDT ($1.50) | 1.5% (3% first time) |
| **(1) Manual: send TRX, burn it, send USDT** | 1.1 + 6.43 = 7.5 TRX ($2.54) | 6.43 to 6.7 TRX ($2.17 to 2.26) | ~2.2% |
| **(2) Rented energy** | 1.1 + 1.9 to 2.9 TRX ($1.01 to 1.35) | 1.9 to 2.9 TRX (**$0.64 to 0.98**) | **~0.6 to 1%** |
| (3) Own staked energy, delegated | 1.1 TRX ($0.37) | ~0 marginal | ~0%, but capital locked (below) |

How the numbers are built:

- **(1) Manual.** The hot TRX wallet sends TRX to the deposit address (267 bytes: free for its first 2 tx/day, then 0.27 TRX). The USDT transfer burns 64,285 × 100 sun = 6.43 TRX. Its bandwidth is free. **Don't send leftover TRX back**: that is another 267-byte tx, and only 260 free bytes remain that day, so it burns 0.27 TRX. Leave the dust for the next sweep. **This is more expensive than GasFree for every repeat sweep.** Reject it as the main path; it is only useful as a fallback.
- **(2) Rental.** Activate once (1.1 TRX). Before each sweep, estimate the energy live and rent ~5% extra (≈ 68k) for 1 hour, delegated to the deposit address. Then sign a normal USDT transfer with the address's HD key. Bandwidth is free. Pay the provider from a prepaid API balance (no per-order tx). If rented energy falls short, the tx burns TRX for the rest, so keep ~1 to 2 TRX of dust in each address as a buffer.
- **(3) Staking.** One sweep per day needs 64,285 ÷ 9.5 ≈ **6,750 TRX staked (~$2,280)**. Energy regenerates over 24 h. Each sweep costs a `DelegateResource` + `UnDelegateResource` pair, with bandwidth covered by ~350 TRX staked for bandwidth. Unstaking takes 14 days. Equivalent to renting: one daily-sweep slot rents for ~365 × 2.4 ≈ 876 TRX/year, ≈ 13% of the 6,750 TRX staked, plus staking/voting rewards. **Worth it only when volume is steady and the client has idle TRX.**

## Monthly example: 10 deposits/day (300/month), 150 new deposit addresses/month, one sweep per deposit

| Approach | Monthly cost |
| --- | --- |
| GasFree | 300 × 1.5 + 150 × 1.5 = **$675** |
| (1) Manual burn | 300 × $2.17 to 2.26 + 150 × $0.37 = **$707 to 734** |
| (2) Rental | 300 × $0.64 to 0.98 + 150 × $0.37 = **$248 to 350** |
| (2) Rental + sweep only when ≥ 2 deposits waiting (≈ 150 sweeps) | **$152 to 203** |
| (3) Staking (needs ~67,500 TRX ≈ $22,800 locked for 10/day) | ~$56 (activations) + opportunity cost |

## Other ways considered

| Idea | Verdict |
| --- | --- |
| **Sweep less often** (sweep when an address holds ≥ N USDT, or after X days) | **Yes, combine it with any rail.** It divides the per-sweep cost across deposits. Trade-off: more USDT waits in addresses whose keys are on the server (`HD_MNEMONIC` in Render), while the treasury seed is on paper. Keep N and X small. |
| Approve once, then a single sweeper wallet pulls with `transferFrom` | No. `approve` costs 99,764 energy per address, more than a transfer, and every pull still costs ~64k energy. It only centralizes where the energy lives. |
| Sweep straight to the exchange where the client sells USDT for INR | Maybe, operationally. It saves the later treasury → exchange hop, but it is a business/ops decision and loses the cold-treasury buffer. |
| Users send straight to the treasury, matched by a unique amount | Zero sweep cost, but confusing UX, and it breaks when the sending exchange deducts its own fee from the amount. No. |
| Batch many addresses in one tx via a sweeper contract | No saving: each USDT move inside still costs ~64k energy, plus contract deployment. GasFree is essentially this. |

## Important for the decision

- **Switching away from GasFree changes the deposit address.** Today the user's address is the GasFree contract address derived from the HD key (`deposit_addresses.tron_address`). With rental or manual, the deposit address is the HD key's own address (`eoa_address`). Funds at a GasFree address can only leave via GasFree. **There are no users yet, so switching now is free. After launch, old addresses must still be swept via GasFree.**
- **New hot key on the server.** Rental and manual both need a small hot TRX wallet (~50 to 100 TRX) to activate addresses and top up dust. Its key goes in Render. Rental also needs a prepaid account + API key with one provider (third-party dependency; pick one with an API and use GasFree-like caps: refuse if a quote is above N TRX).
- **Fallback.** With plain addresses, if the rental API is down, the same sweep can fall back to burning TRX (path 1, ~$2.2). GasFree can no longer be the fallback.
- **The user fee.** At rental cost (~$0.64 to 0.98 per sweep), the platform can make deposits free: the 1% sell spread earns $1 per 100 USDT sold. The current code charges users the live GasFree transfer fee (1.5) and absorbs activation.

## Recommendation (to confirm)

1. **Before the first user:** switch deposits to plain HD addresses + **rented energy**, with **TRX burn as fallback**. Keep GasFree code only if we want it for a rainy day; otherwise delete it.
2. **Make deposits free for users** (or free above ~50 USDT). The platform absorbs ~$0.64 to 0.98 per sweep.
3. **Sweep threshold:** sweep when an address holds ≥ 50 USDT, or its oldest unswept deposit is 24 h old. This roughly halves sweep count without leaving much money on hot keys.
4. **Later, at steady volume** (≈ 20+ sweeps/day) and if the client holds idle TRX: stake TRX for energy and drop rental to a fallback.

Rough build size for 1 to 3: 2 to 3 days (activation step, live energy estimate, rental order + wait for delegation, plain USDT transfer from the HD key, fallback, threshold, tests on a mainnet dust amount).

## Sources

- TRON chain parameters and resources: `https://api.trongrid.io/wallet/getchainparameters`, `/wallet/getaccountresource`, `triggerconstantcontract` (queried 2026-09-26)
- GasFree mainnet API `/api/v1/config/token/all`, `/api/v1/address/{eoa}` (queried 2026-09-25)
- [What It Actually Costs to Send USDT on TRON in 2026 (TronEnergyRent)](https://tronenergyrent.com/en/blog/how-much-trx-send-usdt-2026)
- [TRON Energy Market (Netts)](https://netts.io/market/)
- [TronEnergyRent pricing](https://tronenergyrent.com/en/pricing) and [API](https://tronenergyrent.com/en/overview-api)
- [APITRX](https://apitrx.com/en/)
- [Best TRON Energy Rental Platforms 2026 (TronGuides)](https://tronguides.com/articles/best-tron-energy-rental-platforms.html)
- [How Much to Send USDT (TRC-20)? 2026 (TronSave)](https://blog.tronsave.io/how-much-does-it-cost-to-send-usdt-trc20/)
