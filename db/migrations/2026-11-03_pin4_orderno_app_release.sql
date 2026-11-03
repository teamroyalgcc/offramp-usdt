-- 2026-11-03: 4-digit transaction PIN, 12-digit numeric order numbers, in-app update settings,
-- manual rate as the primary rate (no expiry). Run this, then re-run db/schema.sql.
BEGIN;

-- Transaction PIN length. Existing users keep their 6-digit PIN until they set a 4-digit one;
-- money-out is refused until then (the app sends them to the PIN screen).
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS pin_digits INTEGER NOT NULL DEFAULT 6;
UPDATE public.users SET pin_digits = 6 WHERE transaction_pin_hash IS NOT NULL;

-- 12-digit numeric order numbers, shown to users and admins instead of the UUID.
CREATE SEQUENCE IF NOT EXISTS public.order_no_seq START 100000000001 MINVALUE 100000000001 MAXVALUE 999999999999;
ALTER TABLE public.exchange_orders ADD COLUMN IF NOT EXISTS order_no BIGINT UNIQUE;
ALTER TABLE public.usdt_withdrawals ADD COLUMN IF NOT EXISTS order_no BIGINT UNIQUE;
UPDATE public.exchange_orders SET order_no = nextval('public.order_no_seq') WHERE order_no IS NULL;
UPDATE public.usdt_withdrawals SET order_no = nextval('public.order_no_seq') WHERE order_no IS NULL;
ALTER TABLE public.exchange_orders ALTER COLUMN order_no SET DEFAULT nextval('public.order_no_seq'), ALTER COLUMN order_no SET NOT NULL;
ALTER TABLE public.usdt_withdrawals ALTER COLUMN order_no SET DEFAULT nextval('public.order_no_seq'), ALTER COLUMN order_no SET NOT NULL;

-- In-app update: the app compares its version with app_latest_version and offers the APK.
ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS app_latest_version TEXT,
  ADD COLUMN IF NOT EXISTS app_min_version TEXT,
  ADD COLUMN IF NOT EXISTS app_apk_url TEXT,
  ADD COLUMN IF NOT EXISTS app_release_notes TEXT;

-- The manual rate no longer expires: clear any 24 h expiry left from the old override.
UPDATE public.system_settings SET manual_rate_expires_at = NULL WHERE id = 1;

