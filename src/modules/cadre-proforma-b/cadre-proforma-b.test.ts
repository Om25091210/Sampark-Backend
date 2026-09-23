import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';

const prisma = new PrismaClient();
const config = testConfig();

// See cadre-changes.test.ts's comment on this block — 110-113 is free at the
// time of writing (grep -rho "+91[0-9]\{10\}" --include=*.test.ts src/).
const PHONES = ['+919000000110', '+919000000111', '+919000000112', '+919000000113'];
const CADRE_NAME = 'TEST CADRE PROFORMA B';

let superId = 0;
let adminId = 0;
let officerId = 0;
let cadreId = 0;
let superToken = '';
let adminToken = '';
let officerToken = '';

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const makeApp = (): Promise<FastifyInstance> => buildApp({ config, prisma, logger: false });

interface WireRequest {
  id: number;
  status: string;
  changeType: string;
  awaitingRole?: string;
}

const ADDRESS = { village: 'गांव', thana: 'बीजापुर', district: 'बीजापुर', state: 'छत्तीसगढ़', phone: '+910000000900' };

function minimalFields(overrides: Record<string, unknown> = {}) {
  return {
    fullNameWithAlias: CADRE_NAME,
    nativeAddress: ADDRESS,
    currentAddressDetails: ADDRESS,
    surrenderDate: null,
    surrenderPlaceAndBy: null,
    ownHouseDetails: null, agriculturalLandDetails: null, vehicleDetails: null,
    familyEducationDetails: null, familyEmploymentDetails: null,
    priorCriminalCases: null, aadhaarVoterCardStatus: null, bankDetails: null, healthCondition: null,
    handlerDetails: null, liaisonOfficerDetails: null, currentWorkTypeAndPlace: null,
    employerDetails: null, wageDetails: null, newCriminalCases: null,
    fullRewardReceivedDetails: null, pendingRewardStatus: null,
    applicationDateAndPlace: null, applicationStatus: null,
    rewardWithdrawn: null, rewardUsageDetails: null,
    currentMaoistContact: null, contactWithWhom: null,
    newSkillsLearned: null, needsAndRequirements: null, maoistMovementInfo: null,
    maoistContactAttempt: null, otherSurrenderedArrestedInfo: null, anyProblems: null,
    currentPhotoKey: null,
    ...overrides,
  };
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

  superId = (await mk(PHONES[0]!, 'super_admin', 'PfB Super')).id;
  adminId = (await mk(PHONES[1]!, 'admin', 'PfB Admin', { subDivision: 'बीजापुर' })).id;
  officerId = (await mk(PHONES[2]!, 'officer', 'PfB Officer', { thana: 'बीजापुर' })).id;
  await mk(PHONES[3]!, 'viewer', 'PfB Viewer');

  await prisma.proformaChangeRequest.deleteMany({ where: { cadre: { name: CADRE_NAME } } });
  await prisma.cadreProformaB.deleteMany({ where: { cadre: { name: CADRE_NAME } } });
  await prisma.cadre.deleteMany({ where: { name: CADRE_NAME } });
  const cadre = await prisma.cadre.create({
    data: {
      name: CADRE_NAME, phone: '+910000000901', thana: 'बीजापुर', currentAddress: 'फिक्स्चर पता',
      permanentAddress: 'मूल पता', designation: 'Fixture', category: 'surrendered', alertLevel: 'normal',
      aliases: ['उपनाम1'], surrenderDate: new Date('2024-01-15'), surrenderLocation: 'थाना बीजापुर',
    },
  });
  cadreId = cadre.id;

  superToken = await signAccessToken({ sub: superId, role: 'super_admin' }, config.jwtSecret, '15m');
  adminToken = await signAccessToken({ sub: adminId, role: 'admin' }, config.jwtSecret, '15m');
  officerToken = await signAccessToken({ sub: officerId, role: 'officer' }, config.jwtSecret, '15m');
});

afterEach(async () => {
  const rows = await prisma.proformaChangeRequest.findMany({ where: { cadreId }, select: { id: true } });
  const ids = rows.map((r) => String(r.id));
  if (ids.length > 0) {
    await prisma.auditLog.deleteMany({ where: { entityType: 'proforma_change_request', entityId: { in: ids } } });
  }
  const bRows = await prisma.cadreProformaB.findMany({ where: { cadreId }, select: { id: true } });
  const bIds = bRows.map((r) => String(r.id));
  if (bIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { entityType: 'cadre_proforma_b', entityId: { in: bIds } } });
  }
  await prisma.proformaChangeRequest.deleteMany({ where: { cadreId } });
  await prisma.cadreProformaB.deleteMany({ where: { cadreId } });
});

afterAll(async () => {
  await prisma.proformaChangeRequest.deleteMany({ where: { cadreId } });
  await prisma.cadreProformaB.deleteMany({ where: { cadreId } });
  await prisma.cadre.deleteMany({ where: { name: CADRE_NAME } });
  await prisma.$disconnect();
});

