import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';

const prisma = new PrismaClient();
const config = testConfig();
const PHONES = ['+919000000030', '+919000000031', '+919000000032', '+919000000033'];
const CADRE_NAME = 'TEST CADRE REPORTS';

let officerId = 0;
let viewerId = 0;
let superAdminId = 0;
let officer2Id = 0;
let cadreId = 0;
let officerToken = '';
let viewerToken = '';
let superAdminToken = '';
let officer2Token = '';
const CADRE_ORIGINAL_PHONE = '+910000000001';

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

  // ADR-052: validBody()'s current_phone differs from the fixture cadre's phone
  // by design (to exercise the sync), so every create() also proposes a phone
  // change in the background. Purge those too, same pattern as
  // cadre-changes.test.ts, so a pending phone request from one test doesn't
  // collide (409 CHANGE_PENDING, silently swallowed) with the next.
  const changeRows = await prisma.cadreChangeRequest.findMany({ where: { cadreId }, select: { id: true } });
  const changeIds = changeRows.map((r) => String(r.id));
  if (changeIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { entityType: 'cadre_change_request', entityId: { in: changeIds } } });
  }
  await prisma.cadreChangeRequest.deleteMany({ where: { cadreId } });
}

beforeAll(async () => {
  const officer = await prisma.user.upsert({
    // ADR-044: the officer must be posted to the fixture cadre's station, or scope
    // filtering (correctly) hides it and every report route 404s.
    where: { phone: PHONES[0] },
    update: { deletedAt: null, role: 'officer', name: 'Report Officer', thana: 'बीजापुर सदर' },
    create: { phone: PHONES[0]!, name: 'Report Officer', role: 'officer', thana: 'बीजापुर सदर' },
  });
  const viewer = await prisma.user.upsert({
    where: { phone: PHONES[1] }, update: { deletedAt: null, role: 'viewer', name: 'Report Viewer' },
    create: { phone: PHONES[1]!, name: 'Report Viewer', role: 'viewer' },
  });
  const superAdmin = await prisma.user.upsert({
    where: { phone: PHONES[2] }, update: { deletedAt: null, role: 'super_admin', name: 'Report SuperAdmin' },
    create: { phone: PHONES[2]!, name: 'Report SuperAdmin', role: 'super_admin' },
  });
  // This task, item 3. A SECOND officer at the same thana, so "an officer can only
  // delete their OWN report" is exercised against another real officer's report,
  // not just a role check.
  const officer2 = await prisma.user.upsert({
    where: { phone: PHONES[3] },
    update: { deletedAt: null, role: 'officer', name: 'Report Officer 2', thana: 'बीजापुर सदर' },
    create: { phone: PHONES[3]!, name: 'Report Officer 2', role: 'officer', thana: 'बीजापुर सदर' },
  });
  officerId = officer.id;
  viewerId = viewer.id;
  superAdminId = superAdmin.id;
  officer2Id = officer2.id;

  await prisma.cadre.deleteMany({ where: { name: CADRE_NAME } });
  const cadre = await prisma.cadre.create({
    data: {
      name: CADRE_NAME, phone: CADRE_ORIGINAL_PHONE, thana: 'बीजापुर सदर',
      currentAddress: 'Test address', designation: 'Test', category: 'surrendered',
      alertLevel: 'normal', aliases: [], assignedOfficerId: officerId, avatarUrl: 'https://x/a.jpg',
    },
  });
  cadreId = cadre.id;

  officerToken = await signAccessToken({ sub: officerId, role: 'officer' }, config.jwtSecret, '15m');
  viewerToken = await signAccessToken({ sub: viewerId, role: 'viewer' }, config.jwtSecret, '15m');
  superAdminToken = await signAccessToken({ sub: superAdminId, role: 'super_admin' }, config.jwtSecret, '15m');
  officer2Token = await signAccessToken({ sub: officer2Id, role: 'officer' }, config.jwtSecret, '15m');
});

afterEach(purgeReports);

