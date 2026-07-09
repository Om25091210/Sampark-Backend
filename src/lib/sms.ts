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
  ) {}

  async sendOtp(phone: string, code: string): Promise<void> {
    // In development only, surface the code (in the message string, which is not
    // subject to the Pino `*.otp` redaction) so it can be entered without a real
    // SMS. In any other environment the code is never logged.
    if (this.nodeEnv === 'development') {
      this.log.info({ phone }, `MOCK SMS — OTP for ${phone}: ${code}`);
    } else {
      this.log.info({ phone }, 'MOCK SMS — OTP dispatched (code hidden)');
    }
  }
}

export function createSmsProvider(config: AppConfig, log: FastifyBaseLogger): SmsProvider {
  switch (config.smsProvider) {
    case 'mock':
      return new MockSmsProvider(log, config.nodeEnv);
    case 'msg91':
      // Intentionally not implemented yet — no real gateway integration in Phase 1.
      throw new Error('SMS_PROVIDER=msg91 is not implemented yet; use SMS_PROVIDER=mock in development');
    default:
      return new MockSmsProvider(log, config.nodeEnv);
  }
}
