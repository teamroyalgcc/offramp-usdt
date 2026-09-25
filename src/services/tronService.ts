import { TronWeb } from 'tronweb';
import config from '../config/index.js';

const tronWeb = new TronWeb({
  fullNode: config.tron.fullNode,
  solidityNode: config.tron.solidityNode,
  eventServer: config.tron.eventServer,
  headers: config.tron.proApiKey ? { 'TRON-PRO-API-KEY': config.tron.proApiKey } : {},
});

// Read-only. The backend never signs from the treasury.
export class TronService {
  async getTreasuryBalance(address: string) {
    if (!address) return { trx: 0, usdt: 0 };
    try {
      const trxBalance = await tronWeb.trx.getBalance(address);
      const contract = await tronWeb.contract().at(config.tron.usdtContract);
      const usdtBalance = await contract.balanceOf(address).call();
      return {
        trx: tronWeb.fromSun(trxBalance),
        usdt: Number(usdtBalance) / 1000000
      };
    } catch (err) {
      console.error('[TRON_SERVICE] Failed to get treasury balance:', err);
      return { trx: 0, usdt: 0 };
    }
  }
}

export default new TronService();
