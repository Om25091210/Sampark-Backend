import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';

const prisma = new PrismaClient();
const config = testConfig();
const PHONES = ['+919000000030', '+919000000031'];
const CADRE_NAME = 'TEST CADRE REPORTS';

let officerId = 0;
let viewerId = 0;
let cadreId = 0;
let officerToken = '';
let viewerToken = '';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const makeApp = (): Promise<FastifyInstance> => buildApp({ config, prisma, logger: false });

const validBody = () => ({
  cadre_id: cadreId,
  reporting_place: 'village' as const,
  specific_location: 'गाँव चौक',
  person_status: 'alive' as const,
  current_phone: '+919812345678',
  current_activity: 'खेती कर रहा है',
  gps_coords: { latitude: 18.79, longitude: 80.9, address: 'बीजापुर' },
  is_home_address: true,
});

// Removes every report (and its audit/outbox rows) written against the test cadre,
// so each test starts clean and the dev-DB hash-chain isn't polluted long-term.
async function purgeReports(): Promise<void> {
  const rows = await prisma.report.findMany({ where: { cadreId }, select: { id: true } });
  const ids = rows.map((r) => String(r.id));
  if (ids.length > 0) {
    await prisma.auditLog.deleteMany({ where: { entityType: 'report', entityId: { in: ids } } });
    await prisma.outboxEvent.deleteMany({ where: { aggregateType: 'report', aggregateId: { in: ids } } });
  }
  await prisma.report.deleteMany({ where: { cadreId } });
}

beforeAll(async () => {
  const officer = await prisma.user.upsert({
    where: { phone: PHONES[0] }, update: { deletedAt: null, role: 'officer', name: 'Report Officer' },
    create: { phone: PHONES[0]!, name: 'Report Officer', role: 'officer' },
  });
  const viewer = await prisma.user.upsert({
    where: { phone: PHONES[1] }, update: { deletedAt: null, role: 'viewer', name: 'Report Viewer' },
    create: { phone: PHONES[1]!, name: 'Report Viewer', role: 'viewer' },
  });
  officerId = officer.id;
  viewerId = viewer.id;

  await prisma.cadre.deleteMany({ where: { name: CADRE_NAME } });
  const cadre = await prisma.cadre.create({
    data: {
      name: CADRE_NAME, phone: '+910000000001', thana: 'बीजापुर सदर',
      currentAddress: 'Test address', designation: 'Test', category: 'surrendered',
      alertLevel: 'normal', aliases: [], assignedOfficerId: officerId, avatarUrl: 'https://x/a.jpg',
    },
  });
  cadreId = cadre.id;

  officerToken = await signAccessToken({ sub: officerId, role: 'officer' }, config.jwtSecret, '15m');
  viewerToken = await signAccessToken({ sub: viewerId, role: 'viewer' }, config.jwtSecret, '15m');
});

afterEach(purgeReports);

afterAll(async () => {
  await purgeReports();
  await prisma.cadre.deleteMany({ where: { id: cadreId } });
  await prisma.user.deleteMany({ where: { phone: { in: PHONES } } });
  await prisma.$disconnect();
});

interface WireReportBody {
  id: number;
  cadreId: number;
  cadre?: { id: number; name: string; phone: string; avatarUrl?: string };
  reportedBy: number;
  gpsCoords?: { latitude: number; longitude: number; address: string };
  [k: string]: unknown;
}

