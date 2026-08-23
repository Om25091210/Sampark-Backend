import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';

const prisma = new PrismaClient();
const config = testConfig();

// Fixture phones must not collide with any other test file's — see
// cadre-changes.test.ts's note on why (Sampark-Backend#3). Blocks taken at the time
// of writing: 00-01 / 10-13 / 30-33 / 40-42 / 50-53 / 60-66 / 70-71 / 80-83 / 90-98.
// 20-23 was free. Verify with:
//   grep -rho "+91[0-9]\{10\}" --include=*.test.ts src/ | sort -u
const PHONES = ['+919000000020', '+919000000021', '+919000000022', '+919000000023'];

// Every applied cadre in this suite gets a name under this prefix, so cleanup can
// find them without knowing ids up front (they don't exist until applied).
const NAME_PREFIX = 'TEST CCR';
const THANA = 'बीजापुर';
const OUT_OF_SCOPE_THANA = 'गंगालूर'; // different sub-division (SUB_DIVISION_THANAS)

let superId = 0;
let adminId = 0;
let officerId = 0;
let viewerId = 0;
let superToken = '';
let adminToken = '';
let officerToken = '';
let viewerToken = '';

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const makeApp = (): Promise<FastifyInstance> => buildApp({ config, prisma, logger: false });

interface WireCreateRequest {
  id: number;
  status: string;
  needsAdmin: boolean;
  needsSuperAdmin: boolean;
  awaitingRole?: string;
  submittedBy: { id: number; name: string; role: string };
  decidedReason?: string;
  adminApprovedAt?: string;
  cadreId?: number;
  duplicateWarning?: {
    cadres: { id: number; name: string; serialNumber: string | null; thana: string }[];
    createRequests: { id: number; name: string; submittedBy: string }[];
  };
}

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `${NAME_PREFIX} ${Math.random().toString(36).slice(2, 8)}`,
    phone: '+910000001000',
    thana: THANA,
    currentAddress: 'टेस्ट पता',
    designation: 'टेस्ट पदनाम',
    category: 'surrendered',
    ...overrides,
  };
}

/** Submit as `token`, returning the created request. */
async function submit(
  app: FastifyInstance,
  token: string,
  draftBody: Record<string, unknown>,
  note?: string,
): Promise<WireCreateRequest> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/cadre-create-requests',
    headers: auth(token),
    payload: { draft: draftBody, note },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as WireCreateRequest;
}

async function cleanup(): Promise<void> {
  const requestIds = (
    await prisma.cadreCreateRequest.findMany({
      where: { submittedById: { in: [superId, adminId, officerId, viewerId] } },
      select: { id: true },
    })
  ).map((r) => r.id);

  if (requestIds.length > 0) {
    await prisma.auditLog.deleteMany({
      where: { entityType: 'cadre_create_request', entityId: { in: requestIds.map(String) } },
    });
    await prisma.notification.deleteMany({ where: { cadreCreateRequestId: { in: requestIds } } });
  }
  await prisma.cadreCreateRequest.deleteMany({
    where: { submittedById: { in: [superId, adminId, officerId, viewerId] } },
  });
  await prisma.cadre.deleteMany({ where: { name: { startsWith: NAME_PREFIX } } });
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

  superId = (await mk(PHONES[0]!, 'super_admin', 'CCR Super')).id;
  adminId = (await mk(PHONES[1]!, 'admin', 'CCR Admin', { subDivision: THANA })).id;
  officerId = (await mk(PHONES[2]!, 'officer', 'CCR Officer', { thana: THANA })).id;
  viewerId = (await mk(PHONES[3]!, 'viewer', 'CCR Viewer')).id;

  await cleanup();

  superToken = await signAccessToken({ sub: superId, role: 'super_admin' }, config.jwtSecret, '15m');
  adminToken = await signAccessToken({ sub: adminId, role: 'admin' }, config.jwtSecret, '15m');
  officerToken = await signAccessToken({ sub: officerId, role: 'officer' }, config.jwtSecret, '15m');
  viewerToken = await signAccessToken({ sub: viewerId, role: 'viewer' }, config.jwtSecret, '15m');
});

afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('cadre create requests', () => {
  // ── The ladder ─────────────────────────────────────────────────────────────

  it('officer → admin → super_admin: NOT applied until the last rung signs, serial assigned only then', async () => {
    const app = await makeApp();
    const d = draft();
    const req = await submit(app, officerToken, d, 'नया समर्पण');

    expect(req.status).toBe('pending');
    expect(req.needsAdmin).toBe(true);
    expect(req.needsSuperAdmin).toBe(true);
    expect(req.awaitingRole).toBe('admin');
    expect(req.submittedBy.id).toBe(officerId);
    expect(req.cadreId).toBeUndefined();
    // No cadre exists yet.
    expect(await prisma.cadre.findFirst({ where: { name: d.name as string } })).toBeNull();

    const a = await app.inject({
      method: 'POST',
      url: `/api/v1/cadre-create-requests/${req.id}/approve`,
      headers: auth(adminToken),
    });
    expect(a.statusCode).toBe(200);
    const afterAdmin = a.json() as WireCreateRequest;
    expect(afterAdmin.status).toBe('pending');
    expect(afterAdmin.awaitingRole).toBe('super_admin');
    expect(await prisma.cadre.findFirst({ where: { name: d.name as string } })).toBeNull();

    const s = await app.inject({
      method: 'POST',
      url: `/api/v1/cadre-create-requests/${req.id}/approve`,
      headers: auth(superToken),
    });
    expect(s.statusCode).toBe(200);
    const applied = s.json() as WireCreateRequest;
    expect(applied.status).toBe('applied');
    expect(applied.cadreId).toBeDefined();

    const cadre = await prisma.cadre.findUniqueOrThrow({ where: { id: applied.cadreId! } });
    expect(cadre.name).toBe(d.name);
    expect(cadre.serialNumber).toMatch(/^DIG-\d{6}$/);
    expect(cadre.alertLevel).toBe('normal');
    expect(cadre.alertTag).toBeNull();
    await app.close();
  });

  it('admin submits → needs only super_admin', async () => {
    const app = await makeApp();
    const d = draft();
    const req = await submit(app, adminToken, d);
    expect(req.needsAdmin).toBe(false);
    expect(req.needsSuperAdmin).toBe(true);
    expect(req.awaitingRole).toBe('super_admin');

    const s = await app.inject({
      method: 'POST',
      url: `/api/v1/cadre-create-requests/${req.id}/approve`,
      headers: auth(superToken),
    });
    expect((s.json() as WireCreateRequest).status).toBe('applied');
    expect(await prisma.cadre.findFirst({ where: { name: d.name as string } })).not.toBeNull();
    await app.close();
  });

  it('super_admin submits → applied immediately, still recorded in the trail', async () => {
    const app = await makeApp();
    const d = draft();
    const req = await submit(app, superToken, d);
    expect(req.status).toBe('applied');
    expect(req.needsAdmin).toBe(false);
    expect(req.needsSuperAdmin).toBe(false);
    expect(req.awaitingRole).toBeUndefined();
    expect(req.cadreId).toBeDefined();
    // The row exists even though nobody approved it.
    expect(await prisma.cadreCreateRequest.count({ where: { id: req.id } })).toBe(1);
    await app.close();
  });

  it('viewer cannot propose a new cadre (403)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cadre-create-requests',
      headers: auth(viewerToken),
      payload: { draft: draft() },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('officer cannot approve anything (403)', async () => {
    const app = await makeApp();
    const req = await submit(app, officerToken, draft());
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cadre-create-requests/${req.id}/approve`,
      headers: auth(officerToken),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('an approver cannot approve their own submission', async () => {
    const app = await makeApp();
    const req = await submit(app, adminToken, draft());
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cadre-create-requests/${req.id}/approve`,
      headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(403);
    expect(req.cadreId).toBeUndefined();
    await app.close();
  });

  // ADR-028. A super_admin may not sign the admin rung — same rule as cadre-changes,
  // reused unchanged since the ladder logic is role-based, not field-based.
  it('super_admin CANNOT pre-empt the admin rung', async () => {
    const app = await makeApp();
    const req = await submit(app, officerToken, draft());

    const early = await app.inject({
      method: 'POST',
      url: `/api/v1/cadre-create-requests/${req.id}/approve`,
      headers: auth(superToken),
    });
    expect(early.statusCode).toBe(403);

    const q = await app.inject({
      method: 'GET',
      url: '/api/v1/cadre-create-requests?awaitingMe=true&pageSize=50',
      headers: auth(superToken),
    });
    expect((q.json() as { data: WireCreateRequest[] }).data.some((r) => r.id === req.id)).toBe(false);

    await app.inject({
      method: 'POST',
      url: `/api/v1/cadre-create-requests/${req.id}/approve`,
      headers: auth(adminToken),
    });
    const q2 = await app.inject({
      method: 'GET',
      url: '/api/v1/cadre-create-requests?awaitingMe=true&pageSize=50',
      headers: auth(superToken),
    });
    expect((q2.json() as { data: WireCreateRequest[] }).data.some((r) => r.id === req.id)).toBe(true);

    const done = await app.inject({
      method: 'POST',
      url: `/api/v1/cadre-create-requests/${req.id}/approve`,
      headers: auth(superToken),
    });
    expect((done.json() as WireCreateRequest).status).toBe('applied');
    await app.close();
  });

  // ── Rejection / cancellation ───────────────────────────────────────────────

  it('rejection is terminal, needs a reason, and does not create a cadre', async () => {
    const app = await makeApp();
    const d = draft();
    const req = await submit(app, officerToken, d);
    await app.inject({
      method: 'POST',
      url: `/api/v1/cadre-create-requests/${req.id}/approve`,
      headers: auth(adminToken),
    });

    const noReason = await app.inject({
      method: 'POST',
      url: `/api/v1/cadre-create-requests/${req.id}/reject`,
      headers: auth(superToken),
      payload: {},
    });
    expect(noReason.statusCode).toBe(400);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cadre-create-requests/${req.id}/reject`,
      headers: auth(superToken),
      payload: { reason: 'सत्यापन नहीं हुआ' },
    });
    const out = res.json() as WireCreateRequest;
    expect(out.status).toBe('rejected');
    expect(out.decidedReason).toBe('सत्यापन नहीं हुआ');
    expect(await prisma.cadre.findFirst({ where: { name: d.name as string } })).toBeNull();

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/cadre-create-requests/${req.id}/approve`,
      headers: auth(superToken),
    });
    expect(again.statusCode).toBe(400);
    await app.close();
  });

  it('only the submitter can withdraw their request', async () => {
    const app = await makeApp();
    const req = await submit(app, officerToken, draft());
    const notMine = await app.inject({
      method: 'POST',
      url: `/api/v1/cadre-create-requests/${req.id}/cancel`,
      headers: auth(adminToken),
    });
    expect(notMine.statusCode).toBe(403);
    const mine = await app.inject({
      method: 'POST',
      url: `/api/v1/cadre-create-requests/${req.id}/cancel`,
      headers: auth(officerToken),
    });
    expect((mine.json() as WireCreateRequest).status).toBe('cancelled');
    await app.close();
  });

  // ── Jurisdiction ───────────────────────────────────────────────────────────

  it('a thana outside the submitter\'s scope is refused at submission (400)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cadre-create-requests',
      headers: auth(officerToken),
      payload: { draft: draft({ thana: OUT_OF_SCOPE_THANA }) },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('THANA_OUT_OF_SCOPE');
    await app.close();
  });

  // ── Duplicate warning (non-blocking) ────────────────────────────────────────

  it('warns on a name+thana+phone match against an existing cadre, but does not block submission', async () => {
    const app = await makeApp();
    const existingName = `${NAME_PREFIX} DUP EXISTING`;
    const existing = await prisma.cadre.create({
      data: {
        name: existingName,
        phone: '+910000002000',
        thana: THANA,
        currentAddress: 'पता',
        designation: 'पदनाम',
        category: 'surrendered',
        alertLevel: 'normal',
        aliases: [],
      },
    });

    const req = await submit(app, officerToken, draft({ name: existingName, phone: '+910000002000' }));
    expect(req.status).toBe('pending'); // never blocked
    expect(req.duplicateWarning?.cadres.some((c) => c.id === existing.id)).toBe(true);

    // Surfaced again on the approver's list, recomputed live.
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/cadre-create-requests?awaitingMe=true&pageSize=50',
      headers: auth(adminToken),
    });
    const row = (list.json() as { data: WireCreateRequest[] }).data.find((r) => r.id === req.id);
    expect(row?.duplicateWarning?.cadres.some((c) => c.id === existing.id)).toBe(true);
    await app.close();
  });

  it('warns on a name+thana+phone match against another pending create request, but does not block', async () => {
    const app = await makeApp();
    const dupName = `${NAME_PREFIX} DUP REQ`;
    const first = await submit(app, officerToken, draft({ name: dupName, phone: '+910000003000' }));

    const second = await submit(app, adminToken, draft({ name: dupName, phone: '+910000003000' }));
    expect(second.status).toBe('pending');
    expect(second.duplicateWarning?.createRequests.some((r) => r.id === first.id)).toBe(true);
    await app.close();
  });

  // ── This task: otherOriginType (दीगर जिला/राज्य sub-category) ────────────────

  it('otherOriginType is required once surrenderOrigin=other is chosen (400)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cadre-create-requests',
      headers: auth(officerToken),
      payload: { draft: draft({ surrenderOrigin: 'other' }) },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('a draft with surrenderOrigin=other and otherOriginType set is applied with both fields', async () => {
    const app = await makeApp();
    const d = draft({ surrenderOrigin: 'other', otherOriginType: 'other_state' });
    const req = await submit(app, superToken, d);
    expect(req.status).toBe('applied');
    const cadre = await prisma.cadre.findUniqueOrThrow({ where: { id: req.cadreId! } });
    expect(cadre.surrenderOrigin).toBe('other');
    expect(cadre.otherOriginType).toBe('other_state');
    await app.close();
  });
});
