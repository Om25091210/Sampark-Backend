import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';

const prisma = new PrismaClient();
const config = testConfig();
// Unique to this file — parallel files delete their fixtures by phone (see the
// suite isolation issue). In use: 10-12 cadres, 30-31 reports, 40-42 reports-media,
// 50-53 officers, 60 stats, 70-71 here.
const PHONES = ['+919000000070', '+919000000071'];
const CADRE_NAME = 'TEST CADRE AGG';

let officerAId = 0;
let officerBId = 0;
let cadre1Id = 0;
let cadre2Id = 0;
let tokenA = '';
let tokenB = '';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const makeApp = (): Promise<FastifyInstance> => buildApp({ config, prisma, logger: false });

interface WireReport {
  id: number;
  cadreId: number;
  cadre?: { id: number; name: string };
  reportedBy: number;
  reportedAt: string;
}
interface ListBody {
  data: WireReport[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

async function seedReport(cadreId: number, reporterId: number, daysAgo: number): Promise<void> {
  await prisma.report.create({
    data: {
      cadreId, reportedById: reporterId, reportingPlace: 'thana',
      specificLocation: 'x', personStatus: 'alive', currentPhone: '+910', currentActivity: 'y',
      reportedAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
    },
  });
}

beforeAll(async () => {
  const a = await prisma.user.upsert({
    // ADR-044: both officers are posted to the fixture cadres' station.
    where: { phone: PHONES[0] },
    update: { deletedAt: null, role: 'officer', name: 'Agg Officer A', thana: 'agg' },
    create: { phone: PHONES[0]!, name: 'Agg Officer A', role: 'officer', thana: 'agg' },
  });
  const b = await prisma.user.upsert({
    where: { phone: PHONES[1] },
    update: { deletedAt: null, role: 'officer', name: 'Agg Officer B', thana: 'agg' },
    create: { phone: PHONES[1]!, name: 'Agg Officer B', role: 'officer', thana: 'agg' },
  });
  officerAId = a.id;
  officerBId = b.id;

  await prisma.cadre.deleteMany({ where: { name: { startsWith: CADRE_NAME } } });
  const c1 = await prisma.cadre.create({
    data: { name: `${CADRE_NAME} 1`, phone: '+910000000701', thana: 'agg', currentAddress: 'x',
      designation: 'x', category: 'thana', alertLevel: 'normal', aliases: [] },
  });
  const c2 = await prisma.cadre.create({
    data: { name: `${CADRE_NAME} 2`, phone: '+910000000702', thana: 'agg', currentAddress: 'x',
      designation: 'x', category: 'thana', alertLevel: 'normal', aliases: [] },
  });
  cadre1Id = c1.id;
  cadre2Id = c2.id;

  // Officer A files 3 reports spanning TWO cadres; officer B files 1. The point of
  // the aggregate is that A's record crosses cadres and excludes B's.
  await seedReport(cadre1Id, officerAId, 1);
  await seedReport(cadre1Id, officerAId, 5);
  await seedReport(cadre2Id, officerAId, 10);
  await seedReport(cadre2Id, officerBId, 2);

  tokenA = await signAccessToken({ sub: officerAId, role: 'officer' }, config.jwtSecret, '15m');
  tokenB = await signAccessToken({ sub: officerBId, role: 'officer' }, config.jwtSecret, '15m');
});

afterAll(async () => {
  await prisma.report.deleteMany({ where: { cadreId: { in: [cadre1Id, cadre2Id] } } });
  await prisma.cadre.deleteMany({ where: { name: { startsWith: CADRE_NAME } } });
  await prisma.user.deleteMany({ where: { phone: { in: PHONES } } });
  await prisma.$disconnect();
});

describe('reports aggregate (ADR-021)', () => {
  it('GET /reports without a token → 401', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/reports' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('reportedBy=me returns the caller’s own reports across cadres, newest first', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/reports?reportedBy=me&pageSize=50', headers: auth(tokenA),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ListBody;

    // Exactly A's 3 reports — B's is excluded even though it shares cadre 2.
    expect(body.total).toBe(3);
    expect(body.data.every((r) => r.reportedBy === officerAId)).toBe(true);
    // Crosses cadres: both cadre 1 and cadre 2 appear.
    expect(new Set(body.data.map((r) => r.cadreId))).toEqual(new Set([cadre1Id, cadre2Id]));
    // Each row carries its cadre (so the UI can label it).
    expect(body.data.every((r) => r.cadre?.name?.startsWith(CADRE_NAME))).toBe(true);
    // Newest first.
    const times = body.data.map((r) => new Date(r.reportedAt).getTime());
    expect(times).toEqual([...times].sort((x, y) => y - x));
    await app.close();
  });

  it('the me filter discriminates: officer B sees only their one report', async () => {
    // A no-op filter would return all 4; the seed hides that unless B is checked.
    const app = await makeApp();
    const body = (await app.inject({
      method: 'GET', url: '/api/v1/reports?reportedBy=me&pageSize=50', headers: auth(tokenB),
    })).json() as ListBody;
    expect(body.total).toBe(1);
    expect(body.data[0]!.reportedBy).toBe(officerBId);
    await app.close();
  });

  it('reportedBy=<officerId> scopes to that officer (admin “view record” path)', async () => {
    const app = await makeApp();
    const body = (await app.inject({
      method: 'GET', url: `/api/v1/reports?reportedBy=${officerAId}&pageSize=50`, headers: auth(tokenB),
    })).json() as ListBody;
    // Officer B asking for A's record: allowed (a filter, not a boundary), and it is A's 3.
    expect(body.total).toBe(3);
    expect(body.data.every((r) => r.reportedBy === officerAId)).toBe(true);
    await app.close();
  });

  it('rejects a bad reportedBy with 400', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/reports?reportedBy=everyone', headers: auth(tokenA),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