describe('reports', () => {
  it('GET reports without a token → 401', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}/reports` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('GET reports for an unknown cadre → 404', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/cadres/99999999/reports', headers: auth(officerToken) });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('POST create → 201 with camelCase entity, nested cadre, GPS, and audit + outbox', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
      headers: auth(officerToken), payload: validBody(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as WireReportBody;
    expect(body).toMatchObject({
      cadreId, reportedBy: officerId, specificLocation: 'गाँव चौक',
      reportingPlace: 'village', personStatus: 'alive',
    });
    expect(body.gpsCoords).toEqual({ latitude: 18.79, longitude: 80.9, address: 'बीजापुर' });
    expect(body.cadre).toMatchObject({ id: cadreId, name: CADRE_NAME });
    // Internal columns never leak.
    expect(body).not.toHaveProperty('reportedById');
    expect(body).not.toHaveProperty('deletedAt');
    expect(body).not.toHaveProperty('idempotencyKey');

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'report', entityId: String(body.id), action: 'report.create' },
    });
    expect(audit?.hash).toBeTruthy();
    const event = await prisma.outboxEvent.findFirst({
      where: { aggregateType: 'report', aggregateId: String(body.id), eventType: 'report.created' },
    });
    expect(event).not.toBeNull();
    await app.close();
  });

  it('POST create is idempotent — replay with the same key → 200, same record, no duplicate', async () => {
    const app = await makeApp();
    const key = randomUUID();
    const payload = { ...validBody(), idempotency_key: key };

    const first = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`, headers: auth(officerToken), payload,
    });
    expect(first.statusCode).toBe(201);
    const firstId = (first.json() as WireReportBody).id;

    const replay = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`, headers: auth(officerToken), payload,
    });
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as WireReportBody).id).toBe(firstId);

    const count = await prisma.report.count({ where: { cadreId, idempotencyKey: key } });
    expect(count).toBe(1);
    await app.close();
  });

  it('create with photo_keys → response re-signs them into photoUrls (ADR-016)', async () => {
    const app = await makeApp();
    const keys = [`reports/cadre-${cadreId}/a.jpg`, `reports/cadre-${cadreId}/b.jpg`];
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
      headers: auth(officerToken), payload: { ...validBody(), photo_keys: keys },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as WireReportBody & { photoUrls?: string[] };
    // Each stored key is handed back as a presigned URL, in order — never the raw key.
    expect(body.photoUrls).toHaveLength(2);
    expect(body.photoUrls![0]).toContain(keys[0]!);
    expect(body.photoUrls![0]).toContain('X-Amz-Expires');
    // The durable keys are persisted on the row.
    const row = await prisma.report.findUnique({ where: { id: body.id }, select: { photoKeys: true } });
    expect(row?.photoKeys).toEqual(keys);
    await app.close();
  });

  it('create honours a back-dated selected_date → reportedAt is the picked date, createdAt is now', async () => {
    const app = await makeApp();
    const picked = '2026-03-04T08:30:00.000Z';
    const before = Date.now();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
      headers: auth(officerToken), payload: { ...validBody(), selected_date: picked },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as WireReportBody;
    // The officer's picked date is what the client reads back and renders.
    expect(body.reportedAt).toBe(picked);
    // …while the insert time stays truthful, so the audit trail isn't back-dated.
    const row = await prisma.report.findUnique({
      where: { id: body.id }, select: { reportedAt: true, createdAt: true },
    });
    expect(row?.reportedAt.toISOString()).toBe(picked);
    expect(row!.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    await app.close();
  });

  it('create with no selected_date → reportedAt defaults to now', async () => {
    const app = await makeApp();
    const before = Date.now();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
      headers: auth(officerToken), payload: validBody(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as WireReportBody;
    expect(new Date(body.reportedAt as string).getTime()).toBeGreaterThanOrEqual(before);
    await app.close();
  });

  it('create with a future selected_date → clamped to now, never rejected (offline drain would drop it)', async () => {
    const app = await makeApp();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
      headers: auth(officerToken), payload: { ...validBody(), selected_date: future },
    });
    // A 400 here would make the mobile drain retry 3× and then silently discard
    // the report, so a skewed device clock must not cost the officer their work.
    expect(res.statusCode).toBe(201);
    const body = res.json() as WireReportBody;
    expect(new Date(body.reportedAt as string).getTime()).toBeLessThan(new Date(future).getTime());
    await app.close();
  });

  it('create rejects a malformed selected_date → 400 VALIDATION_ERROR', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
      headers: auth(officerToken), payload: { ...validBody(), selected_date: '04-03-2026' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    await app.close();
  });

  it('create rejects more than 3 photo_keys → 400 VALIDATION_ERROR', async () => {
    const app = await makeApp();
    const keys = [1, 2, 3, 4].map((n) => `reports/cadre-${cadreId}/${n}.jpg`);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
      headers: auth(officerToken), payload: { ...validBody(), photo_keys: keys },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    await app.close();
  });

  it('GET detail returns the report; unknown id → 404', async () => {
    const app = await makeApp();
    const created = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`, headers: auth(officerToken), payload: validBody(),
    });
    const id = (created.json() as WireReportBody).id;

    const ok = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}/reports/${id}`, headers: auth(officerToken) });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as WireReportBody).id).toBe(id);

    const miss = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}/reports/99999999`, headers: auth(officerToken) });
    expect(miss.statusCode).toBe(404);
    await app.close();
  });

  it('GET list returns a paginated, newest-first feed scoped to the cadre', async () => {
    const app = await makeApp();
    await app.inject({ method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`, headers: auth(officerToken), payload: { ...validBody(), specific_location: 'पहला' } });
    await app.inject({ method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`, headers: auth(officerToken), payload: { ...validBody(), specific_location: 'दूसरा' } });

    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}/reports?pageSize=50`, headers: auth(officerToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: WireReportBody[]; total: number; page: number; pageSize: number; hasMore: boolean };
    expect(body.total).toBe(2);
    expect(body.data.every((r) => r.cadreId === cadreId)).toBe(true);
    // Newest first (reportedAt desc → last created leads).
    expect(body.data[0]!.specificLocation).toBe('दूसरा');
    await app.close();
  });

  it('search filters the list by specific location', async () => {
    const app = await makeApp();
    await app.inject({ method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`, headers: auth(officerToken), payload: { ...validBody(), specific_location: 'रेलवे स्टेशन' } });
    await app.inject({ method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`, headers: auth(officerToken), payload: { ...validBody(), specific_location: 'बस अड्डा' } });

    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}/reports?search=${encodeURIComponent('रेलवे')}`, headers: auth(officerToken) });
    const body = res.json() as { data: WireReportBody[]; total: number };
    expect(body.total).toBe(1);
    expect(body.data[0]!.specificLocation).toBe('रेलवे स्टेशन');
    await app.close();
  });

  it('create with a missing required field → 400 VALIDATION_ERROR', async () => {
    const app = await makeApp();
    const { specific_location, ...bad } = validBody();
    void specific_location;
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`, headers: auth(officerToken), payload: bad,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    await app.close();
  });

  it('create is forbidden for viewers (403)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`, headers: auth(viewerToken), payload: validBody(),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('create with a body cadre_id that differs from the URL → 400 CADRE_ID_MISMATCH', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
      headers: auth(officerToken), payload: { ...validBody(), cadre_id: cadreId + 1 },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('CADRE_ID_MISMATCH');
    await app.close();
  });

  it('create against an unknown cadre → 404', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/cadres/99999999/reports',
      headers: auth(officerToken), payload: { ...validBody(), cadre_id: 99999999 },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
