import bcrypt from 'bcryptjs';

// Transaction PIN: 6 digits, required for every money-out action (sell orders, USDT withdrawals).
// ponytail: in-memory lockout, single instance (same as the OTP guard). Move to the DB if the API scales out.
const failures = new Map<string, { count: number; lockedUntil: number }>();
export const MAX_PIN_FAILURES = 5;
export const PIN_LOCK_MS = 15 * 60 * 1000;

export const isValidPin = (pin: unknown): pin is string => typeof pin === 'string' && /^\d{6}$/.test(pin);

export const hashPin = (pin: string) => bcrypt.hash(pin, 10);

// Returns null when the PIN is correct, otherwise the message to show the user.
export async function checkPin(userId: string, pin: unknown, hash: string | null | undefined): Promise<string | null> {
  if (!hash) return 'Set a transaction PIN first (Profile → Transaction PIN).';
  const f = failures.get(userId);
  if (f && f.lockedUntil > Date.now()) {
    return `Too many wrong PIN attempts. Try again in ${Math.ceil((f.lockedUntil - Date.now()) / 60000)} minutes.`;
  }
  if (!isValidPin(pin)) return 'Enter your 6-digit transaction PIN.';
  if (await bcrypt.compare(pin, hash)) {
    failures.delete(userId);
    return null;
  }
  const count = (f && f.lockedUntil === 0 ? f.count : 0) + 1;
  if (count >= MAX_PIN_FAILURES) {
    failures.set(userId, { count: 0, lockedUntil: Date.now() + PIN_LOCK_MS });
    return 'Too many wrong PIN attempts. Money-out is locked for 15 minutes.';
  }
  failures.set(userId, { count, lockedUntil: 0 });
  return `Wrong PIN. ${MAX_PIN_FAILURES - count} attempts left.`;
}
