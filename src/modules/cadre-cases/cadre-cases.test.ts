import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';

const prisma = new PrismaClient();
const config = testConfig();
const PHONES = ['+919000000040', '+919000000041', '+919000000042'];
const CADRE_NAME = 'TEST CADRE JAIL CASES';

let officerId = 0;
let viewerId = 0;
let adminId = 0;
let cadreId = 0;
let officerToken = '';
let viewerToken = '';
let adminToken = '';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const makeApp = (): Promise<FastifyInstance> => buildApp({ config, prisma, logger: false });

const validBody = () => ({
  crime_number: '02/2010',
  sections: 'धारा 147, 148, 149 भादवि',
  crime_thana: 'आवापल्ली',
  crime_description: 'परीक्षण विवरण',
  arrest_date: '2011-12-25',
  bail_granted: true,
  bail_date: '2012-03-21',
  in_jail: false,
  under_investigation: false,
  under_trial: true,
  challan_number: 'CH-1',
  court_name: 'न्यायालय बीजापुर',
  public_harm_occurred: true,
  uapa_applied: false,
});

async function purgeCases(): Promise<void> {
  const rows = await prisma.cadreCase.findMany({ where: { cadreId }, select: { id: true } });
  const ids = rows.map((r) => String(r.id));
  if (ids.length > 0) {
    await prisma.auditLog.deleteMany({ where: { entityType: 'cadre_case', entityId: { in: ids } } });
  }
  await prisma.cadreCase.deleteMany({ where: { cadreId } });
}

beforeAll(async () => {
  const officer = await prisma.user.upsert({
    where: { phone: PHONES[0] },
    update: { deletedAt: null, role: 'officer', name: 'Case Officer', thana: 'बीजापुर' },
    create: { phone: PHONES[0]!, name: 'Case Officer', role: 'officer', thana: 'बीजापुर' },
  });
  const viewer = await prisma.user.upsert({
    where: { phone: PHONES[1] }, update: { deletedAt: null, role: 'viewer', name: 'Case Viewer' },
    create: { phone: PHONES[1]!, name: 'Case Viewer', role: 'viewer' },
  });
  // ADR-044: an admin without a subDivision fail-closes to an empty scope (sees
  // nothing) — 'बीजापुर' is both the sub-division and its own canonical thana
  // (SUB_DIVISION_THANAS), unlike the legacy 'बीजापुर सदर' value some older
  // fixtures use, which only an officer's own-thana scope (not subDivision
  // lookup) resolves.
  const admin = await prisma.user.upsert({
    where: { phone: PHONES[2] },
    update: { deletedAt: null, role: 'admin', name: 'Case Admin', subDivision: 'बीजापुर' },
    create: { phone: PHONES[2]!, name: 'Case Admin', role: 'admin', subDivision: 'बीजापुर' },
  });
  officerId = officer.id;
  viewerId = viewer.id;
  adminId = admin.id;

  await prisma.cadre.deleteMany({ where: { name: CADRE_NAME } });
  const cadre = await prisma.cadre.create({
    data: {
      name: CADRE_NAME, phone: '+910000000099', thana: 'बीजापुर',
      currentAddress: 'Test address', designation: 'NA', category: 'jail',
      alertLevel: 'normal', aliases: [],
    },
  });
  cadreId = cadre.id;

  officerToken = await signAccessToken({ sub: officerId, role: 'officer' }, config.jwtSecret, '15m');
  viewerToken = await signAccessToken({ sub: viewerId, role: 'viewer' }, config.jwtSecret, '15m');
  adminToken = await signAccessToken({ sub: adminId, role: 'admin' }, config.jwtSecret, '15m');
});

afterEach(purgeCases);

afterAll(async () => {
  await purgeCases();
  await prisma.cadre.deleteMany({ where: { id: cadreId } });
  await prisma.user.deleteMany({ where: { phone: { in: PHONES } } });
  await prisma.$disconnect();
});

interface WireCaseBody {
  id: number;
  cadreId: number;
  [k: string]: unknown;
}

describe('cadre-cases', () => {
  it('GET cases without a token → 401', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}/cases` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('GET cases for an unknown cadre → 404', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/cadres/99999999/cases', headers: auth(officerToken),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('POST create as viewer → 403', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/cases`,
      headers: auth(viewerToken), payload: validBody(),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('POST create as officer → 201, direct write (no approval), camelCase entity', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/cases`,
      headers: auth(officerToken), payload: validBody(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as WireCaseBody;
    expect(body).toMatchObject({
      cadreId, crimeNumber: '02/2010', bailGranted: true, bailDate: '2012-03-21',
      inJail: false, underTrial: true, courtName: 'न्यायालय बीजापुर',
    });

    // Written immediately, not queued behind a change-request row.
    const pending = await prisma.cadreChangeRequest.count({ where: { cadreId } });
    expect(pending).toBe(0);

    // Shows up on the cadre detail's `cases` array.
    const detail = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerToken) });
    const detailBody = detail.json() as { cases?: WireCaseBody[] };
    expect(detailBody.cases).toHaveLength(1);
    expect(detailBody.cases?.[0]).toMatchObject({ crimeNumber: '02/2010' });
    await app.close();
  });

  it('GET cases list is absent on the paginated cadre list (only on detail)', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/cases`,
      headers: auth(officerToken), payload: validBody(),
    });
    const list = await app.inject({ method: 'GET', url: '/api/v1/cadres', headers: auth(officerToken) });
    const listBody = list.json() as { data: Array<{ id: number; cases?: unknown }> };
    const row = listBody.data.find((r) => r.id === cadreId);
    expect(row?.cases).toBeUndefined();
    await app.close();
  });

  it('PATCH update as officer → 200, only sent fields change', async () => {
    const app = await makeApp();
    const created = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/cases`,
      headers: auth(officerToken), payload: validBody(),
    });
    const caseId = (created.json() as WireCaseBody).id;

    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/cadres/${cadreId}/cases/${caseId}`,
      headers: auth(officerToken), payload: { case_status: 'दोषमुक्त', under_trial: false },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as WireCaseBody;
    expect(body).toMatchObject({ caseStatus: 'दोषमुक्त', underTrial: false, crimeNumber: '02/2010' });
    await app.close();
  });

  it('DELETE as officer → 403 (admin+ only)', async () => {
    const app = await makeApp();
    const created = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/cases`,
      headers: auth(officerToken), payload: validBody(),
    });
    const caseId = (created.json() as WireCaseBody).id;

    const res = await app.inject({
      method: 'DELETE', url: `/api/v1/cadres/${cadreId}/cases/${caseId}`, headers: auth(officerToken),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('DELETE as admin → 204, soft-deleted (absent from list)', async () => {
    const app = await makeApp();
    const created = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/cases`,
      headers: auth(officerToken), payload: validBody(),
    });
    const caseId = (created.json() as WireCaseBody).id;

    const res = await app.inject({
      method: 'DELETE', url: `/api/v1/cadres/${cadreId}/cases/${caseId}`, headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(204);

    const list = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}/cases`, headers: auth(officerToken) });
    expect(list.json()).toEqual([]);

    const row = await prisma.cadreCase.findUnique({ where: { id: caseId } });
    expect(row?.deletedAt).not.toBeNull();
    await app.close();
  });
});
