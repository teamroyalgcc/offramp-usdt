import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

const smtpPort = Number(process.env.SMTP_PORT) || 587;
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: smtpPort,
  secure: smtpPort === 465 || process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  family: 4, 
  pool: false,
  connectionTimeout: 30000, 
  greetingTimeout: 30000,   
  socketTimeout: 30000,
  tls: {
    servername: (process.env.SMTP_HOST || 'smtp.gmail.com').trim(),
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2'
  },
} as any);

const FROM_NAME = 'Royal GCC Support';

/**
 * Sends through Brevo's HTTPS API when BREVO_API_KEY is set (Render's free tier
 * blocks outbound SMTP ports), otherwise through SMTP.
 */
export const sendEmail = async (to: string, subject: string, text: string, html?: string) => {
  const sender = process.env.EMAIL_FROM || process.env.SMTP_USER;
  if (process.env.BREVO_API_KEY) {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { name: FROM_NAME, email: sender },
        to: [{ email: to }],
        subject,
        textContent: text,
        ...(html ? { htmlContent: html } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Brevo HTTP ${res.status}: ${await res.text()}`);
    return;
  }
  await transporter.sendMail({ from: `"${FROM_NAME}" <${sender}>`, to, subject, text, html });
};

/**
 * Sends a 6-digit numeric OTP to the user for authentication.
 * Tailored with a premium purple theme as per user requirement.
 */
export const sendOTPEmail = async (to: string, otp: string) => {
  await sendEmail(
    to,
    `Your OTP Code: ${otp}`,
    `Your Royal GCC verification code is: ${otp}. It will expire in 10 minutes.`,
    `
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
  );
};
