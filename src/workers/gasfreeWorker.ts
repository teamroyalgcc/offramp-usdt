import config from '../config/index.js';
import { query } from '../utils/db.js';
import { TronChain } from '../tron/chain.js';
import { GasFreeClient, GasFreeRejected, Permit, recoverPermitSigner, signPermit } from '../tron/gasfree.js';
import { derivePrivateKey } from '../tron/hd.js';
import { loadSeedPhrase } from '../tron/seed.js';
import { formatUsdt, parseUsdt } from '../tron/usdt.js';
import wsService from '../services/wsService.js';
import { sendEmail } from '../utils/email.js';

// Detect finalized USDT deposits to per-user GasFree addresses, credit them
// atomically (record_deposit), and sweep to the treasury via GasFree.
// Only addresses inside their watch window (user opened the deposit screen) are
// polled. Only the pinned USDT contract counts; other tokens and TRX are ignored.
//
// Sweep states: pending -> submitted -> confirmed, or failed (needs a human).
// Safety comes from: unique (network, tx_id, log_index) on deposits, one open
// sweep per address, conditional state updates, and the provider nonce, which
// makes a signed permit executable at most once.
//
// ponytail: runs inside the API process; run exactly ONE instance. Conditional
// updates stop double submits, but two instances would waste TronGrid quota.
// Add SKIP LOCKED claims if you ever need more than one.

const NETWORK = config.tron.network;
const USDT = config.tron.usdtContract;
const WATCH_POLL_MS = 15_000;
const RESCAN_OVERLAP_MS = 2 * 60 * 60_000; // re-reads recent history to cover indexer lag
const TICK_MS = 5_000;
const MAX_ATTEMPTS = 5;
const AUDIT_EVERY_MS = 24 * 60 * 60_000;

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), svc: 'gasfree-worker', msg, ...extra }));
const alert = (msg: string, extra: Record<string, unknown> = {}) =>
  console.error(JSON.stringify({ at: new Date().toISOString(), svc: 'gasfree-worker', level: 'ALERT', msg, ...extra }));

export class GasFreeWorker {
  private chain = new TronChain({
    fullNode: config.tron.fullNode,
    solidityNode: config.tron.solidityNode,
    apiKey: config.tron.proApiKey,
  });
  private gasfree!: GasFreeClient;
  private provider: { address: string; deadlineSec: number } | null = null;
  private running = false;
  private minNetRaw = parseUsdt(config.gasfree.minNetUsdt);
  private feeRaw = parseUsdt(config.gasfree.processingFeeUsdt);
  private maxFeeRaw = parseUsdt(config.gasfree.maxFeeUsdt);

  /** Validates config synchronously; provider setup is retried inside the loop. */
  async start() {
    if (!config.treasuryAddress) throw new Error('TREASURY_ADDRESS is required');
    this.gasfree = new GasFreeClient(NETWORK, config.gasfree.apiKey, config.gasfree.apiSecret);
    loadSeedPhrase(); // throws if HD_MNEMONIC is missing or invalid

    // Refuse to run if the phrase was swapped after addresses were issued:
    // new addresses would come from a different wallet and old funds could not be swept.
    const { rows } = await query(
      `SELECT derivation_index, eoa_address FROM deposit_addresses WHERE method = 'gasfree' ORDER BY derivation_index LIMIT 1`,
    );
    if (rows[0]) {
      try {
        derivePrivateKey(loadSeedPhrase(), Number(rows[0].derivation_index), rows[0].eoa_address);
      } catch {
        throw new Error('HD_MNEMONIC does not match the existing deposit addresses. Restore the original phrase.');
      }
    }

    this.running = true;
    void this.loop();
  }

