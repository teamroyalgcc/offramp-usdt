import supabase from '../utils/supabase.js';
import configService from './configService.js';
import { formatUsdt, parseUsdt } from '../tron/usdt.js';

import { CACHE_MS, fetchMarketRate, MarketRate, resolveRate, userRate } from './marketRate.js';

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

  /** Everything the app and the admin Rates page show. Throws only when no rate can be given (sells pause). */
  async getRateInfo() {
    const market = await this.marketRate().catch((e) => {
      console.error('[EXCHANGE_SERVICE] market rate:', e.message);
      return null;
    });
    const spreadPercent = Number(configService.get('exchange_spread_percent') || 0);
    const manualRate = Number(configService.get('manual_rate_inr')) || null;
    const expires = configService.get('manual_rate_expires_at');
    const manual = manualRate && expires ? { rate: manualRate, expiresAt: new Date(expires) } : null;
    // No trustworthy rate: rate null (sells paused), not a 500, so the app and the limits below still load.
    let r: { rate: number; mode: 'live' | 'manual' } | null = null;
    let pausedReason: string | null = null;
    try {
      r = userRate(market, spreadPercent, manual, Date.now());
    } catch (e: any) {
      pausedReason = e.message;
    }
    return {
      rate: r ? Number(r.rate.toFixed(2)) : null,
      mode: r?.mode ?? null,
      pausedReason,
      marketRate: market ? Number(market.rate.toFixed(2)) : null,
      spreadPercent,
      source: market?.source ?? null,
      sources: market?.sources ?? null,
      updatedAt: market ? new Date(market.updatedAt).toISOString() : null,
      manualRate: r?.mode === 'manual' ? manualRate : null,
      manualRateExpiresAt: r?.mode === 'manual' ? new Date(expires as string).toISOString() : null,
      // Limits the app shows (the DB enforces them): no hardcoded fee/minimums in the app.
      minSellUsdt: Number(configService.get('min_exchange_usdt')),
      minWithdrawalUsdt: Number(configService.get('min_usdt_withdrawal')),
      withdrawalFeeUsdt: Number(configService.get('usdt_withdrawal_fee')),
    };
  }

  /** User rate. Throws when no trustworthy rate exists, which blocks sells. */
  async getLiveRate(): Promise<number> {
    const { rate, pausedReason } = await this.getRateInfo();
    if (rate === null) throw new Error(pausedReason ?? 'Live rate unavailable, try again shortly');
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
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
  }
}

export default ExchangeService.getInstance();
