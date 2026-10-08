// The only user fields the app may see. A whitelist, so a new secret column never leaks by default.
const FIELDS = ['id', 'email', 'email_verified', 'auth_provider', 'account_holder_name', 'phone', 'phone_number',
  'kyc_status', 'kyc_rejection_reason', 'kyc_verified_at', 'referral_code', 'is_frozen', 'account_status',
  'pin_hold_until', 'created_at'] as const;

export const publicUser = (u: Record<string, any>) => ({
  ...Object.fromEntries(FIELDS.filter((k) => k in u).map((k) => [k, u[k]])),
  has_pin: !!u.transaction_pin_hash,
});
