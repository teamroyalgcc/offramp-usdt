import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const configSchema = z.object({
  PORT: z.string().default('3000').transform(Number),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
  NODE_ENV: z.enum(['development', 'production', 'test', 'mainnet', 'testnet']).default('production'),
  TRON_NETWORK: z.enum(['mainnet', 'testnet']).default('mainnet'),
  TRON_PRO_API_KEY: z.string().optional(),
  TREASURY_ADDRESS: z.string().optional(),
  ENABLE_REAL_PAYOUTS: z.string().optional().default('false').transform(v => v === 'true'),
  KYC_MODE: z.enum(['MANUAL', 'AUTO']).default('MANUAL'),
  TRON_FULL_NODE: z.string().url().default('https://api.trongrid.io'),
  TRON_SOLIDITY_NODE: z.string().url().default('https://api.trongrid.io'),
  TRON_EVENT_SERVER: z.string().url().default('https://api.trongrid.io'),
  USDT_CONTRACT_ADDRESS: z.string().optional(),
  // Deposits + sweeps (see docs/GASFREE_SWEEP_IMPLEMENTATION.md). HD_MNEMONIC is read in src/tron/seed.ts.
  DEPOSIT_MIN_USDT: z.string().default('10'),        // smaller deposits are held for admin review
  SWEEP_IMMEDIATE_USDT: z.string().default('100'),   // at or above: swept now; below: within 24 h
  SWEEP_MAX_COST_TRX: z.string().default('10').transform(Number), // per sweep, rental + burn
  NETTS_API_KEY: z.string().optional(),
  OPERATING_WALLET_PRIVATE_KEY: z.string().optional(), // hot TRX-only wallet: pays burn fallback
  OPERATING_WALLET_MIN_TRX: z.string().default('50').transform(Number), // daily alert below this
  ALERT_EMAIL: z.string().optional(),
  DATABASE_URL: z.string().optional(),
});

const env = configSchema.safeParse(process.env);

if (!env.success) {
  console.error('❌ Invalid environment variables:', JSON.stringify(env.error.format(), null, 2));
  process.exit(1);
}

const validatedConfig = env.data;

export const config = {
  port: validatedConfig.PORT,
  jwtSecret: validatedConfig.JWT_SECRET,
  supabase: {
    url: validatedConfig.SUPABASE_URL,
    serviceRoleKey: validatedConfig.SUPABASE_SERVICE_ROLE_KEY,
  },
  nodeEnv: validatedConfig.NODE_ENV,
  treasuryAddress: validatedConfig.TREASURY_ADDRESS || '',
  enableRealPayouts: validatedConfig.ENABLE_REAL_PAYOUTS,
  kycMode: validatedConfig.KYC_MODE,
  tron: {
    network: validatedConfig.TRON_NETWORK || (validatedConfig.NODE_ENV === 'testnet' ? 'testnet' : 'mainnet'),
    fullNode: validatedConfig.TRON_NETWORK === 'testnet' ? 'https://nile.trongrid.io' : (validatedConfig.TRON_FULL_NODE || 'https://api.trongrid.io'),
    solidityNode: validatedConfig.TRON_NETWORK === 'testnet' ? 'https://nile.trongrid.io' : (validatedConfig.TRON_SOLIDITY_NODE || 'https://api.trongrid.io'),
    eventServer: validatedConfig.TRON_NETWORK === 'testnet' ? 'https://nile.trongrid.io' : (validatedConfig.TRON_EVENT_SERVER || 'https://api.trongrid.io'),
    usdtContract: validatedConfig.USDT_CONTRACT_ADDRESS
      || (validatedConfig.TRON_NETWORK === 'testnet' ? 'TXLAQ63Xg1qMAr3zCPwrCcS9R8x5QJ2GvX' : 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'),
    proApiKey: validatedConfig.TRON_PRO_API_KEY,
  },
  sweep: {
    minDepositUsdt: validatedConfig.DEPOSIT_MIN_USDT,
    immediateUsdt: validatedConfig.SWEEP_IMMEDIATE_USDT,
    maxCostTrx: validatedConfig.SWEEP_MAX_COST_TRX,
    nettsApiKey: validatedConfig.NETTS_API_KEY || '',
    operatingKey: validatedConfig.OPERATING_WALLET_PRIVATE_KEY || '',
    operatingMinTrx: validatedConfig.OPERATING_WALLET_MIN_TRX,
  },
  alertEmail: validatedConfig.ALERT_EMAIL || '',
  databaseUrl: validatedConfig.DATABASE_URL || '',
};

export default config;
