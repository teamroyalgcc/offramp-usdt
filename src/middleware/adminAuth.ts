import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import supabase from '../utils/supabase.js';
import config from '../config/index.js';
import { AdminRequest } from '../controllers/adminController.js';

export const adminAuth = async (req: AdminRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, config.jwtSecret) as { id: string };
    
    const { data: admin, error } = await supabase
      .from('admins')
      .select('id, username, role')
      .eq('id', decoded.id)
      .maybeSingle();

    if (error || !admin) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    req.admin = admin;
    next();
  } catch (err) {
    res.status(401).json({ message: 'Invalid session' });
  }
};

// Role matrix: staff accounts can look but not move money or change users/settings.
export const notStaff = (req: AdminRequest, res: Response, next: NextFunction) =>
  req.admin?.role === 'staff' ? res.status(403).json({ message: 'Staff accounts are read-only' }) : next();
