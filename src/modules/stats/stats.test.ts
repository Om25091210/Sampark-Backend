import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';

const prisma = new PrismaClient();
const config = testConfig();
// Unique to this file. Test files run in parallel against one DB and delete their
// own fixtures by phone in afterAll — a shared number would let one file delete a
// user another still references (an FK failure on the other's report.create).
// In use elsewhere: 10-12 cadres, 30-31 reports, 40-42 reports-media, 50-53 officers.
const PHONE = '+919000000060';
const TOKEN = 'STATFIXTURE';

let officerId = 0;
let officerToken = '';
const cadreIds: number[] = [];

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const makeApp = (): Promise<FastifyInstance> => buildApp({ config, prisma, logger: false });

const DAY_MS = 24 * 60 * 60 * 1000;

interface Stats {
  totalCadres: number;
  activeAlerts: number;
  reportsThisWeek: number;
  pendingReporting: number;
  byCategory: {
    surrendered: { district: number; other: number; total: number };
    thana: number;
    jail: number;
  };
}

beforeAll(async () => {
  const officer = await prisma.user.upsert({
    where: { phone: PHONE }, update: { deletedAt: null, role: 'officer', name: 'Stats Officer' },
    create: { phone: PHONE, name: 'Stats Officer', role: 'officer' },
  });
  officerId = officer.id;
  officerToken = await signAccessToken({ sub: officerId, role: 'officer' }, config.jwtSecret, '15m');

  await prisma.cadre.deleteMany({ where: { name: { startsWith: TOKEN } } });

  const base = {
    phone: '+910000000300', thana: 'स्टैट', currentAddress: 'Stats fixture',
    designation: 'Fixture', aliases: [] as string[],
  };

  // A distinctive sub-population so the endpoint's fields can be shown to reflect
  // real queries rather than hardcoded numbers. The dashboard stats count the WHOLE
  // table (they cannot be scoped by search), and Vitest runs files in parallel
  // against one database — so, per ADR-018, exact global counts are NOT asserted.
  // What IS asserted: the partition/subset math (exact, true regardless of other
  // rows) and that each fixture row moves its field (robust lower bounds).
  const cAlert = await prisma.cadre.create({
    data: { ...base, name: `${TOKEN}-ALERT`, category: 'surrendered', surrenderOrigin: 'district', alertLevel: 'critical' },
  }); // district +1, activeAlerts +1, never-reported -> pending +1
  const cOther = await prisma.cadre.create({
    data: { ...base, name: `${TOKEN}-OTHER`, category: 'surrendered', surrenderOrigin: 'other', alertLevel: 'normal' },
  }); // other +1, gets a fresh report -> NOT pending, reportsThisWeek +1
  const cThana = await prisma.cadre.create({
    data: { ...base, name: `${TOKEN}-THANA`, category: 'thana', alertLevel: 'normal' },
  }); // thana +1, only a stale (40d) report -> pending +1, NOT in reportsThisWeek
  cadreIds.push(cAlert.id, cOther.id, cThana.id);

  await prisma.report.create({
    data: {
      cadreId: cOther.id, reportedById: officerId, reportingPlace: 'thana',
      specificLocation: 'x', personStatus: 'alive', currentPhone: '+910', currentActivity: 'y',
      reportedAt: new Date(Date.now() - 2 * DAY_MS), // within the 7-day and 30-day windows
    },
  });
  await prisma.report.create({
    data: {
      cadreId: cThana.id, reportedById: officerId, reportingPlace: 'thana',
      specificLocation: 'x', personStatus: 'alive', currentPhone: '+910', currentActivity: 'y',
      reportedAt: new Date(Date.now() - 40 * DAY_MS), // older than 30 days -> still pending
    },
  });
});

afterAll(async () => {
  await prisma.report.deleteMany({ where: { cadreId: { in: cadreIds } } });
  await prisma.cadre.deleteMany({ where: { name: { startsWith: TOKEN } } });
  await prisma.user.deleteMany({ where: { phone: PHONE } });
  await prisma.$disconnect();
});

describe('stats', () => {
  it('GET /stats/dashboard without a token → 401', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/stats/dashboard' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns the full shape with integer counts', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/stats/dashboard', headers: auth(officerToken) });
    expect(res.statusCode).toBe(200);
    const s = res.json() as Stats;
    for (const n of [s.totalCadres, s.activeAlerts, s.reportsThisWeek, s.pendingReporting,
      s.byCategory.surrendered.district, s.byCategory.surrendered.other, s.byCategory.surrendered.total,
      s.byCategory.thana, s.byCategory.jail]) {
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }
    await app.close();
  });

  it('the three categories partition the total, and origin is a subset of surrendered', async () => {
    // Exact invariants — true no matter what other test files have in the table.
    const app = await makeApp();
    const s = (await app.inject({ method: 'GET', url: '/api/v1/stats/dashboard', headers: auth(officerToken) })).json() as Stats;
    expect(s.totalCadres).toBe(s.byCategory.surrendered.total + s.byCategory.thana + s.byCategory.jail);
    // district + other ≤ total: a surrendered cadre may have a NULL origin (ADR-019),
    // so the two tiles need not sum to the surrendered total.
    expect(s.byCategory.surrendered.district + s.byCategory.surrendered.other)
      .toBeLessThanOrEqual(s.byCategory.surrendered.total);
    await app.close();
  });

  it('each fixture row is reflected in its field (counts are live, not hardcoded)', async () => {
    const app = await makeApp();
    const s = (await app.inject({ method: 'GET', url: '/api/v1/stats/dashboard', headers: auth(officerToken) })).json() as Stats;
    // Lower bounds: my fixture contributes at least this much; parallel data only adds.
    expect(s.byCategory.surrendered.district).toBeGreaterThanOrEqual(1);
    expect(s.byCategory.surrendered.other).toBeGreaterThanOrEqual(1);
    expect(s.byCategory.thana).toBeGreaterThanOrEqual(1);
    expect(s.activeAlerts).toBeGreaterThanOrEqual(1);
    expect(s.reportsThisWeek).toBeGreaterThanOrEqual(1); // the 2-day-old report
    expect(s.pendingReporting).toBeGreaterThanOrEqual(2); // never-reported + 40-day-stale
    expect(s.totalCadres).toBeGreaterThanOrEqual(3);
    await app.close();
  });
});
