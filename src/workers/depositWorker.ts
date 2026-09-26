import { TronWeb } from 'tronweb';
import config from '../config/index.js';
import { query } from '../utils/db.js';
import { TronChain } from '../tron/chain.js';
import { burnSunNeeded, currentEgressIp, energyToRent, nettsBalanceTrx, nettsIdempotencyKey, nettsRent5m, sunToTrx, sweepDueAt, tronNrgRent, tronNrgTrx } from '../tron/energy.js';
import { derivePrivateKey } from '../tron/hd.js';
import { loadSeedPhrase } from '../tron/seed.js';
import { formatUsdt, parseUsdt } from '../tron/usdt.js';
import wsService from '../services/wsService.js';
import { sendEmail } from '../utils/email.js';

// Detect finalized USDT deposits to per-user HD addresses, credit them atomically
// (record_deposit, no fee), and sweep them to the treasury. The sweep's energy is
// rented from Netts, else TronNRG, else bought by burning TRX sent from the operating wallet.
// Only addresses inside their watch window (user opened the deposit screen) are
// polled. Only the pinned USDT contract counts; other tokens and TRX are ignored.
//
// Sweep states: pending (wait until due, get energy) -> submitted (tx id saved
// before broadcast) -> confirmed, or failed (needs a human). Sweeps only ever send
// to the treasury, which is pinned in the DB on first start. A duplicate transfer
// is harmless (it can only move the remaining balance to the treasury); the worst
// a bug can do is waste energy, which the per-sweep cost cap bounds.
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
const RENTAL_SETTLE_MS = 60_000; // after renting/sending TRX, wait this long for it to show before trying again
const TX_EXPIRY_MS = 5 * 60_000; // a broadcast tx not solid after this is treated as dropped
const AUDIT_EVERY_MS = 24 * 60 * 60_000;
const SUN = 1_000_000n;
const TRANSFER_BANDWIDTH = 400;

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), svc: 'deposit-worker', msg, ...extra }));
const alert = (msg: string, extra: Record<string, unknown> = {}) =>
  console.error(JSON.stringify({ at: new Date().toISOString(), svc: 'deposit-worker', level: 'ALERT', msg, ...extra }));

export class DepositWorker {
  private chain = new TronChain({
    fullNode: config.tron.fullNode,
    solidityNode: config.tron.solidityNode,
    apiKey: config.tron.proApiKey,
  });
  private tronWeb = new TronWeb({
    fullHost: config.tron.fullNode,
    headers: config.tron.proApiKey ? { 'TRON-PRO-API-KEY': config.tron.proApiKey } : {},
  });
  private running = false;
  private minRaw = parseUsdt(config.sweep.minDepositUsdt);
  private immediateRaw = parseUsdt(config.sweep.immediateUsdt);
  private capSun = BigInt(Math.round(config.sweep.maxCostTrx * 1e6));