afterAll(async () => {
  await purgeReports();
  await prisma.cadre.deleteMany({ where: { id: cadreId } });
  await prisma.notification.deleteMany({ where: { user: { phone: { in: PHONES } } } });
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

  // ── Structured description fields (ADR-050) ────────────────────────────────

  it('create with surrender_network_details and other_information → both round-trip on the wire', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
      headers: auth(officerToken),
      payload: {
        ...validBody(),
        surrender_network_details: 'दो अन्य साथियों के साथ समर्पण की जानकारी दी',
        other_information: 'परिवार से मुलाकात हुई',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as WireReportBody;
    expect(body.surrenderNetworkDetails).toBe('दो अन्य साथियों के साथ समर्पण की जानकारी दी');
    expect(body.otherInformation).toBe('परिवार से मुलाकात हुई');
    await app.close();
  });

  it('create without surrender_network_details / other_information → both omitted from the wire, not null', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
      headers: auth(officerToken), payload: validBody(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as WireReportBody;
    expect(body).not.toHaveProperty('surrenderNetworkDetails');
    expect(body).not.toHaveProperty('otherInformation');
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

  // ── Date-only filter (ADR-024) ─────────────────────────────────────────────

  it('date filters the log to that IST calendar day', async () => {
    const app = await makeApp();
    // 12:00 IST on each day — safely inside the day under either timezone reading,
    // so this test passes even if the IST handling were wrong. The boundary test
    // below is the one that actually pins the behaviour.
    await app.inject({ method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`, headers: auth(officerToken), payload: { ...validBody(), specific_location: 'चौदह', selected_date: '2026-07-14T06:30:00.000Z' } });
    await app.inject({ method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`, headers: auth(officerToken), payload: { ...validBody(), specific_location: 'पंद्रह', selected_date: '2026-07-15T06:30:00.000Z' } });

    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}/reports?date=2026-07-15`, headers: auth(officerToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: WireReportBody[]; total: number };
    expect(body.total).toBe(1);
    expect(body.data[0]!.specificLocation).toBe('पंद्रह');
    await app.close();
  });

  it('date buckets a report by IST, not UTC, across the midnight boundary', async () => {
    const app = await makeApp();
    // 00:30 IST on the 16th IS 19:00 UTC on the 15th. A UTC-day filter would file
    // this under the 15th, so the officer who wrote it at half past midnight would
    // pick "16 जुलाई" and not find their own report.
    await app.inject({ method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`, headers: auth(officerToken), payload: { ...validBody(), specific_location: 'आधी रात के बाद', selected_date: '2026-07-15T19:00:00.000Z' } });

    const utcDay = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}/reports?date=2026-07-15`, headers: auth(officerToken) });
    expect((utcDay.json() as { total: number }).total).toBe(0);

    const istDay = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}/reports?date=2026-07-16`, headers: auth(officerToken) });
    const body = istDay.json() as { data: WireReportBody[]; total: number };
    expect(body.total).toBe(1);
    expect(body.data[0]!.specificLocation).toBe('आधी रात के बाद');
    await app.close();
  });

  it('a malformed date → 400 VALIDATION_ERROR', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}/reports?date=16-07-2026`, headers: auth(officerToken) });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    await app.close();
  });

  it('a legacy `search` param is ignored, not rejected', async () => {
    const app = await makeApp();
    await app.inject({ method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`, headers: auth(officerToken), payload: { ...validBody(), specific_location: 'रेलवे स्टेशन' } });
    await app.inject({ method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`, headers: auth(officerToken), payload: { ...validBody(), specific_location: 'बस अड्डा' } });

    // An older build still sending `search` must not 400 a field officer mid-task.
    // Zod strips the unknown key, so the filter simply does not apply.
    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}/reports?search=${encodeURIComponent('रेलवे')}`, headers: auth(officerToken) });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { total: number }).total).toBe(2);
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

  // ── ADR-049: jail/death cadres cannot be reported ──────────────────────────

  describe('reportability (ADR-049)', () => {
    it('create against a jail-custody cadre (category) → 400 CADRE_NOT_REPORTABLE', async () => {
      const jail = await prisma.cadre.create({
        data: {
          name: 'TEST CADRE JAIL', phone: '+910000000002', thana: 'बीजापुर सदर',
          currentAddress: 'Test address', designation: 'Test', category: 'jail',
          alertLevel: 'normal', aliases: [], assignedOfficerId: officerId, avatarUrl: 'https://x/a.jpg',
        },
      });
      const app = await makeApp();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${jail.id}/reports`,
        headers: auth(officerToken), payload: { ...validBody(), cadre_id: jail.id },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe('CADRE_NOT_REPORTABLE');
      await prisma.cadre.delete({ where: { id: jail.id } });
      await app.close();
    });

    it('create against a priorityCategory=death cadre → 400 CADRE_NOT_REPORTABLE', async () => {
      const dead = await prisma.cadre.create({
        data: {
          name: 'TEST CADRE DEATH', phone: '+910000000003', thana: 'बीजापुर सदर',
          currentAddress: 'Test address', designation: 'Test', category: 'surrendered',
          priorityCategory: 'death',
          alertLevel: 'normal', aliases: [], assignedOfficerId: officerId, avatarUrl: 'https://x/a.jpg',
        },
      });
      const app = await makeApp();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${dead.id}/reports`,
        headers: auth(officerToken), payload: { ...validBody(), cadre_id: dead.id },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe('CADRE_NOT_REPORTABLE');
      await prisma.cadre.delete({ where: { id: dead.id } });
      await app.close();
    });

    it('create against a priorityCategory=jail cadre (distinct from Cadre.category) → 400 CADRE_NOT_REPORTABLE', async () => {
      const jailGrade = await prisma.cadre.create({
        data: {
          name: 'TEST CADRE JAIL GRADE', phone: '+910000000004', thana: 'बीजापुर सदर',
          currentAddress: 'Test address', designation: 'Test', category: 'surrendered',
          priorityCategory: 'jail',
          alertLevel: 'normal', aliases: [], assignedOfficerId: officerId, avatarUrl: 'https://x/a.jpg',
        },
      });
      const app = await makeApp();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${jailGrade.id}/reports`,
        headers: auth(officerToken), payload: { ...validBody(), cadre_id: jailGrade.id },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe('CADRE_NOT_REPORTABLE');
      await prisma.cadre.delete({ where: { id: jailGrade.id } });
      await app.close();
    });

    // This task, item 7: permanentStatus extends the same ADR-049-style block —
    // "no attendance/reporting required" means filing a NEW report is exactly
    // the act being exempted.
    it('create against a permanentStatus-tagged cadre → 400 CADRE_NOT_REPORTABLE', async () => {
      const marked = await prisma.cadre.create({
        data: {
          name: 'TEST CADRE PERMSTATUS', phone: '+910000000005', thana: 'बीजापुर सदर',
          currentAddress: 'Test address', designation: 'Test', category: 'surrendered',
          permanentStatus: 'living_elsewhere',
          alertLevel: 'normal', aliases: [], assignedOfficerId: officerId, avatarUrl: 'https://x/a.jpg',
        },
      });
      const app = await makeApp();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${marked.id}/reports`,
        headers: auth(officerToken), payload: { ...validBody(), cadre_id: marked.id },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe('CADRE_NOT_REPORTABLE');
      await prisma.cadre.delete({ where: { id: marked.id } });
      await app.close();
    });
  });

  // ── ADR-052: report-time phone mismatch proposes a change, never writes directly ──

  describe('report-time phone sync (ADR-052)', () => {
    it('officer report with a different current_phone → a pending phone CadreChangeRequest, cadre.phone unchanged', async () => {
      const app = await makeApp();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
        headers: auth(officerToken), payload: validBody(), // current_phone !== CADRE_ORIGINAL_PHONE
      });
      expect(res.statusCode).toBe(201);

      const change = await prisma.cadreChangeRequest.findFirst({ where: { cadreId, status: 'pending' } });
      expect(change).not.toBeNull();
      expect((change!.changes as Record<string, { old: string; new: string }>).phone).toEqual({
        old: CADRE_ORIGINAL_PHONE,
        new: '+919812345678',
      });
      expect(change!.submittedById).toBe(officerId);
      // Officer submitted → needs both rungs, so it must NOT have applied yet.
      expect(change!.needsAdmin).toBe(true);
      expect(change!.needsSuperAdmin).toBe(true);

      const cadre = await prisma.cadre.findUnique({ where: { id: cadreId }, select: { phone: true } });
      expect(cadre?.phone).toBe(CADRE_ORIGINAL_PHONE);
      await app.close();
    });

    it('report with current_phone === cadre.phone → no change request proposed', async () => {
      const app = await makeApp();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
        headers: auth(officerToken), payload: { ...validBody(), current_phone: CADRE_ORIGINAL_PHONE },
      });
      expect(res.statusCode).toBe(201);
      const change = await prisma.cadreChangeRequest.findFirst({ where: { cadreId } });
      expect(change).toBeNull();
      await app.close();
    });

    it('super_admin report with a different current_phone → applies immediately, same as any other super_admin edit', async () => {
      const app = await makeApp();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
        headers: auth(superAdminToken), payload: validBody(),
      });
      expect(res.statusCode).toBe(201);

      const cadre = await prisma.cadre.findUnique({ where: { id: cadreId }, select: { phone: true } });
      expect(cadre?.phone).toBe('+919812345678');

      const change = await prisma.cadreChangeRequest.findFirst({ where: { cadreId }, orderBy: { id: 'desc' } });
      expect(change?.status).toBe('applied');

      // Restore the fixture so later/re-runs see the original phone again.
      await prisma.cadre.update({ where: { id: cadreId }, data: { phone: CADRE_ORIGINAL_PHONE } });
      await app.close();
    });

    it('a report that collides with an already-pending phone change still succeeds (201) — the collision is swallowed, not surfaced', async () => {
      const app = await makeApp();
      const first = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
        headers: auth(officerToken), payload: validBody(),
      });
      expect(first.statusCode).toBe(201);

      // Second report, same mismatch → submit() would 409 CHANGE_PENDING internally;
      // the report itself must not fail because of it.
      const second = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
        headers: auth(officerToken),
        payload: { ...validBody(), specific_location: 'दूसरी रिपोर्ट' },
      });
      expect(second.statusCode).toBe(201);

      // Still exactly one pending phone request — the second attempt did not
      // create a duplicate or clobber the first.
      const pending = await prisma.cadreChangeRequest.findMany({ where: { cadreId, status: 'pending' } });
      expect(pending).toHaveLength(1);
      await app.close();
    });
  });

  // ── report-time photo sync (this task) — mirrors ADR-052's phone sync ───────

  describe('report-time photo sync (this task)', () => {
    it('officer report with all three photo keys → three independent pending avatar CadreChangeRequests, cadre avatars unchanged', async () => {
      const app = await makeApp();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
        headers: auth(officerToken),
        payload: {
          ...validBody(),
          front_photo_key: 'reports/front.jpg',
          right_photo_key: 'reports/right.jpg',
          left_photo_key: 'reports/left.jpg',
        },
      });
      expect(res.statusCode).toBe(201);

      const pending = await prisma.cadreChangeRequest.findMany({ where: { cadreId, status: 'pending' } });
      // Three photo slots + the phone sync every validBody() also triggers.
      expect(pending).toHaveLength(4);
      const byField = new Map(
        pending.map((c) => [Object.keys(c.changes as Record<string, unknown>)[0], c.changes as Record<string, { new: string }>]),
      );
      expect(byField.get('avatarKey')?.avatarKey?.new).toBe('reports/front.jpg');
      expect(byField.get('avatarKey2')?.avatarKey2?.new).toBe('reports/right.jpg');
      expect(byField.get('avatarKey3')?.avatarKey3?.new).toBe('reports/left.jpg');

      const cadre = await prisma.cadre.findUnique({
        where: { id: cadreId }, select: { avatarKey: true, avatarKey2: true, avatarKey3: true },
      });
      expect(cadre).toMatchObject({ avatarKey: null, avatarKey2: null, avatarKey3: null });
      await app.close();
    });

    it('report with only one photo key (right) → only that slot is proposed, the other two are not touched', async () => {
      const app = await makeApp();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
        headers: auth(officerToken),
        payload: { ...validBody(), right_photo_key: 'reports/right-only.jpg' },
      });
      expect(res.statusCode).toBe(201);

      const pending = await prisma.cadreChangeRequest.findMany({ where: { cadreId, status: 'pending' } });
      const avatarChanges = pending.filter((c) => Object.keys(c.changes as Record<string, unknown>)[0]?.startsWith('avatarKey'));
      expect(avatarChanges).toHaveLength(1);
      const changes = avatarChanges[0]!.changes as Record<string, { new: string }>;
      expect(changes.avatarKey2?.new).toBe('reports/right-only.jpg');
      await app.close();
    });

    it('report with no photo keys → no avatar change request proposed', async () => {
      const app = await makeApp();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
        headers: auth(officerToken), payload: validBody(),
      });
      expect(res.statusCode).toBe(201);
      const pending = await prisma.cadreChangeRequest.findMany({ where: { cadreId, status: 'pending' } });
      expect(pending.some((c) => Object.keys(c.changes as Record<string, unknown>)[0]?.startsWith('avatarKey'))).toBe(false);
      await app.close();
    });

    it('super_admin report with a front photo key → applies immediately, same as any other super_admin edit', async () => {
      const app = await makeApp();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
        headers: auth(superAdminToken),
        payload: { ...validBody(), front_photo_key: 'reports/super-front.jpg' },
      });
      expect(res.statusCode).toBe(201);

      const cadre = await prisma.cadre.findUnique({ where: { id: cadreId }, select: { avatarKey: true } });
      expect(cadre?.avatarKey).toBe('reports/super-front.jpg');

      // Restore the fixture so later/re-runs see no avatar again.
      await prisma.cadre.update({ where: { id: cadreId }, data: { avatarKey: null } });
      await app.close();
    });

    it('a report that collides with an already-pending avatar change still succeeds (201) — the collision is swallowed, not surfaced', async () => {
      const app = await makeApp();
      const first = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
        headers: auth(officerToken),
        payload: { ...validBody(), front_photo_key: 'reports/first-front.jpg' },
      });
      expect(first.statusCode).toBe(201);

      // Second report, same slot → submit() would 409 CHANGE_PENDING internally;
      // the report itself must not fail because of it.
      const second = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
        headers: auth(officerToken),
        payload: { ...validBody(), specific_location: 'दूसरी रिपोर्ट', front_photo_key: 'reports/second-front.jpg' },
      });
      expect(second.statusCode).toBe(201);

      // Still exactly one pending avatarKey request — the second attempt did not
      // create a duplicate or clobber the first.
      const pending = await prisma.cadreChangeRequest.findMany({ where: { cadreId, status: 'pending' } });
      const avatarChanges = pending.filter((c) => Object.keys(c.changes as Record<string, unknown>)[0] === 'avatarKey');
      expect(avatarChanges).toHaveLength(1);
      await app.close();
    });
  });

  // ── report-time death sync (this task) ───────────────────────────────────────
  describe('report-time death sync (this task)', () => {
    const deadBody = (overrides: Record<string, unknown> = {}) => ({
      cadre_id: cadreId,
      reporting_place: 'village' as const,
      person_status: 'dead' as const,
      other_information: 'गाँव वालों के अनुसार मुठभेड़ में मृत्यु हुई',
      death_date: '2026-08-15T00:00:00.000Z',
      ...overrides,
    });

    it('a dead report with only other_information + death_date → 201, no specific_location/current_phone/current_activity required', async () => {
      const app = await makeApp();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
        headers: auth(officerToken), payload: deadBody(),
      });
      expect(res.statusCode).toBe(201);
      await app.close();
    });

    it('a dead report missing other_information → 400', async () => {
      const app = await makeApp();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
        headers: auth(officerToken), payload: deadBody({ other_information: '' }),
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it('a dead report missing death_date → 400', async () => {
      const app = await makeApp();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
        headers: auth(officerToken), payload: deadBody({ death_date: undefined }),
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it('an alive report still requires specific_location/current_phone/current_activity → 400 each when missing', async () => {
      const app = await makeApp();
      const base = { cadre_id: cadreId, reporting_place: 'village' as const, person_status: 'alive' as const };
      const missingLocation = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
        headers: auth(officerToken), payload: { ...base, current_phone: 'x', current_activity: 'x' },
      });
      expect(missingLocation.statusCode).toBe(400);
      const missingPhone = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
        headers: auth(officerToken), payload: { ...base, specific_location: 'x', current_activity: 'x' },
      });
      expect(missingPhone.statusCode).toBe(400);
      const missingActivity = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
        headers: auth(officerToken), payload: { ...base, specific_location: 'x', current_phone: 'x' },
      });
      expect(missingActivity.statusCode).toBe(400);
      await app.close();
    });

    it('officer dead report → ONE bundled pending change proposing permanentStatus+deceasedDate together, cadre unchanged', async () => {
      const app = await makeApp();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
        headers: auth(officerToken), payload: deadBody(),
      });
      expect(res.statusCode).toBe(201);

      const pending = await prisma.cadreChangeRequest.findMany({ where: { cadreId, status: 'pending' } });
      expect(pending).toHaveLength(1);
      const changes = pending[0]!.changes as Record<string, { old: unknown; new: unknown }>;
      expect(changes.permanentStatus).toEqual({ old: null, new: 'deceased' });
      expect(changes.deceasedDate?.new).toBe('2026-08-15T00:00:00.000Z');
      // Officer submitted → needs both rungs.
      expect(pending[0]!.needsAdmin).toBe(true);
      expect(pending[0]!.needsSuperAdmin).toBe(true);

      const cadre = await prisma.cadre.findUnique({ where: { id: cadreId }, select: { permanentStatus: true, deceasedDate: true } });
      expect(cadre).toMatchObject({ permanentStatus: null, deceasedDate: null });
      await app.close();
    });

    it('super_admin dead report → applies immediately, cadre marked deceased with the date set', async () => {
      const app = await makeApp();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
        headers: auth(superAdminToken), payload: deadBody(),
      });
      expect(res.statusCode).toBe(201);

      const cadre = await prisma.cadre.findUnique({ where: { id: cadreId }, select: { permanentStatus: true, deceasedDate: true } });
      expect(cadre?.permanentStatus).toBe('deceased');
      expect(cadre?.deceasedDate?.toISOString()).toBe('2026-08-15T00:00:00.000Z');

      // Restore the fixture so later/re-runs are unaffected — same pattern the
      // photo-sync and phone-sync super_admin tests already use.
      await prisma.cadre.update({ where: { id: cadreId }, data: { permanentStatus: null, deceasedDate: null } });
      await app.close();
    });

    it('deleting the report that proposed a still-pending death mark withdraws it — status effectively reverts to "not deceased"', async () => {
      const app = await makeApp();
      const create = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
        headers: auth(officerToken), payload: deadBody(),
      });
      expect(create.statusCode).toBe(201);
      const reportId = (create.json() as WireReportBody).id;

      const beforeDelete = await prisma.cadreChangeRequest.findFirst({ where: { cadreId, status: 'pending' } });
      expect(beforeDelete).not.toBeNull();

      const del = await app.inject({
        method: 'DELETE', url: `/api/v1/cadres/${cadreId}/reports/${reportId}`,
        headers: auth(officerToken),
      });
      expect(del.statusCode).toBe(204);

      const after = await prisma.cadreChangeRequest.findUnique({ where: { id: beforeDelete!.id } });
      expect(after?.status).toBe('cancelled');

      const cadre = await prisma.cadre.findUnique({ where: { id: cadreId }, select: { permanentStatus: true } });
      expect(cadre?.permanentStatus).toBe(null);
      await app.close();
    });

    it('deleting a report whose death mark was ALREADY applied does not revert the cadre — that stays a deliberate profile edit', async () => {
      const app = await makeApp();
      const create = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
        headers: auth(superAdminToken), payload: deadBody(),
      });
      expect(create.statusCode).toBe(201);
      const reportId = (create.json() as WireReportBody).id;

      const del = await app.inject({
        method: 'DELETE', url: `/api/v1/cadres/${cadreId}/reports/${reportId}`,
        headers: auth(superAdminToken),
      });
      expect(del.statusCode).toBe(204);

      const cadre = await prisma.cadre.findUnique({ where: { id: cadreId }, select: { permanentStatus: true, deceasedDate: true } });
      expect(cadre?.permanentStatus).toBe('deceased');

      // Restore the fixture.
      await prisma.cadre.update({ where: { id: cadreId }, data: { permanentStatus: null, deceasedDate: null } });
      await app.close();
    });
  });

  // ── DELETE /cadres/:cadreId/reports/:reportId (this task, item 3) ───────────

  describe('DELETE report', () => {
    async function fileAsOfficer(): Promise<number> {
      const app = await makeApp();
      const res = await app.inject({
        method: 'POST', url: `/api/v1/cadres/${cadreId}/reports`,
        headers: auth(officerToken), payload: validBody(),
      });
      const id = (res.json() as WireReportBody).id;
      await app.close();
      return id;
    }

    it('without a token → 401', async () => {
      const app = await makeApp();
      const res = await app.inject({ method: 'DELETE', url: `/api/v1/cadres/${cadreId}/reports/1` });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it('a viewer is refused (403) — read-only, same gate as create', async () => {
      const reportId = await fileAsOfficer();
      const app = await makeApp();
      const res = await app.inject({
        method: 'DELETE', url: `/api/v1/cadres/${cadreId}/reports/${reportId}`, headers: auth(viewerToken),
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it('an officer deletes their OWN report within the window → 204, soft-deleted, audited', async () => {
      const reportId = await fileAsOfficer();
      const app = await makeApp();
      const res = await app.inject({
        method: 'DELETE', url: `/api/v1/cadres/${cadreId}/reports/${reportId}`, headers: auth(officerToken),
      });
      expect(res.statusCode).toBe(204);

      const row = await prisma.report.findUnique({ where: { id: reportId } });
      expect(row?.deletedAt).not.toBeNull(); // soft-deleted, row still exists

      const getRes = await app.inject({
        method: 'GET', url: `/api/v1/cadres/${cadreId}/reports/${reportId}`, headers: auth(officerToken),
      });
      expect(getRes.statusCode).toBe(404); // and no longer reachable through the normal read path

      const audit = await prisma.auditLog.findFirst({
        where: { entityType: 'report', entityId: String(reportId), action: 'report.delete' },
      });
      expect(audit).not.toBeNull();
      expect(audit?.actorId).toBe(officerId);
      await app.close();
    });

    it('an officer CANNOT delete another officer\'s report', async () => {
      const reportId = await fileAsOfficer(); // filed by `officerToken`
      const app = await makeApp();
      const res = await app.inject({
        method: 'DELETE', url: `/api/v1/cadres/${cadreId}/reports/${reportId}`, headers: auth(officer2Token),
      });
      expect(res.statusCode).toBe(403);
      const row = await prisma.report.findUnique({ where: { id: reportId } });
      expect(row?.deletedAt).toBeNull(); // untouched
      await app.close();
    });

    it('an officer CANNOT delete their own report past the 24-hour window', async () => {
      const reportId = await fileAsOfficer();
      // Backdate createdAt past the window — the only way to exercise this without
      // actually waiting 24 hours.
      await prisma.report.update({
        where: { id: reportId },
        data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
      });
      const app = await makeApp();
      const res = await app.inject({
        method: 'DELETE', url: `/api/v1/cadres/${cadreId}/reports/${reportId}`, headers: auth(officerToken),
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it('super_admin can delete any report, with no time window', async () => {
      const reportId = await fileAsOfficer();
      await prisma.report.update({
        where: { id: reportId },
        data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
      });
      const app = await makeApp();
      const res = await app.inject({
        method: 'DELETE', url: `/api/v1/cadres/${cadreId}/reports/${reportId}`, headers: auth(superAdminToken),
      });
      expect(res.statusCode).toBe(204);
      await app.close();
    });

    it('deleting an already-deleted (or nonexistent) report → 404', async () => {
      const reportId = await fileAsOfficer();
      const app = await makeApp();
      const first = await app.inject({
        method: 'DELETE', url: `/api/v1/cadres/${cadreId}/reports/${reportId}`, headers: auth(superAdminToken),
      });
      expect(first.statusCode).toBe(204);
      const second = await app.inject({
        method: 'DELETE', url: `/api/v1/cadres/${cadreId}/reports/${reportId}`, headers: auth(superAdminToken),
      });
      expect(second.statusCode).toBe(404);
      await app.close();
    });

    it('an out-of-scope cadre 404s rather than leaking whether the report exists', async () => {
      const app = await makeApp();
      const res = await app.inject({
        method: 'DELETE', url: '/api/v1/cadres/99999999/reports/1', headers: auth(superAdminToken),
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });
});
