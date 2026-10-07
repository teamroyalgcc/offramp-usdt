import { Request, Response, NextFunction } from 'express';

// Money-out and bank routes need approved KYC (deposits do not). Runs after authenticate, which loads kyc_status.
export const requireKyc = (req: Request, res: Response, next: NextFunction) => {
  if ((req as any).user?.kycStatus !== 'approved') {
    return res.status(403).json({ error: 'Complete KYC verification first.' });
  }
  next();
};
