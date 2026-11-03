// The rate users get is set by the admin (system_settings.manual_rate_inr). No external price feeds
// are read: the platform quotes one rate until the admin changes it. Pure logic, no imports, for tests.

export const NO_RATE_MESSAGE = 'No exchange rate is set. Set it in the admin panel under Rates.';

export interface ManualRate { rate: number; expiresAt: Date | null }

/** The admin's rate while it is set (and not past its optional expiry); throws otherwise, which pauses exchanges. */
export function userRate(manual: ManualRate | null, now: number): { rate: number; mode: 'manual' } {
  const active = manual && manual.rate > 0 && (!manual.expiresAt || manual.expiresAt.getTime() > now) ? manual : null;
  if (!active) throw new Error(NO_RATE_MESSAGE);
  return { rate: active.rate, mode: 'manual' };
}