  async start() {
    const treasury = config.treasuryAddress;
    if (!TronWeb.isAddress(treasury)) throw new Error('TREASURY_ADDRESS is missing or not a TRON address');
    loadSeedPhrase(); // throws if HD_MNEMONIC is missing or invalid

    // Refuse to run if the phrase was swapped after addresses were issued:
    // new addresses would come from a different wallet and old funds could not be swept.
    const { rows } = await query(`SELECT derivation_index, eoa_address FROM deposit_addresses ORDER BY derivation_index LIMIT 1`);
    if (rows[0]) {
      try {
        derivePrivateKey(loadSeedPhrase(), Number(rows[0].derivation_index), rows[0].eoa_address);
      } catch {
        throw new Error('HD_MNEMONIC does not match the existing deposit addresses. Restore the original phrase.');
      }
    }

    // Pin the treasury on first start. A changed TREASURY_ADDRESS (typo, tampering) stops the
    // server instead of silently redirecting sweeps. To really change it, update
    // system_settings.pinned_treasury_address by hand as well.
    const pin = await query(
      `UPDATE system_settings SET pinned_treasury_address = COALESCE(pinned_treasury_address, $1) WHERE id = 1
       RETURNING pinned_treasury_address`,
      [treasury],
    );
    const pinned = pin.rows[0]?.pinned_treasury_address;
    if (pinned !== treasury) {
      throw new Error(`TREASURY_ADDRESS ${treasury} differs from the pinned treasury ${pinned}. Fix the env var, or change the pin in the DB on purpose.`);
    }

    if (!config.sweep.nettsApiKey && !config.sweep.operatingKey) {
      alert('neither NETTS_API_KEY nor OPERATING_WALLET_PRIVATE_KEY is set: deposits are credited but cannot be swept');
    }
    // Re-check deferred sweeps now, so a changed SWEEP_IMMEDIATE_USDT applies at once.
    await query(`UPDATE sweeps SET next_attempt_at = NOW() WHERE status = 'pending'`);
    log('started', { network: NETWORK, token: USDT, treasury, netts: Boolean(config.sweep.nettsApiKey), operatingWallet: this.operatingAddress() });
    // Render leaves from a shared range; log the actual IP so it can be whitelisted in Netts.
    if (config.sweep.nettsApiKey) {
      const egress = await currentEgressIp().catch((e) => `unknown (${e.message})`);
      nettsBalanceTrx(config.sweep.nettsApiKey)
        .then((balanceTrx) => log('netts ok', { egress, balanceTrx }))
        .catch((e) => log('netts FAILED: whitelist this egress IP in Netts', { egress, error: e.message.slice(0, 200) }));
    }
    this.running = true;
    void this.loop();
  }

  stop() {
    this.running = false;
  }

  private operatingAddress() {
    return config.sweep.operatingKey ? TronWeb.address.fromPrivateKey(config.sweep.operatingKey.replace(/^0x/, '')) || null : null;
  }

  private async loop() {
    while (this.running) {
      try {
        await this.pollDueAddresses();
        await this.processSweeps();
        await this.dailyAudit();
      } catch (e: any) {
        alert('tick failed', { error: e.message });
      }
      await new Promise((r) => setTimeout(r, TICK_MS));
    }
  }

  // ---------- detection + credit ----------

