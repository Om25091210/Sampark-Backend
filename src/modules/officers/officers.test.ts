import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';

const prisma = new PrismaClient();
const config = testConfig();

// Distinct phone block so this suite never collides with the others.
const PHONES = ['+919000000050', '+919000000051', '+919000000052', '+919000000053'];
const CADRE_NAME = 'TEST CADRE OFFICERS';

let officerAId = 0;
let officerBId = 0;
let adminId = 0;
let viewerId = 0;
let cadreId = 0;

let officerAToken = '';
let adminToken = '';
let viewerToken = '';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const makeApp = (): Promise<FastifyInstance> => buildApp({ config, prisma, logger: false });

interface WireOfficerBody {
  id: number;
  name: string;
  phone: string;
  role: string;
  assignedCadreCount: number;
  [k: string]: unknown;
}
interface Page<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

beforeAll(async () => {
  const officerA = await prisma.user.upsert({
    where: { phone: PHONES[0] },
    update: { deletedAt: null, role: 'officer', name: 'ZZ Officer Alpha', thana: 'भैरमगढ़' },
    create: { phone: PHONES[0]!, name: 'ZZ Officer Alpha', role: 'officer', thana: 'भैरमगढ़' },
  });
  const officerB = await prisma.user.upsert({
    where: { phone: PHONES[1] },
    update: { deletedAt: null, role: 'officer', name: 'ZZ Officer Beta', thana: 'जांगला' },
    create: { phone: PHONES[1]!, name: 'ZZ Officer Beta', role: 'officer', thana: 'जांगला' },
  });
  const admin = await prisma.user.upsert({
    where: { phone: PHONES[2] },
    // ADR-044: both fixture officers are in the भैरमगढ़ sub-division (भैरमगढ़ + जांगला),
    // so this SDOP's roster covers exactly them. Previously 'जांगला', which is आवापल्ली's.
    update: { deletedAt: null, role: 'admin', name: 'ZZ Admin', subDivision: 'भैरमगढ़' },
    create: { phone: PHONES[2]!, name: 'ZZ Admin', role: 'admin', subDivision: 'भैरमगढ़' },
  });
  const viewer = await prisma.user.upsert({
    where: { phone: PHONES[3] },
    update: { deletedAt: null, role: 'viewer', name: 'ZZ Viewer' },
    create: { phone: PHONES[3]!, name: 'ZZ Viewer', role: 'viewer' },
  });

  officerAId = officerA.id;
  officerBId = officerB.id;
  adminId = admin.id;
  viewerId = viewer.id;

  // One cadre, assigned to officer A.
  await prisma.cadre.deleteMany({ where: { name: CADRE_NAME } });
  const cadre = await prisma.cadre.create({
    data: {
      name: CADRE_NAME, phone: '+910000000050', thana: 'भैरमगढ़',
      currentAddress: 'Test address', designation: 'Test', category: 'surrendered',
      alertLevel: 'normal', aliases: [], assignedOfficerId: officerAId,
    },
  });
  cadreId = cadre.id;

  officerAToken = await signAccessToken({ sub: officerAId, role: 'officer' }, config.jwtSecret, '15m');
  adminToken = await signAccessToken({ sub: adminId, role: 'admin' }, config.jwtSecret, '15m');
  viewerToken = await signAccessToken({ sub: viewerId, role: 'viewer' }, config.jwtSecret, '15m');
});

afterAll(async () => {
  await prisma.cadre.deleteMany({ where: { id: cadreId } });
  await prisma.user.deleteMany({ where: { phone: { in: PHONES } } });
  await prisma.$disconnect();
});

