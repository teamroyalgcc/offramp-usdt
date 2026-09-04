# TRON-USDT GasFree Deposit Sweep Plan

## Executive decision

Use a dedicated, database-backed worker to sweep each confirmed deposit through the TRON GasFree provider. The application will show a new GasFree deposit address for every transfer, credit the user's ledger after a finalized deposit is detected and the provider fee is known, and submit a signed GasFree authorization to move the net USDT to a hot aggregation wallet.

This replaces the proposed Stake 2.0 Energy/Bandwidth delegation model for deposit sweeps. No TRX stake, per-address TRX funding, account-activation transaction, or JustLend rental is required for these sweeps. GasFree instead charges its activation and transfer fees in USDT. Because every deposit uses a fresh GasFree account, every sweep is a first-use transfer and is expected to include both fees. The worker must obtain a fresh provider quote rather than hard-code either fee.

Target operating profile:

- Up to 100 TRON deposits per day initially.
- Confirmed deposits credited within approximately two minutes of solidification.
- Normal sweep completion within five minutes of credit.
- A configurable minimum net credit of 10 USDT.
- Late deposits are credited and flagged rather than abandoned.
- Swept funds enter a hot aggregation wallet; excess is moved to the cold/admin treasury only after manual approval under the treasury policy.

## Cost and resource research snapshot

The following comparison was calculated on 2026-09-04 for 100 successful USDT sweeps per day. It is a sizing estimate, not a permanent network constant. Before procurement, refresh the network resource weights, recent USDT transfer receipts, TRX/USD price, Energy-rental quote, and authenticated GasFree quote.

### Fresh-address activation constraint

Receiving USDT does not activate a fresh TRON EOA. TRON's standard activation paths are a TRX/TRC-10 transfer or `wallet/createaccount`; an incoming TRC-20 balance only updates state inside the token contract. A conventional sweep therefore has to activate each fresh deposit address before that address can originate its USDT transfer.

Standard activation costs 1 TRX per fresh address. If the activating wallet has insufficient Bandwidth, the network can charge an additional 0.1 TRX. Once activated, the deposit account receives 600 free Bandwidth per day, which should cover its one normal sweep transaction. Consequently, stake Bandwidth centrally for the wallet issuing activation transactions rather than delegating Bandwidth to every one-use deposit address.

GasFree avoids separate TRX funding and activation transactions from this application, but charges a first-use activation fee and transfer fee in USDT. Because this product deliberately creates a new address for every deposit, it cannot amortize the GasFree activation fee over later transfers.

### Baseline measurements and assumptions

- Recent successful USDT transfers consumed approximately 64,285-65,123 Energy when the recipient already held USDT; use 65,123 Energy per sweep for planning.
- At 100 sweeps per day, the worker needs approximately 6,512,300 Energy per rolling 24-hour period.
- The 2026-09-04 network weights yielded approximately 9.5902 Energy and 1.6076 Bandwidth per staked TRX.
- The observed JustLend quote was approximately 0.41408627 TRX per 10,000 rented Energy.
- The observed TRX price was approximately 0.3282077 USD.
- Current chain parameters charged 100 sun per Energy, 1,000 sun per Bandwidth byte, and 1 TRX for standard account activation.

### Approximate cost at 100 sweeps per day

| Resource method | Approximate requirement or recurring cost | Operational note |
| --- | ---: | --- |
| Burn TRX | 651.23 TRX/day for Energy + 100 TRX/day for activation | About 751.23 TRX/day before a possible Bandwidth shortfall; simplest but most expensive recurring method. |
| Rent Energy | 269.67 TRX/day for Energy + 100 TRX/day for activation | About 369.67 TRX/day with the activation wallet's Bandwidth covered; suitable while volume is uncertain. |
| Stake Energy | About 679,000 TRX bare minimum | Use roughly 815,000-883,000 TRX with a 20-30% Energy buffer; the 100 TRX/day fresh-address activation charge remains. |
| Stake central Bandwidth | About 17,000-20,000 TRX | Intended for the central activation wallet; the newly activated deposit account's free Bandwidth should cover its single sweep. |
| GasFree | `100 * F` USDT/day | `F` is the authenticated first-use activation-plus-transfer fee per fresh GasFree address. |

The practical conventional staking estimate is therefore approximately 832,000-903,000 TRX in total: 815,000-883,000 TRX for buffered Energy plus 17,000-20,000 TRX for central activation Bandwidth. This minimizes resource burn but does not eliminate the protocol's 1 TRX standard activation charge for each new address.

### Economic decision rule

