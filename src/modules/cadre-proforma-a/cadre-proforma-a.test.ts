import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';

const prisma = new PrismaClient();
const config = testConfig();

// See cadre-changes.test.ts's comment on this block — the 100-103 block is free
// at the time of writing (grep -rho "+91[0-9]\{10\}" --include=*.test.ts src/).
const PHONES = ['+919000000100', '+919000000101', '+919000000102', '+919000000103'];
const CADRE_NAME = 'TEST CADRE PROFORMA A';

let superId = 0;
let adminId = 0;
let officerId = 0;
let viewerId = 0;
let cadreId = 0;
let superToken = '';
let adminToken = '';
let officerToken = '';
let viewerToken = '';

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const makeApp = (): Promise<FastifyInstance> => buildApp({ config, prisma, logger: false });

interface WireRequest {
  id: number;
  status: string;
  changeType: string;
  needsAdmin: boolean;
  needsSuperAdmin: boolean;
  awaitingRole?: string;
}

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

  superId = (await mk(PHONES[0]!, 'super_admin', 'PfA Super')).id;
  adminId = (await mk(PHONES[1]!, 'admin', 'PfA Admin', { subDivision: 'बीजापुर' })).id;
  officerId = (await mk(PHONES[2]!, 'officer', 'PfA Officer', { thana: 'बीजापुर' })).id;
  viewerId = (await mk(PHONES[3]!, 'viewer', 'PfA Viewer')).id;

  await prisma.proformaChangeRequest.deleteMany({ where: { cadre: { name: CADRE_NAME } } });
  await prisma.cadreProformaA.deleteMany({ where: { cadre: { name: CADRE_NAME } } });
  await prisma.cadre.deleteMany({ where: { name: CADRE_NAME } });
  const cadre = await prisma.cadre.create({
    data: {
      name: CADRE_NAME, phone: '+910000000900', thana: 'बीजापुर', currentAddress: 'फिक्स्चर पता',
      designation: 'Fixture', category: 'surrendered', alertLevel: 'normal', aliases: [],
    },
  });
  cadreId = cadre.id;

  superToken = await signAccessToken({ sub: superId, role: 'super_admin' }, config.jwtSecret, '15m');
  adminToken = await signAccessToken({ sub: adminId, role: 'admin' }, config.jwtSecret, '15m');
  officerToken = await signAccessToken({ sub: officerId, role: 'officer' }, config.jwtSecret, '15m');
  viewerToken = await signAccessToken({ sub: viewerId, role: 'viewer' }, config.jwtSecret, '15m');
});

afterEach(async () => {
  const rows = await prisma.proformaChangeRequest.findMany({ where: { cadreId }, select: { id: true } });
  const ids = rows.map((r) => String(r.id));
  if (ids.length > 0) {
    await prisma.auditLog.deleteMany({ where: { entityType: 'proforma_change_request', entityId: { in: ids } } });
  }
  const proformaRows = await prisma.cadreProformaA.findMany({ where: { cadreId }, select: { id: true } });
  const proformaIds = proformaRows.map((r) => String(r.id));
  if (proformaIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { entityType: 'cadre_proforma_a', entityId: { in: proformaIds } } });
  }
  await prisma.proformaChangeRequest.deleteMany({ where: { cadreId } });
  await prisma.cadreProformaA.deleteMany({ where: { cadreId } });
});

afterAll(async () => {
  await prisma.proformaChangeRequest.deleteMany({ where: { cadreId } });
  await prisma.cadreProformaA.deleteMany({ where: { cadreId } });
  await prisma.cadre.deleteMany({ where: { name: CADRE_NAME } });
  await prisma.$disconnect();
});

const MINIMAL_FIELDS = {
  party: 'टेस्ट पार्टी',
  fatherOccupation: null, spouseOccupation: null, subCaste: null, religion: null, placeOfBirth: null,
  aadhaarNumber: null, identifierMobile: null, identifierEmail: null, socialMediaHandle: null,
  rationCardNumber: null, voterIdNumber: null, drivingLicenseNumber: null, bankAccountNumber: null,
  postOfficeAccountNumber: null, educationalQualification: null, occupation: null,
  economicStatus: 'average', fingerprintKey: null,
  height: null, build: 'दुबला', complexion: null, distinguishingFeatures: null, hair: null,
  eyebrows: null, eyes: null, irisColor: null, nose: null, teeth: null, lips: null, fingers: null,
  chin: null, ears: null, face: null, beard: null, moustache: null, marksOrTattoos: null, deformity: null,
  specialHabits: null, vulnerabilities: null, handwritingSampleKey: null, friendsAndAssociates: null,
  childhoodFriends: null, classmates: null, organizationAssociatesChronological: null, relatives: null,
  identifyingPoliceOfficers: null, otherPointsOfInterest: null,
  priorArrestDetails: null, convictions: null, areaOfOperation: null,
  sectionB: { reasonForJoining: 'विचारधारा' }, sectionC: null, sectionD: null,
};

