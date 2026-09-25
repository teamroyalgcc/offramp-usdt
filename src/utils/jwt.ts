import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();

import config from '../config/index.js';

const JWT_SECRET = config.jwtSecret;

export const generateToken = (payload: object): string => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
};

export const verifyToken = (token: string): any => {
  return jwt.verify(token, JWT_SECRET);
};
