import { Response } from 'express';
import { BaseController } from './baseController.js';
import withdrawalService from '../services/withdrawalService.js';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { AuthService } from '../services/auth.service.js';
import { idempotencyKey } from '../middleware/authMiddleware.js';
import adminService from '../services/adminService.js';
import { withdrawalAddressError } from '../tron/usdt.js';
import config from '../config/index.js';
import supabase from '../utils/supabase.js';

export class WithdrawalController extends BaseController {
  async requestWithdrawal(req: AuthRequest, res: Response) {
    try {
      if (!req.user) return this.unauthorized(res);
      
      const { destination_address, usdt_amount } = req.body;
      
      if (!destination_address || !usdt_amount) {
        return this.clientError(res, 'Missing destination_address or usdt_amount');
      }

      const { data: own } = await supabase.from('deposit_addresses').select('id').eq('tron_address', destination_address).maybeSingle();
      const addressError = withdrawalAddressError(destination_address, [config.treasuryAddress, config.tron.usdtContract])
        ?? (own ? 'You cannot withdraw to a Royal GCC deposit address' : null);
      if (addressError) return this.clientError(res, addressError);

      const pinError = await AuthService.verifyTransactionPin(req.user.id, req.body.pin);
      if (pinError) return this.forbidden(res, pinError);

      const withdrawal = await withdrawalService.requestUSDTWithdrawal(req.user.id, {
        destination_address,
        usdt_amount: String(usdt_amount),
        idempotency_key: idempotencyKey(req),
      });

      return this.ok(res, withdrawal);
    } catch (error: any) {
      return this.clientError(res, error.message);
    }
  }

  async getMyWithdrawals(req: AuthRequest, res: Response) {
    try {
      if (!req.user) return this.unauthorized(res);

      const history = await withdrawalService.getWithdrawalHistory(req.user.id);
      return this.ok(res, history);
    } catch (error: any) {
      return this.fail(res, error.message);
    }
  }

  // Admin APIs
  async adminListAll(req: any, res: Response) {
    try {
      const withdrawals = await withdrawalService.listAllWithdrawals();
      return this.ok(res, withdrawals);
    } catch (error: any) {
      return this.fail(res, error.message);
    }
  }

  async adminProcess(req: any, res: Response) {
    try {
      const { id } = req.params;
      const { tx_hash } = req.body;
      
      if (!tx_hash) return this.clientError(res, 'Transaction hash required');

      const w = await withdrawalService.processWithdrawal(id, tx_hash);
      await adminService.logAction(req.admin.id, 'WITHDRAWAL_SENT', 'usdt_withdrawal', id, { tx_hash, user_id: w.user_id, net_amount: w.net_amount });
      return this.ok(res, { success: true, message: 'Withdrawal processed' });
    } catch (error: any) {
      return this.clientError(res, error.message);
    }
  }

  async adminReject(req: any, res: Response) {
    try {
      const { id } = req.params;
      const { reason } = req.body;
      
      if (!reason) return this.clientError(res, 'Rejection reason required');

      await withdrawalService.rejectWithdrawal(id, reason);
      await adminService.logAction(req.admin.id, 'WITHDRAWAL_REJECTED', 'usdt_withdrawal', id, { reason });
      return this.ok(res, { success: true, message: 'Withdrawal rejected and funds refunded' });
    } catch (error: any) {
      return this.clientError(res, error.message);
    }
  }
}

export default new WithdrawalController();
