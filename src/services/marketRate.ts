// USDT/INR market rate = the LOWEST of several live quotes for what a USDT seller gets.
// The platform pays INR for users' USDT, so it never quotes above the cheapest market.
// Pure logic + fetchers only; no config/supabase imports, so it is unit-testable.
//
// Sources (price a seller receives, median of the top ads/quote):
//   binance_p2p: Binance P2P merchant buyers paying by UPI (tradeType=SELL = ads that BUY USDT)
//   okx_p2p:     OKX P2P buy ads
//   coindcx:     CoinDCX USDTINR best bid
//   wazirx:      WazirX usdtinr best buy
// ponytail: Binance merchant filter and OKX use undocumented public endpoints; if Render gets
// blocked they just count as unavailable and the others carry on.

export const MAX_SPREAD = 0.08; // highest/lowest source above this -> something is off, pause sells
export const STALE_MS = 2 * 60_000;
export const CACHE_MS = 30_000;

export type SourceName = 'binance_p2p' | 'okx_p2p' | 'coindcx' | 'wazirx';
export type Sources = Record<SourceName, number | null>;

export interface MarketRate {
  rate: number;
  source: SourceName;
  sources: Sources;
  updatedAt: number;
}

export function median(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Lowest available source; throws if sources are too far apart. Null if none is available. */
export function pickRate(sources: Sources, now: number): MarketRate | null {
  const live = (Object.entries(sources) as [SourceName, number | null][])
    .filter((e): e is [SourceName, number] => Number.isFinite(e[1]) && (e[1] as number) > 0)
    .sort((a, b) => a[1] - b[1]);
  if (!live.length) return null;
  const [lowName, low] = live[0];
  const high = live[live.length - 1][1];
  if (high / low - 1 > MAX_SPREAD) {
    throw new Error(`Rate sources disagree (${live.map(([n, v]) => `${n} ${v}`).join(', ')}); sells paused`);
  }
  return { rate: low, source: lowName, sources, updatedAt: now };
}

/** Fresh pick, else the last good value while it is younger than STALE_MS. */
export function resolveRate(fresh: MarketRate | null, last: MarketRate | null, now: number): MarketRate {
  if (fresh) return fresh;
  if (last && now - last.updatedAt <= STALE_MS) return last;
  throw new Error('Live rate unavailable, try again shortly');
}

const req = async (url: string, body?: unknown) => {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${new URL(url).host}`);
  return res.json() as Promise<any>;
};

const fetchers: Record<SourceName, () => Promise<number | null>> = {
  binance_p2p: async () => {
    const j = await req('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', {
      fiat: 'INR', asset: 'USDT', tradeType: 'SELL', page: 1, rows: 10, payTypes: ['UPI'], publisherType: 'merchant',
    });
    return median((j?.data ?? []).map((a: any) => Number(a.adv?.price)));
  },
  okx_p2p: async () => {
    const j = await req('https://www.okx.com/v3/c2c/tradingOrders/books?quoteCurrency=INR&baseCurrency=USDT&side=buy&paymentMethod=all&userType=all&showTrade=false&showFollow=false&showAlreadyTraded=false&isAbleFilter=false&receivingAds=false');
    return median((j?.data?.buy ?? []).slice(0, 10).map((a: any) => Number(a.price)));
  },
  coindcx: async () => {
    const t: any[] = await req('https://api.coindcx.com/exchange/ticker');
    return Number(t.find((x) => x.market === 'USDTINR')?.bid) || null;
  },
  wazirx: async () => Number((await req('https://api.wazirx.com/api/v2/tickers/usdtinr'))?.ticker?.buy) || null,
};

/** Fetches every source; a failed source counts as unavailable. Disagreement still throws. */
export async function fetchMarketRate(now = Date.now()): Promise<MarketRate | null> {
  const names = Object.keys(fetchers) as SourceName[];
  const results = await Promise.allSettled(names.map((n) => fetchers[n]()));
  const sources = {} as Sources;
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`[MARKET_RATE] ${names[i]} failed:`, r.reason?.message);
    sources[names[i]] = r.status === 'fulfilled' ? r.value : null;
  });
  return pickRate(sources, now);
}

/**
 * Final rate users get. Live: market minus spread. Manual override (admin, 24 h):
 * the fixed rate, but never above the live market; used alone if live is unavailable.
 */
export function userRate(market: MarketRate | null, spreadPercent: number, manual: { rate: number; expiresAt: Date } | null, now: number) {
  const active = manual && manual.expiresAt.getTime() > now ? manual : null;
  if (active) {
    return { rate: market ? Math.min(active.rate, market.rate) : active.rate, mode: 'manual' as const };
  }
  if (!market) throw new Error('Live rate unavailable, try again shortly');
  return { rate: market.rate * (1 - spreadPercent / 100), mode: 'live' as const };
}