Using the snapshot above, Energy rental plus standard activation costs approximately 369.67 TRX/day, or 121.33 USD/day. GasFree is cheaper on direct transaction cost only when its authenticated total first-use fee is below approximately 1.21 USDT per deposit:

```text
GasFree break-even fee = conventional daily cost / 100 sweeps
                         = 121.33 USD / 100
                         = approximately 1.21 USDT per sweep
```

Do not infer the GasFree fee from documentation examples. The public configuration endpoint requires authentication, so the implementation must obtain and persist the real provider quote. GasFree remains the selected architecture in this document, but production enablement has an economic gate: confirm that the live first-use fee is below the approved threshold, or document that the team is intentionally paying a premium for its simpler no-TRX user flow.

For a stable base load near 100 sweeps per day, staking is normally cheaper over time if the business already intends to hold TRX and accepts its price exposure and 14-day unstaking delay. A lower-risk rollout is to rent Energy initially, measure real p50/p95 consumption for several weeks, then stake for 70-80% of predictable demand and rent for peaks. Direct Energy burn should remain an emergency fallback.

TRON deployer Energy sharing does not solve USDT sweep costs. Only the USDT contract deployer can change its `consume_user_resource_percent`; this application does not control Tether's contract. The applicable mechanism for conventional sweeps is Stake 2.0 resource delegation from a central resource wallet to each activated deposit address.

## Current repository state

The canonical backend is the root `src/` tree. The root `package.json` and `tsconfig.json` compile it into `dist/`. The duplicate `server/src/` tree has diverged, while `api/index.js` points at a nonexistent `server/index.js`; deployment must be normalized around the root build.

Transfer primitives exist but are not production-ready:

- `src/services/walletService.ts#sweepFunds` signs a normal TRC-20 `transfer` using a deposit private key.
- `src/services/tronService.ts#sendTRX` funds a deposit address with TRX.
- `src/workers/tronWorker.ts#triggerSweep` attempts an immediate sweep after crediting a deposit.
- The database has only partial sweep fields such as `sweep_tx_hash`; it does not have a durable job state machine.

The present implementation must not be enabled for production because it:

- Sends a hard-coded 15 TRX to every deposit address.
- Has no GasFree integration or provider authorization flow.
- Can retry and rebroadcast without an atomic claim or durable prepared state.
- Sometimes invents a `DEP_*` transaction identifier.
- Credits the address's current balance rather than an exact finalized transfer event.
- Uses JavaScript `Number` for six-decimal token amounts.
- Stores random deposit private keys encrypted with application-managed AES-CBC.
- Stores a 30-minute expiry but does not enforce it during detection.
- Has no executable automated test suite.

## Target architecture

### Runtime separation

Run two independently deployable processes from the same root codebase:

1. The API handles authentication, deposit-intent creation, balance/status reads, and user/admin notifications.
2. A dedicated worker handles finalized-chain detection, provider quoting, GasFree authorization, submission, confirmation, retries, and reconciliation.

Add explicit `start:api`, `start:worker`, `dev`, `build`, and `test` scripts. API instances must never start blockchain workers implicitly. Only the dedicated worker deployment receives signing and GasFree credentials.

### Address and key model

Generate one underlying EOA per deposit intent with the TRON BIP-44 path:

```text
m/44'/195'/0'/0/<derivation_index>
```

Use a PostgreSQL sequence to allocate `derivation_index` atomically. Store the derivation index, underlying EOA address, returned GasFree address, provider address, network, and expiry; do not store a per-address private key.

Bootstrap the wallet once:

- Generate the BIP-39 seed outside the application deployment.
- Store only an AWS KMS envelope-encrypted seed in the production secret store.
- Store the account-level extended public key separately so the API can derive underlying EOAs without decrypting the seed.
- Grant `kms:Decrypt` only to the dedicated signer worker role.
- Require an environment-specific AWS Encryption SDK context and key commitment.
- During signing, derive only the required child key, verify that it produces the recorded EOA, sign the typed authorization, and clear seed/key buffers as soon as possible.

For a new intent, the API derives the EOA from the public key, calls GasFree `GET /api/v1/address/{accountAddress}`, and displays the returned `gasFreeAddress` to the user. The ordinary EOA address must not be displayed as the deposit destination.

The hot aggregation wallet should also have a GasFree account so occasional treasury consolidation can use the same provider flow where supported. The cold/admin destination remains a separately controlled multisig treasury.

### Provider integration

Implement a narrow `GasFreeProvider` interface with these operations:

