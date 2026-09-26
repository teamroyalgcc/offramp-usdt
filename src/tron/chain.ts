import { TronWeb } from 'tronweb';

// Minimal TronGrid reads. Credits and sweeps are only ever based on
// solidified (finalized) data from the walletsolidity API.
const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface ChainConfig {
  fullNode: string;
  solidityNode: string;
  apiKey?: string;
}

export interface UsdtTransferLog {
  txId: string;
  logIndex: number;
  from: string;
  to: string;
  amountRaw: bigint;
  blockNumber: number;
  blockTs: Date;
}

const hex20 = (base58: string) => TronWeb.address.toHex(base58).slice(2).toLowerCase();
const fromHex20 = (h: string) => TronWeb.address.fromHex('41' + h.slice(-40));

export class TronChain {
  constructor(private cfg: ChainConfig) {}

  private async req(url: string, body?: unknown): Promise<any> {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(this.cfg.apiKey ? { 'TRON-PRO-API-KEY': this.cfg.apiKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`TronGrid HTTP ${res.status} for ${new URL(url).pathname}`);
    return res.json();
  }

  /** Candidate incoming tx ids for `address` since `minTs` (ms). Unverified hints only. */
  async incomingTxIds(address: string, token: string, minTs: number): Promise<string[]> {
    const ids = new Set<string>();
    let fingerprint: string | undefined;
    do {
      const q = new URLSearchParams({
        only_to: 'true',
        only_confirmed: 'true',
        contract_address: token,
        min_timestamp: String(minTs),
        order_by: 'block_timestamp,asc',
        limit: '200',
      });
      if (fingerprint) q.set('fingerprint', fingerprint);
      const json = await this.req(`${this.cfg.fullNode}/v1/accounts/${address}/transactions/trc20?${q}`);
      if (!json.success) throw new Error('TronGrid trc20 history request failed');
      for (const t of json.data ?? []) ids.add(t.transaction_id);
      fingerprint = json.meta?.fingerprint;
    } while (fingerprint);
    return [...ids];
  }

  /**
   * Finalized USDT Transfer logs inside `txId` that pay `to`. Returns [] if the
   * tx is not yet solidified or failed. This is the source of truth for credits.
   */
  async solidTransfersTo(txId: string, token: string, to: string): Promise<UsdtTransferLog[]> {
    const info = await this.req(`${this.cfg.solidityNode}/walletsolidity/gettransactioninfobyid`, { value: txId });
    if (!info?.id || info.receipt?.result !== 'SUCCESS') return [];
    const tokenHex = hex20(token);
    const toHex = hex20(to);
    const out: UsdtTransferLog[] = [];
    (info.log ?? []).forEach((log: any, i: number) => {
      if (log.address?.toLowerCase().slice(-40) !== tokenHex) return;
      if (log.topics?.[0] !== TRANSFER_TOPIC || log.topics.length !== 3) return;
      if (log.topics[2].slice(-40).toLowerCase() !== toHex) return;
      out.push({
        txId,
        logIndex: i,
        from: fromHex20(log.topics[1]),
        to,
        amountRaw: BigInt('0x' + (log.data || '0')),
        blockNumber: Number(info.blockNumber),
        blockTs: new Date(Number(info.blockTimeStamp)),
      });
    });
    return out;
  }

  private async constantCall(contract: string, selector: string, addressArg: string): Promise<string> {
    const json = await this.req(`${this.cfg.solidityNode}/walletsolidity/triggerconstantcontract`, {
      owner_address: addressArg,
      contract_address: contract,
      function_selector: selector,
      parameter: hex20(addressArg).padStart(64, '0'),
      visible: true,
    });
    const out = json?.constant_result?.[0];
    if (!out || json.result?.result === false) throw new Error(`${selector} call failed`);
    return out;
  }

  /** Finalized USDT balance in micro-USDT. */
  async usdtBalance(token: string, address: string): Promise<bigint> {
    return BigInt('0x' + (await this.constantCall(token, 'balanceOf(address)', address)));
  }

  /** Solidified tx confirmation for a sweep: exact USDT transfer from -> to of amount. */
  async verifySweep(txId: string, token: string, from: string, to: string, amountRaw: bigint): Promise<boolean> {
    const logs = await this.solidTransfersTo(txId, token, to);
    return logs.some((l) => l.from === from && l.amountRaw === amountRaw);
  }

  /** Receipt result of a solidified tx ('SUCCESS', 'OUT_OF_ENERGY', ...), or null if not solid yet. */
  async solidResult(txId: string): Promise<string | null> {
    const info = await this.req(`${this.cfg.solidityNode}/walletsolidity/gettransactioninfobyid`, { value: txId });
    return info?.id ? (info.receipt?.result ?? 'SUCCESS') : null;
  }

  /** Energy a USDT transfer would use right now. `from` must hold at least `amountRaw`. */
  async estimateTransferEnergy(token: string, from: string, to: string, amountRaw: bigint): Promise<number> {
    const json = await this.req(`${this.cfg.fullNode}/wallet/triggerconstantcontract`, {
      owner_address: from,
      contract_address: token,
      function_selector: 'transfer(address,uint256)',
      parameter: hex20(to).padStart(64, '0') + amountRaw.toString(16).padStart(64, '0'),
      visible: true,
    });
    if (!json?.result?.result || json.result.message || !json.energy_used) {
      throw new Error(`energy estimate failed: ${json?.result?.message ?? 'no energy_used'}`);
    }
    return Number(json.energy_used);
  }

  /** Whether the account exists, its spendable energy, bandwidth and TRX (sun). */
  async resources(address: string): Promise<{ exists: boolean; energy: number; bandwidth: number; trxSun: bigint }> {
    const [acct, res] = await Promise.all([
      this.req(`${this.cfg.fullNode}/wallet/getaccount`, { address, visible: true }),
      this.req(`${this.cfg.fullNode}/wallet/getaccountresource`, { address, visible: true }),
    ]);
    return {
      exists: Boolean(acct?.address),
      energy: Math.max(0, Number(res?.EnergyLimit ?? 0) - Number(res?.EnergyUsed ?? 0)),
      bandwidth: Math.max(0, Number(res?.freeNetLimit ?? 0) - Number(res?.freeNetUsed ?? 0))
        + Math.max(0, Number(res?.NetLimit ?? 0) - Number(res?.NetUsed ?? 0)),
      trxSun: BigInt(acct?.balance ?? 0),
    };
  }

  /** Current burn price of one energy unit, in sun. */
  async energyFeeSun(): Promise<number> {
    const json = await this.req(`${this.cfg.fullNode}/wallet/getchainparameters`);
    const p = (json.chainParameter ?? []).find((x: any) => x.key === 'getEnergyFee');
    if (!p) throw new Error('getEnergyFee missing from chain parameters');
    return Number(p.value);
  }

  async broadcast(signedTx: unknown): Promise<void> {
    const json = await this.req(`${this.cfg.fullNode}/wallet/broadcasttransaction`, signedTx);
    if (!json?.result) throw new Error(`broadcast rejected: ${json?.code ?? ''} ${json?.message ? Buffer.from(json.message, 'hex').toString() : ''}`);
  }
}
