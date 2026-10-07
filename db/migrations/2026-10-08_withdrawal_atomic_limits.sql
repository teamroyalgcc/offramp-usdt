-- 2026-10-08: atomic USDT withdrawals + daily limits enforced in SQL with an IST day (AUDIT items 8, 9, 13).
-- create_exchange_order: idempotency key returns the first order; pause flag, minimum and daily limits under the ledger lock.
BEGIN;
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
    RETURN json_build_object('success', false, 'message', 'Sells are paused');
  END IF;
  IF p_usdt_amount < s.min_exchange_usdt THEN
    RETURN json_build_object('success', false, 'message', 'Minimum sell is ' || s.min_exchange_usdt || ' USDT');
  END IF;
  SELECT COALESCE(SUM(usdt_amount), 0), COALESCE(SUM(inr_amount), 0) INTO v_day_usdt, v_day_inr
    FROM public.exchange_orders
   WHERE user_id = p_user_id AND status <> 'REFUNDED'
     AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata';
  IF v_day_usdt + p_usdt_amount > s.daily_exchange_usdt THEN
    RETURN json_build_object('success', false, 'message', 'Daily sell limit is ' || s.daily_exchange_usdt || ' USDT');
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
  VALUES (p_user_id, 'exchange_lock', p_usdt_amount, 'available', 'debit', v_id::text, 'Locked for sell order', v_avail, v_avail - p_usdt_amount),
         (p_user_id, 'exchange_lock', p_usdt_amount, 'locked', 'credit', v_id::text, 'Locked for sell order', v_locked, v_locked + p_usdt_amount);
  RETURN json_build_object('success', true, 'order_id', v_id);
END;
$$;

-- Request: pause flag, minimum, fee and the daily limit (IST day) from system_settings,
-- then lock the funds and insert the withdrawal, all in one transaction under the ledger row lock.
CREATE OR REPLACE FUNCTION public.request_withdrawal(p_user_id UUID, p_amount NUMERIC, p_destination TEXT, p_idempotency_key TEXT)
RETURNS JSON LANGUAGE plpgsql AS $$
DECLARE s public.system_settings%ROWTYPE; v_day NUMERIC; v_id UUID := gen_random_uuid(); v_lock JSON; w public.usdt_withdrawals%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.ledger_accounts WHERE user_id = p_user_id FOR UPDATE;
  SELECT * INTO w FROM public.usdt_withdrawals WHERE idempotency_key = p_idempotency_key AND user_id = p_user_id;
  IF w.id IS NOT NULL THEN
    RETURN json_build_object('success', true, 'withdrawal', row_to_json(w), 'duplicate', true);
  END IF;
  SELECT * INTO s FROM public.system_settings WHERE id = 1;
  IF NOT s.withdrawals_enabled THEN
    RETURN json_build_object('success', false, 'message', 'Withdrawals are currently paused');
  END IF;
  IF p_amount IS NULL OR p_amount < s.min_usdt_withdrawal THEN
    RETURN json_build_object('success', false, 'message', 'Minimum withdrawal amount is ' || s.min_usdt_withdrawal || ' USDT');
  END IF;
  IF p_amount - s.usdt_withdrawal_fee <= 0 THEN
    RETURN json_build_object('success', false, 'message', 'Withdrawal amount too low after fees');
  END IF;
  SELECT COALESCE(SUM(usdt_amount), 0) INTO v_day FROM public.usdt_withdrawals
   WHERE user_id = p_user_id AND status <> 'failed'
     AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata';
  IF v_day + p_amount > s.daily_withdrawal_usdt THEN
    RETURN json_build_object('success', false, 'message', 'Daily USDT withdrawal limit is ' || s.daily_withdrawal_usdt || ' USDT');
  END IF;
  v_lock := public.lock_funds(p_user_id, p_amount, v_id::text, 'USDT withdrawal to ' || p_destination);
  IF NOT (v_lock->>'success')::boolean THEN
    RETURN v_lock;
  END IF;
  INSERT INTO public.usdt_withdrawals (id, user_id, destination_address, usdt_amount, fee, net_amount, idempotency_key)
  VALUES (v_id, p_user_id, p_destination, p_amount, s.usdt_withdrawal_fee, p_amount - s.usdt_withdrawal_fee, p_idempotency_key)
  RETURNING * INTO w;
  RETURN json_build_object('success', true, 'withdrawal', row_to_json(w));
END;
$$;

-- Admin sent the USDT (tx verified on-chain by the backend): pending -> completed exactly once, locked -> settled.
CREATE OR REPLACE FUNCTION public.complete_withdrawal(p_id UUID, p_tx_hash TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE w public.usdt_withdrawals%ROWTYPE;
BEGIN
  UPDATE public.usdt_withdrawals SET status = 'completed', tx_hash = p_tx_hash, updated_at = NOW()
   WHERE id = p_id AND status IN ('pending', 'processing') RETURNING * INTO w;
  IF w.id IS NULL THEN
    RAISE EXCEPTION 'Withdrawal not found or already completed/rejected';
  END IF;
  PERFORM public.finalize_withdrawal(w.user_id, w.usdt_amount, w.id);
END;
$$;

-- Admin rejected: pending -> failed exactly once, locked -> available.
CREATE OR REPLACE FUNCTION public.reject_withdrawal(p_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE w public.usdt_withdrawals%ROWTYPE;
BEGIN
  UPDATE public.usdt_withdrawals SET status = 'failed', failure_reason = p_reason, updated_at = NOW()
   WHERE id = p_id AND status IN ('pending', 'processing') RETURNING * INTO w;
  IF w.id IS NULL THEN
    RAISE EXCEPTION 'Withdrawal not found or already completed/rejected';
  END IF;
  PERFORM public.fail_withdrawal(w.user_id, w.usdt_amount, w.id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.request_withdrawal(uuid,numeric,text,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_withdrawal(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reject_withdrawal(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.create_exchange_order(uuid,numeric,numeric,numeric,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_withdrawal(uuid,numeric,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_withdrawal(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reject_withdrawal(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_exchange_order(uuid,numeric,numeric,numeric,uuid,text) TO service_role;
COMMIT;