```ts
interface GasFreeProvider {
  getConfiguration(): Promise<GasFreeConfiguration>;
  getAccount(eoaAddress: string): Promise<GasFreeAccount>;
  quoteTransfer(input: TransferQuoteInput): Promise<TransferQuote>;
  submitAuthorization(input: SignedAuthorization): Promise<Submission>;
  getTransfer(traceId: string): Promise<GasFreeTransferStatus>;
}
```

The initial adapter uses the official Mainnet provider endpoints and TIP-712 authorization format. Keep chain ID, verifying contract, service-provider address, token contract, deadline constraints, and fee values sourced from authenticated configuration responses. Pin the Mainnet USDT contract to `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` and fail closed if provider configuration reports another token for the USDT symbol.

Store the API key and secret in the worker's secret store. Generate request HMACs inside the provider adapter and never log credentials, signed headers, seed material, or child keys.

Every transfer must pass an explicit `maxFee` in micro-USDT. Reject the job for manual review when the provider quote exceeds the configurable business cap; do not silently accept a changed provider fee.

## Deposit lifecycle

### Creating an intent

`POST /api/wallet/generate-address` performs the following atomically where applicable:

1. Allocate a derivation index.
2. Derive the underlying EOA from the extended public key.
3. Resolve its GasFree address and current provider configuration.
4. Obtain or calculate the first-transfer fee quote.
5. Create a deposit intent expiring in 30 minutes.
6. Return the GasFree address, expiry, quoted activation fee, quoted transfer fee, and minimum accepted deposit.

The minimum shown to the user is:

```text
minimum deposit = configured minimum net credit + current activation fee + current transfer fee
```

The default configured minimum net credit is 10 USDT. Quotes are informational until sweep time because provider fees can change.

### Detecting and crediting

Replace global `limit=20` contract-event polling with persisted, finalized TRC-20 history cursors:

- Poll active GasFree addresses frequently enough to meet the credit target.
- Request confirmed/finalized transactions only.
- Paginate fully and filter by exact USDT contract and destination address.
- Use `(network, transaction_id, event_index)` as the unique event identity.
- Store raw amounts as integer micro-USDT values (`bigint`/Postgres integer or high-precision numeric), never floating-point numbers.
- Continue scanning expired addresses frequently for 24 hours and through a daily rolling reconciliation afterward so late transfers are recoverable.

When a finalized deposit is found, obtain a fresh GasFree account state and transfer quote. Calculate:

```text
gross deposit = finalized incoming USDT
provider fee = quoted activation fee + transfer fee
net credit = gross deposit - provider fee
```

In one PostgreSQL transaction:

- Insert the exact blockchain event idempotently.
- Credit the gross deposit to the ledger.
- Debit the quoted provider fee as a separate transparent ledger entry.
- Leave the resulting net amount available to the user.
- Flag the deposit as late when its finalized transfer timestamp is after `expires_at`.
- If the net credit is below 10 USDT, hold it for manual review instead of making it withdrawable.
- Create the sweep job.

The user balance is therefore backed by the amount expected to reach aggregation rather than by the gross amount before provider fees.

### GasFree sweep state machine

Create a durable state machine:

```text
pending
  -> quoting
  -> authorization_prepared
  -> submitted
  -> relaying
  -> confirmed
  -> reconciled
  -> complete
```

Terminal/exception states are `retryable_failed`, `fee_review`, `manual_review`, and `permanent_failed`.

Workers claim jobs atomically with `FOR UPDATE SKIP LOCKED`, a worker id, lease expiry, and attempt counter. External provider/network calls must happen outside open database transactions.

For each claimed job:

1. Read the GasFree account and ensure the provider allows submission.
2. Reconcile its finalized USDT balance and current nonce.
3. Quote the transfer of the maximum net amount to the hot aggregator.
4. Ensure the balance covers the receiver amount plus quoted fees.
5. Build a TIP-712 authorization containing token, service provider, user EOA, receiver, value, `maxFee`, deadline, version, and nonce.
6. Derive the matching child key through the KMS-protected signer and sign the authorization.
7. Persist the authorization hash, nonce, deadline, quote, and state before submission.
8. Submit once and persist the returned GasFree `traceId` separately from the eventual TRON transaction ID.
9. Poll by `traceId` until the provider publishes the native transaction and it reaches the required finality.
10. Verify the native receipt, USDT Transfer log, recipient, amount, fee, and source GasFree address.
11. Reconcile the aggregation-wallet increase and deposit-address residual balance.
12. Store actual provider fees and adjust the provisional fee ledger entry if the final fee differs from the quote.
13. Mark the job complete only after all on-chain and ledger values agree.