  private async connectProvider() {
    // Fail closed if the provider does not support exactly our USDT contract.
    const token = await this.gasfree.getToken(USDT);
    if (!token) throw new Error(`GasFree does not list ${USDT} as a supported token on ${NETWORK}`);

    const providers = await this.gasfree.getProviders();
    const p = config.gasfree.providerAddress
      ? providers.find((x) => x.address === config.gasfree.providerAddress)
      : providers[0];
    if (!p) throw new Error('No matching GasFree service provider');
    const c = p.config;
    this.provider = {
      address: p.address,
      deadlineSec: Math.min(Math.max(c.defaultDeadlineDuration, c.minDeadlineDuration), c.maxDeadlineDuration),
    };
    log('started', { network: NETWORK, token: USDT, provider: p.address, treasury: config.treasuryAddress, activateFee: token.activateFee, transferFee: token.transferFee });
  }

  stop() {
    this.running = false;
  }

  private async loop() {
    while (this.running) {
      try {
        if (!this.provider) await this.connectProvider();
        await this.pollDueAddresses();
        await this.processSweeps();
        await this.dailyAudit();
      } catch (e: any) {
        alert('tick failed', { error: e.message });
      }
      await new Promise((r) => setTimeout(r, this.provider ? TICK_MS : 60_000));
    }
  }

  // ---------- detection + credit ----------

  private async pollDueAddresses() {
    const { rows } = await query(
      `SELECT id, tron_address, created_at, last_polled_at, hot_until
         FROM deposit_addresses
        WHERE method = 'gasfree' AND network = 'tron' AND next_poll_at <= NOW()
        ORDER BY next_poll_at LIMIT 20`,
    );
    for (const a of rows) {
      try {
        await this.pollAddress(a);
      } catch (e: any) {
        log('poll failed', { address: a.tron_address, error: e.message });
        await query(`UPDATE deposit_addresses SET next_poll_at = NOW() + interval '1 minute' WHERE id = $1`, [a.id]);
      }
    }
  }

  private async pollAddress(a: any) {
    const startedAt = new Date();
    const watching = a.hot_until && new Date(a.hot_until) > startedAt;
    const since = Math.max(
      new Date(a.created_at).getTime(),
      a.last_polled_at ? new Date(a.last_polled_at).getTime() - RESCAN_OVERLAP_MS : 0,
    );
    const txIds = await this.chain.incomingTxIds(a.tron_address, USDT, since);
    // ponytail: skips a tx once any of its logs is recorded. A crash between two logs of the
    // same multi-transfer tx would skip the second; the daily audit (balance vs records) catches it.
    const known = txIds.length
      ? new Set((await query(`SELECT tx_id FROM deposits WHERE deposit_address_id = $1 AND tx_id = ANY($2)`, [a.id, txIds])).rows.map((r) => r.tx_id))
      : new Set();
    for (const txId of txIds.filter((id) => !known.has(id))) {
      for (const t of await this.chain.solidTransfersTo(txId, USDT, a.tron_address)) {
        await this.record(a.id, t);
      }
    }
    // Outside the watch window the address sleeps until the user opens the deposit screen again.
    await query(
      `UPDATE deposit_addresses SET last_polled_at = $2, next_poll_at = $3 WHERE id = $1`,
      [a.id, startedAt, watching ? new Date(startedAt.getTime() + WATCH_POLL_MS) : 'infinity'],
    );
  }

  /** Admin "Check again": rescans the address's full history now. Returns deposits found. */
  async scanNow(depositAddressId: string) {
    const { rows } = await query(
      `SELECT id, tron_address, created_at, NULL AS last_polled_at, hot_until
         FROM deposit_addresses WHERE id = $1 AND method = 'gasfree'`,
      [depositAddressId],
    );
    if (!rows[0]) throw new Error('Deposit address not found');
    const before = await query(`SELECT COUNT(*)::int AS n FROM deposits WHERE deposit_address_id = $1`, [depositAddressId]);
    await this.pollAddress(rows[0]);
    const after = await query(`SELECT COUNT(*)::int AS n FROM deposits WHERE deposit_address_id = $1`, [depositAddressId]);
    return { newDeposits: after.rows[0].n - before.rows[0].n };
  }

