import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Diagnostic tool to check SMTP connection.
 * Run with: node dist/scripts/test-smtp.js (after build)
 * Or: npx ts-node src/scripts/test-smtp.ts
 */

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  family: 4, 
  connectionTimeout: 10000, 
  debug: true,
  logger: true
} as any);

console.log('--- Testing SMTP Connection ---');
console.log('Host:', process.env.SMTP_HOST || 'smtp.gmail.com');
console.log('Port:', process.env.SMTP_PORT || 587);
console.log('Secure:', process.env.SMTP_SECURE === 'true');
console.log('User:', process.env.SMTP_USER);

transporter.verify((error, success) => {
  if (error) {
    console.error('--- Verification Failed ---');
    console.error(error);
  } else {
    console.log('--- Server is ready to take our messages ---');
    
    // Attempt to send a test mail
    const mailOptions = {
        from: `"SMTP Test" <${process.env.SMTP_USER}>`,
        to: process.env.SMTP_USER, // Send to self
        subject: 'SMTP Diagnostic Test',
        text: 'This is a test email to verify SMTP configuration.',
        html: '<b>This is a test email to verify SMTP configuration.</b>',
    };

    console.log('--- Sending Test Email ---');
    transporter.sendMail(mailOptions, (err, info) => {
        if (err) {
            console.error('--- Send Error ---');
            console.error(err);
        } else {
            console.log('--- Email Sent Successfully ---');
            console.log(info);
        }
        process.exit(0);
    });
  }
});
