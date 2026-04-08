import { TronWeb } from 'tronweb';
import config from '../config/index.js';
import supabase from '../utils/supabase.js';

const TRON_CONFIG = {
  fullNode: config.tron.fullNode,
  solidityNode: config.tron.solidityNode,
  eventServer: config.tron.eventServer
};

const tronWeb = new TronWeb(TRON_CONFIG);

export class TronWorker {
  private static instance: TronWorker;
  private isProcessing: boolean = false;
  private timer: NodeJS.Timeout | null = null;

  private constructor() {}

  public static getInstance(): TronWorker {
    if (!TronWorker.instance) {
      TronWorker.instance = new TronWorker();
    }
    return TronWorker.instance;
  }

  public start() {
    console.log('[TRON_WORKER] Starting persistent deposit listener...');
    // Poll every 10 seconds for deposits
    this.timer = setInterval(() => this.checkDeposits(), 10000);
  }

  public stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async checkDeposits() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      // Find active deposit addresses that haven't been swept yet
      const { data: addresses, error } = await supabase
        .from('deposit_addresses')
        .select('*')
        .eq('is_used', false);
      
      if (error) throw error;
      if (!addresses || addresses.length === 0) return;

      for (const addr of addresses) {
        await this.processAddress(addr);
      }
    } catch (err) {
      console.error('[TRON_WORKER] Error checking deposits:', err);
    } finally {
      this.isProcessing = false;
    }
  }

  private async processAddress(addr: any) {
    try {
      const contract = await tronWeb.contract().at(config.tron.usdtContract);
      const balanceUSDTBig = await contract.balanceOf(addr.tron_address).call();
      const balanceUSDT = Number(balanceUSDTBig) / 1000000;

      if (balanceUSDT > 0) {
        console.log(`[TRON_WORKER] Deposit detected: ${balanceUSDT} USDT at ${addr.tron_address}`);
        const txHash = `DEP_${addr.tron_address}_${Date.now()}`;
        
        // Record in blockchain_transactions for user and admin tracking
        const { error: txError } = await supabase
          .from('blockchain_transactions')
          .insert({
            tx_hash: txHash,
            network: config.nodeEnv === 'production' ? 'tron_mainnet' : 'tron_shasta',
            from_address: 'unknown',
            to_address: addr.tron_address,
            amount: balanceUSDT,
            status: 'credited',
            user_id: addr.user_id,
            processed_at: new Date().toISOString()
          });

        if (txError) {
          console.error(`[TRON_WORKER] Error recording blockchain_transaction:`, txError.message);
        }
        
        // Use RPC function for atomic credit
        const { data, error } = await supabase.rpc('credit_deposit', {
          p_user_id: addr.user_id,
          p_amount: balanceUSDT,
          p_tx_hash: txHash,
          p_description: `USDT Deposit via ${addr.tron_address}`
        });

        if (error) {
          console.error(`[TRON_WORKER] RPC credit_deposit failed for ${addr.tron_address}:`, error.message);
          return;
        }

        if (data && data.success === false) {
          console.log(`[TRON_WORKER] Deposit already processed or failed: ${data.message}`);
          return;
        }

        // Mark address as used/processed
        await supabase
          .from('deposit_addresses')
          .update({ is_used: true, last_balance: balanceUSDT })
          .eq('id', addr.id);
          
        console.log(`[TRON_WORKER] Successfully credited ${balanceUSDT} USDT to user ${addr.user_id}`);
      }
    } catch (err: any) {
      console.error(`[TRON_WORKER] Error processing address ${addr.tron_address}:`, err.message);
    }
  }
}

export default TronWorker.getInstance();
