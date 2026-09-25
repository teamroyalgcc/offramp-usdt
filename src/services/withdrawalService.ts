import supabase from '../utils/supabase.js';
import configService from './configService.js';
import { v4 as uuidv4 } from 'uuid';
import config from '../config/index.js';
import { TronChain } from '../tron/chain.js';
import { parseUsdt } from '../tron/usdt.js';

const chain = new TronChain({
  fullNode: config.tron.fullNode,
  solidityNode: config.tron.solidityNode,
  apiKey: config.tron.proApiKey,
});

/** Moves a pending withdrawal to a final status exactly once; returns the row or throws. */
async function closeWithdrawal(id: string, fields: Record<string, unknown>) {
  const { data, error } = await supabase
    .from('usdt_withdrawals')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', id)
    .in('status', ['pending', 'processing'])
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Withdrawal not found or already completed/rejected');
  return data;
}

export class WithdrawalService {
  async requestUSDTWithdrawal(userId: string, data: {
    destination_address: string;
    usdt_amount: number;
  }) {
    try {
      if (!configService.get('withdrawals_enabled')) {
        throw new Error('Withdrawals are currently paused');
      }

      const minWithdrawal = configService.get('min_usdt_withdrawal') || 20;
      if (data.usdt_amount < minWithdrawal) {
        throw new Error(`Minimum withdrawal amount is ${minWithdrawal} USDT`);
      }

      const fee = configService.get('usdt_withdrawal_fee') || 5;
      const netAmount = data.usdt_amount - fee;

      if (netAmount <= 0) {
        throw new Error('Withdrawal amount too low after fees');
      }

      const withdrawalId = uuidv4();
      
      // 1. Lock funds using RPC (Atomic operation)
      const { data: lockResult, error: lockError } = await supabase.rpc('lock_funds', {
        p_user_id: userId,
        p_amount: data.usdt_amount,
        p_ref_id: withdrawalId,
        p_description: `USDT Withdrawal to ${data.destination_address}`
      });

      if (lockError) throw lockError;
      if (!lockResult.success) throw new Error(lockResult.message);

      // 2. Create withdrawal record
      const { data: withdrawal, error: createError } = await supabase
        .from('usdt_withdrawals')
        .insert({
          id: withdrawalId,
          user_id: userId,
          destination_address: data.destination_address,
          usdt_amount: data.usdt_amount,
          fee: fee,
          net_amount: netAmount,
          status: 'pending',
          idempotency_key: `WD_${userId}_${Date.now()}` // for client retries
        })
        .select()
        .single();

      if (createError) {
        // Refund if record creation fails
        await supabase.rpc('fail_withdrawal', {
          p_user_id: userId,
          p_amount: data.usdt_amount,
          p_withdrawal_id: uuidv4() // placeholder
        });
        throw createError;
      }

      return withdrawal;
    } catch (error: any) {
      console.error('[WITHDRAWAL_SERVICE] Request failed:', error.message);
      throw error;
    }
  }

  async getWithdrawalHistory(userId: string) {
    const { data, error } = await supabase
      .from('usdt_withdrawals')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
  }

  // Admin APIs
  async listAllWithdrawals() {
    const { data, error } = await supabase
      .from('usdt_withdrawals')
      .select('*, user:users(phone_number, account_holder_name)')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
  }

  /**
   * Admin sent the USDT by hand from the treasury wallet. We only accept the tx hash
   * if it is final on-chain and pays exactly net_amount USDT to the user's address.
   */
  async processWithdrawal(id: string, txHash: string) {
    const { data: w, error } = await supabase.from('usdt_withdrawals').select('*').eq('id', id).single();
    if (error || !w) throw new Error('Withdrawal not found');
    if (!['pending', 'processing'].includes(w.status)) throw new Error(`Withdrawal is already ${w.status}`);

    const hash = txHash.trim().replace(/^0x/, '');
    const { count } = await supabase.from('usdt_withdrawals').select('id', { count: 'exact', head: true }).eq('tx_hash', hash);
    if (count) throw new Error('This transaction hash is already used for another withdrawal');

    const expected = parseUsdt(String(w.net_amount));
    const logs = await chain.solidTransfersTo(hash, config.tron.usdtContract, w.destination_address);
    const paid = logs.reduce((sum, l) => sum + l.amountRaw, 0n);
    if (!logs.length) {
      throw new Error('Transaction not found, not final yet, or not a USDT payment to the user\'s address. Wait a minute and try again.');
    }
    if (paid !== expected) {
      throw new Error(`Transaction pays ${Number(paid) / 1e6} USDT but this withdrawal needs exactly ${w.net_amount} USDT.`);
    }

    await closeWithdrawal(id, { status: 'completed', tx_hash: hash });
    await supabase.rpc('finalize_withdrawal', {
      p_user_id: w.user_id,
      p_amount: w.usdt_amount,
      p_withdrawal_id: id
    });
    return true;
  }

  async rejectWithdrawal(id: string, reason: string) {
    const w = await closeWithdrawal(id, { status: 'failed', failure_reason: reason });
    // Refund in ledger
    await supabase.rpc('fail_withdrawal', {
      p_user_id: w.user_id,
      p_amount: w.usdt_amount,
      p_withdrawal_id: id
    });
    return true;
  }
}

export default new WithdrawalService();
