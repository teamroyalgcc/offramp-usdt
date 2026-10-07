-- 2026-10-08: transaction PIN lockout in the DB + emailed PIN code + 24 h hold after a reset (AUDIT items 2, 3).
BEGIN;
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS pin_failures INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pin_code_hash TEXT,
  ADD COLUMN IF NOT EXISTS pin_code_expires TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pin_hold_until TIMESTAMPTZ;
ALTER TABLE public.users DROP COLUMN IF EXISTS pin_reset_until;  -- the old login-code reset window is gone

-- PIN guess counter. Counted atomically BEFORE the bcrypt compare, so parallel guesses
-- cannot slip past the limit. Returns this attempt's number (1, 2, ...), or 0 while locked.
CREATE OR REPLACE FUNCTION public.begin_pin_attempt(p_user_id UUID) RETURNS INTEGER
LANGUAGE sql AS $$
  UPDATE public.users SET
    pin_failures = CASE WHEN pin_locked_until > NOW() THEN pin_failures
                        WHEN pin_locked_until IS NOT NULL THEN 1 ELSE pin_failures + 1 END,
    pin_locked_until = CASE WHEN pin_locked_until > NOW() THEN pin_locked_until END
  WHERE id = p_user_id
  RETURNING CASE WHEN pin_locked_until > NOW() THEN 0 ELSE pin_failures END
$$;

-- Success clears the counter; a wrong guess at or past p_max starts the lock.
CREATE OR REPLACE FUNCTION public.end_pin_attempt(p_user_id UUID, p_ok BOOLEAN, p_max INTEGER, p_lock_minutes INTEGER)
RETURNS VOID LANGUAGE sql AS $$
  UPDATE public.users SET
    pin_failures = CASE WHEN p_ok THEN 0 ELSE pin_failures END,
    pin_locked_until = CASE WHEN NOT p_ok AND pin_failures >= p_max
                            THEN NOW() + make_interval(mins => p_lock_minutes) ELSE pin_locked_until END
  WHERE id = p_user_id
$$;
REVOKE EXECUTE ON FUNCTION public.begin_pin_attempt(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.end_pin_attempt(uuid,boolean,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_pin_attempt(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.end_pin_attempt(uuid,boolean,integer,integer) TO service_role;
COMMIT;
