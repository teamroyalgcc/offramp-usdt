import supabase from '../utils/supabase.js';
import config from '../config/index.js';

export class SmsService {
  private static instance: SmsService;

  private constructor() {}

  public static getInstance(): SmsService {
    if (!SmsService.instance) {
      SmsService.instance = new SmsService();
    }
    return SmsService.instance;
  }

  async sendOTP(phoneNumber: string, otp: string): Promise<boolean> {
    console.log(`[SMS_SERVICE] Attempting to send OTP ${otp} to ${phoneNumber}`);

    // If Twilio is configured, use it
    if (config.twilio.accountSid && config.twilio.authToken && config.twilio.phoneNumber) {
      try {
        console.log('[SMS_SERVICE] Twilio configuration detected. Sending...');
        // We'll dynamic import to avoid issues if not installed yet or in different environments
        const twilio = (await import('twilio')).default;
        const client = twilio(config.twilio.accountSid, config.twilio.authToken);
        
        const message = await client.messages.create({
          body: `Your Offramp verification code is: ${otp}. Valid for 10 minutes.`,
          from: config.twilio.phoneNumber,
          to: phoneNumber
        });
        
        console.log(`[SMS_SERVICE] Twilio success! SID: ${message.sid}`);
        return true;
      } catch (error: any) {
        console.error('[SMS_SERVICE] Twilio failed:', error.message);
        console.error('[SMS_SERVICE] Full error:', error);
        // Fallback to log in development, but in production this should probably fail
        if (config.nodeEnv === 'production') return false;
      }
    } else {
      console.warn('[SMS_SERVICE] Twilio NOT configured. Missing SID, Token, or Phone Number.');
    }

    // Default behavior for development: Log to console
    console.log(`
      **************************************************
      [DEVELOPMENT ONLY / FALLBACK]
      TO: ${phoneNumber}
      MESSAGE: Your Offramp verification code is: ${otp}
      **************************************************
    `);

    return true;
  }
}

export default SmsService.getInstance();
