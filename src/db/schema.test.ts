import { describe, it, expect } from 'vitest';

// DB-independent smoke of the generated client: confirms every Phase-1 model
// delegate exists. Constructs the client but never connects (no queries).
describe('prisma generated client', () => {
  it('exposes all Phase-1 model delegates', async () => {
    process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5432/placeholder';
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    try {
      expect(prisma.user).toBeDefined();
      expect(prisma.cadre).toBeDefined();
      expect(prisma.report).toBeDefined();
      // ADR-042: otpChallenge removed with the SMS-OTP track.
      expect(prisma.refreshToken).toBeDefined();
      expect(prisma.auditLog).toBeDefined();
      expect(prisma.outboxEvent).toBeDefined();
    } finally {
      await prisma.$disconnect();
    }
  });
});
