import supabase from '../utils/supabase.js';
import config from '../config/index.js';
import { TronChain } from '../tron/chain.js';
import { formatUsdt, normalizeTxHash, parseUsdt, payoutError } from '../tron/usdt.js';

const chain = new TronChain({
  fullNode: config.tron.fullNode,
  solidityNode: config.tron.solidityNode,
  apiKey: config.tron.proApiKey,
});

export class WithdrawalService {
  /** Pause flag, minimum, fee, daily limit, fund lock and insert all happen in one SQL transaction. */
  async requestUSDTWithdrawal(userId: string, data: {
    destination_address: string;
    usdt_amount: string;
    idempotency_key: string;
  }) {
    const { data: r, error } = await supabase.rpc('request_withdrawal', {
      p_user_id: userId,
      p_amount: formatUsdt(parseUsdt(data.usdt_amount)), // exact 6-decimal string, never a float
      p_destination: data.destination_address,
      p_idempotency_key: `${userId}:${data.idempotency_key}`,
    });
    if (error) throw error;
    if (!r.success) throw new Error(r.message);
    return r.withdrawal;
  }

  async getWithdrawalHistory(userId: string) {
    const { data, error } = await supabase
      .from('usdt_withdrawals')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
  }

  // Admin APIs
  async listAllWithdrawals() {
    const { data, error } = await supabase
      .from('usdt_withdrawals')
      .select('*, user:users(phone_number, account_holder_name)')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
  }

  /**
   * Admin sent the USDT by hand from the treasury wallet. We only accept the tx hash
   * if it is final on-chain and pays exactly net_amount USDT to the user's address.
   */
  async processWithdrawal(id: string, txHash: string) {
    const { data: w, error } = await supabase.from('usdt_withdrawals').select('*').eq('id', id).single();
    if (error || !w) throw new Error('Withdrawal not found');
    if (!['pending', 'processing'].includes(w.status)) throw new Error(`Withdrawal is already ${w.status}`);

    const hash = normalizeTxHash(txHash);
    if (!hash) throw new Error('The transaction hash must be 64 hex characters');
    const { count } = await supabase.from('usdt_withdrawals').select('id', { count: 'exact', head: true }).eq('tx_hash', hash);
    if (count) throw new Error('This transaction hash is already used for another withdrawal');

    const logs = await chain.solidTransfersTo(hash, config.tron.usdtContract, w.destination_address);
    const problem = payoutError(logs, {
      treasury: config.treasuryAddress, // pinned in the DB; the worker refuses to start if it differs
      expected: parseUsdt(String(w.net_amount)),
      createdAt: new Date(w.created_at),
    });
    if (problem) throw new Error(problem);

    const { error: rpcError } = await supabase.rpc('complete_withdrawal', { p_id: id, p_tx_hash: hash });
    if (rpcError) throw new Error(rpcError.message);
    return w;
  }

  async rejectWithdrawal(id: string, reason: string) {
    const { error } = await supabase.rpc('reject_withdrawal', { p_id: id, p_reason: reason });
    if (error) throw new Error(error.message);
    return true;
  }
}

export default new WithdrawalService();
