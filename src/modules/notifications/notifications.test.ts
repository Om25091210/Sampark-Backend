import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';
import { MockPushProvider } from '../../lib/push.js';

const prisma = new PrismaClient();
const config = testConfig();

// Fixture phones must not collide with ANY other test file's — see
// cadre-changes.test.ts's comment for the free-block bookkeeping. This file uses 94-97.
const PHONES = ['+919000000094', '+919000000095', '+919000000096', '+919000000097'];

let superId = 0;
let adminId = 0; // scoped to sub-division कुटरू (thanas: बेदरे, कुटरू, नैमेड़)
let officerInId = 0; // thana कुटरू — inside the admin's scope
let officerOutId = 0; // thana बीजापुर — outside the admin's scope
let viewerId = 0;
let superToken = '';
let adminToken = '';
let officerInToken = '';
let officerOutToken = '';
let viewerToken = '';

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const makeApp = (): Promise<FastifyInstance> =>
  buildApp({ config, prisma, logger: false, pushProvider: new MockPushProvider() });

beforeAll(async () => {
  const mk = async (
    phone: string,
    role: 'super_admin' | 'admin' | 'officer' | 'viewer',
    name: string,
    scope: { thana?: string; subDivision?: string } = {},
  ) =>
    prisma.user.upsert({
      where: { phone },
      update: { deletedAt: null, role, name, thana: null, subDivision: null, ...scope },
      create: { phone, name, role, ...scope },
    });

  superId = (await mk(PHONES[0]!, 'super_admin', 'Notif Super')).id;
  adminId = (await mk(PHONES[1]!, 'admin', 'Notif Admin', { subDivision: 'कुटरू' })).id;
  officerInId = (await mk(PHONES[2]!, 'officer', 'Notif Officer In', { thana: 'कुटरू' })).id;
  officerOutId = (await mk(PHONES[3]!, 'officer', 'Notif Officer Out', { thana: 'बीजापुर' })).id;

  const v = await prisma.user.upsert({
    where: { phone: '+919000000098' },
    update: { deletedAt: null, role: 'viewer', name: 'Notif Viewer', thana: null, subDivision: null },
    create: { phone: '+919000000098', name: 'Notif Viewer', role: 'viewer' },
  });
  viewerId = v.id;

  superToken = await signAccessToken({ sub: superId, role: 'super_admin' }, config.jwtSecret, '15m');
  adminToken = await signAccessToken({ sub: adminId, role: 'admin' }, config.jwtSecret, '15m');
  officerInToken = await signAccessToken({ sub: officerInId, role: 'officer' }, config.jwtSecret, '15m');
  officerOutToken = await signAccessToken({ sub: officerOutId, role: 'officer' }, config.jwtSecret, '15m');
  viewerToken = await signAccessToken({ sub: viewerId, role: 'viewer' }, config.jwtSecret, '15m');
});

afterEach(async () => {
  await prisma.notification.deleteMany({
    where: { userId: { in: [superId, adminId, officerInId, officerOutId, viewerId] } },
  });
});

afterAll(async () => {
  await prisma.notification.deleteMany({
    where: { userId: { in: [superId, adminId, officerInId, officerOutId, viewerId] } },
  });
  await prisma.$disconnect();
});

