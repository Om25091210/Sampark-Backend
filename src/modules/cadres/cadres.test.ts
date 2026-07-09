import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';

const prisma = new PrismaClient();
const config = testConfig();
const PHONES = ['+919000000010', '+919000000011', '+919000000012'];

let adminId = 0;
let officerAId = 0;
let officerBId = 0;
let cadreId = 0;
let adminToken = '';
let officerToken = '';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const makeApp = (): Promise<FastifyInstance> => buildApp({ config, prisma, logger: false });

beforeAll(async () => {
  const admin = await prisma.user.upsert({
    where: { phone: PHONES[0] }, update: { deletedAt: null, role: 'admin', name: 'Test Admin' },
    create: { phone: PHONES[0]!, name: 'Test Admin', role: 'admin' },
  });
  const officerA = await prisma.user.upsert({
    where: { phone: PHONES[1] }, update: { deletedAt: null, role: 'officer', name: 'Test Officer A' },
    create: { phone: PHONES[1]!, name: 'Test Officer A', role: 'officer' },
  });
  const officerB = await prisma.user.upsert({
    where: { phone: PHONES[2] }, update: { deletedAt: null, role: 'officer', name: 'Test Officer B' },
    create: { phone: PHONES[2]!, name: 'Test Officer B', role: 'officer' },
  });
  adminId = admin.id;
  officerAId = officerA.id;
  officerBId = officerB.id;

  await prisma.cadre.deleteMany({ where: { name: 'TEST CADRE ALPHA' } });
  const cadre = await prisma.cadre.create({
    data: {
      name: 'TEST CADRE ALPHA', phone: '+910000000000', thana: 'बीजापुर सदर',
      currentAddress: 'Test address', designation: 'Test', category: 'surrendered',
      alertLevel: 'normal', aliases: ['alpha-x'], assignedOfficerId: officerAId,
    },
  });
  cadreId = cadre.id;

  adminToken = await signAccessToken({ sub: adminId, role: 'admin' }, config.jwtSecret, '15m');
  officerToken = await signAccessToken({ sub: officerAId, role: 'officer' }, config.jwtSecret, '15m');
});

afterEach(async () => {
  // Undo transfer side effects so each test starts from a known state.
  await prisma.auditLog.deleteMany({ where: { entityType: 'cadre', entityId: String(cadreId) } });
  await prisma.outboxEvent.deleteMany({ where: { aggregateType: 'cadre', aggregateId: String(cadreId) } });
  await prisma.cadre.update({ where: { id: cadreId }, data: { assignedOfficerId: officerAId } });
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { entityType: 'cadre', entityId: String(cadreId) } });
  await prisma.outboxEvent.deleteMany({ where: { aggregateType: 'cadre', aggregateId: String(cadreId) } });
  await prisma.cadre.deleteMany({ where: { id: cadreId } });
  await prisma.user.deleteMany({ where: { phone: { in: PHONES } } });
  await prisma.$disconnect();
});

interface ListBody {
  data: Array<{ id: number; category: string } & Record<string, unknown>>;
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

describe('cadres', () => {
  it('GET /cadres without a token → 401', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/cadres' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('GET /cadres returns a paginated, camelCase list (no internal fields)', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/cadres?pageSize=50', headers: auth(officerToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ListBody;
    expect(body).toMatchObject({ page: 1, pageSize: 50 });
    expect(typeof body.total).toBe('number');
    expect(typeof body.hasMore).toBe('boolean');
    const mine = body.data.find((c) => c.id === cadreId);
    expect(mine).toBeDefined();
    expect(mine).toMatchObject({ currentAddress: 'Test address', category: 'surrendered', alertLevel: 'normal' });
    expect(mine).not.toHaveProperty('assignedOfficerId');
    expect(mine).not.toHaveProperty('deletedAt');
    await app.close();
  });

  it('filters by category', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/cadres?category=surrendered&pageSize=50', headers: auth(officerToken) });
    const body = res.json() as ListBody;
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((c) => c.category === 'surrendered')).toBe(true);
    await app.close();
  });

  it('paginates (pageSize=2)', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/cadres?pageSize=2', headers: auth(officerToken) });
    const body = res.json() as ListBody;
    expect(body.data.length).toBe(2);
    expect(body.hasMore).toBe(body.total > 2);
    await app.close();
  });

  it('rejects pageSize over the max (51) with 400', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/cadres?pageSize=51', headers: auth(officerToken) });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    await app.close();
  });

  it('GET /cadres/:id returns the cadre', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: cadreId, name: 'TEST CADRE ALPHA', category: 'surrendered' });
    await app.close();
  });

  it('GET /cadres/:id → 404 for unknown id', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/cadres/99999999', headers: auth(officerToken) });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('transfer is forbidden for officers (403)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/transfer`,
      headers: auth(officerToken), payload: { to_officer_id: officerBId },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('admin transfer → 204, reassigns, and writes audit + outbox atomically', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/transfer`,
      headers: auth(adminToken), payload: { to_officer_id: officerBId },
    });
    expect(res.statusCode).toBe(204);

    const updated = await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } });
    expect(updated.assignedOfficerId).toBe(officerBId);

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'cadre', entityId: String(cadreId), action: 'cadre.transfer' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.hash).toBeTruthy();
    expect(audit?.prevHash).toBeTruthy();

    const event = await prisma.outboxEvent.findFirst({
      where: { aggregateType: 'cadre', aggregateId: String(cadreId), eventType: 'cadre.transferred' },
    });
    expect(event).not.toBeNull();
    await app.close();
  });

  it('transfer with missing to_officer_id → 400', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/transfer`,
      headers: auth(adminToken), payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('transfer unknown cadre → 404', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/cadres/99999999/transfer',
      headers: auth(adminToken), payload: { to_officer_id: officerBId },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('transfer to an unknown officer → 400 INVALID_OFFICER', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/transfer`,
      headers: auth(adminToken), payload: { to_officer_id: 99999999 },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_OFFICER');
    await app.close();
  });
});
