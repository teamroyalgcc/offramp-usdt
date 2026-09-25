-- Royal GCC offramp: complete database schema for a FRESH Supabase project.
-- Paste into Supabase SQL Editor and Run (safe to re-run). See docs/DEPLOYMENT.md.
--
-- All money amounts: NUMERIC. On-chain amounts: integer micro-USDT (NUMERIC(38,0)).
-- The backend uses the service role, which bypasses RLS. RLS is ON with no policies
-- on every table, so the public anon/publishable key can read nothing.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================ users & admins

CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  email_otp TEXT,
  email_otp_expires TIMESTAMPTZ,
  email_verification_token TEXT,
  password_hash TEXT,
  transaction_pin_hash TEXT,    -- bcrypt of the 6-digit PIN that confirms sell orders and withdrawals
  pin_reset_until TIMESTAMPTZ,  -- set by a fresh email OTP login: PIN can be reset without the old one until then
  google_id TEXT,
  auth_provider TEXT,
  account_holder_name TEXT,
  account_number TEXT,
  ifsc_code TEXT,
  phone TEXT,
  phone_number TEXT,
  kyc_status TEXT NOT NULL DEFAULT 'not_submitted', -- not_submitted | pending | approved | rejected
  kyc_provider TEXT,
  aadhaar_number TEXT,
  aadhaar_photo_url TEXT,
  kyc_verified_at TIMESTAMPTZ,
  kyc_rejection_reason TEXT,
  referral_code TEXT UNIQUE,
  referred_by UUID REFERENCES public.users(id),
  referral_points NUMERIC NOT NULL DEFAULT 0,
  is_frozen BOOLEAN NOT NULL DEFAULT FALSE,
  is_banned BOOLEAN NOT NULL DEFAULT FALSE,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  account_status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_kyc_status ON public.users (kyc_status);

-- Admin panel logins. Create the first superadmin by hand (docs/DEPLOYMENT.md step 2):
--   INSERT INTO admins (username, password_hash, role)
--   VALUES ('owner@example.com', crypt('A-LONG-UNIQUE-PASSWORD', gen_salt('bf', 10)), 'superadmin');
CREATE TABLE IF NOT EXISTS public.admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('superadmin', 'admin', 'staff')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Both user actions (auditService) and admin actions (adminService.logAction) land here.
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  actor_type TEXT,
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  reference_id TEXT,
  new_values JSONB,
  metadata JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON public.audit_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS public.kyc_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id),
  aadhaar_number_masked TEXT,
  full_name TEXT,
  status TEXT,
  document_url TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.referral_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id UUID NOT NULL REFERENCES public.users(id),
  referred_user_id UUID REFERENCES public.users(id),
  points_amount NUMERIC NOT NULL DEFAULT 0,
  type TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.bank_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id),
  account_holder_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  ifsc_code TEXT NOT NULL,
  bank_name TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_user ON public.bank_accounts (user_id) WHERE deleted_at IS NULL;

-- One row, id = 1. Loaded by configService at startup.
CREATE TABLE IF NOT EXISTS public.system_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  exchange_spread_percent NUMERIC NOT NULL DEFAULT 1.0,
  min_exchange_usdt NUMERIC NOT NULL DEFAULT 10,
  min_usdt_withdrawal NUMERIC NOT NULL DEFAULT 20,
  usdt_withdrawal_fee NUMERIC NOT NULL DEFAULT 5,
  daily_exchange_usdt NUMERIC NOT NULL DEFAULT 10000,
  daily_withdrawal_inr NUMERIC NOT NULL DEFAULT 500000,
  daily_withdrawal_usdt NUMERIC NOT NULL DEFAULT 50000,
  daily_withdrawal_limit NUMERIC NOT NULL DEFAULT 100000,
  deposits_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  exchanges_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  withdrawals_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO public.system_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ============================================================ ledger