  private async record(depositAddressId: string, t: Awaited<ReturnType<TronChain['solidTransfersTo']>>[number]) {
    const { rows } = await query(
      `SELECT record_deposit($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS r`,
      [`tron_${NETWORK}`, depositAddressId, t.txId, t.logIndex, t.from, t.amountRaw.toString(),
        t.blockNumber, t.blockTs, this.minNetRaw.toString(), this.feeRaw.toString()],
    );
    const r = rows[0].r;
    if (!r.inserted) return;
    if (r.status === 'review') {
      alert('deposit below minimum held for review', { txId: t.txId, amountRaw: t.amountRaw.toString() });
      return;
    }
    log('deposit credited', { txId: t.txId, logIndex: t.logIndex, user: r.user_id, gross: r.gross, fee: r.fee });
    wsService.sendToUser(r.user_id, 'DEPOSIT_CREDITED', { amount: String(r.net), gross: String(r.gross), fee: String(r.fee), txHash: t.txId });
    void wsService.pushDashboardUpdate(r.user_id);
  }

  // ---------- sweeps ----------

  private async processSweeps() {
    const { rows } = await query(
      `SELECT s.*, a.tron_address, a.eoa_address, a.derivation_index
         FROM sweeps s JOIN deposit_addresses a ON a.id = s.deposit_address_id
        WHERE s.status IN ('pending', 'submitted') AND s.next_attempt_at <= NOW()
        ORDER BY s.next_attempt_at LIMIT 10`,
    );
    for (const s of rows) {
      try {
        if (s.status === 'pending') await this.prepareAndSubmit(s);
        else await this.track(s);
      } catch (e: any) {
        log('sweep step failed', { sweep: s.id, status: s.status, error: e.message });
        await query(`UPDATE sweeps SET next_attempt_at = NOW() + interval '1 minute', last_error = $2, updated_at = NOW() WHERE id = $1`, [s.id, e.message]);
      }
    }
  }

  private async setStatus(id: string, fields: Record<string, unknown>, delaySec = 0) {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    await query(
      `UPDATE sweeps SET ${sets}${sets ? ', ' : ''}next_attempt_at = NOW() + make_interval(secs => ${Number(delaySec)}), updated_at = NOW() WHERE id = $1`,
      [id, ...keys.map((k) => fields[k])],
    );
  }

  /** `s.attempts` = submits already made (incremented when a sweep is claimed for submit). */
  private async retryOrFail(s: any, error: string, delaySec: number) {
    if (s.attempts >= MAX_ATTEMPTS) {
      alert('sweep failed permanently', { sweep: s.id, error });
      await this.setStatus(s.id, { status: 'failed', last_error: error });
    } else {
      await this.setStatus(s.id, { status: 'pending', trace_id: null, last_error: error }, delaySec * 2 ** s.attempts);
    }
  }

