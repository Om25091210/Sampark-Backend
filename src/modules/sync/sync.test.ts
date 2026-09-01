import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';

const prisma = new PrismaClient();
const config = testConfig();
// Distinct phone block so this suite never collides with the others.
const PHONES = ['+919000000070', '+919000000071', '+919000000072'];
const CADRE_IN_SCOPE = 'TEST CADRE SYNC IN SCOPE';
const CADRE_OUT_OF_SCOPE = 'TEST CADRE SYNC OUT OF SCOPE';
const CADRE_NARROWING = 'TEST CADRE SYNC NARROWING';

let officerId = 0;
let adminId = 0;
let viewerId = 0;
let officerToken = '';
let adminToken = '';
let viewerToken = '';
let cadreInScopeId = 0;
let cadreOutOfScopeId = 0;
let cadreNarrowingId = 0;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const makeApp = (): Promise<FastifyInstance> => buildApp({ config, prisma, logger: false });

interface EntityBlock {
  upserted: { id: number; [k: string]: unknown }[];
  deleted: number[];
  truncated: boolean;
}
interface PullBody {
  serverTime: number;
  cadres: EntityBlock;
  reports: EntityBlock;
  officers: EntityBlock;
}
interface PushItemResult {
  clientKey: string;
  status: 'created' | 'exists' | 'error';
  serverId?: number;
  error?: string;
}
interface PushBody {
  reports: PushItemResult[];
  cadreChangeRequests: PushItemResult[];
}

async function cleanupCadre(name: string): Promise<void> {
  const cadre = await prisma.cadre.findFirst({ where: { name } });
  if (cadre === null) return;
  const reportIds = (await prisma.report.findMany({ where: { cadreId: cadre.id }, select: { id: true } })).map(
    (r) => String(r.id),
  );
  const changeIds = (
    await prisma.cadreChangeRequest.findMany({ where: { cadreId: cadre.id }, select: { id: true } })
  ).map((r) => String(r.id));
  const entityIds = [...reportIds, ...changeIds, String(cadre.id)];
  await prisma.auditLog.deleteMany({ where: { entityId: { in: entityIds } } });
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: entityIds } } });
  await prisma.report.deleteMany({ where: { cadreId: cadre.id } });
  await prisma.cadreChangeRequest.deleteMany({ where: { cadreId: cadre.id } });
  await prisma.cadre.delete({ where: { id: cadre.id } });
}

beforeAll(async () => {
  const officer = await prisma.user.upsert({
    where: { phone: PHONES[0] },
    update: { deletedAt: null, role: 'officer', name: 'Sync Officer', thana: 'भैरमगढ़' },
    create: { phone: PHONES[0]!, name: 'Sync Officer', role: 'officer', thana: 'भैरमगढ़' },
  });
  const admin = await prisma.user.upsert({
    where: { phone: PHONES[1] },
    // भैरमगढ़ sub-division covers भैरमगढ़/जांगला/नेलसनार/मिरतुर — the fixture officer's
    // station is inside it, बीजापुर (its own sub-division) is not.
    update: { deletedAt: null, role: 'admin', name: 'Sync Admin', subDivision: 'भैरमगढ़' },
    create: { phone: PHONES[1]!, name: 'Sync Admin', role: 'admin', subDivision: 'भैरमगढ़' },
  });
  const viewer = await prisma.user.upsert({
    where: { phone: PHONES[2] },
    update: { deletedAt: null, role: 'viewer', name: 'Sync Viewer' },
    create: { phone: PHONES[2]!, name: 'Sync Viewer', role: 'viewer' },
  });
  officerId = officer.id;
  adminId = admin.id;
  viewerId = viewer.id;

  await cleanupCadre(CADRE_IN_SCOPE);
  await cleanupCadre(CADRE_OUT_OF_SCOPE);
  await cleanupCadre(CADRE_NARROWING);

  const inScope = await prisma.cadre.create({
    data: {
      name: CADRE_IN_SCOPE, phone: '+910000000010', thana: 'भैरमगढ़',
      currentAddress: 'Test address', designation: 'Test', category: 'surrendered',
      alertLevel: 'normal', aliases: [], assignedOfficerId: officerId,
    },
  });
  const outOfScope = await prisma.cadre.create({
    data: {
      name: CADRE_OUT_OF_SCOPE, phone: '+910000000011', thana: 'बीजापुर',
      currentAddress: 'Test address', designation: 'Test', category: 'surrendered',
      alertLevel: 'normal', aliases: [],
    },
  });
  const narrowing = await prisma.cadre.create({
    data: {
      name: CADRE_NARROWING, phone: '+910000000012', thana: 'भैरमगढ़',
      currentAddress: 'Test address', designation: 'Test', category: 'surrendered',
      alertLevel: 'normal', aliases: [],
    },
  });
  cadreInScopeId = inScope.id;
  cadreOutOfScopeId = outOfScope.id;
  cadreNarrowingId = narrowing.id;

  officerToken = await signAccessToken({ sub: officerId, role: 'officer' }, config.jwtSecret, '15m');
  adminToken = await signAccessToken({ sub: adminId, role: 'admin' }, config.jwtSecret, '15m');
  viewerToken = await signAccessToken({ sub: viewerId, role: 'viewer' }, config.jwtSecret, '15m');
});

