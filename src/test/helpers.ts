import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config/env.js';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test',
    jwtSecret: 'test-secret-that-is-at-least-32-characters-long',
    // SDR-007. Import machine key is off by default in tests (super_admin JWT path);
    // the import tests that exercise the key path pass their own via overrides.
    importApiKey: undefined,
    accessTokenTtl: '15m',
    refreshTokenTtlDays: 30,
    // ADR-042: the OTP/SMS config is gone — auth is email+password everywhere.
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
