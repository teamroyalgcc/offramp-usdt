-- GasFree -> plain HD deposit addresses swept with rented energy; no deposit fee.
-- For a database that already ran the GasFree version of db/schema.sql.
-- Run this, then re-run db/schema.sql (creates the new indexes/functions and re-applies grants).
-- Assumes no deposits exist yet (true on 2026-09-26): old GasFree address rows are deleted.
BEGIN;
DELETE FROM public.sweeps;
DELETE FROM public.deposits;
DELETE FROM public.deposit_addresses;
DROP FUNCTION IF EXISTS public.record_deposit(text,uuid,text,integer,text,numeric,bigint,timestamptz,numeric,numeric);
DROP INDEX IF EXISTS public.uq_deposit_addresses_user_gasfree;
DROP INDEX IF EXISTS public.idx_deposit_addresses_poll_due;
ALTER TABLE public.deposit_addresses DROP COLUMN IF EXISTS method;
ALTER TABLE public.deposits DROP COLUMN IF EXISTS fee_raw;
ALTER TABLE public.sweeps
  DROP COLUMN IF EXISTS max_fee_raw,
  DROP COLUMN IF EXISTS actual_fee_raw,
  DROP COLUMN IF EXISTS nonce,
  DROP COLUMN IF EXISTS deadline,
  DROP COLUMN IF EXISTS trace_id,
  ADD COLUMN IF NOT EXISTS provider TEXT,
  ADD COLUMN IF NOT EXISTS order_id TEXT,
  ADD COLUMN IF NOT EXISTS cost_trx NUMERIC(20, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rented_at TIMESTAMPTZ;
ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS pinned_treasury_address TEXT,
  ADD COLUMN IF NOT EXISTS manual_rate_inr NUMERIC CHECK (manual_rate_inr > 0),
  ADD COLUMN IF NOT EXISTS manual_rate_expires_at TIMESTAMPTZ;
COMMIT;
