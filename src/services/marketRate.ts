// USDT/INR market rate: Binance P2P primary, CoinDCX/WazirX as fallback and cross-check.
// Pure logic + fetchers only; no config/supabase imports, so it is unit-testable.

// tradeType=SELL lists ads of people BUYING USDT = the price a user gets when SELLING.
// Switch to 'BUY' for the (lower) price at which USDT can be bought.
export const P2P_SIDE = 'SELL';
export const MAX_DISAGREE = 0.06; // P2P runs ~4% above exchange tickers (Sep 2026)
export const STALE_MS = 2 * 60_000;
export const CACHE_MS = 30_000;

export interface MarketRate {
  rate: number;
  source: string;
  updatedAt: number;
}

export function median(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Picks the rate from fresh quotes; throws if the sources disagree. Returns null if nothing is available. */
export function pickRate(p2p: number | null, exchange: number | null, now: number): MarketRate | null {
  if (p2p && exchange && Math.abs(p2p / exchange - 1) > MAX_DISAGREE) {
    throw new Error(`Rate sources disagree (P2P ${p2p}, exchanges ${exchange}); sells paused`);
  }
  if (p2p) return { rate: p2p, source: 'binance_p2p', updatedAt: now };
  if (exchange) return { rate: exchange, source: 'exchanges', updatedAt: now };
  return null;
}

/** Fresh pick, else the last good value while it is younger than STALE_MS. */
export function resolveRate(fresh: MarketRate | null, last: MarketRate | null, now: number): MarketRate {
  if (fresh) return fresh;
  if (last && now - last.updatedAt <= STALE_MS) return last;
  throw new Error('Live rate unavailable, try again shortly');
}

const get = async (url: string) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${new URL(url).host}`);
  return res.json() as Promise<any>;
};

export async function fetchP2P(): Promise<number | null> {
  const j = await get(`https://www.binance.com/bapi/c2c/v1/public/c2c/agent/ad-list?fiat=INR&asset=USDT&tradeType=${P2P_SIDE}&limit=10&tradeMethodIdentifiers=UPI`);
  return median((j?.data?.items ?? []).map((i: any) => Number(i.price)));
}

export async function fetchExchanges(): Promise<number | null> {
  const [dcx, wx] = await Promise.allSettled([
    get('https://api.coindcx.com/exchange/ticker').then((t: any[]) => Number(t.find((x) => x.market === 'USDTINR')?.bid)),
    get('https://api.wazirx.com/api/v2/tickers/usdtinr').then((t) => Number(t?.ticker?.buy)),
  ]);
  return median([dcx, wx].flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])));
}

/** Fetches every source; a failed source counts as missing. Disagreement still throws. */
export async function fetchMarketRate(now = Date.now()): Promise<MarketRate | null> {
  const [p2p, ex] = await Promise.allSettled([fetchP2P(), fetchExchanges()]);
  for (const r of [p2p, ex]) if (r.status === 'rejected') console.error('[MARKET_RATE] source failed:', r.reason?.message);
  return pickRate(
    p2p.status === 'fulfilled' ? p2p.value : null,
    ex.status === 'fulfilled' ? ex.value : null,
    now,
  );
}