  private async prepareAndSubmit(s: any) {
    const provider = this.provider!;
    const acct = await this.gasfree.getAccount(s.eoa_address, USDT);
    if (acct.gasFreeAddress !== s.tron_address) {
      alert('provider GasFree address mismatch', { sweep: s.id, stored: s.tron_address, provider: acct.gasFreeAddress });
      return this.setStatus(s.id, { status: 'failed', last_error: 'address_mismatch' });
    }
    if (!acct.allowSubmit) return this.setStatus(s.id, { last_error: 'provider_not_accepting' }, 30);

    const maxFee = acct.transferFee + (acct.active ? 0n : acct.activateFee);
    if (maxFee > this.maxFeeRaw) {
      alert('GasFree fee above cap, funds left in place', { sweep: s.id, maxFee: maxFee.toString(), cap: this.maxFeeRaw.toString() });
      return this.setStatus(s.id, { status: 'failed', last_error: `fee_cap:${maxFee}` });
    }

    const balance = (await this.chain.usdtBalance(USDT, s.tron_address)) - acct.frozen;
    const value = balance - maxFee;
    if (value <= 0n) {
      log('nothing to sweep', { sweep: s.id, balance: balance.toString() });
      return this.setStatus(s.id, { status: 'confirmed', amount_raw: '0', last_error: 'nothing_to_sweep', confirmed_at: new Date() });
    }

    const permit: Permit = {
      token: USDT,
      serviceProvider: provider.address,
      user: s.eoa_address,
      receiver: config.treasuryAddress,
      value,
      maxFee,
      deadline: Math.floor(Date.now() / 1000) + provider.deadlineSec,
      version: 1,
      nonce: acct.nonce,
    };
    const sig = signPermit(NETWORK, permit, derivePrivateKey(loadSeedPhrase(), Number(s.derivation_index), s.eoa_address));
    if (recoverPermitSigner(NETWORK, permit, sig) !== s.eoa_address) throw new Error('signature self-check failed');

    // Persist intent before the network call. Only one caller can win this transition.
    const claimed = await query(
      `UPDATE sweeps SET status = 'submitted', amount_raw = $2, max_fee_raw = $3, nonce = $4, deadline = $5,
              trace_id = NULL, attempts = attempts + 1, submitted_at = NOW(), updated_at = NOW(),
              next_attempt_at = NOW() + interval '10 seconds'
        WHERE id = $1 AND status = 'pending' RETURNING id`,
      [s.id, value.toString(), maxFee.toString(), permit.nonce, permit.deadline],
    );
    if (!claimed.rowCount) return;

    try {
      const res = await this.gasfree.submit(permit, sig);
      await this.setStatus(s.id, { trace_id: res.id, last_response: JSON.stringify(res) }, 10);
      log('sweep submitted', { sweep: s.id, traceId: res.id, value: value.toString(), maxFee: maxFee.toString() });
    } catch (e: any) {
      if (e instanceof GasFreeRejected) {
        // Definite rejection: permit was not accepted, nonce not consumed.
        await this.retryOrFail({ ...s, attempts: s.attempts + 1 }, e.reason, 30);
      } else {
        // Ambiguous (timeout/5xx): stay submitted without trace; track() resolves via nonce.
        log('ambiguous submit', { sweep: s.id, error: e.message });
      }
    }
  }

  private async track(s: any) {
    if (!s.trace_id) {
      const acct = await this.gasfree.getAccount(s.eoa_address, USDT);
      if (acct.nonce > Number(s.nonce)) {
        alert('ambiguous submit consumed nonce; reconcile manually', { sweep: s.id, address: s.tron_address });
        return this.setStatus(s.id, { status: 'failed', last_error: 'ambiguous_submit_nonce_consumed' });
      }
      if (Date.now() / 1000 > Number(s.deadline) + 60) {
        return this.retryOrFail(s, 'ambiguous_submit_expired', 10);
      }
      return this.setStatus(s.id, {}, 15);
    }

    const t = await this.gasfree.getTransfer(s.trace_id);
    if (t.state === 'FAILED' || t.txnState === 'ON_CHAIN_FAILED') {
      return this.retryOrFail(s, `provider_failed:${t.txnState ?? ''}`, 30);
    }
    if (t.state !== 'SUCCEED' || !t.txnHash) return this.setStatus(s.id, { last_response: JSON.stringify(t) }, 10);

    const ok = await this.chain.verifySweep(t.txnHash, USDT, s.tron_address, config.treasuryAddress, BigInt(s.amount_raw));
    if (!ok) return this.setStatus(s.id, { tx_id: t.txnHash, last_error: 'awaiting_solid_receipt' }, 15);

    await this.setStatus(s.id, {
      status: 'confirmed',
      tx_id: t.txnHash,
      actual_fee_raw: t.txnTotalFee != null ? String(t.txnTotalFee) : null,
      confirmed_at: new Date(),
      last_error: null,
      last_response: JSON.stringify(t),
    });
    log('sweep confirmed', { sweep: s.id, txId: t.txnHash, amount: s.amount_raw, fee: t.txnTotalFee });

    // Deposits that landed while this sweep was open could not open a new one.
    const residual = await this.chain.usdtBalance(USDT, s.tron_address);
    if (residual > this.maxFeeRaw) {
      await query(
        `INSERT INTO sweeps (deposit_address_id) VALUES ($1)
         ON CONFLICT (deposit_address_id) WHERE status IN ('pending', 'submitted') DO NOTHING`,
        [s.deposit_address_id],
      );
    } else if (residual > 0n) {
      log('residual dust left at address', { address: s.tron_address, residual: residual.toString() });
    }
  }

