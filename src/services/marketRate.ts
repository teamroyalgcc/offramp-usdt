// USDT/INR market rate = the LOWEST best bid among the big Indian exchanges, i.e. what
// a user would get selling USDT there (our competitors). The platform pays INR for users'
// USDT, so it never quotes above that. P2P was dropped (user decision 2026-09-26): it runs
// 3 to 4% higher and is noisy. Pure logic + fetchers only; no config/supabase imports.
//
// Sources: CoinDCX USDTINR bid, WazirX usdtinr buy, ZebPay USDT-INR bid (all public, no key).

export const MAX_SPREAD = 0.03; // highest/lowest above this -> a feed is off, pause sells (exchanges agree within ~0.3%)
export const STALE_MS = 2 * 60_000;
export const CACHE_MS = 30_000;

export type SourceName = 'coindcx' | 'wazirx' | 'zebpay';
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

const req = async (url: string) => {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${new URL(url).host}`);
  return res.json() as Promise<any>;
};

const fetchers: Record<SourceName, () => Promise<number | null>> = {
  coindcx: async () => {
    const t: any[] = await req('https://api.coindcx.com/exchange/ticker');
    return Number(t.find((x) => x.market === 'USDTINR')?.bid) || null;
  },
  wazirx: async () => Number((await req('https://api.wazirx.com/api/v2/tickers/usdtinr'))?.ticker?.buy) || null,
  zebpay: async () => Number((await req('https://sapi.zebpay.com/api/v2/market/ticker?symbol=USDT-INR'))?.data?.bid) || null,
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
