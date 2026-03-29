-- 1. Ensure USDT Withdrawals Table points to public.users
CREATE TABLE IF NOT EXISTS public.usdt_withdrawals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id),
    destination_address VARCHAR(255) NOT NULL,
    usdt_amount DECIMAL(20, 6) NOT NULL,
    fee DECIMAL(20, 6) NOT NULL,
    net_amount DECIMAL(20, 6) NOT NULL, 
    tx_hash VARCHAR(255) UNIQUE,
    status VARCHAR(50) DEFAULT 'pending', -- pending, processing, completed, failed, refunded
    failure_reason TEXT,
    retry_count INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Create Payouts Table (Offramp: USDT to INR)
CREATE TABLE IF NOT EXISTS public.payout_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id),
    bank_account_id UUID NOT NULL REFERENCES public.bank_accounts(id),
    usdt_amount DECIMAL(20, 6) NOT NULL,
    exchange_rate DECIMAL(20, 6) NOT NULL,
    inr_amount DECIMAL(20, 2) NOT NULL,
    fee_usdt DECIMAL(20, 6) NOT NULL,
    net_usdt DECIMAL(20, 6) NOT NULL,
    status VARCHAR(50) DEFAULT 'pending', -- pending, processing, approved, completed, rejected, failed
    payout_tx_id VARCHAR(255), -- UTR or Bank Reference Number
    failure_reason TEXT,
    admin_notes TEXT,
    processed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Indexes for fast lookup
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON public.usdt_withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_payouts_user ON public.payout_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON public.payout_orders(status);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON public.usdt_withdrawals(status);
