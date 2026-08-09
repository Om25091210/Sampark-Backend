import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';

const prisma = new PrismaClient();
const config = testConfig();

const TOKEN = 'CFGFIXTURE';
const SA_ID = `${TOKEN}_SA`;
const OFF_ID = `${TOKEN}_OFF`;

let saId = 0;
let offId = 0;
let saToken = '';
let officerToken = '';

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const makeApp = (): Promise<FastifyInstance> => buildApp({ config, prisma, logger: false });

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { name: { in: [SA_ID, OFF_ID] } } });
  const sa = await prisma.user.create({ data: { name: SA_ID, role: 'super_admin' } });
  const off = await prisma.user.create({ data: { name: OFF_ID, role: 'officer', thana: 'बीजापुर सदर' } });
  saId = sa.id;
  offId = off.id;
  saToken = await signAccessToken({ sub: saId, role: 'super_admin' }, config.jwtSecret, '15m');
  officerToken = await signAccessToken({ sub: offId, role: 'officer' }, config.jwtSecret, '15m');
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { entityType: 'config' } });
  await prisma.configEntry.deleteMany({ where: { id: 1 } });
  await prisma.syncLog.deleteMany({ where: { targetKey: TOKEN } });
  await prisma.user.deleteMany({ where: { id: { in: [saId, offId] } } });
  await prisma.$disconnect();
});

// ConfigEntry is a genuine singleton (id=1) -- this is the ONLY test file that
// touches it. Every other consumer of sheets-sync in the suite injects
// MockSheetsSyncProvider directly and never reads the row, so there is no
// cross-file interleaving risk despite the shared global row.
describe('GET/PATCH /config (ADR-059)', () => {
  it('401s unauthenticated, 403s a non-super_admin', async () => {
    const app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/v1/config' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/config', headers: auth(officerToken) })).statusCode,
    ).toBe(403);
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/config',
      headers: auth(officerToken),
      payload: { sheetsSyncUrl: 'https://script.google.com/macros/s/x/exec' },
    });
    expect(patch.statusCode).toBe(403);
    await app.close();
  });

  it('reads as all-null before any PATCH has ever run', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/config', headers: auth(saToken) });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { sheetsSyncUrl: string | null }).sheetsSyncUrl).toBeNull();
    await app.close();
  });

  it('rejects a non-URL value', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/config',
      headers: auth(saToken),
      payload: { sheetsSyncUrl: 'not-a-url' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('sets, then reads back, the deployment URL, and audits the change against the acting super_admin', async () => {
    const app = await makeApp();
    const url = 'https://script.google.com/macros/s/AKfycbTEST/exec';
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/config',
      headers: auth(saToken),
      payload: { sheetsSyncUrl: url },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { sheetsSyncUrl: string | null }).sheetsSyncUrl).toBe(url);

    const get = await app.inject({ method: 'GET', url: '/api/v1/config', headers: auth(saToken) });
    expect((get.json() as { sheetsSyncUrl: string | null }).sheetsSyncUrl).toBe(url);

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'config', action: 'config.updated' },
      orderBy: { id: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorId).toBe(saId);
    await app.close();
  });

  it('clears the URL back to null (pausing sync) via an explicit null', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/config',
      headers: auth(saToken),
      payload: { sheetsSyncUrl: null },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { sheetsSyncUrl: string | null }).sheetsSyncUrl).toBeNull();
    await app.close();
  });
});

describe('GET /config/sync-log (ADR-059 §4)', () => {
  it('401s unauthenticated, 403s a non-super_admin', async () => {
    const app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/v1/config/sync-log' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/config/sync-log', headers: auth(officerToken) }))
        .statusCode,
    ).toBe(403);
    await app.close();
  });

  it('returns recent entries newest-first', async () => {
    // sync_log is shared across the whole suite (cadre-export/user-sync tests write
    // to it too), so this can't assume its 3 rows land in the top N overall -- a
    // generous limit + filtering down to this fixture's own targetKey is what makes
    // the ordering assertion below safe from cross-file interleaving.
    await prisma.syncLog.createMany({
      data: [
        { eventType: 'cadre.export', targetKey: TOKEN, status: 'success' },
        { eventType: 'user.created', targetKey: TOKEN, status: 'error', error: 'boom' },
        { eventType: 'user.updated', targetKey: TOKEN, status: 'success' },
      ],
    });
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/config/sync-log?limit=100',
      headers: auth(saToken),
    });
    expect(res.statusCode).toBe(200);
    const all = res.json() as Array<{ eventType: string; targetKey: string | null; status: string; error: string | null }>;
    const body = all.filter((e) => e.targetKey === TOKEN);
    expect(body).toHaveLength(3);
    expect(body[0]!.eventType).toBe('user.updated');
    expect(body[1]!.eventType).toBe('user.created');
    expect(body[1]!.error).toBe('boom');
    expect(body[2]!.eventType).toBe('cadre.export');
    await app.close();
  });
});