CREATE TABLE IF NOT EXISTS public.ledger_accounts (
  user_id UUID PRIMARY KEY REFERENCES public.users(id),
  available_balance NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (available_balance >= 0),
  locked_balance NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (locked_balance >= 0),
  settled_balance NUMERIC(20, 6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id),
  type TEXT NOT NULL,           -- deposit, deposit_fee, exchange_lock, exchange_settle, exchange_refund, withdrawal_lock, withdrawal_settle, withdrawal_refund
  amount NUMERIC(20, 6) NOT NULL,
  balance_type TEXT NOT NULL,   -- available | locked
  direction TEXT NOT NULL,      -- credit | debit
  reference_id TEXT,
  description TEXT,
  balance_before NUMERIC(20, 6) NOT NULL,
  balance_after NUMERIC(20, 6) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_user ON public.ledger_entries (user_id, created_at DESC);

-- Moves p_amount from available to locked. Used by USDT withdrawals.
CREATE OR REPLACE FUNCTION public.lock_funds(p_user_id UUID, p_amount NUMERIC, p_ref_id TEXT, p_description TEXT)
RETURNS JSON LANGUAGE plpgsql AS $$
DECLARE v_avail NUMERIC; v_locked NUMERIC;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN json_build_object('success', false, 'message', 'Amount must be greater than zero');
  END IF;
  SELECT available_balance, locked_balance INTO v_avail, v_locked
    FROM public.ledger_accounts WHERE user_id = p_user_id FOR UPDATE;
  IF v_avail IS NULL OR v_avail < p_amount THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient balance');
  END IF;
  UPDATE public.ledger_accounts
     SET available_balance = v_avail - p_amount, locked_balance = v_locked + p_amount, updated_at = NOW()
   WHERE user_id = p_user_id;
  INSERT INTO public.ledger_entries (user_id, type, amount, balance_type, direction, reference_id, description, balance_before, balance_after)
  VALUES (p_user_id, 'withdrawal_lock', p_amount, 'available', 'debit', p_ref_id, p_description, v_avail, v_avail - p_amount),
         (p_user_id, 'withdrawal_lock', p_amount, 'locked', 'credit', p_ref_id, p_description, v_locked, v_locked + p_amount);
  RETURN json_build_object('success', true);
END;
$$;

-- Withdrawal paid out: the locked amount leaves the platform.
CREATE OR REPLACE FUNCTION public.finalize_withdrawal(p_user_id UUID, p_amount NUMERIC, p_withdrawal_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE v_locked NUMERIC;
BEGIN
  SELECT locked_balance INTO v_locked FROM public.ledger_accounts WHERE user_id = p_user_id FOR UPDATE;
  UPDATE public.ledger_accounts
     SET locked_balance = v_locked - p_amount, settled_balance = settled_balance + p_amount, updated_at = NOW()
   WHERE user_id = p_user_id;
  INSERT INTO public.ledger_entries (user_id, type, amount, balance_type, direction, reference_id, description, balance_before, balance_after)
  VALUES (p_user_id, 'withdrawal_settle', p_amount, 'locked', 'debit', p_withdrawal_id::text, 'USDT withdrawal sent', v_locked, v_locked - p_amount);
END;
$$;

-- Withdrawal rejected: the locked amount goes back to available.
CREATE OR REPLACE FUNCTION public.fail_withdrawal(p_user_id UUID, p_amount NUMERIC, p_withdrawal_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE v_avail NUMERIC; v_locked NUMERIC;
BEGIN
  SELECT available_balance, locked_balance INTO v_avail, v_locked
    FROM public.ledger_accounts WHERE user_id = p_user_id FOR UPDATE;
  UPDATE public.ledger_accounts
     SET locked_balance = v_locked - p_amount, available_balance = v_avail + p_amount, updated_at = NOW()
   WHERE user_id = p_user_id;
  INSERT INTO public.ledger_entries (user_id, type, amount, balance_type, direction, reference_id, description, balance_before, balance_after)
  VALUES (p_user_id, 'withdrawal_refund', p_amount, 'locked', 'debit', p_withdrawal_id::text, 'USDT withdrawal refunded', v_locked, v_locked - p_amount),
         (p_user_id, 'withdrawal_refund', p_amount, 'available', 'credit', p_withdrawal_id::text, 'USDT withdrawal refunded', v_avail, v_avail + p_amount);
END;
$$;

-- ============================================================ USDT withdrawals (sent by hand by an admin)

CREATE TABLE IF NOT EXISTS public.usdt_withdrawals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id),
  destination_address TEXT NOT NULL,
  usdt_amount NUMERIC(20, 6) NOT NULL CHECK (usdt_amount > 0),
  fee NUMERIC(20, 6) NOT NULL DEFAULT 0,
  net_amount NUMERIC(20, 6) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  tx_hash TEXT UNIQUE,
  failure_reason TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_usdt_withdrawals_user ON public.usdt_withdrawals (user_id, created_at DESC);

-- ============================================================ USDT -> INR sell orders
-- create (available -> locked, PROCESSING) -> admin pays INR by bank transfer ->
-- complete: paid (SUCCESS, locked USDT spent) or refund (REFUNDED, locked -> available).

CREATE TABLE IF NOT EXISTS public.exchange_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id),
  usdt_amount NUMERIC(20, 6) NOT NULL CHECK (usdt_amount > 0),
  inr_amount NUMERIC(20, 2) NOT NULL,
  rate NUMERIC(20, 2) NOT NULL,
  bank_account_id UUID REFERENCES public.bank_accounts(id),
  status TEXT NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING', 'SUCCESS', 'REFUNDED')),
  idempotency_key TEXT UNIQUE,
  payout_reference TEXT,
  failure_reason TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_exchange_orders_user ON public.exchange_orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exchange_orders_open ON public.exchange_orders (created_at) WHERE status = 'PROCESSING';

CREATE OR REPLACE FUNCTION public.create_exchange_order(
  p_user_id UUID, p_usdt_amount NUMERIC, p_inr_amount NUMERIC, p_rate NUMERIC,
  p_bank_account_id UUID, p_idempotency_key TEXT
) RETURNS JSON LANGUAGE plpgsql AS $$
DECLARE v_avail NUMERIC; v_locked NUMERIC; v_id UUID;
BEGIN
  IF p_usdt_amount IS NULL OR p_usdt_amount <= 0 THEN
    RETURN json_build_object('success', false, 'message', 'Amount must be greater than zero');
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
            'Sell order paid out: ' || COALESCE(p_note, ''), v_locked, v_locked - o.usdt_amount);
  ELSE
    UPDATE public.ledger_accounts
       SET locked_balance = v_locked - o.usdt_amount, available_balance = v_avail + o.usdt_amount, updated_at = NOW()
     WHERE user_id = o.user_id;
    INSERT INTO public.ledger_entries (user_id, type, amount, balance_type, direction, reference_id, description, balance_before, balance_after)
    VALUES (o.user_id, 'exchange_refund', o.usdt_amount, 'locked', 'debit', o.id::text, 'Sell order refunded', v_locked, v_locked - o.usdt_amount),
           (o.user_id, 'exchange_refund', o.usdt_amount, 'available', 'credit', o.id::text, 'Sell order refunded', v_avail, v_avail + o.usdt_amount);
  END IF;
  RETURN json_build_object('user_id', o.user_id, 'status', o.status);