describe('notifications (ADR-048 in-app inbox)', () => {
  it('401s every route with no Authorization header', async () => {
    const app = await makeApp();
    const routes: [string, string][] = [
      ['GET', '/api/v1/notifications'],
      ['GET', '/api/v1/notifications/unread-count'],
      ['POST', '/api/v1/notifications/1/read'],
      ['POST', '/api/v1/notifications/read-all'],
      ['POST', '/api/v1/notifications/broadcast'],
    ];
    for (const [method, url] of routes) {
      const res = await app.inject({ method: method as 'GET' | 'POST', url });
      expect(res.statusCode).toBe(401);
    }
  });

  it('400s on validation failure', async () => {
    const app = await makeApp();

    const badPage = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications?page=0',
      headers: auth(officerInToken),
    });
    expect(badPage.statusCode).toBe(400);

    const missingThana = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/broadcast',
      headers: auth(superToken),
      payload: { title: 'x', body: 'y', target: 'thana' },
    });
    expect(missingThana.statusCode).toBe(400);
  });

  it('list/unread-count/mark-read/mark-all-read round trip', async () => {
    const app = await makeApp();
    const n1 = await prisma.notification.create({
      data: { userId: officerInId, type: 'broadcast', title: 'सूचना 1', body: 'बॉडी 1' },
    });
    await prisma.notification.create({
      data: { userId: officerInId, type: 'broadcast', title: 'सूचना 2', body: 'बॉडी 2' },
    });

    const unread1 = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications/unread-count',
      headers: auth(officerInToken),
    });
    expect(unread1.json()).toEqual({ count: 2 });

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: auth(officerInToken),
    });
    expect(list.json().total).toBe(2);

    const read = await app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${n1.id}/read`,
      headers: auth(officerInToken),
    });
    expect(read.statusCode).toBe(204);

    const unread2 = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications/unread-count',
      headers: auth(officerInToken),
    });
    expect(unread2.json()).toEqual({ count: 1 });

    const markAll = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/read-all',
      headers: auth(officerInToken),
    });
    expect(markAll.statusCode).toBe(204);

    const unread3 = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications/unread-count',
      headers: auth(officerInToken),
    });
    expect(unread3.json()).toEqual({ count: 0 });
  });

  it('mark-read never reveals a notification belonging to another user (fail-closed 404)', async () => {
    const app = await makeApp();
    const n = await prisma.notification.create({
      data: { userId: officerInId, type: 'broadcast', title: 't', body: 'b' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${n.id}/read`,
      headers: auth(officerOutToken),
    });
    expect(res.statusCode).toBe(404);
  });

  it('RBAC: officer/viewer 403 on broadcast, admin/super_admin 201', async () => {
    const app = await makeApp();

    const officerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/broadcast',
      headers: auth(officerInToken),
      payload: { title: 'x', body: 'y', target: 'all' },
    });
    expect(officerRes.statusCode).toBe(403);

    const viewerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/broadcast',
      headers: auth(viewerToken),
      payload: { title: 'x', body: 'y', target: 'all' },
    });
    expect(viewerRes.statusCode).toBe(403);

    const superRes = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/broadcast',
      headers: auth(superToken),
      payload: { title: 'सामान्य सूचना', body: 'सभी अधिकारियों के लिए', target: 'thana', thana: 'कुटरू' },
    });
    expect(superRes.statusCode).toBe(201);
  });

  it('jurisdiction scope: admin broadcasting target=all never reaches an out-of-scope officer', async () => {
    const app = await makeApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/broadcast',
      headers: auth(adminToken),
      payload: { title: 'सूचना', body: 'सूचना पाठ', target: 'all' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().recipient_count).toBe(1); // only officerIn, whose thana is in the admin's sub-division

    const insideRows = await prisma.notification.findMany({ where: { userId: officerInId } });
    expect(insideRows.length).toBe(1);
    const outsideRows = await prisma.notification.findMany({ where: { userId: officerOutId } });
    expect(outsideRows.length).toBe(0);
  });

  it('admin cannot target a thana outside their own sub-division (400)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/broadcast',
      headers: auth(adminToken),
      payload: { title: 'x', body: 'y', target: 'thana', thana: 'बीजापुर' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('admin cannot target a sub-division at all (super_admin-only)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/broadcast',
      headers: auth(adminToken),
      payload: { title: 'x', body: 'y', target: 'sub_division', sub_division: 'कुटरू' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('super_admin can target any single thana, including one outside every admin scope test fixture', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/broadcast',
      headers: auth(superToken),
      payload: { title: 'x', body: 'y', target: 'sub_division', sub_division: 'कुटरू' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().recipient_count).toBe(1);
  });
});
