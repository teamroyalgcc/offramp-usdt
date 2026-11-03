import bcrypt from 'bcryptjs';

export const MAX_PIN_FAILURES = 5;
export const PIN_LOCK_MINUTES = 15;
export const PIN_RESET_HOLD_MS = 24 * 60 * 60 * 1000;
/** New transaction PINs are 4 digits. Older accounts may still hold a 6-digit PIN (users.pin_digits). */
export const PIN_DIGITS = 4;
/** The emailed code that sets or resets a PIN is 6 digits. */
export const PIN_CODE_DIGITS = 6;

// The guess counter lives in the DB (begin_pin_attempt / end_pin_attempt in db/schema.sql),
// so it survives restarts and parallel guesses cannot race past the limit.
export type PinCounter = {
  begin: (userId: string) => Promise<number>;
  end: (userId: string, ok: boolean) => Promise<void>;
};

export const isValidPin = (pin: unknown, digits = PIN_DIGITS): pin is string =>
  typeof pin === 'string' && new RegExp(`^\\d{${digits}}$`).test(pin);
export const hashPin = (pin: string) => bcrypt.hash(pin, 10);

// Checks a PIN, or the emailed PIN code (label 'email code'). Both share one counter.
// `digits` is the length of the stored secret (users.pin_digits for the PIN, 6 for the code).
export async function checkPin(
  counter: PinCounter, userId: string, pin: unknown, hash: string | null | undefined,
  label = 'transaction PIN', digits = PIN_DIGITS,
): Promise<string | null> {
  if (!hash) return 'Set a transaction PIN first (Profile → Transaction PIN).';
  if (!isValidPin(pin, digits)) return `Enter your ${digits}-digit ${label}.`;
  const attempt = await counter.begin(userId);
  if (attempt === 0 || attempt > MAX_PIN_FAILURES) {
    return `Too many wrong attempts. Money-out is locked for up to ${PIN_LOCK_MINUTES} minutes.`;
  }
  const ok = await bcrypt.compare(pin, hash);
  await counter.end(userId, ok);
  if (ok) return null;
  if (attempt >= MAX_PIN_FAILURES) return `Too many wrong attempts. Money-out is locked for ${PIN_LOCK_MINUTES} minutes.`;
  return `Wrong ${label}. ${MAX_PIN_FAILURES - attempt} attempts left.`;
}
