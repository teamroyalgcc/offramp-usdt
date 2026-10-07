import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import supabase from '../utils/supabase.js';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    kycStatus?: string;
  };
}

export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'No token provided' });
  }

  let decoded: { id: string };
  try {
    decoded = jwt.verify(token, config.jwtSecret) as { id: string };
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
  // Frozen or banned accounts are locked out of everything (admin "Freeze user").
  // ponytail: one lookup per request; cache for a few seconds if traffic grows.
  const { data: user } = await supabase.from('users').select('is_frozen, is_banned, kyc_status').eq('id', decoded.id).maybeSingle();
  if (!user) return res.status(401).json({ message: 'Account not found' });
  if (user.is_frozen || user.is_banned) return res.status(403).json({ message: 'Your account is frozen. Please contact support.' });
  req.user = { id: decoded.id, kycStatus: user.kyc_status };
  next();
};

/** Client-sent `Idempotency-Key` header (a retry or double tap reuses it), else a fresh one per request. */
export const idempotencyKey = (req: Request) => {
  const key = req.get('idempotency-key');
  return key && /^[\w-]{8,64}$/.test(key) ? key : crypto.randomUUID();
};