  private nextAuditAt = 0;

  /** Runs the audit once a day. The last run time lives in the DB, so restarts do not re-run it. */
  private async dailyAudit() {
    if (Date.now() < this.nextAuditAt) return;
    const { rows } = await query(`SELECT MAX(created_at) AS last FROM audit_reports`);
    const last = rows[0].last ? new Date(rows[0].last).getTime() : 0;
    if (Date.now() - last < AUDIT_EVERY_MS) {
      this.nextAuditAt = last + AUDIT_EVERY_MS;
      return;
    }
    const report = await this.runAudit('daily');
    this.nextAuditAt = Date.now() + AUDIT_EVERY_MS;
    const { rows: live } = await query(
      `SELECT (SELECT COUNT(*) FROM sweeps WHERE status = 'failed') AS failed,
              (SELECT COUNT(*) FROM deposits WHERE status = 'review') AS review`,
    );
    const problems = report.issues.length + Number(live[0].failed) + Number(live[0].review);
    if (problems && config.alertEmail) {
      await sendEmail(
        config.alertEmail,
        `[Royal GCC] ${problems} deposit item(s) need attention`,
        `The daily deposit check found ${problems} item(s) that need attention.\n` +
          `Open the admin panel > Deposits to see what happened and what to do.`,
      ).catch((e) => alert('alert email failed', { error: e.message }));
    }
  }

  /**
   * Compares each deposit address's on-chain USDT balance with what our records
   * say should be there (everything received minus everything swept out, fees included).
   * - more on chain than expected: a deposit we have not recorded yet (e.g. sent while
   *   nobody had the deposit screen open) -> "Check address again" records it.
   * - less on chain than expected with no sweep running: money left by a path we did
   *   not make -> escalate.
   */
  async runAudit(trigger: 'daily' | 'manual') {
    const { rows: addrs } = await query(
      `SELECT a.id, a.user_id, a.tron_address,
              COALESCE((SELECT SUM(d.amount_raw) FROM deposits d WHERE d.deposit_address_id = a.id), 0) AS received,
              COALESCE((SELECT SUM(s.amount_raw + COALESCE(s.actual_fee_raw, s.max_fee_raw, 0)) FROM sweeps s
                         WHERE s.deposit_address_id = a.id AND s.status = 'confirmed' AND s.amount_raw > 0), 0) AS swept,
              EXISTS (SELECT 1 FROM sweeps s WHERE s.deposit_address_id = a.id AND s.status IN ('pending', 'submitted')) AS sweep_open
         FROM deposit_addresses a WHERE a.method = 'gasfree'`,
    );
    const issues: Record<string, unknown>[] = [];
    for (const a of addrs) {
      const onChain = await this.chain.usdtBalance(USDT, a.tron_address);
      const diff = onChain - (BigInt(a.received) - BigInt(a.swept));
      if (diff > 0n) {
        issues.push({ kind: 'unrecorded_funds', depositAddressId: a.id, userId: a.user_id, address: a.tron_address, amount: formatUsdt(diff) });
      } else if (diff < 0n && !a.sweep_open) {
        issues.push({ kind: 'balance_short', depositAddressId: a.id, userId: a.user_id, address: a.tron_address, amount: formatUsdt(-diff) });
      }
    }
    await query(
      `INSERT INTO audit_reports (trigger, addresses_checked, issues) VALUES ($1, $2, $3)`,
      [trigger, addrs.length, JSON.stringify(issues)],
    );
    if (issues.length) alert('audit found issues', { issues });
    else log('audit clean', { addresses: addrs.length });
    return { addressesChecked: addrs.length, issues };
  }
}

export default new GasFreeWorker();