On timeout or an ambiguous response, query by the persisted trace/authorization identity before resubmitting. Never create another authorization with the same nonce while one is pending. When a deadline expires without acceptance, refresh account state and nonce before preparing a replacement.

GasFree-only means provider failure leaves funds safely at the GasFree address and the job queued. Do not fall back to sending TRX, normal `transfer`, Energy rental, or Stake 2.0 delegation automatically.

### Additional deposits and residual funds

An address may receive another transfer after its first sweep. Detection remains enabled indefinitely. Each new finalized event receives its own ledger treatment and reopens or creates a new sweep job.

After every completion, require the residual USDT balance to be zero or below a documented provider dust threshold. Non-zero residuals create reconciliation jobs rather than being ignored.

## Database changes

Evolve `deposit_addresses` into explicit deposit intents with:

- `derivation_index` with a unique constraint.
- `eoa_address` and `gasfree_address`, both unique per network.
- `provider_address`, `network`, `status`, `expires_at`, and `late_deposit_at`.
- `next_scan_at`, scan cursor, last scan time, and last observed balance.
- No `private_key_encrypted` for newly created records.

Strengthen `blockchain_transactions` with:

- Network, token contract, transaction ID, event index, and unique composite constraint.
- Block number, block timestamp, finality state, sender, and receiver.
- Gross raw amount, quoted fee, actual fee, and net amount in micro-USDT.
- Credited time, late flag, GasFree trace ID, and native sweep transaction ID.

Add `sweep_jobs` with:

- Deposit address/event references and state.
- Lease owner/expiry, attempts, next retry, and last error classification.
- Provider nonce, fee quote, maximum fee, deadline, authorization hash, trace ID, and native transaction ID.
- Gross balance, receiver amount, actual fee, and reconciliation values.
- Created, claimed, submitted, confirmed, reconciled, and completed timestamps.

Add an append-only `gasfree_operations` audit table containing sanitized request identities, provider responses, state changes, and fee data. Do not store private keys or API authentication headers.

Implement database functions for:

- Atomic finalized-deposit insertion plus ledger credit/fee debit/job creation.
- Nonblocking sweep claim with `FOR UPDATE SKIP LOCKED`.
- Lease recovery.
- Quote-to-actual fee adjustment.
- Terminal sweep reconciliation.

Add partial indexes for active deposit scanning, actionable sweep states, expired leases, and unreconciled operations.

## API and notification changes

Preserve `POST /api/wallet/generate-address`, returning:

```json
{
  "depositId": "uuid",
  "network": "tron",
  "addressType": "gasfree",
  "address": "T...",
  "expiresAt": "ISO-8601",
  "quotedActivationFee": "decimal USDT",
  "quotedTransferFee": "decimal USDT",
  "minimumDeposit": "decimal USDT",
  "status": "awaiting_deposit"
}
```

Add `GET /api/wallet/deposits/:depositId` with user-facing states: `awaiting_deposit`, `expired`, `confirming`, `credited`, `credited_late`, and `manual_review`. Internal sweep state must not be exposed as if it affects ownership of an already confirmed credit.

Notifications should show gross deposit, GasFree fee, and net credited amount. Add authenticated admin views for:

- Sweep queue depth and oldest age.
- Provider availability and authentication failures.
- Quoted versus actual fees.
- Fee-cap/manual-review jobs.
- Late and below-minimum deposits.
- GasFree-address residuals and aggregation reconciliation.

## Treasury flow

The hot aggregation balance is monitored continuously. When it exceeds the configured operating threshold or the daily review time arrives, create an admin alert and treasury transfer proposal.

The cold transfer requires manual approval under the treasury's multisig/operations policy. The application must not hold enough authority to move cold treasury funds by itself. If the aggregation account uses GasFree for the outgoing transfer, quote and cap its USDT fee exactly as for deposit sweeps; because the aggregator is reused, its GasFree activation fee is paid only once.

## Failure handling and monitoring

Retry with bounded exponential backoff and jitter for provider 429/5xx responses and network timeouts. Fail closed for configuration mismatch, invalid signatures, changed verifying contract, unexpected token contract, fee-cap breach, nonce conflict, or receipt mismatch.

Alert on:

- A confirmed deposit not credited within two minutes.
- A credited deposit not swept within five minutes.
- Provider authentication or availability failure.
- Quote above the configured fee cap.
- Quote-to-actual fee variance.
- A pending authorization near deadline.
- Native transaction failure or mismatched Transfer log.
- Non-zero residual balance after reconciliation.
- Queue lease recovery or repeated retries.
- Aggregation balance not matching completed sweep totals.

