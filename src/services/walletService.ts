import config from '../config/index.js';
import supabase from '../utils/supabase.js';
import { deriveAddressFromXpub } from '../tron/hd.js';
import { TronChain } from '../tron/chain.js';
import { GASFREE_NETWORKS } from '../tron/gasfree.js';
import { loadAccountXpub } from '../tron/seed.js';
import { formatUsdt, parseUsdt } from '../tron/usdt.js';
import gasfreeWorker from '../workers/gasfreeWorker.js';

const chain = new TronChain({
  fullNode: config.tron.fullNode,
  solidityNode: config.tron.solidityNode,
  apiKey: config.tron.proApiKey,
});

// How long the worker keeps checking an address after the user opens the deposit
// screen. Outside this window nothing is polled; the next open rescans everything
// since the last check, so late transfers are still found.
export const WATCH_WINDOW_MS = 60 * 60 * 1000;

const STATEMENT_LABELS: Record<string, string> = {
  deposit: 'Deposit',
  deposit_fee: 'Processing fee',
  exchange_lock: 'Sell order (locked)',
  exchange_refund: 'Sell order refunded',
  withdrawal_lock: 'Withdrawal (locked)',
  withdrawal_refund: 'Withdrawal refunded',
};

export class WalletService {
  private static instance: WalletService;

  private constructor() {}

  public static getInstance(): WalletService {
    if (!WalletService.instance) {
      WalletService.instance = new WalletService();
    }
    return WalletService.instance;
  }

  /**
   * The user's permanent GasFree deposit address. Every call returns the same
   * address and (re)starts the watch window so the worker checks it every 15s.
   */
  async generateDepositAddress(userId: string) {
    const watchUntil = new Date(Date.now() + WATCH_WINDOW_MS).toISOString();
    const now = new Date().toISOString();

    const find = () => supabase
      .from('deposit_addresses')
      .select('id, tron_address, eoa_address')
      .eq('user_id', userId)
      .eq('network', 'tron')
      .eq('method', 'gasfree')
      .maybeSingle();

    let { data: row, error } = await find();
    if (error) throw error;

    if (row) {
      const { error: upErr } = await supabase
        .from('deposit_addresses')
        .update({ hot_until: watchUntil, next_poll_at: now })
        .eq('id', row.id);
      if (upErr) throw upErr;
    } else {
      const { data: idx, error: idxErr } = await supabase.rpc('next_derivation_index');
      if (idxErr) throw idxErr;
      const index = Number(idx);
      const eoa = deriveAddressFromXpub(loadAccountXpub(), index);
      // Resolved on-chain from the pinned controller, not from the provider API.
      const gasFreeAddress = await chain.gasFreeAddressOf(GASFREE_NETWORKS[config.tron.network].controller, eoa);

      const { data: inserted, error: insErr } = await supabase
        .from('deposit_addresses')
        .insert({
          user_id: userId,
          network: 'tron',
          method: 'gasfree',
          derivation_index: index,
          eoa_address: eoa,
          tron_address: gasFreeAddress,
          is_used: true,
          hot_until: watchUntil,
          next_poll_at: now,
        })
        .select('id, tron_address, eoa_address')
        .single();

      if (insErr?.code === '23505') {
        // Concurrent request for the same user won; the burnt index is harmless.
        ({ data: row, error } = await find());
        if (error || !row) throw error ?? new Error('Deposit address race');
      } else if (insErr) {
        throw insErr;
      } else {
        row = inserted;
      }
    }

    // Live quote: what the next deposit to this address will be charged.
    const fee = await gasfreeWorker.depositFeeRaw(row!.eoa_address);
    const minNet = parseUsdt(config.gasfree.minNetUsdt);
    return {
      depositAddressId: row!.id,
      network: 'tron',
      token: 'USDT-TRC20',
      address: row!.tron_address,
      processingFee: formatUsdt(fee),
      minimumDeposit: formatUsdt(minNet + fee),
      watchingUntil: watchUntil,
    };
  }

  // Every change to the available balance, newest first. Cursor = (before, beforeId) of the last row seen;
  // the id breaks ties because a deposit and its fee share one created_at.
  async getStatement(userId: string, limit = 50, before?: string, beforeId?: string) {
    let q = supabase
      .from('ledger_entries')
      .select('id, type, amount, direction, balance_after, reference_id, created_at')
      .eq('user_id', userId)
      .eq('balance_type', 'available')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 100));
    if (before && beforeId) q = q.or(`created_at.lt.${before},and(created_at.eq.${before},id.lt.${beforeId})`);
    else if (before) q = q.lt('created_at', before);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []).map((e: any) => ({
      id: e.id,
      type: e.type,
      label: STATEMENT_LABELS[e.type] ?? e.type,
      amount: (e.direction === 'credit' ? '' : '-') + e.amount,
      balance_after: e.balance_after,
      reference: e.reference_id,
      created_at: e.created_at,
    }));
  }

  async listDeposits(userId: string) {
    const { data, error } = await supabase
      .from('deposits')
      .select('id, tx_id, amount_raw, fee_raw, status, block_ts')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    return (data ?? []).map((d: any) => {
      const gross = BigInt(String(d.amount_raw));
      const fee = d.status === 'credited' ? BigInt(String(d.fee_raw)) : 0n;
      return {
        id: d.id,
        txId: d.tx_id,
        amount: formatUsdt(gross),
        processingFee: formatUsdt(fee),
        credited: d.status === 'credited' ? formatUsdt(gross - fee) : '0',
        status: d.status === 'credited' ? 'credited' : 'under_review',
        receivedAt: d.block_ts,
      };
    });
  }

  async getBalance(userId: string) {
    const { data, error } = await supabase
      .from('ledger_accounts')
      .select('available_balance, locked_balance')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    return {
      available_balance: Number(data?.available_balance ?? 0),
      locked_balance: Number(data?.locked_balance ?? 0),
    };
  }
}

export default WalletService.getInstance();
