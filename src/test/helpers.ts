import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config/env.js';
import type { SmsProvider } from '../lib/sms.js';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test',
    jwtSecret: 'test-secret-that-is-at-least-32-characters-long',
    // SDR-007. Import machine key is off by default in tests (super_admin JWT path);
    // the import tests that exercise the key path pass their own via overrides.
    importApiKey: undefined,
    accessTokenTtl: '15m',
    refreshTokenTtlDays: 30,
    otpTtlSeconds: 300,
    otpLength: 6,
    otpMaxAttempts: 5,
    smsProvider: 'mock',
    mockOtpEcho: false,
    storageProvider: 'mock',
    s3Region: 'ap-south-1',
    mediaUrlTtlSeconds: 604800,
    uploadMaxBytes: 10 * 1024 * 1024,
    ...overrides,
  };
}

// Minimal PrismaClient stub exposing only the DB-probe surface (health tests).
// The cast is deliberate and test-scoped: only `$queryRaw` is exercised.
export function fakeDbProbe(queryImpl: () => Promise<unknown>): PrismaClient {
  return {
    $queryRaw: queryImpl,
    $connect: async () => undefined,
    $disconnect: async () => undefined,
  } as unknown as PrismaClient;
}

// Captures OTP codes instead of sending SMS, so integration tests can complete
// the send → verify flow deterministically.
export class CapturingSmsProvider implements SmsProvider {
  readonly name = 'capturing';
  readonly sent: Array<{ phone: string; code: string }> = [];

  async sendOtp(phone: string, code: string): Promise<void> {
    this.sent.push({ phone, code });
  }

  last(phone: string): string | undefined {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      const entry = this.sent[i];
      if (entry !== undefined && entry.phone === phone) return entry.code;
    }
    return undefined;
  }
}
