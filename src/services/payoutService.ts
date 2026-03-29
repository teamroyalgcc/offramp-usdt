import supabase from '../utils/supabase.js';
import configService from './configService.js';

export class PayoutService {
  async requestPayout(userId: string, data: {
    bank_account_id: string;
    usdt_amount: number;
    exchange_rate: number;
  }) {
    try {
      if (!configService.get('exchanges_enabled')) {
        throw new Error('Payouts (offramps) are currently paused');
      }

      const inrAmount = Number((data.usdt_amount * data.exchange_rate).toFixed(2));
      const feePercent = configService.get('exchange_spread_percent') || 1;
      const feeUsdt = Number((data.usdt_amount * (feePercent / 100)).toFixed(6));
      const netUsdt = data.usdt_amount - feeUsdt;

      if (netUsdt <= 0) {
        throw new Error('Payout amount too low after fees');
      }

      // 1. Lock funds using RPC
      const { data: lockResult, error: lockError } = await supabase.rpc('lock_funds', {
        p_user_id: userId,
        p_amount: data.usdt_amount,
        p_ref_id: `PO-${Date.now()}`,
        p_description: `INR Payout Request: ${inrAmount} INR`
      });

      if (lockError) throw lockError;
      if (!lockResult.success) throw new Error(lockResult.message);

      // 2. Create payout order record
      const { data: payout, error: createError } = await supabase
        .from('payout_orders')
        .insert({
          user_id: userId,
          bank_account_id: data.bank_account_id,
          usdt_amount: data.usdt_amount,
          exchange_rate: data.exchange_rate,
          inr_amount: inrAmount,
          fee_usdt: feeUsdt,
          net_usdt: netUsdt,
          status: 'pending'
        })
        .select()
        .single();

      if (createError) {
        // Refund if record creation fails
        await supabase.rpc('fail_withdrawal', {
          p_user_id: userId,
          p_amount: data.usdt_amount,
          p_withdrawal_id: `ERR-${Date.now()}` // placeholder
        });
        throw createError;
      }

      return payout;
    } catch (error: any) {
      console.error('[PAYOUT_SERVICE] Request failed:', error.message);
      throw error;
    }
  }

  async getMyPayouts(userId: string) {
    const { data, error } = await supabase
      .from('payout_orders')
      .select('*, bank_accounts(*)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
  }

  // Admin APIs
  async listAllPayouts() {
    const { data, error } = await supabase
      .from('payout_orders')
      .select('*, user:users(phone_number, account_holder_name), bank_accounts(*)')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
  }

  async processPayout(id: string, bankRef: string) {
    const { data: payout, error: fetchError } = await supabase
      .from('payout_orders')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !payout) throw new Error('Payout order not found');

    const { error: updateError } = await supabase
      .from('payout_orders')
      .update({
        status: 'completed',
        payout_tx_id: bankRef,
        processed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', id);

    if (updateError) throw updateError;

    // Finalize in ledger
    await supabase.rpc('finalize_withdrawal', {
      p_user_id: payout.user_id,
      p_amount: payout.usdt_amount,
      p_withdrawal_id: id
    });

    return true;
  }

  async rejectPayout(id: string, reason: string) {
    const { data: payout, error: fetchError } = await supabase
      .from('payout_orders')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !payout) throw new Error('Payout order not found');

    const { error: updateError } = await supabase
      .from('payout_orders')
      .update({
        status: 'rejected',
        failure_reason: reason,
        updated_at: new Date().toISOString()
      })
      .eq('id', id);

    if (updateError) throw updateError;

    // Refund in ledger
    await supabase.rpc('fail_withdrawal', {
      p_user_id: payout.user_id,
      p_amount: payout.usdt_amount,
      p_withdrawal_id: id
    });

    return true;
  }
}

export default new PayoutService();