END;
$$;

-- ============================================================ USDT deposits (GasFree)
-- One permanent HD-derived GasFree address per user. See docs/GASFREE_SWEEP_IMPLEMENTATION.md.

CREATE SEQUENCE IF NOT EXISTS public.deposit_derivation_index_seq START 0 MINVALUE 0;

CREATE OR REPLACE FUNCTION public.next_derivation_index() RETURNS BIGINT
LANGUAGE sql AS $$ SELECT nextval('public.deposit_derivation_index_seq') $$;

CREATE TABLE IF NOT EXISTS public.deposit_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id),
  network TEXT NOT NULL DEFAULT 'tron',
  method TEXT NOT NULL DEFAULT 'gasfree',
  tron_address TEXT NOT NULL UNIQUE,   -- the GasFree address users send to
  eoa_address TEXT NOT NULL UNIQUE,    -- the HD key that signs sweeps
  derivation_index BIGINT NOT NULL UNIQUE,
  is_used BOOLEAN NOT NULL DEFAULT TRUE,
  hot_until TIMESTAMPTZ,               -- watch window end (user opened the deposit screen)
  next_poll_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_polled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_addresses_user_gasfree
  ON public.deposit_addresses (user_id, network) WHERE method = 'gasfree';
CREATE INDEX IF NOT EXISTS idx_deposit_addresses_poll_due
  ON public.deposit_addresses (next_poll_at) WHERE method = 'gasfree';

