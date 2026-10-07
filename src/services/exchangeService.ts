import supabase from '../utils/supabase.js';
import { v4 as uuidv4 } from 'uuid';
import configService from './configService.js';
import complianceService from './complianceService.js';

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
    const r = userRate(market, spreadPercent, manual, Date.now());
    return {
      rate: Number(r.rate.toFixed(2)),
      mode: r.mode,
      marketRate: market ? Number(market.rate.toFixed(2)) : null,
      spreadPercent,
      source: market?.source ?? null,
      sources: market?.sources ?? null,
      updatedAt: market ? new Date(market.updatedAt).toISOString() : null,
      manualRate: r.mode === 'manual' ? manualRate : null,
      manualRateExpiresAt: r.mode === 'manual' ? new Date(expires as string).toISOString() : null,
    };
  }

  /** User rate. Throws when no trustworthy rate exists, which blocks sells. */
  async getLiveRate(): Promise<number> {
    return (await this.getRateInfo()).rate;
  }

  async createExchangeOrder(userId: string, usdtAmount: number, bankAccountId: string) {
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
      // Use RPC for atomic operation
      const { data, error } = await supabase.rpc('create_exchange_order', {
        p_user_id: userId,
        p_usdt_amount: usdtAmount,
        p_inr_amount: inrAmount,
        p_rate: rate,
        p_bank_account_id: bankAccountId,
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
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
  }
}

export default ExchangeService.getInstance();