Track p50/p95 detection latency, credit latency, sweep latency, fee per transfer, first-use activation fees, retry rate, and provider uptime. Re-evaluate GasFree economics monthly because using a fresh account for every transfer forces first-use fees on every deposit.

## Test plan

### Unit tests

- HD derivation matches fixed TRON vectors and each stored EOA/GasFree mapping.
- Micro-USDT arithmetic preserves six decimals without floating point.
- TIP-712 domain and message serialization match GasFree fixtures.
- Signatures recover the expected EOA.
- Fee, minimum-deposit, gross-credit, fee-debit, and net-balance calculations are exact.
- State transitions reject regressions, duplicate nonce use, and duplicate submissions.
- Late and below-minimum deposits follow the selected policies.

### Database and concurrency tests

- Duplicate blockchain events produce one ledger credit and one sweep job.
- Concurrent workers claim different jobs with `SKIP LOCKED`.
- Expired leases are recoverable without duplicating an authorization.
- Quote-to-actual adjustment is idempotent.
- A second deposit to an already swept address creates new processing work.

### Provider integration tests

Mock success, pending, rejection, timeout, 429, 5xx, auth failure, fee change, deadline expiry, nonce conflict, and mismatched receipt cases. Verify that ambiguous submissions are queried before retry and that ordinary TRX/USDT transfer methods are never invoked.

### Nile acceptance test

1. Create an HD-derived EOA and resolve its Nile GasFree address.
2. Deposit Nile USDT to that address.
3. Detect the finalized event and credit the ledger exactly once.
4. Quote, sign, submit, and track the GasFree authorization.
5. Verify the native transfer to aggregation, actual fee, net amount, and zero residual.
6. Repeat with an expired intent, below-minimum deposit, provider timeout, and second deposit to the same address.

### Mainnet canary

Run one controlled Mainnet deposit with a strict fee cap. Verify provider configuration, gross/fee/net ledger entries, trace ID, native transaction receipt, aggregation balance, and user notification before increasing traffic.

## Rollout sequence

1. Perform a read-only Mainnet inventory confirming all legacy random deposit addresses are empty.
2. Normalize deployment on root `src/` and separate API/worker entry points.
3. Provision AWS KMS, secret storage, least-privilege worker IAM, HD seed backup, and recovery procedure.
4. Obtain separate GasFree Nile and Mainnet API credentials.
5. Apply the schema migration and deploy provider/signing code behind feature flags.
6. Run detection in shadow mode and compare it with on-chain history.
7. Complete Nile acceptance tests.
8. Run the one-deposit Mainnet canary.
9. Enable GasFree deposit generation gradually while monitoring fees and latency.
10. Disable and remove the current 15-TRX auto-sweep path after the canary period.
11. Remove the duplicate `server/` deployment path only after confirming no production system references it.

## Explicit assumptions

- GasFree is the only automated sweep mechanism; there is no automatic stake, rental, or TRX-burn fallback.
- Users are credited net of actual GasFree fees, with gross deposit and fee shown separately.
- Every transfer receives a new GasFree address, so every sweep is budgeted as a first-use GasFree transfer.
- The provider's live authenticated quote is authoritative; documentation examples are not treated as current prices.
- Initial volume is at most 100 deposits per day.
- Default minimum net credit is 10 USDT and all fee caps are configurable.
- Existing Mainnet deposit addresses hold no funds, but rollout still verifies this on-chain.
- Late deposits remain recoverable and are flagged.
- Cold treasury transfers require manual authorization.

## References

- GasFree developer documentation: https://docs.gasfree.io/
- Tether WDK TRON GasFree transfer guide: https://docs.wdk.tether.io/sdk/wallet-modules/wallet-tron-gasfree/guides/transfer-tokens/
- TRON account and activation model: https://developers.tron.network/docs/account
- TRON Bandwidth and Energy model: https://developers.tron.network/docs/bandwidth-and-energy
- TRON paying for resources and Energy sharing: https://developers.tron.network/docs/paying-for-resources
- TRON Stake 2.0 resource delegation: https://developers.tron.network/docs/delegation
- JustLend resource quote API used for the dated snapshot: https://openapi.just.network/lend/strx
- TRON custodial wallet guidance: https://developers.tron.network/docs/exchange-wallet-integration
- AWS Encryption SDK envelope encryption: https://docs.aws.amazon.com/encryption-sdk/latest/developer-guide/concepts.html