CREATE TABLE IF NOT EXISTS public.deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  network TEXT NOT NULL,
  deposit_address_id UUID NOT NULL REFERENCES public.deposit_addresses(id),
  user_id UUID NOT NULL REFERENCES public.users(id),
  tx_id TEXT NOT NULL,
  log_index INT NOT NULL,
  from_address TEXT NOT NULL,
  amount_raw NUMERIC(38, 0) NOT NULL CHECK (amount_raw > 0),
  fee_raw NUMERIC(38, 0) NOT NULL DEFAULT 0,
  block_number BIGINT NOT NULL,
  block_ts TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('credited', 'review')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (network, tx_id, log_index)
);
CREATE INDEX IF NOT EXISTS idx_deposits_user ON public.deposits (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deposits_review ON public.deposits (created_at) WHERE status = 'review';

-- At most one open sweep per address.
CREATE TABLE IF NOT EXISTS public.sweeps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_address_id UUID NOT NULL REFERENCES public.deposit_addresses(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed')),
  amount_raw NUMERIC(38, 0),
  max_fee_raw NUMERIC(38, 0),
  actual_fee_raw NUMERIC(38, 0),
  nonce BIGINT,
  deadline BIGINT,
  trace_id TEXT,
  tx_id TEXT,
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  last_response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sweeps_one_open
  ON public.sweeps (deposit_address_id) WHERE status IN ('pending', 'submitted');
CREATE INDEX IF NOT EXISTS idx_sweeps_actionable
  ON public.sweeps (next_attempt_at) WHERE status IN ('pending', 'submitted');

-- Daily balance audit results (gasfreeWorker.runAudit).
CREATE TABLE IF NOT EXISTS public.audit_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger TEXT NOT NULL,
  addresses_checked INT NOT NULL,
  issues JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Atomic: record event -> credit gross -> debit processing fee -> open sweep.
-- Below-minimum deposits are recorded as 'review' and not credited.
CREATE OR REPLACE FUNCTION public.record_deposit(
  p_network TEXT, p_deposit_address_id UUID, p_tx_id TEXT, p_log_index INT, p_from TEXT,
  p_amount_raw NUMERIC, p_block_number BIGINT, p_block_ts TIMESTAMPTZ, p_min_net_raw NUMERIC, p_fee_raw NUMERIC
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_user UUID;
  v_id UUID;
  v_gross NUMERIC := p_amount_raw / 1000000;
  v_fee NUMERIC := p_fee_raw / 1000000;
  v_before NUMERIC;
  v_ref TEXT := p_tx_id || ':' || p_log_index;
BEGIN
  SELECT user_id INTO STRICT v_user FROM public.deposit_addresses WHERE id = p_deposit_address_id;

  INSERT INTO public.deposits (network, deposit_address_id, user_id, tx_id, log_index, from_address,
                               amount_raw, fee_raw, block_number, block_ts, status)
  VALUES (p_network, p_deposit_address_id, v_user, p_tx_id, p_log_index, p_from,
          p_amount_raw, p_fee_raw, p_block_number, p_block_ts,
          CASE WHEN p_amount_raw - p_fee_raw >= p_min_net_raw THEN 'credited' ELSE 'review' END)
  ON CONFLICT (network, tx_id, log_index) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN jsonb_build_object('inserted', false);
  END IF;
  IF p_amount_raw - p_fee_raw < p_min_net_raw THEN
    RETURN jsonb_build_object('inserted', true, 'deposit_id', v_id, 'status', 'review', 'user_id', v_user);
  END IF;

  INSERT INTO public.ledger_accounts (user_id) VALUES (v_user) ON CONFLICT (user_id) DO NOTHING;
  SELECT available_balance INTO v_before FROM public.ledger_accounts WHERE user_id = v_user FOR UPDATE;

  INSERT INTO public.ledger_entries (user_id, type, amount, balance_type, direction, reference_id,
                                     description, balance_before, balance_after)
  VALUES (v_user, 'deposit', v_gross, 'available', 'credit', v_ref,
          'USDT-TRC20 deposit ' || p_tx_id, v_before, v_before + v_gross);
  IF v_fee > 0 THEN
    INSERT INTO public.ledger_entries (user_id, type, amount, balance_type, direction, reference_id,
                                       description, balance_before, balance_after)
    VALUES (v_user, 'deposit_fee', v_fee, 'available', 'debit', v_ref,
            'Processing fee for deposit ' || p_tx_id, v_before + v_gross, v_before + v_gross - v_fee);
  END IF;
  UPDATE public.ledger_accounts SET available_balance = v_before + v_gross - v_fee, updated_at = NOW()
   WHERE user_id = v_user;

  INSERT INTO public.sweeps (deposit_address_id) VALUES (p_deposit_address_id)
  ON CONFLICT (deposit_address_id) WHERE status IN ('pending', 'submitted') DO NOTHING;

  RETURN jsonb_build_object('inserted', true, 'deposit_id', v_id, 'status', 'credited', 'user_id', v_user,
                            'gross', v_gross, 'fee', v_fee, 'net', v_gross - v_fee);
END;
$$;

-- Admin "Credit anyway" for a held (below-minimum) deposit. Credits amount minus fee
-- (never below zero) and opens a sweep. Works once per deposit.
CREATE OR REPLACE FUNCTION public.credit_held_deposit(p_deposit_id UUID) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE d public.deposits%ROWTYPE; v_gross NUMERIC; v_fee NUMERIC; v_before NUMERIC; v_ref TEXT;
BEGIN
  UPDATE public.deposits SET status = 'credited', fee_raw = LEAST(fee_raw, amount_raw)
   WHERE id = p_deposit_id AND status = 'review'
  RETURNING * INTO d;
  IF d.id IS NULL THEN
    RAISE EXCEPTION 'Deposit is not waiting for review';
  END IF;

  v_gross := d.amount_raw / 1000000;
  v_fee := d.fee_raw / 1000000;
  v_ref := d.tx_id || ':' || d.log_index;

  INSERT INTO public.ledger_accounts (user_id) VALUES (d.user_id) ON CONFLICT (user_id) DO NOTHING;
  SELECT available_balance INTO v_before FROM public.ledger_accounts WHERE user_id = d.user_id FOR UPDATE;

  INSERT INTO public.ledger_entries (user_id, type, amount, balance_type, direction, reference_id,
                                     description, balance_before, balance_after)
  VALUES (d.user_id, 'deposit', v_gross, 'available', 'credit', v_ref,
          'USDT-TRC20 deposit ' || d.tx_id || ' (approved by admin)', v_before, v_before + v_gross);
  IF v_fee > 0 THEN
    INSERT INTO public.ledger_entries (user_id, type, amount, balance_type, direction, reference_id,
                                       description, balance_before, balance_after)
    VALUES (d.user_id, 'deposit_fee', v_fee, 'available', 'debit', v_ref,
            'Processing fee for deposit ' || d.tx_id, v_before + v_gross, v_before + v_gross - v_fee);
  END IF;
  UPDATE public.ledger_accounts SET available_balance = v_before + v_gross - v_fee, updated_at = NOW()
   WHERE user_id = d.user_id;

  INSERT INTO public.sweeps (deposit_address_id) VALUES (d.deposit_address_id)
  ON CONFLICT (deposit_address_id) WHERE status IN ('pending', 'submitted') DO NOTHING;

  RETURN jsonb_build_object('user_id', d.user_id, 'credited', v_gross - v_fee);
END;
$$;

-- ============================================================ lock down

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','admins','audit_logs','kyc_records','referral_history','bank_accounts',
    'system_settings','ledger_accounts','ledger_entries','usdt_withdrawals','exchange_orders',
    'deposit_addresses','deposits','sweeps','audit_reports'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- The backend (service_role) gets explicit access, so this works even when the project
-- was created with "Automatically expose new tables" turned off. anon/authenticated get nothing.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT USAGE ON SCHEMA public TO service_role;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
  END IF;
END $$;

-- Only the backend may call the money functions.
DO $$
DECLARE f TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    FOREACH f IN ARRAY ARRAY['lock_funds(uuid,numeric,text,text)','finalize_withdrawal(uuid,numeric,uuid)',
      'fail_withdrawal(uuid,numeric,uuid)','create_exchange_order(uuid,numeric,numeric,numeric,uuid,text)',
      'complete_exchange_order(uuid,boolean,text)','next_derivation_index()',
      'record_deposit(text,uuid,text,integer,text,numeric,bigint,timestamptz,numeric,numeric)',
      'credit_held_deposit(uuid)'] LOOP
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    END LOOP;
  END IF;
END $$;

-- Private bucket for KYC photos (admin panel gets 1-hour signed links).
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public) VALUES ('KYC-DOCUMENTS', 'KYC-DOCUMENTS', false)
    ON CONFLICT (id) DO UPDATE SET public = false;
  END IF;
END $$;