  private async pollDueAddresses() {
    const { rows } = await query(
      `SELECT id, tron_address, created_at, last_polled_at, hot_until
         FROM deposit_addresses
        WHERE network = 'tron' AND next_poll_at <= NOW()
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
      `SELECT id, tron_address, created_at, NULL AS last_polled_at, hot_until FROM deposit_addresses WHERE id = $1`,
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
      `SELECT record_deposit($1, $2, $3, $4, $5, $6, $7, $8, $9) AS r`,
      [`tron_${NETWORK}`, depositAddressId, t.txId, t.logIndex, t.from, t.amountRaw.toString(),
        t.blockNumber, t.blockTs, this.minRaw.toString()],
    );
    const r = rows[0].r;
    if (!r.inserted) return;
    if (r.status === 'review') {
      alert('deposit below minimum held for review', { txId: t.txId, amountRaw: t.amountRaw.toString() });
      return;
    }
    log('deposit credited', { txId: t.txId, logIndex: t.logIndex, user: r.user_id, amount: r.amount });
    wsService.sendToUser(r.user_id, 'DEPOSIT_CREDITED', { amount: String(r.amount), gross: String(r.amount), fee: '0', txHash: t.txId });
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
        if (s.status === 'pending') await this.advance(s);
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

  /** Counts one attempt; after MAX_ATTEMPTS the sweep is failed and needs an admin Retry. */
  private async retryOrFail(s: any, error: string, delaySec: number) {
    const attempts = s.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      alert('sweep failed permanently', { sweep: s.id, error });
      await this.setStatus(s.id, { status: 'failed', attempts, tx_id: null, last_error: error });
    } else {
      await this.setStatus(s.id, { status: 'pending', attempts, tx_id: null, last_error: error }, delaySec * 2 ** attempts);
    }
  }

  /** pending: wait until due, make sure the address has energy (rent or burn), then sign and broadcast. */
  private async advance(s: any) {
    const addr = s.tron_address;
    const treasury = config.treasuryAddress;
    const balance = await this.chain.usdtBalance(USDT, addr);
    if (balance === 0n) {
      return this.setStatus(s.id, { status: 'confirmed', amount_raw: '0', last_error: 'nothing_to_sweep', confirmed_at: new Date() });
    }
    const due = sweepDueAt(balance, this.immediateRaw, new Date(s.created_at));
    if (due.getTime() > Date.now()) return this.setStatus(s.id, {}, Math.ceil((due.getTime() - Date.now()) / 1000));

    const estimate = await this.chain.estimateTransferEnergy(USDT, addr, treasury, balance);
    const res = await this.chain.resources(addr);
    // A USDT transfer needs ~350 bandwidth: the free 600/day covers one sweep, after that it costs ~0.35 TRX.
    const bandwidthOk = res.bandwidth >= TRANSFER_BANDWIDTH || res.trxSun >= SUN / 2n;
    if (res.energy >= estimate && bandwidthOk) return this.submit(s, balance, SUN);
    const burnSun = burnSunNeeded(estimate, res.energy, await this.chain.energyFeeSun());
    if (res.exists && res.trxSun >= burnSun) return this.submit(s, balance, burnSun);

    // Energy or TRX was just bought: give it time to show up before paying again.
    if (s.rented_at && Date.now() - new Date(s.rented_at).getTime() < RENTAL_SETTLE_MS) return this.setStatus(s.id, {}, 5);

    let spentSun = BigInt(Math.round(Number(s.cost_trx) * 1e6));
    if (spentSun >= this.capSun) return this.failCost(s, spentSun);
    if (s.attempts >= MAX_ATTEMPTS) return this.retryOrFail(s, s.last_error ?? 'too_many_attempts', 0);
    const claimed = await query(
      `UPDATE sweeps SET attempts = attempts + 1, updated_at = NOW() WHERE id = $1 AND status = 'pending' AND attempts = $2 RETURNING id`,
      [s.id, s.attempts],
    );
    if (!claimed.rowCount) return;

    const opKey = config.sweep.operatingKey.replace(/^0x/, '');
    const bought = (provider: string, costSun: bigint, orderId: string | null = null) => {
      log('energy bought', { sweep: s.id, provider, costTrx: sunToTrx(costSun), orderId });
      return this.setStatus(s.id, { provider, order_id: orderId, cost_trx: sunToTrx(spentSun + costSun), rented_at: new Date(), last_error: null }, 3);
    };
    const errors: string[] = [];

    // 1. Netts. Only rents energy; if just bandwidth is missing, skip to burn.
    if (config.sweep.nettsApiKey && res.energy < estimate) {
      const need = energyToRent(estimate);
      try {
        const o = await nettsRent5m(config.sweep.nettsApiKey, addr, need, nettsIdempotencyKey(s.id, s.attempts));
        const costSun = BigInt(Math.round(o.paidTrx * 1e6));
        if (spentSun + costSun > this.capSun) alert('Netts rental pushed sweep over the cost cap', { sweep: s.id, costTrx: sunToTrx(spentSun + costSun) });
        return bought('netts', costSun, o.orderId);
      } catch (e: any) {
        errors.push(e.message);
        log('Netts rental failed, trying next provider', { sweep: s.id, error: e.message });
      }
    }

    if (opKey) {
      // TronNRG and burn both need an activated address. Sending TRX activates it
      // (the operating wallet pays ~1.1 TRX once); the next tick continues from here.
      if (!res.exists) {
        try {
          const r: any = await this.tronWeb.trx.sendTransaction(addr, 100_000, { privateKey: opKey });
          if (!r?.result) throw new Error(`activation rejected: ${r?.code ?? ''}`);
          return bought('activate', 1_200_000n, r.txid);
        } catch (e: any) {
          errors.push(e.message);
        }
      } else {
        // 2. TronNRG: pay from the operating wallet, claim the delegation.
        if (res.energy < estimate) {
          const trx = tronNrgTrx(estimate);
          const costSun = BigInt(trx) * SUN;
          if (spentSun + costSun > this.capSun) return this.failCost(s, spentSun + costSun);
          try {
            const o = await tronNrgRent(this.tronWeb, opKey, addr, trx);
            return bought('tronnrg', costSun, o.orderId);
          } catch (e: any) {
            errors.push(e.message);
            if (e.paidTxId) {
              // TRX left the wallet but no energy arrived: count it, keep the payment hash for follow-up.
              spentSun += costSun;
              alert('TronNRG paid but delegation not confirmed', { sweep: s.id, paymentTx: e.paidTxId, error: e.message });
              await this.setStatus(s.id, { cost_trx: sunToTrx(spentSun), order_id: e.paidTxId }, 0);
            }
            log('TronNRG failed, trying burn', { sweep: s.id, error: e.message });
          }
        }

        // 3. Burn: send the deposit address enough TRX to pay for its own energy.
        const sendSun = burnSun - res.trxSun;
        if (spentSun + sendSun > this.capSun) return this.failCost(s, spentSun + sendSun);
        try {
          const r: any = await this.tronWeb.trx.sendTransaction(addr, Number(sendSun), { privateKey: opKey });
          if (!r?.result) throw new Error(`TRX send rejected: ${r?.code ?? ''}`);
          return bought('burn', sendSun, r.txid);
        } catch (e: any) {
          errors.push(e.message);
        }
      }
    }

    const error = `no_energy:${errors.join(' | ') || 'no provider configured'}`.slice(0, 500);
    // attempts was already counted by the claim above.
    if (s.attempts + 1 >= MAX_ATTEMPTS) {
      alert('sweep failed permanently', { sweep: s.id, error });
      return this.setStatus(s.id, { status: 'failed', last_error: error });
    }
    return this.setStatus(s.id, { last_error: error }, 60 * 2 ** s.attempts);
  }

  private async failCost(s: any, costSun: bigint) {
    alert('sweep cost above cap, funds left in place', { sweep: s.id, costTrx: sunToTrx(costSun), capTrx: config.sweep.maxCostTrx });
    return this.setStatus(s.id, { status: 'failed', last_error: `cost_cap:${sunToTrx(costSun)}` });
  }

  private async submit(s: any, amount: bigint, feeLimitSun: bigint) {
    const feeLimit = Number(feeLimitSun < this.capSun ? feeLimitSun : this.capSun);
    const { transaction } = await this.tronWeb.transactionBuilder.triggerSmartContract(
      USDT, 'transfer(address,uint256)', { feeLimit },
      [{ type: 'address', value: config.treasuryAddress }, { type: 'uint256', value: amount.toString() }],
      s.tron_address,
    );
    const key = derivePrivateKey(loadSeedPhrase(), Number(s.derivation_index), s.eoa_address);
    const signed = await this.tronWeb.trx.sign(transaction, key);

    // Save the tx id before broadcasting; track() resolves it either way. Only one caller wins.
    const claimed = await query(
      `UPDATE sweeps SET status = 'submitted', amount_raw = $2, tx_id = $3, submitted_at = NOW(), updated_at = NOW(),
              next_attempt_at = NOW() + interval '10 seconds'
        WHERE id = $1 AND status = 'pending' RETURNING id`,
      [s.id, amount.toString(), signed.txID],
    );
    if (!claimed.rowCount) return;
    try {
      await this.chain.broadcast(signed);
      log('sweep broadcast', { sweep: s.id, txId: signed.txID, amount: amount.toString(), feeLimit });
    } catch (e: any) {
      // May or may not be on chain (timeout). track() waits for it, then retries after TX_EXPIRY_MS.
      log('broadcast failed or unclear', { sweep: s.id, txId: signed.txID, error: e.message });
    }
  }

  private async track(s: any) {
    const result = await this.chain.solidResult(s.tx_id);
    if (result === null) {
      if (Date.now() - new Date(s.submitted_at).getTime() > TX_EXPIRY_MS) return this.retryOrFail(s, 'tx_not_confirmed', 10);
      return this.setStatus(s.id, {}, 10);
    }
    if (result !== 'SUCCESS') return this.retryOrFail(s, `tx_failed:${result}`, 30);

    if (!(await this.chain.verifySweep(s.tx_id, USDT, s.tron_address, config.treasuryAddress, BigInt(s.amount_raw)))) {
      alert('sweep tx succeeded but did not move the expected amount to the treasury', { sweep: s.id, txId: s.tx_id });
      return this.setStatus(s.id, { status: 'failed', last_error: 'unexpected_receipt' });
    }
    await this.setStatus(s.id, { status: 'confirmed', confirmed_at: new Date(), last_error: null });
    log('sweep confirmed', { sweep: s.id, txId: s.tx_id, amount: s.amount_raw, provider: s.provider, costTrx: s.cost_trx });

    // Deposits that landed while this sweep was open could not open a new one.
    if ((await this.chain.usdtBalance(USDT, s.tron_address)) > 0n) {
      await query(
        `INSERT INTO sweeps (deposit_address_id) VALUES ($1)
         ON CONFLICT (deposit_address_id) WHERE status IN ('pending', 'submitted') DO NOTHING`,
        [s.deposit_address_id],
      );
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
    const lowFunds = await this.lowFundsWarnings();
    const problems = report.issues.length + Number(live[0].failed) + Number(live[0].review) + lowFunds.length;
    if (problems && config.alertEmail) {
      await sendEmail(
        config.alertEmail,
        `[Royal GCC] ${problems} deposit item(s) need attention`,
        `The daily deposit check found ${problems} item(s) that need attention.\n` +
          lowFunds.map((w) => `- ${w}\n`).join('') +
          `Open the admin panel > Deposits to see what happened and what to do.`,
      ).catch((e) => alert('alert email failed', { error: e.message }));
    }
  }

  /** Top-up reminders for the two things that pay for sweeps. */
  async lowFundsWarnings(): Promise<string[]> {
    const out: string[] = [];
    const op = this.operatingAddress();
    if (op) {
      const trx = sunToTrx((await this.chain.resources(op)).trxSun);
      if (trx < config.sweep.operatingMinTrx) out.push(`Operating wallet ${op} has ${trx} TRX. Top it up.`);
    }
    if (config.sweep.nettsApiKey) {
      try {
        const bal = await nettsBalanceTrx(config.sweep.nettsApiKey);
        if (!(bal >= 20)) out.push(`Netts balance is ${bal} TRX. Top it up at netts.io.`);
      } catch (e: any) {
        const ip = await currentEgressIp().catch(() => 'unknown');
        out.push(`Could not read the Netts balance (${e.message.slice(0, 100)}). If the IP is not whitelisted, add ${ip} in Netts > API > IP Whitelist.`);
      }
    }
    return out;
  }

  /**
   * Compares each deposit address's on-chain USDT balance with what our records
   * say should be there (everything received minus everything swept out).
   * - more on chain than expected: a deposit we have not recorded yet (e.g. sent while
   *   nobody had the deposit screen open) -> "Check address again" records it.
   * - less on chain than expected with no sweep running: money left by a path we did
   *   not make -> escalate.
   */
  async runAudit(trigger: 'daily' | 'manual') {
    const { rows: addrs } = await query(
      `SELECT a.id, a.user_id, a.tron_address,
              COALESCE((SELECT SUM(d.amount_raw) FROM deposits d WHERE d.deposit_address_id = a.id), 0) AS received,
              COALESCE((SELECT SUM(s.amount_raw) FROM sweeps s
                         WHERE s.deposit_address_id = a.id AND s.status = 'confirmed'), 0) AS swept,
              EXISTS (SELECT 1 FROM sweeps s WHERE s.deposit_address_id = a.id AND s.status IN ('pending', 'submitted')) AS sweep_open
         FROM deposit_addresses a`,
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

export default new DepositWorker();