describe('AB Proforma (ADR-064)', () => {
  it('rejects an unauthenticated request', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}/proforma-a` });
    expect(res.statusCode).toBe(401);
  });

  it('404s before any AB Proforma has been created', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cadres/${cadreId}/proforma-a`,
      headers: auth(officerToken),
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an invalid economicStatus at the Zod boundary', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cadres/${cadreId}/proforma-a`,
      headers: auth(officerToken),
      payload: { fields: { ...MINIMAL_FIELDS, economicStatus: 'rich' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('viewers cannot propose a create', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cadres/${cadreId}/proforma-a`,
      headers: auth(viewerToken),
      payload: { fields: MINIMAL_FIELDS },
    });
    expect(res.statusCode).toBe(403);
  });

  it('officer → admin → super_admin: create is NOT applied until the last rung signs, then GET returns it', async () => {
    const app = await makeApp();
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/cadres/${cadreId}/proforma-a`,
      headers: auth(officerToken),
      payload: { fields: MINIMAL_FIELDS, note: 'पहली बार' },
    });
    expect(create.statusCode).toBe(201);
    const req = create.json() as WireRequest;
    expect(req.status).toBe('pending');
    expect(req.changeType).toBe('create');
    expect(req.awaitingRole).toBe('admin');

    const stillMissing = await app.inject({
      method: 'GET',
      url: `/api/v1/cadres/${cadreId}/proforma-a`,
      headers: auth(officerToken),
    });
    expect(stillMissing.statusCode).toBe(404);

    const a = await app.inject({
      method: 'POST',
      url: `/api/v1/proforma-a-changes/${req.id}/approve`,
      headers: auth(adminToken),
    });
    expect(a.statusCode).toBe(200);
    expect((a.json() as WireRequest).status).toBe('pending');

    const s = await app.inject({
      method: 'POST',
      url: `/api/v1/proforma-a-changes/${req.id}/approve`,
      headers: auth(superToken),
    });
    expect(s.statusCode).toBe(200);
    expect((s.json() as WireRequest).status).toBe('applied');

    const got = await app.inject({
      method: 'GET',
      url: `/api/v1/cadres/${cadreId}/proforma-a`,
      headers: auth(officerToken),
    });
    expect(got.statusCode).toBe(200);
    expect((got.json() as { party: string }).party).toBe('टेस्ट पार्टी');
  });

  it('super_admin creates immediately (still recorded as applied)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cadres/${cadreId}/proforma-a`,
      headers: auth(superToken),
      payload: { fields: MINIMAL_FIELDS },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as WireRequest).status).toBe('applied');
  });

  it('a second create request 409s once one already applied', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'POST',
      url: `/api/v1/cadres/${cadreId}/proforma-a`,
      headers: auth(superToken),
      payload: { fields: MINIMAL_FIELDS },
    });
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/cadres/${cadreId}/proforma-a`,
      headers: auth(officerToken),
      payload: { fields: MINIMAL_FIELDS },
    });
    expect(again.statusCode).toBe(409);
  });

  it('PATCH proposes an edit; applies on super_admin approval; an empty diff 400s', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'POST',
      url: `/api/v1/cadres/${cadreId}/proforma-a`,
      headers: auth(superToken),
      payload: { fields: MINIMAL_FIELDS },
    });

    const noop = await app.inject({
      method: 'PATCH',
      url: `/api/v1/cadres/${cadreId}/proforma-a`,
      headers: auth(officerToken),
      payload: { changes: { party: 'टेस्ट पार्टी' } },
    });
    expect(noop.statusCode).toBe(400);

    const edit = await app.inject({
      method: 'PATCH',
      url: `/api/v1/cadres/${cadreId}/proforma-a`,
      headers: auth(officerToken),
      payload: { changes: { occupation: 'मजदूरी' } },
    });
    expect(edit.statusCode).toBe(201);
    const req = edit.json() as WireRequest;
    expect(req.changeType).toBe('edit');

    await app.inject({
      method: 'POST',
      url: `/api/v1/proforma-a-changes/${req.id}/approve`,
      headers: auth(adminToken),
    });
    const s = await app.inject({
      method: 'POST',
      url: `/api/v1/proforma-a-changes/${req.id}/approve`,
      headers: auth(superToken),
    });
    expect((s.json() as WireRequest).status).toBe('applied');

    const got = await app.inject({
      method: 'GET',
      url: `/api/v1/cadres/${cadreId}/proforma-a`,
      headers: auth(officerToken),
    });
    expect((got.json() as { occupation: string }).occupation).toBe('मजदूरी');
  });

  it('approve-bulk tallies applied/error outcomes', async () => {
    const app = await makeApp();
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/cadres/${cadreId}/proforma-a`,
      headers: auth(officerToken),
      payload: { fields: MINIMAL_FIELDS },
    });
    const req = create.json() as WireRequest;

    const bulk = await app.inject({
      method: 'POST',
      url: '/api/v1/proforma-a-changes/approve-bulk',
      headers: auth(adminToken),
      payload: { ids: [req.id, 999999] },
    });
    expect(bulk.statusCode).toBe(200);
    const body = bulk.json() as { approved: number; failed: number };
    expect(body.approved).toBe(1);
    expect(body.failed).toBe(1);
  });

  it('rejects an unsupported file type on upload', async () => {
    const app = await makeApp();
    const boundary = '----vitestBoundary';
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\n` +
      `Content-Type: text/plain\r\n\r\nhello\r\n--${boundary}--\r\n`;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cadres/${cadreId}/proforma-a/upload?slot=fingerprint`,
      headers: { ...auth(officerToken), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(415);
  });
});
