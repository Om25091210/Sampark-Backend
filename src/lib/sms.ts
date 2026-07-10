import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../config/env.js';

// Provider-agnostic SMS interface. Production wires in a real India-resident
// gateway (e.g. MSG91); development uses the mock, selected by SMS_PROVIDER.
export interface SmsProvider {
  readonly name: string;
  sendOtp(phone: string, code: string): Promise<void>;
}

class MockSmsProvider implements SmsProvider {
  readonly name = 'mock';

  constructor(
    private readonly log: FastifyBaseLogger,
    private readonly nodeEnv: string,
    private readonly mockOtpEcho: boolean,
  ) {}

  async sendOtp(phone: string, code: string): Promise<void> {
    // Surface the code (in the message string, which is not subject to the Pino
    // `*.otp` redaction) so it can be entered without a real SMS.
    //
    // `development` covers local work. MOCK_OTP_ECHO covers a *deployed* staging
    // environment, which must run NODE_ENV=production and would otherwise leave no
    // way to complete a login at all. The flag is a deliberate, narrow hole: it
    // writes the OTP to CloudWatch in plaintext, and Terraform's mock_otp_echo
    // variable defaults to false so production cannot enable it by omission.
    if (this.nodeEnv === 'development' || this.mockOtpEcho) {
      this.log.info({ phone }, `MOCK SMS — OTP for ${phone}: ${code}`);
    } else {
      this.log.info({ phone }, 'MOCK SMS — OTP dispatched (code hidden)');
    }
  }
}

export function createSmsProvider(config: AppConfig, log: FastifyBaseLogger): SmsProvider {
  if (config.mockOtpEcho && config.nodeEnv === 'production') {
    // Loud, once, at boot: the OTP is about to be written to logs in an environment
    // that calls itself production. Staging does this on purpose; anything else has
    // a misconfigured Terraform variable.
    log.warn('MOCK_OTP_ECHO=true under NODE_ENV=production — OTPs will be logged in plaintext');
  }

  switch (config.smsProvider) {
    case 'mock':
      return new MockSmsProvider(log, config.nodeEnv, config.mockOtpEcho);
    case 'msg91':
      // Intentionally not implemented yet — no real gateway integration in Phase 1.
      throw new Error('SMS_PROVIDER=msg91 is not implemented yet; use SMS_PROVIDER=mock in development');
    default:
      return new MockSmsProvider(log, config.nodeEnv, config.mockOtpEcho);
  }
}
