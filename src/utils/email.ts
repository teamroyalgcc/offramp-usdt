import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  // CRITICAL FIX: Force IPv4 to prevent ENETUNREACH resolution to IPv6
  family: 4, 
  // Optimized for production platforms like Render
  pool: true,
  maxConnections: 3,
  maxMessages: 100,
  connectionTimeout: 10000, 
  greetingTimeout: 5000,    
  tls: {
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2'
  }
} as any);

/**
 * Sends a 6-digit numeric OTP to the user for authentication.
 * Tailored with a premium purple theme as per user requirement.
 */
export const sendOTPEmail = async (to: string, otp: string) => {
  const mailOptions = {
    from: `"Royal GCC Support" <${process.env.SMTP_USER}>`,
    to,
    subject: `Your OTP Code: ${otp}`,
    text: `Your Royal GCC verification code is: ${otp}. It will expire in 10 minutes.`,
    html: `
      <div style="background-color: #F9FAFB; padding: 40px 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
        <div style="max-width: 500px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          
          <!-- Purple Header -->
          <div style="background-color: #5246E5; padding: 20px; text-align: center;">
            <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: bold;">Your OTP Code</h1>
          </div>

          <!-- Body Content -->
          <div style="padding: 30px; color: #374151; line-height: 1.6;">
            <p style="margin-top: 0;">Hello,</p>
            <p>Your One-Time Password (OTP) for account verification is:</p>
            
            <!-- OTP Box -->
            <div style="background-color: #F3F4F6; border-radius: 8px; padding: 20px; text-align: center; margin: 25px 0;">
              <span style="font-size: 36px; font-weight: bold; color: #5246E5; letter-spacing: 2px;">${otp}</span>
            </div>

            <p style="font-size: 14px;">This OTP is valid for <strong>10 minutes</strong>. Please do not share this code with anyone.</p>
            
            <p style="font-size: 14px; margin-bottom: 5px;">If you didn't request this code, please ignore this email.</p>
            <p style="font-size: 14px;">Thank you for using our service!</p>
          </div>

          <!-- Footer -->
          <div style="background-color: #F9FAFB; padding: 15px; text-align: center; border-top: 1px solid #E5E7EB;">
            <p style="font-size: 12px; color: #9CA3AF; margin: 0;">&copy; ${new Date().getFullYear()} Royal GCC Team. All rights reserved.</p>
          </div>

        </div>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
};