describe('officers — roster for the admin assignment picker (ADR-018)', () => {
  it('GET /officers without a token → 401', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/officers' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('GET /officers is forbidden for an officer (403) — officers do not enumerate each other', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/officers', headers: auth(officerAToken),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('GET /officers is forbidden for a viewer (403)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/officers', headers: auth(viewerToken),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('admin gets a paginated roster of officers only — no admins, no viewers', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/officers?pageSize=50', headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Page<WireOfficerBody>;

    // Every row is an officer.
    expect(body.data.every((o) => o.role === 'officer')).toBe(true);
    // The admin and viewer we seeded are absent — only officers are assignable.
    const ids = body.data.map((o) => o.id);
    expect(ids).not.toContain(adminId);
    expect(ids).not.toContain(viewerId);
    expect(ids).toContain(officerAId);
    expect(ids).toContain(officerBId);

    // Pagination envelope matches the client's PaginatedResponse shape.
    expect(body).toMatchObject({ page: 1, pageSize: 50 });
    expect(typeof body.total).toBe('number');
    expect(typeof body.hasMore).toBe('boolean');
    await app.close();
  });

  it('each officer carries assignedCadreCount so the admin can see load', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/officers?search=ZZ Officer&pageSize=50', headers: auth(adminToken),
    });
    const body = res.json() as Page<WireOfficerBody>;

    const a = body.data.find((o) => o.id === officerAId);
    const b = body.data.find((o) => o.id === officerBId);
    // A holds the one cadre we assigned; B holds none.
    expect(a?.assignedCadreCount).toBe(1);
    expect(b?.assignedCadreCount).toBe(0);
    await app.close();
  });

  it('search matches on name and on thana', async () => {
    const app = await makeApp();

    const byName = await app.inject({
      method: 'GET', url: '/api/v1/officers?search=Officer Beta', headers: auth(adminToken),
    });
    const nameBody = byName.json() as Page<WireOfficerBody>;
    expect(nameBody.data.map((o) => o.id)).toContain(officerBId);
    expect(nameBody.data.map((o) => o.id)).not.toContain(officerAId);

    const byThana = await app.inject({
      method: 'GET', url: '/api/v1/officers?search=जांगला', headers: auth(adminToken),
    });
    const thanaBody = byThana.json() as Page<WireOfficerBody>;
    expect(thanaBody.data.map((o) => o.id)).toContain(officerBId);

    await app.close();
  });

  it('a soft-deleted officer disappears from the roster', async () => {
    const app = await makeApp();
    await prisma.user.update({ where: { id: officerBId }, data: { deletedAt: new Date() } });

    const res = await app.inject({
      method: 'GET', url: '/api/v1/officers?pageSize=50', headers: auth(adminToken),
    });
    const body = res.json() as Page<WireOfficerBody>;
    expect(body.data.map((o) => o.id)).not.toContain(officerBId);

    await prisma.user.update({ where: { id: officerBId }, data: { deletedAt: null } });
    await app.close();
  });

  it('never leaks credential columns (passwordHash / totpSecret)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/officers', headers: auth(adminToken),
    });
    const body = res.json() as Page<WireOfficerBody>;
    for (const o of body.data) {
      expect(o).not.toHaveProperty('passwordHash');
      expect(o).not.toHaveProperty('totpSecret');
      expect(o).not.toHaveProperty('deletedAt');
    }
    await app.close();
  });
});

describe('cadres — assignedTo filter + assignedOfficerId serialization (ADR-018)', () => {
  it('GET /cadres now returns assignedOfficerId', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerAToken),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { assignedOfficerId?: number }).assignedOfficerId).toBe(officerAId);
    await app.close();
  });

  it('assignedTo=me scopes the list to the caller\'s own cadres', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/cadres?assignedTo=me&pageSize=50', headers: auth(officerAToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Page<{ id: number; assignedOfficerId?: number }>;
    // Every row belongs to the caller, and our seeded cadre is among them.
    expect(body.data.every((c) => c.assignedOfficerId === officerAId)).toBe(true);
    expect(body.data.map((c) => c.id)).toContain(cadreId);
    await app.close();
  });

  it('assignedTo=<officerId> scopes to that officer (the admin roster view)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/cadres?assignedTo=${officerAId}&pageSize=50`, headers: auth(adminToken),
    });
    const body = res.json() as Page<{ id: number; assignedOfficerId?: number }>;
    expect(body.data.every((c) => c.assignedOfficerId === officerAId)).toBe(true);
    expect(body.data.map((c) => c.id)).toContain(cadreId);
    await app.close();
  });

  it('assignedTo for an officer with no cadres returns an empty page, not an error', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/cadres?assignedTo=${officerBId}`, headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Page<{ id: number }>;
    expect(body.data).toHaveLength(0);
    expect(body.total).toBe(0);
    expect(body.hasMore).toBe(false);
    await app.close();
  });

  it('assignedTo composes with the category filter rather than replacing it', async () => {
    const app = await makeApp();
    const hit = await app.inject({
      method: 'GET', url: `/api/v1/cadres?assignedTo=me&category=surrendered&pageSize=50`,
      headers: auth(officerAToken),
    });
    expect((hit.json() as Page<{ id: number }>).data.map((c) => c.id)).toContain(cadreId);

    // Same assignment, non-matching category → excluded.
    const miss = await app.inject({
      method: 'GET', url: `/api/v1/cadres?assignedTo=me&category=jail&pageSize=50`,
      headers: auth(officerAToken),
    });
    expect((miss.json() as Page<{ id: number }>).data.map((c) => c.id)).not.toContain(cadreId);
    await app.close();
  });

  it('a garbage assignedTo → 400 VALIDATION_ERROR', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/cadres?assignedTo=everyone', headers: auth(officerAToken),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    await app.close();
  });

  it('transfer reassigns, and the cadre then follows the new officer in assignedTo', async () => {
    const app = await makeApp();

    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/transfer`,
      headers: auth(adminToken), payload: { to_officer_id: officerBId },
    });
    expect(res.statusCode).toBe(204);

    // It leaves A's list...
    const aList = await app.inject({
      method: 'GET', url: `/api/v1/cadres?assignedTo=${officerAId}&pageSize=50`, headers: auth(adminToken),
    });
    expect((aList.json() as Page<{ id: number }>).data.map((c) => c.id)).not.toContain(cadreId);

    // ...and appears in B's.
    const bList = await app.inject({
      method: 'GET', url: `/api/v1/cadres?assignedTo=${officerBId}&pageSize=50`, headers: auth(adminToken),
    });
    expect((bList.json() as Page<{ id: number }>).data.map((c) => c.id)).toContain(cadreId);

    // Restore for suite independence.
    await prisma.cadre.update({ where: { id: cadreId }, data: { assignedOfficerId: officerAId } });
    await app.close();
  });
});
