import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { scanEscalations } from './notification-escalation.worker.js';
import { MockPushProvider } from '../lib/push.js';

const prisma = new PrismaClient();
const log = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as FastifyBaseLogger;
const pushProvider = new MockPushProvider();

const PHONE = '+919000000065';
const CADRE_NAME = 'TEST ESCALATION CADRE';
const DAY_MS = 86_400_000;

let officerId = 0;
let cadreId = 0;

async function setLastReportedDaysAgo(days: number | null): Promise<void> {
  await prisma.report.deleteMany({ where: { cadreId } });
  if (days === null) return; // never reported
  await prisma.report.create({
    data: {
      cadreId,
      reportingPlace: 'thana',
      specificLocation: 'x',
      personStatus: 'alive',
      currentPhone: '+910000000000',
      currentActivity: 'x',
      reportedById: officerId,
      reportedAt: new Date(Date.now() - days * DAY_MS),
    },
  });
}

beforeAll(async () => {
  const officer = await prisma.user.upsert({
    where: { phone: PHONE },
    update: { deletedAt: null, role: 'officer', name: 'Escalation Officer', thana: 'बीजापुर' },
    create: { phone: PHONE, name: 'Escalation Officer', role: 'officer', thana: 'बीजापुर' },
  });
  officerId = officer.id;

  await prisma.report.deleteMany({ where: { cadre: { name: CADRE_NAME } } });
  await prisma.cadre.deleteMany({ where: { name: CADRE_NAME } });
  const cadre = await prisma.cadre.create({
    data: {
      name: CADRE_NAME,
      phone: '+910000000099',
      thana: 'बीजापुर',
      currentAddress: 'पता',
      designation: 'Fixture',
      category: 'surrendered',
      alertLevel: 'normal',
      aliases: [],
      priorityCategory: 'A', // cadence 30d: current<=30, overdue1m 31-60, overdue2m 61-90, overdue3m >90
      assignedOfficerId: officerId,
    },
  });
  cadreId = cadre.id;
});

afterEach(async () => {
  await prisma.notification.deleteMany({ where: { cadreId } });
  await prisma.cadre.update({ where: { id: cadreId }, data: { lastEscalationTier: null } });
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { cadreId } });
  await prisma.report.deleteMany({ where: { cadreId } });
  await prisma.cadre.deleteMany({ where: { name: CADRE_NAME } });
  await prisma.$disconnect();
});

describe('notification escalation scan (ADR-046/047 + ADR-048)', () => {
  // `scanEscalations` scans every live cadre in the DB, not just this file's fixture
  // — other suites run in parallel against the same database (the same caveat
  // outbox.worker.test.ts's tests already carry), so its RETURN VALUE is a global
  // count and not asserted here. Every assertion below is scoped to OUR cadreId.

  it('notifies once when a cadre crosses into सतर्क (overdue1m), and does not repeat on an unchanged re-scan', async () => {
    await setLastReportedDaysAgo(45); // 31-60d -> overdue1m
    await scanEscalations({ prisma, pushProvider, log });

    const rows1 = await prisma.notification.findMany({ where: { cadreId } });
    expect(rows1.length).toBe(1);
    expect(rows1[0]!.title).toContain('सतर्क');

    const cadre1 = await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } });
    expect(cadre1.lastEscalationTier).toBe('overdue1m');

    await scanEscalations({ prisma, pushProvider, log });
    const rows2 = await prisma.notification.findMany({ where: { cadreId } });
    expect(rows2.length).toBe(1); // no duplicate
  });

  it('notifies again when the tier advances further (overdue1m -> overdue2m)', async () => {
    await setLastReportedDaysAgo(45); // overdue1m
    await scanEscalations({ prisma, pushProvider, log });

    await setLastReportedDaysAgo(75); // 61-90d -> overdue2m
    await scanEscalations({ prisma, pushProvider, log });

    const rows = await prisma.notification.findMany({ where: { cadreId }, orderBy: { id: 'asc' } });
    expect(rows.length).toBe(2);
    expect(rows[1]!.title).toContain('जोखिम');

    const cadre = await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } });
    expect(cadre.lastEscalationTier).toBe('overdue2m');
  });

  it('resets the marker once a new report returns the cadre to current (no new notification)', async () => {
    await setLastReportedDaysAgo(45); // overdue1m
    await scanEscalations({ prisma, pushProvider, log });

    await setLastReportedDaysAgo(1); // back to current
    await scanEscalations({ prisma, pushProvider, log });

    const cadre = await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } });
    expect(cadre.lastEscalationTier).toBeNull();
  });
});