afterAll(async () => {
  await cleanupCadre(CADRE_IN_SCOPE);
  await cleanupCadre(CADRE_OUT_OF_SCOPE);
  await cleanupCadre(CADRE_NARROWING);
  await prisma.user.deleteMany({ where: { phone: { in: PHONES } } });
  await prisma.$disconnect();
});

describe('sync', () => {
  it('GET /sync/pull without a token → 401', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/sync/pull' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('POST /sync/push without a token → 401', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/sync/push', payload: {} });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('POST /sync/push as a viewer → 403 (read-only, same gate as report creation)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/sync/push', headers: auth(viewerToken), payload: {},
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('GET /sync/pull (officer, full snapshot) — ADR-044 scope: in-scope cadre present, out-of-scope absent, officer roster empty', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/sync/pull', headers: auth(officerToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PullBody;
    const ids = body.cadres.upserted.map((c) => c.id);
    expect(ids).toContain(cadreInScopeId);
    expect(ids).not.toContain(cadreOutOfScopeId);
    // Officer roster is admin+ only (ADR-018) — an officer's own mirror carries none.
    expect(body.officers.upserted).toEqual([]);
    expect(typeof body.serverTime).toBe('number');
    await app.close();
  });

  it('GET /sync/pull (admin, full snapshot) — officer roster IS populated, scoped to the sub-division', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/sync/pull', headers: auth(adminToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PullBody;
    expect(body.officers.upserted.map((o) => o.id)).toContain(officerId);
    await app.close();
  });

  it('GET /sync/pull with a future lastPulledAt → nothing new for either entity', async () => {
    const app = await makeApp();
    const future = Date.now() + 24 * 60 * 60 * 1000;
    const res = await app.inject({
      method: 'GET', url: `/api/v1/sync/pull?lastPulledAt=${future}`, headers: auth(officerToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PullBody;
    expect(body.cadres.upserted).toEqual([]);
    expect(body.reports.upserted).toEqual([]);
    await app.close();
  });

  it('POST /sync/push files a report, idempotently — a replayed push returns the SAME serverId, no duplicate row', async () => {
    const app = await makeApp();
    const key = randomUUID();
    const payload = {
      reports: [
        {
          idempotency_key: key,
          cadre_id: cadreInScopeId,
          reporting_place: 'village',
          specific_location: 'गाँव चौक',
          person_status: 'alive',
          current_phone: '+919812345000',
          current_activity: 'खेती कर रहा है',
        },
      ],
    };

    const first = await app.inject({
      method: 'POST', url: '/api/v1/sync/push', headers: auth(officerToken), payload,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as PushBody;
    expect(firstBody.reports[0]!.status).toBe('created');
    expect(firstBody.reports[0]!.clientKey).toBe(key);
    const serverId = firstBody.reports[0]!.serverId;
    expect(serverId).toBeDefined();

    const replay = await app.inject({
      method: 'POST', url: '/api/v1/sync/push', headers: auth(officerToken), payload,
    });
    const replayBody = replay.json() as PushBody;
    expect(replayBody.reports[0]!.status).toBe('exists');
    expect(replayBody.reports[0]!.serverId).toBe(serverId);

    const count = await prisma.report.count({ where: { cadreId: cadreInScopeId, deletedAt: null } });
    expect(count).toBe(1);
    await app.close();
  });

  it('POST /sync/push submits a cadre change request, idempotently — a replayed push returns the SAME serverId, no duplicate row', async () => {
    const app = await makeApp();
    const key = randomUUID();
    const payload = {
      cadreChangeRequests: [
        { idempotency_key: key, cadre_id: cadreInScopeId, changes: { incident: 'सिंक टेस्ट घटना' } },
      ],
    };

    const first = await app.inject({
      method: 'POST', url: '/api/v1/sync/push', headers: auth(officerToken), payload,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as PushBody;
    expect(firstBody.cadreChangeRequests[0]!.status).toBe('created');
    const serverId = firstBody.cadreChangeRequests[0]!.serverId;
    expect(serverId).toBeDefined();

    const replay = await app.inject({
      method: 'POST', url: '/api/v1/sync/push', headers: auth(officerToken), payload,
    });
    const replayBody = replay.json() as PushBody;
    expect(replayBody.cadreChangeRequests[0]!.serverId).toBe(serverId);

    // Filtered to THIS test's own field: cadreInScopeId also carries an unrelated
    // pending `phone` change request from the earlier report-push test (ADR-052's
    // report-time phone sync fires whenever current_phone differs from the cadre's
    // own — by design, not part of what this assertion is checking).
    const rows = await prisma.cadreChangeRequest.findMany({ where: { cadreId: cadreInScopeId } });
    const incidentRows = rows.filter((r) => 'incident' in (r.changes as Record<string, unknown>));
    expect(incidentRows).toHaveLength(1);
    await app.close();
  });

  it('a soft-deleted report shows up as a tombstone on the NEXT pull', async () => {
    const app = await makeApp();
    const before = await app.inject({ method: 'GET', url: '/api/v1/sync/pull', headers: auth(officerToken) });
    const cursor = (before.json() as PullBody).serverTime;

    const report = await prisma.report.create({
      data: {
        cadreId: cadreInScopeId, reportingPlace: 'village', specificLocation: 'x',
        personStatus: 'alive', currentPhone: '+919812340001', currentActivity: 'x', reportedById: officerId,
      },
    });
    await prisma.report.update({ where: { id: report.id }, data: { deletedAt: new Date() } });

    const after = await app.inject({
      method: 'GET', url: `/api/v1/sync/pull?lastPulledAt=${cursor}`, headers: auth(officerToken),
    });
    const body = after.json() as PullBody;
    expect(body.reports.deleted).toContain(report.id);
    await app.close();
  });

  // ADR-044 scope-narrowing (see sync.service.ts's scopeNarrowedCadreIds): a thana
  // transfer moves a cadre out of scope WITHOUT touching deletedAt, so the ordinary
  // tombstone query above cannot see it — the device must be told through the
  // audit-log-derived path instead. Writes the audit row directly (bypassing
  // writeAuditLog's hash chain, which nothing here reads) since exercising the full
  // transferThana() service call would require wiring up notification/push deps
  // this test does not otherwise need.
  it('a cadre that moved OUT of scope via a thana transfer (no soft-delete) also tombstones on the next pull', async () => {
    const app = await makeApp();
    const before = await app.inject({ method: 'GET', url: '/api/v1/sync/pull', headers: auth(officerToken) });
    const cursor = (before.json() as PullBody).serverTime;
    expect((before.json() as PullBody).cadres.upserted.map((c) => c.id)).toContain(cadreNarrowingId);

    await prisma.auditLog.create({
      data: {
        actorId: adminId,
        action: 'cadre.thana_transfer',
        entityType: 'cadre',
        entityId: String(cadreNarrowingId),
        before: { thana: 'भैरमगढ़' },
        after: { thana: 'बीजापुर' },
        prevHash: 'TEST',
        hash: randomUUID(),
      },
    });
    await prisma.cadre.update({ where: { id: cadreNarrowingId }, data: { thana: 'बीजापुर' } });

    const after = await app.inject({
      method: 'GET', url: `/api/v1/sync/pull?lastPulledAt=${cursor}`, headers: auth(officerToken),
    });
    const body = after.json() as PullBody;
    expect(body.cadres.deleted).toContain(cadreNarrowingId);
    expect(body.cadres.upserted.map((c) => c.id)).not.toContain(cadreNarrowingId);
    await app.close();
  });
});
