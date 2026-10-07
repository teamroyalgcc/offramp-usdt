-- 2026-10-08: a sell order's bank account must belong to the user and not be deleted (AUDIT item 5).
CREATE OR REPLACE FUNCTION public.create_exchange_order(
  p_user_id UUID, p_usdt_amount NUMERIC, p_inr_amount NUMERIC, p_rate NUMERIC,
  p_bank_account_id UUID, p_idempotency_key TEXT
) RETURNS JSON LANGUAGE plpgsql AS $$
DECLARE v_avail NUMERIC; v_locked NUMERIC; v_id UUID;
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
  IF v_avail IS NULL OR v_avail < p_usdt_amount THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient balance');
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
