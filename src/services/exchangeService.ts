import supabase from '../utils/supabase.js';
import configService from './configService.js';
import { formatUsdt, parseUsdt } from '../tron/usdt.js';

import { userRate } from './rate.js';

export class ExchangeService {
  private static instance: ExchangeService;

  private constructor() {}

  public static getInstance(): ExchangeService {
    if (!ExchangeService.instance) {
      ExchangeService.instance = new ExchangeService();
    }
    return ExchangeService.instance;
  }

  /** Everything the app and the admin Rates page show. rate is null (exchanges paused) while no rate is set. */
  async getRateInfo() {
    const manualRate = Number(configService.get('manual_rate_inr')) || null;
    const expires = configService.get('manual_rate_expires_at');
    const manual = manualRate ? { rate: manualRate, expiresAt: expires ? new Date(expires) : null } : null;
    let r: { rate: number; mode: 'manual' } | null = null;
    let pausedReason: string | null = null;
    try {
      r = userRate(manual, Date.now());
    } catch (e: any) {
      pausedReason = e.message;
    }
    return {
      rate: r ? Number(r.rate.toFixed(2)) : null,
      mode: r?.mode ?? null,
      pausedReason,
      manualRate: r ? manualRate : null,
      manualRateExpiresAt: r && expires ? new Date(expires as string).toISOString() : null,
      updatedAt: configService.get('updated_at') ?? null,
      // Limits the app shows (the DB enforces them): no hardcoded fee/minimums in the app.
      minSellUsdt: Number(configService.get('min_exchange_usdt')),
      minWithdrawalUsdt: Number(configService.get('min_usdt_withdrawal')),
      withdrawalFeeUsdt: Number(configService.get('usdt_withdrawal_fee')),
    };
  }

  /** The rate for a new order. Throws while no rate is set, which blocks exchanges. */
  async getLiveRate(): Promise<number> {
    const { rate, pausedReason } = await this.getRateInfo();
    if (rate === null) throw new Error(pausedReason ?? 'No exchange rate is set');
    return rate;
  }

  /** Pause flag, minimum, daily limits (IST day) and idempotency are enforced inside create_exchange_order. */
  async createExchangeOrder(userId: string, usdtAmount: string, bankAccountId: string, idempotencyKey: string) {
    try {
      const amount = formatUsdt(parseUsdt(usdtAmount)); // exact 6-decimal string; rejects more decimals
      const rate = await this.getLiveRate();
      const inrAmount = Number((Number(amount) * rate).toFixed(2));

      const { data, error } = await supabase.rpc('create_exchange_order', {
        p_user_id: userId,
        p_usdt_amount: amount,
        p_inr_amount: inrAmount,
        p_rate: rate,
        p_bank_account_id: bankAccountId,
        p_idempotency_key: `${userId}:${idempotencyKey}`
      });

      if (error) throw error;
      
      // The RPC returns a JSON object with 'success' and 'message' if it fails
      if (data && data.success === false) {
        throw new Error(data.message || 'Exchange failed');
      }

      // The 12-digit order number is shown on the app's success screen and receipt.
      const orderId = data.order_id || data;
      const { data: row } = await supabase.from('exchange_orders').select('order_no').eq('id', orderId).maybeSingle();
      return {
        success: true,
        orderId,
        orderNo: row?.order_no ? String(row.order_no) : null,
        inrAmount,
        rate
      };
    } catch (error: any) {
      console.error('[EXCHANGE_SERVICE] Order creation failed:', error.message);
      throw error;
    }
  }

  /** The user's orders with the payout bank account (beneficiary name shown in the app's history and receipt). */
  async getOrders(userId: string) {
    const { data, error } = await supabase
      .from('exchange_orders')
      .select('*, bank_accounts(account_holder_name, account_number, ifsc_code, bank_name)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
  }
}

export default ExchangeService.getInstance();