describe('B Proforma (ADR-064 addendum)', () => {
  it('rejects an unauthenticated request', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}/proforma-b` });
    expect(res.statusCode).toBe(401);
  });

  it('this task: a non-surrendered (jail/thana) cadre is refused — proforma only applies to the surrendered register', async () => {
    const jailCadre = await prisma.cadre.create({
      data: {
        name: 'TEST CADRE PROFORMA B JAIL', phone: '+910000000902', thana: 'बीजापुर', currentAddress: 'फिक्स्चर पता',
        designation: 'Fixture', category: 'jail', alertLevel: 'normal', aliases: [],
      },
    });
    const app = await makeApp();
    const list = await app.inject({
      method: 'GET', url: `/api/v1/cadres/${jailCadre.id}/proforma-b`, headers: auth(officerToken),
    });
    expect(list.statusCode).toBe(400);
    const create = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${jailCadre.id}/proforma-b`,
      headers: auth(officerToken), payload: { fields: minimalFields() },
    });
    expect(create.statusCode).toBe(400);
    expect((create.json() as { error: { code: string } }).error.code).toBe('CADRE_NOT_SURRENDERED');
    await prisma.cadre.delete({ where: { id: jailCadre.id } });
    await app.close();
  });

  it('lists an empty history before any filing exists', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cadres/${cadreId}/proforma-b`,
      headers: auth(officerToken),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { total: number }).total).toBe(0);
  });

  it('new-draft snapshots the cadre and leaves carry-forward/blank fields null on the first filing', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cadres/${cadreId}/proforma-b/new-draft`,
      headers: auth(officerToken),
    });
    expect(res.statusCode).toBe(200);
    const draft = res.json() as Record<string, unknown>;
    expect(draft.fullNameWithAlias).toBe(`${CADRE_NAME} (उपनाम1)`);
    expect((draft.nativeAddress as { thana: string }).thana).toBe('बीजापुर');
    expect(draft.surrenderPlaceAndBy).toBe('थाना बीजापुर');
    expect(draft.healthCondition).toBeNull();
    expect(draft.handlerDetails).toBeNull();
  });

  it('rejects a malformed create body at the Zod boundary', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cadres/${cadreId}/proforma-b`,
      headers: auth(officerToken),
      payload: { fields: minimalFields({ fullNameWithAlias: '' }) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('super_admin files immediately; the new-draft for the NEXT period carries forward its fields', async () => {
    const app = await makeApp();
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/cadres/${cadreId}/proforma-b`,
      headers: auth(superToken),
      payload: { fields: minimalFields({ healthCondition: 'स्वस्थ', handlerDetails: 'निरीक्षक XYZ' }) },
    });
    expect(create.statusCode).toBe(201);
    expect((create.json() as WireRequest).status).toBe('applied');

    const draft2 = await app.inject({
      method: 'GET',
      url: `/api/v1/cadres/${cadreId}/proforma-b/new-draft`,
      headers: auth(officerToken),
    });
    const d2 = draft2.json() as Record<string, unknown>;
    // Carry-forward field copied from the prior filing.
    expect(d2.healthCondition).toBe('स्वस्थ');
    // Time-bound field is blank again, however it was set last period.
    expect(d2.handlerDetails).toBeNull();

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/cadres/${cadreId}/proforma-b`,
      headers: auth(officerToken),
    });
    expect((list.json() as { total: number }).total).toBe(1);
  });

  it('officer → admin → super_admin ladder on create, then PATCH edits the filed row', async () => {
    const app = await makeApp();
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/cadres/${cadreId}/proforma-b`,
      headers: auth(officerToken),
      payload: { fields: minimalFields() },
    });
    const req = create.json() as WireRequest;
    expect(req.status).toBe('pending');
    expect(req.awaitingRole).toBe('admin');

    await app.inject({ method: 'POST', url: `/api/v1/proforma-b-changes/${req.id}/approve`, headers: auth(adminToken) });
    const applied = await app.inject({ method: 'POST', url: `/api/v1/proforma-b-changes/${req.id}/approve`, headers: auth(superToken) });
    expect((applied.json() as WireRequest).status).toBe('applied');

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/cadres/${cadreId}/proforma-b`,
      headers: auth(officerToken),
    });
    const filing = (list.json() as { data: { id: number }[] }).data[0]!;

    const edit = await app.inject({
      method: 'PATCH',
      url: `/api/v1/cadres/${cadreId}/proforma-b/${filing.id}`,
      headers: auth(officerToken),
      payload: { changes: { anyProblems: 'कोई समस्या नहीं' } },
    });
    expect(edit.statusCode).toBe(201);
    expect((edit.json() as WireRequest).changeType).toBe('edit');
  });

  it('rejects an unsupported file type on the photo upload', async () => {
    const app = await makeApp();
    const boundary = '----vitestBoundary';
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\n` +
      `Content-Type: text/plain\r\n\r\nhello\r\n--${boundary}--\r\n`;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cadres/${cadreId}/proforma-b/upload`,
      headers: { ...auth(officerToken), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(415);
  });
});