-- Messages and ledger labels say "exchange" instead of "sell".
CREATE OR REPLACE FUNCTION public.create_exchange_order(
  p_user_id UUID, p_usdt_amount NUMERIC, p_inr_amount NUMERIC, p_rate NUMERIC,
  p_bank_account_id UUID, p_idempotency_key TEXT
) RETURNS JSON LANGUAGE plpgsql AS $$
DECLARE v_avail NUMERIC; v_locked NUMERIC; v_id UUID; s public.system_settings%ROWTYPE; v_day_usdt NUMERIC; v_day_inr NUMERIC;
BEGIN
  IF p_usdt_amount IS NULL OR p_usdt_amount <= 0 THEN
    RETURN json_build_object('success', false, 'message', 'Amount must be greater than zero');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bank_accounts
                 WHERE id = p_bank_account_id AND user_id = p_user_id AND deleted_at IS NULL) THEN
    RETURN json_build_object('success', false, 'message', 'Bank account not found');
  END IF;
  SELECT available_balance, locked_balance INTO v_avail, v_locked
    FROM public.ledger_accounts WHERE user_id = p_user_id FOR UPDATE;
  -- Same idempotency key (a double tap or a client retry) returns the first order.
  SELECT id INTO v_id FROM public.exchange_orders WHERE idempotency_key = p_idempotency_key AND user_id = p_user_id;
  IF v_id IS NOT NULL THEN
    RETURN json_build_object('success', true, 'order_id', v_id, 'duplicate', true);
  END IF;
  IF v_avail IS NULL OR v_avail < p_usdt_amount THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient balance');
  END IF;
  -- Pause flag, minimum and daily limits (IST day), checked under the ledger row lock so parallel orders can't race past.
  SELECT * INTO s FROM public.system_settings WHERE id = 1;
  IF NOT s.exchanges_enabled THEN
    RETURN json_build_object('success', false, 'message', 'Exchanges are paused');
  END IF;
  IF p_usdt_amount < s.min_exchange_usdt THEN
    RETURN json_build_object('success', false, 'message', 'Minimum exchange is ' || s.min_exchange_usdt || ' USDT');
  END IF;
  SELECT COALESCE(SUM(usdt_amount), 0), COALESCE(SUM(inr_amount), 0) INTO v_day_usdt, v_day_inr
    FROM public.exchange_orders
   WHERE user_id = p_user_id AND status <> 'REFUNDED'
     AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata';
  IF v_day_usdt + p_usdt_amount > s.daily_exchange_usdt THEN
    RETURN json_build_object('success', false, 'message', 'Daily exchange limit is ' || s.daily_exchange_usdt || ' USDT');
  END IF;
  IF v_day_inr + p_inr_amount > s.daily_withdrawal_inr THEN
    RETURN json_build_object('success', false, 'message', 'Daily payout limit is ' || s.daily_withdrawal_inr || ' INR');
  END IF;

  INSERT INTO public.exchange_orders (user_id, usdt_amount, inr_amount, rate, bank_account_id, idempotency_key)
  VALUES (p_user_id, p_usdt_amount, p_inr_amount, p_rate, p_bank_account_id, p_idempotency_key)
  RETURNING id INTO v_id;

  UPDATE public.ledger_accounts
     SET available_balance = v_avail - p_usdt_amount, locked_balance = v_locked + p_usdt_amount, updated_at = NOW()
   WHERE user_id = p_user_id;
  INSERT INTO public.ledger_entries (user_id, type, amount, balance_type, direction, reference_id, description, balance_before, balance_after)
  VALUES (p_user_id, 'exchange_lock', p_usdt_amount, 'available', 'debit', v_id::text, 'Locked for exchange order', v_avail, v_avail - p_usdt_amount),
         (p_user_id, 'exchange_lock', p_usdt_amount, 'locked', 'credit', v_id::text, 'Locked for exchange order', v_locked, v_locked + p_usdt_amount);
  RETURN json_build_object('success', true, 'order_id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_exchange_order(p_order_id UUID, p_paid BOOLEAN, p_note TEXT)
RETURNS JSON LANGUAGE plpgsql AS $$
DECLARE o public.exchange_orders%ROWTYPE; v_avail NUMERIC; v_locked NUMERIC;
BEGIN
  UPDATE public.exchange_orders
     SET status = CASE WHEN p_paid THEN 'SUCCESS' ELSE 'REFUNDED' END,
         payout_reference = CASE WHEN p_paid THEN p_note ELSE payout_reference END,
         failure_reason = CASE WHEN p_paid THEN failure_reason ELSE p_note END,
         completed_at = NOW(), updated_at = NOW()
   WHERE id = p_order_id AND status = 'PROCESSING'
  RETURNING * INTO o;
  IF o.id IS NULL THEN
    RAISE EXCEPTION 'Order not found or already completed';
  END IF;

  SELECT available_balance, locked_balance INTO v_avail, v_locked
    FROM public.ledger_accounts WHERE user_id = o.user_id FOR UPDATE;
  IF p_paid THEN
    UPDATE public.ledger_accounts
       SET locked_balance = v_locked - o.usdt_amount, settled_balance = settled_balance + o.usdt_amount, updated_at = NOW()
     WHERE user_id = o.user_id;
    INSERT INTO public.ledger_entries (user_id, type, amount, balance_type, direction, reference_id, description, balance_before, balance_after)
    VALUES (o.user_id, 'exchange_settle', o.usdt_amount, 'locked', 'debit', o.id::text,
            'Exchange order paid out: ' || COALESCE(p_note, ''), v_locked, v_locked - o.usdt_amount);
  ELSE
    UPDATE public.ledger_accounts
       SET locked_balance = v_locked - o.usdt_amount, available_balance = v_avail + o.usdt_amount, updated_at = NOW()
     WHERE user_id = o.user_id;
    INSERT INTO public.ledger_entries (user_id, type, amount, balance_type, direction, reference_id, description, balance_before, balance_after)
    VALUES (o.user_id, 'exchange_refund', o.usdt_amount, 'locked', 'debit', o.id::text, 'Exchange order refunded', v_locked, v_locked - o.usdt_amount),
           (o.user_id, 'exchange_refund', o.usdt_amount, 'available', 'credit', o.id::text, 'Exchange order refunded', v_avail, v_avail + o.usdt_amount);
  END IF;
  RETURN json_build_object('user_id', o.user_id, 'status', o.status);
END;
$$;

COMMIT;
