import supabase from '../utils/supabase.js';
import bcrypt from 'bcryptjs';
import { createHash, randomInt } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { checkPin, MAX_PIN_FAILURES, PIN_LOCK_MINUTES, PinCounter } from '../utils/pin.js';
import { verifyGoogleToken } from '../utils/google.js';

export class AuthService {
  static verifyGoogleToken = verifyGoogleToken;

  static async findUserByEmail(email: string) {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .maybeSingle(); // maybeSingle doesn't throw on no rows returned
    
    if (error) throw error;
    return user || null;
  }

  static async findUserById(id: string) {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;
    return user || null;
  }

  static async hashPassword(password: string) {
    return bcrypt.hash(password, 10);
  }

  static async checkPassword(password: string, hash: string) {
    return bcrypt.compare(password, hash);
  }

  static generateVerificationToken() {
    return randomUUID();
  }

  static generateOTP() {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  /** Login codes are stored hashed (users.email_otp), so a DB read doesn't hand out live codes. */
  static hashOTP(email: string, otp: string) {
    return createHash('sha256').update(`${email}:${otp}`).digest('hex');
  }

  // Money-out guard. Returns null when the transaction PIN is correct, otherwise the message to show.
  static async verifyTransactionPin(userId: string, pin: unknown) {
    const { data, error } = await supabase.from('users').select('transaction_pin_hash, pin_hold_until').eq('id', userId).single();
    if (error) throw error;
    if (data.pin_hold_until && new Date(data.pin_hold_until) > new Date()) {
      const until = new Date(data.pin_hold_until).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      return `Your PIN was reset recently. For your safety, sells and withdrawals unlock at ${until} IST.`;
    }
    return checkPin(pinCounter, userId, pin, data.transaction_pin_hash);
  }
}

export const pinCounter: PinCounter = {
  begin: async (userId) => {
    const { data, error } = await supabase.rpc('begin_pin_attempt', { p_user_id: userId });
    if (error) throw error;
    return data ?? 0;
  },
  end: async (userId, ok) => {
    const { error } = await supabase.rpc('end_pin_attempt', {
      p_user_id: userId, p_ok: ok, p_max: MAX_PIN_FAILURES, p_lock_minutes: PIN_LOCK_MINUTES,
    });
    if (error) throw error;
  },
};
