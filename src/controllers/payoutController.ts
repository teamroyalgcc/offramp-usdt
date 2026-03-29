import { Response } from 'express';
import { BaseController } from './baseController.js';
import payoutService from '../services/payoutService.js';
import { AuthRequest } from '../middleware/authMiddleware.js';

export class PayoutController extends BaseController {
  async requestPayout(req: AuthRequest, res: Response) {
    try {
      if (!req.user) return this.unauthorized(res);
      
      const { bank_account_id, usdt_amount, exchange_rate } = req.body;
      
      if (!bank_account_id || !usdt_amount || !exchange_rate) {
        return this.clientError(res, 'Missing bank_account_id, usdt_amount or exchange_rate');
      }

      const payout = await payoutService.requestPayout(req.user.id, {
        bank_account_id,
        usdt_amount: Number(usdt_amount),
        exchange_rate: Number(exchange_rate)
      });

      return this.ok(res, payout);
    } catch (error: any) {
      return this.fail(res, error.message);
    }
  }

  async getMyPayouts(req: AuthRequest, res: Response) {
    try {
      if (!req.user) return this.unauthorized(res);

      const history = await payoutService.getMyPayouts(req.user.id);
      return this.ok(res, history);
    } catch (error: any) {
      return this.fail(res, error.message);
    }
  }

  // Admin APIs
  async adminListAll(req: any, res: Response) {
    try {
      const payouts = await payoutService.listAllPayouts();
      return this.ok(res, payouts);
    } catch (error: any) {
      return this.fail(res, error.message);
    }
  }

  async adminProcess(req: any, res: Response) {
    try {
      const { id } = req.params;
      const { payout_tx_id } = req.body;
      
      if (!payout_tx_id) return this.clientError(res, 'Bank reference (UTR) required');

      await payoutService.processPayout(id, payout_tx_id);
      return this.ok(res, { success: true, message: 'Payout marked as completed' });
    } catch (error: any) {
      return this.fail(res, error.message);
    }
  }

  async adminReject(req: any, res: Response) {
    try {
      const { id } = req.params;
      const { reason } = req.body;
      
      if (!reason) return this.clientError(res, 'Rejection reason required');

      await payoutService.rejectPayout(id, reason);
      return this.ok(res, { success: true, message: 'Payout rejected and USDT refunded' });
    } catch (error: any) {
      return this.fail(res, error.message);
    }
  }
}

export default new PayoutController();
