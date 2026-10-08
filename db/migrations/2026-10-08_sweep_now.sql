-- Admin "Sweep now" + a per-sweep log of energy/TRX purchases (shown in the admin panel).
ALTER TABLE public.sweeps
  ADD COLUMN IF NOT EXISTS purchases JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS sweep_now BOOLEAN NOT NULL DEFAULT false;
