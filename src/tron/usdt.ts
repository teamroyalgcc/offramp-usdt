// Exact 6-decimal USDT math. Never route token amounts through JS Number.
const DECIMALS = 6n;
const UNIT = 10n ** DECIMALS;

/** "12.5" -> 12_500_000n. Rejects more than 6 decimals, signs and junk. */
export function parseUsdt(value: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!m) throw new Error(`Invalid USDT amount: ${value}`);
  return BigInt(m[1]) * UNIT + BigInt((m[2] ?? '').padEnd(6, '0'));
}

/** 12_500_000n -> "12.5" */
export function formatUsdt(raw: bigint): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const frac = (abs % UNIT).toString().padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${abs / UNIT}${frac ? `.${frac}` : ''}`;
}
