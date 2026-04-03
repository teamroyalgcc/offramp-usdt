
import { ethers } from 'ethers';
import config from '../config/index.js';
import supabase from '../utils/supabase.js';
import wsService from './wsService.js';

const USDT_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

const BSC_RPC = "https://bsc-dataseed.binance.org/";
const BSC_USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955";

export class BSCService {
  private static instance: BSCService;
  private provider: ethers.JsonRpcProvider;
  private contract: ethers.Contract;
  private activeAddresses: Set<string> = new Set();
  private lastCacheRefresh: number = 0;

  private constructor() {
    this.provider = new ethers.JsonRpcProvider(BSC_RPC);
    this.contract = new ethers.Contract(BSC_USDT_CONTRACT, USDT_ABI, this.provider);
    this.refreshCache();
    // Refresh cache every 2 minutes
    setInterval(() => this.refreshCache(), 120000);
  }

  public static getInstance(): BSCService {
    if (!BSCService.instance) {
      BSCService.instance = new BSCService();
    }
    return BSCService.instance;
  }

  public async startListening() {
    console.log('[BSC_SERVICE] Starting BSC USDT listener...');
    
    // Ensure cache is populated before starting
    await this.refreshCache();

    // Polling interval increased to 60s to avoid rate limits
    setInterval(() => this.pollEvents(), 60000);
    
    this.contract.on("Transfer", async (from, to, value, event) => {
      // QUICK FILTER: Only proceed if 'to' is one of our active addresses
      if (this.activeAddresses.has(to.toLowerCase())) {
        await this.handleTransfer(from, to, value, event.transactionHash);
      }
    });
  }

  private async refreshCache() {
    try {
      const { data, error } = await supabase
        .from('deposit_addresses')
        .select('tron_address')
        .eq('network', 'bsc')
        .eq('is_used', false);

      if (error) throw error;

      const newAddresses = new Set<string>();
      if (data) {
        data.forEach(addr => {
          if (addr.tron_address) {
            newAddresses.add(addr.tron_address.toLowerCase());
          }
        });
      }
      
      this.activeAddresses = newAddresses;
      this.lastCacheRefresh = Date.now();
      console.log(`[BSC_SERVICE] Cache refreshed: ${this.activeAddresses.size} active BSC addresses`);
    } catch (err) {
      console.error('[BSC_SERVICE] Failed to refresh address cache:', err);
    }
  }

  public addActiveAddress(address: string) {
    this.activeAddresses.add(address.toLowerCase());
  }

  private async pollEvents() {
    try {
      const currentBlock = await this.provider.getBlockNumber();
      // Only check last 50 blocks instead of 100 to reduce data size and potential errors
      const events = await this.contract.queryFilter("Transfer", currentBlock - 50, currentBlock);
      for (const event of events) {
        if ('args' in event && event.args) {
          const [from, to, value] = event.args;
          // Filter in memory first
          if (this.activeAddresses.has(to.toLowerCase())) {
            await this.handleTransfer(from, to, value, event.transactionHash);
          }
        }
      }
    } catch (err: any) {
      if (err.message?.includes('rate limit')) {
        console.warn('[BSC_SERVICE] Polling rate limit reached. Skipping this cycle.');
      } else {
        console.error('[BSC_SERVICE] Polling error:', err.message || err);
      }
    }
  }

  private async handleTransfer(from: string, to: string, value: any, txHash: string) {
    const amount = Number(ethers.formatUnits(value, 18)); // BSC USDT uses 18 decimals
    
    // Check if this 'to' address matches any of our users' BSC deposit addresses
    const { data: addr, error } = await supabase
      .from('deposit_addresses')
      .select('*')
      .eq('network', 'bsc')
      .eq('tron_address', to.toLowerCase()) // Reusing tron_address column for BSC for simplicity
      .eq('is_used', false)
      .maybeSingle();

    if (addr) {
      console.log(`[BSC_SERVICE] Deposit detected: ${amount} USDT to ${to}`);
      await this.processBSCDeposit(addr, amount, txHash);
    }
  }

  private async processBSCDeposit(addr: any, amount: number, txHash: string) {
    try {
      const { data, error } = await supabase.rpc('credit_deposit', {
        p_user_id: addr.user_id,
        p_amount: amount,
        p_tx_hash: txHash,
        p_description: `BSC USDT Deposit via ${addr.address}`
      });

      if (error) throw error;

      await supabase
        .from('deposit_addresses')
        .update({ is_used: true, last_balance: amount })
        .eq('id', addr.id);

      wsService.sendToUser(addr.user_id, 'DEPOSIT_CREDITED', {
        network: 'BSC',
        amount,
        txHash
      });
      
      console.log(`[BSC_SERVICE] Successfully credited ${amount} USDT (BSC) to user ${addr.user_id}`);
    } catch (err) {
      console.error('[BSC_SERVICE] Error processing BSC deposit:', err);
    }
  }

  public async sendUSDT(to: string, amount: number, privateKey: string): Promise<string | null> {
    try {
      const wallet = new ethers.Wallet(privateKey, this.provider);
      const contractWithSigner = this.contract.connect(wallet) as ethers.Contract;
      const tx = await contractWithSigner.transfer(to, ethers.parseUnits(amount.toString(), 18));
      await tx.wait();
      return tx.hash;
    } catch (err) {
      console.error('[BSC_SERVICE] Send USDT failed:', err);
      return null;
    }
  }
}

export default BSCService.getInstance();
