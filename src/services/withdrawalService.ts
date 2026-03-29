import supabase from '../utils/supabase.js';
import configService from './configService.js';
import { v4 as uuidv4 } from 'uuid';

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

      // 1. Lock funds using RPC (Atomic operation)
      const { data: lockResult, error: lockError } = await supabase.rpc('lock_funds', {
        p_user_id: userId,
        p_amount: data.usdt_amount,
        p_ref_id: uuidv4(),
        p_description: `USDT Withdrawal to ${data.destination_address}`
      });

      if (lockError) throw lockError;
      if (!lockResult.success) throw new Error(lockResult.message);

      // 2. Create withdrawal record
      const { data: withdrawal, error: createError } = await supabase
        .from('usdt_withdrawals')
        .insert({
          user_id: userId,
          destination_address: data.destination_address,
          usdt_amount: data.usdt_amount,
          fee: fee,
          net_amount: netAmount,
          status: 'pending'
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

  async processWithdrawal(id: string, txHash: string) {
    const { data: withdrawal, error: fetchError } = await supabase
      .from('usdt_withdrawals')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !withdrawal) throw new Error('Withdrawal not found');

    const { error: updateError } = await supabase
      .from('usdt_withdrawals')
      .update({
        status: 'completed',
        tx_hash: txHash,
        updated_at: new Date().toISOString()
      })
      .eq('id', id);

    if (updateError) throw updateError;

    // Finalize in ledger
    await supabase.rpc('finalize_withdrawal', {
      p_user_id: withdrawal.user_id,
      p_amount: withdrawal.usdt_amount,
      p_withdrawal_id: id
    });

    return true;
  }

  async rejectWithdrawal(id: string, reason: string) {
    const { data: withdrawal, error: fetchError } = await supabase
      .from('usdt_withdrawals')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !withdrawal) throw new Error('Withdrawal not found');

    const { error: updateError } = await supabase
      .from('usdt_withdrawals')
      .update({
        status: 'failed',
        failure_reason: reason,
        updated_at: new Date().toISOString()
      })
      .eq('id', id);

    if (updateError) throw updateError;

    // Refund in ledger
    await supabase.rpc('fail_withdrawal', {
      p_user_id: withdrawal.user_id,
      p_amount: withdrawal.usdt_amount,
      p_withdrawal_id: id
    });

    return true;
  }
}

export default new WithdrawalService();
