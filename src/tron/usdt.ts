import { TronWeb } from 'tronweb';

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

/**
 * Checks the USDT logs of an admin's hand-sent withdrawal tx. Returns null when it pays exactly
 * `expected` to the user, only from the treasury, and was mined after the withdrawal was requested.
 */
export function payoutError(
  logs: { from: string; amountRaw: bigint; blockTs: Date }[],
  w: { treasury: string; expected: bigint; createdAt: Date },
): string | null {
  if (!logs.length) return 'Transaction not found, not final yet, or not a USDT payment to the user\'s address. Wait a minute and try again.';
  if (!w.treasury || logs.some((l) => l.from !== w.treasury)) return 'Transaction was not sent from the treasury wallet.';
  if (logs[0].blockTs <= w.createdAt) return 'Transaction is older than this withdrawal request.';
  const paid = logs.reduce((sum, l) => sum + l.amountRaw, 0n);
  if (paid !== w.expected) return `Transaction pays ${formatUsdt(paid)} USDT but this withdrawal needs exactly ${formatUsdt(w.expected)} USDT.`;
  return null;
}

/** Withdrawal destinations: base58 TRON addresses only (no hex), never one of `denied` (treasury, USDT contract). */
export function withdrawalAddressError(addr: unknown, denied: string[]): string | null {
  if (typeof addr !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr) || !TronWeb.isAddress(addr)) {
    return 'Invalid TRON address (it starts with T and has 34 characters)';
  }
  if (denied.includes(addr)) return 'This address cannot receive withdrawals';
  return null;
}
