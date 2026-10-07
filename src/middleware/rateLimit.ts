import { Request, Response, NextFunction } from 'express';

// ponytail: in-memory fixed windows, fine for the single Render instance; move to the DB/Redis if the API scales out.
const hits = new Map<string, { count: number; resetAt: number }>();

/** True when `key` has used up `max` hits in the current `windowMs`. Counts this hit. */
export function overLimit(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  const h = hits.get(key);
  if (!h || h.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + windowMs });
    if (hits.size > 50_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    return false;
  }
  return ++h.count > max;
}

/** Per-IP limit, plus per-email/username when the body has one (needs `trust proxy` for the real IP). */
export const rateLimit = (name: string, max: number, windowMs: number) =>
  (req: Request, res: Response, next: NextFunction) => {
    const who = String(req.body?.email ?? req.body?.username ?? '').toLowerCase().trim();
    if (overLimit(`${name}:ip:${req.ip}`, max, windowMs) || (who && overLimit(`${name}:who:${who}`, max, windowMs))) {
      return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.', message: 'Too many attempts. Please wait a few minutes and try again.' });
    }
    next();
  };
