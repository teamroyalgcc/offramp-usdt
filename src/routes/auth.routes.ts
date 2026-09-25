import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/authMiddleware.js';

const router = Router();

/**
 * @route   POST /api/auth/google
 * @desc    Google OAuth Login/Signup
 */
router.post('/google', AuthController.googleAuth);

/**
 * @route   POST /api/auth/send-email-otp
 * @desc    Unified Email OTP entry point (works for both signup and login)
 */
router.post('/send-email-otp', AuthController.sendEmailOTP);

/**
 * @route   POST /api/auth/verify-email-otp
 * @desc    Verify OTP and complete authentication
 */
router.post('/verify-email-otp', AuthController.verifyEmailOTP);

/**
 * @route   GET /api/auth/me
 * @desc    Get current user profile (Requires JWT)
 */
router.get('/me', authenticate, AuthController.me);

/**
 * @route   GET /api/auth/pin/status  -> { hasPin }
 * @route   POST /api/auth/pin        body { pin, currentPin? }: set or change the 6-digit transaction PIN
 */
router.get('/pin/status', authenticate, AuthController.pinStatus);
router.post('/pin', authenticate, AuthController.setPin);

export default router;
