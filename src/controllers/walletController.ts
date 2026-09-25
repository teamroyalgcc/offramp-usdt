import { Request, Response } from 'express';
import { BaseController } from './baseController.js';
import walletService from '../services/walletService.js';
import { AuthRequest } from '../middleware/authMiddleware.js';

export class WalletController extends BaseController {
  async generateAddress(req: AuthRequest, res: Response) {
    try {
      if (!req.user) return this.unauthorized(res);
      
      const result = await walletService.generateDepositAddress(req.user.id);
      return this.ok(res, result);
    } catch (error: any) {
      return this.fail(res, error);
    }
  }

  async listDeposits(req: AuthRequest, res: Response) {
    try {
      if (!req.user) return this.unauthorized(res);
      return this.ok(res, await walletService.listDeposits(req.user.id));
    } catch (error: any) {
      return this.fail(res, error);
    }
  }

  async getStatement(req: AuthRequest, res: Response) {
    try {
      if (!req.user) return this.unauthorized(res);
      const { limit, before, beforeId } = req.query as Record<string, string | undefined>;
      // The cursor goes into a PostgREST filter string: accept only a timestamp and a uuid.
      if (before && (!/^[\d\-T:.+ Z]+$/.test(before) || isNaN(Date.parse(before)))) return this.clientError(res, 'Invalid before');
      if (beforeId && !/^[0-9a-f-]{36}$/i.test(beforeId)) return this.clientError(res, 'Invalid beforeId');
      return this.ok(res, await walletService.getStatement(req.user.id, Number(limit) || 50, before, beforeId));
    } catch (error: any) {
      return this.fail(res, error);
    }
  }

  async getBalance(req: AuthRequest, res: Response) {
    try {
      console.log(`[WALLET_CONTROLLER] Balance request for user: ${req.user?.id}`);
      if (!req.user) return this.unauthorized(res);

      const balance = await walletService.getBalance(req.user.id);
      return this.ok(res, balance);
    } catch (error: any) {
      console.error('[WALLET_CONTROLLER] Balance error:', error);
      return this.fail(res, error);
    }
  }
}

export default new WalletController();
