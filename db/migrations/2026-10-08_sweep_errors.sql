-- 2026-10-08: count unexpected sweep step errors so stuck sweeps back off and get emailed (AUDIT item 6).
ALTER TABLE public.sweeps ADD COLUMN IF NOT EXISTS errors INT NOT NULL DEFAULT 0;
