import supabase from '../utils/supabase.js';
import { v4 as uuidv4 } from 'uuid';
import configService from './configService.js';
import complianceService from './complianceService.js';

import { CACHE_MS, fetchMarketRate, MarketRate, resolveRate } from './marketRate.js';

export class ExchangeService {
  private static instance: ExchangeService;
  private last: MarketRate | null = null;
  private inflight: Promise<MarketRate> | null = null;

  private constructor() {}

  public static getInstance(): ExchangeService {
    if (!ExchangeService.instance) {
      ExchangeService.instance = new ExchangeService();
    }
    return ExchangeService.instance;
  }

  /** Market rate, refreshed at most every CACHE_MS. Throws if stale (> 2 min) or sources disagree. */
  private async marketRate(): Promise<MarketRate> {
    if (this.last && Date.now() - this.last.updatedAt < CACHE_MS) return this.last;
    // One refresh at a time; concurrent callers share it.
    this.inflight ??= fetchMarketRate()
      .then((fresh) => (this.last = resolveRate(fresh, this.last, Date.now())))
      .finally(() => (this.inflight = null));
    return this.inflight;
  }

  async getRateInfo() {
    const m = await this.marketRate();
    const spreadPercent = Number(configService.get('exchange_spread_percent') || 0);
    return {
      rate: Number((m.rate * (1 - spreadPercent / 100)).toFixed(2)),
      marketRate: Number(m.rate.toFixed(2)),
      spreadPercent,
      source: m.source,
      updatedAt: new Date(m.updatedAt).toISOString(),
    };
  }

  /** User rate (market minus spread). Throws when no trustworthy rate exists, which blocks sells. */
  async getLiveRate(): Promise<number> {
    return (await this.getRateInfo()).rate;
  }

  async createExchangeOrder(userId: string, usdtAmount: number, bankAccountId?: string, bankDetails?: any) {
    try {
      if (!configService.get('exchanges_enabled')) {
        throw new Error('Exchanges are paused');
      }

      const minUsdt = Number(configService.get('min_exchange_usdt') || 0);
      if (usdtAmount < minUsdt) {
        throw new Error(`Minimum exchange amount is ${minUsdt} USDT`);
      }

      const rate = await this.getLiveRate();
      const inrAmount = Number((usdtAmount * rate).toFixed(2));
      
      // Check limits
      await complianceService.checkExchangeLimit(userId, usdtAmount);
      await complianceService.checkWithdrawalLimit(userId, inrAmount);

      const idempotencyKey = uuidv4(); 
      let finalBankAccountId = bankAccountId;
      
      if (!finalBankAccountId && bankDetails) {
        const { data: existingBank } = await supabase
          .from('bank_accounts')
          .select('id')
          .eq('user_id', userId)
          .eq('account_number', bankDetails.account_number)
          .eq('ifsc_code', bankDetails.ifsc)
          .maybeSingle();
            
        if (existingBank) {
          finalBankAccountId = existingBank.id;
        } else {
          const { data: newBank, error: createError } = await supabase
            .from('bank_accounts')
            .insert({
              user_id: userId,
              account_holder_name: bankDetails.account_holder_name,
              account_number: bankDetails.account_number,
              ifsc_code: bankDetails.ifsc,
              bank_name: 'Bank',
              is_verified: true
            })
            .select()
            .single();
                
          if (createError) throw new Error('Failed to save bank');
          finalBankAccountId = newBank.id;
        }
      }

      if (!finalBankAccountId) {
        throw new Error('Bank account required for exchange');
      }

      // Use RPC for atomic operation
      const { data, error } = await supabase.rpc('create_exchange_order', {
        p_user_id: userId,
        p_usdt_amount: usdtAmount,
        p_inr_amount: inrAmount,
        p_rate: rate,
        p_bank_account_id: finalBankAccountId,
        p_idempotency_key: idempotencyKey
      });

      if (error) throw error;
      
      // The RPC returns a JSON object with 'success' and 'message' if it fails
      if (data && data.success === false) {
        throw new Error(data.message || 'Exchange failed');
      }

      return {
        success: true,
        orderId: data.order_id || data,
        inrAmount,
        rate
      };
    } catch (error: any) {
      console.error('[EXCHANGE_SERVICE] Order creation failed:', error.message);
      throw error;
    }
  }

  async getOrders(userId: string) {
    const { data, error } = await supabase
      .from('exchange_orders')
      .select('*, bank_accounts(*)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
  }
}

export default ExchangeService.getInstance();
