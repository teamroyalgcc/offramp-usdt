import config from '../config/index.js';
import { TronChain } from '../tron/chain.js';

const chain = new TronChain({
  fullNode: config.tron.fullNode,
  solidityNode: config.tron.solidityNode,
  apiKey: config.tron.proApiKey,
});

// Read-only. The backend never signs from the treasury.
// Uses the same finalized constant calls as the deposit worker (TronWeb's contract().at() needs a
// default address set and silently returned 0 USDT on the dashboard).
export class TronService {
  async getTreasuryBalance(address: string): Promise<{ trx: number | null; usdt: number | null }> {
    if (!address) return { trx: null, usdt: null };
    try {
      const [res, usdtRaw] = await Promise.all([chain.resources(address), chain.usdtBalance(config.tron.usdtContract, address)]);
      return { trx: Number(res.trxSun) / 1e6, usdt: Number(usdtRaw) / 1e6 };
    } catch (err: any) {
      console.error('[TRON_SERVICE] Failed to get treasury balance:', err.message);
      return { trx: null, usdt: null };
    }
  }
}

export default new TronService();
