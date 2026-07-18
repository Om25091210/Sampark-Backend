import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';

const prisma = new PrismaClient();
const config = testConfig();

// Fixture phones must not collide with ANY other test file's — suites share one
// database and run in parallel, so a duplicate phone upserts another file's user
// out from under it mid-run. This block (80-83) was free at the time of writing;
// the blocks already taken were 01 / 10-12 / 30-31 / 40-42 / 50-53 / 60 / 70-71.
//
// This is exactly the fragility tracked in Sampark-Backend#3, and it is not
// theoretical: this file was first written on 50-53, which silently belongs to
// officers.test.ts, and the whole officers suite failed on the next full run while
// passing in isolation. Verify with:
//   grep -rho "+91[0-9]\{10\}" --include=*.test.ts src/ | sort -u
const PHONES = ['+919000000080', '+919000000081', '+919000000082', '+919000000083'];
const CADRE_NAME = 'TEST CADRE CHANGES';

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

const ORIGINAL_PHONE = '+910000000055';
const ORIGINAL_ADDRESS = 'मूल पता';

interface WireChange {
  id: number;
  status: string;
  needsAdmin: boolean;
  needsSuperAdmin: boolean;
  awaitingRole?: string;
  changes: Record<string, { old: unknown; new: unknown }>;
  submittedBy: { id: number; name: string; role: string };
  decidedReason?: string;
  adminApprovedAt?: string;
}

async function resetCadre(): Promise<void> {
  await prisma.cadre.update({
    where: { id: cadreId },
    data: {
      phone: ORIGINAL_PHONE, currentAddress: ORIGINAL_ADDRESS,
      hasAadhaar: false, hasBankAccount: false, hasAbProforma: false, hasAgreementLetter: false,
      avatarKey: null,
      // ADR-036 — reset or a prior test's DOB/relations bleed into the next assertion.
      dateOfBirth: null, fatherName: null, motherName: null, spouseName: null,
      aliases: [], alertTag: null,
      // ADR-032/033 — both derived from alertTag, so they reset with it.
      alertDate: null, alertLevel: 'normal',
      // ADR-027 — reset too, or an earlier test's editor bleeds into the next one's
      // assertion and the suite passes for the wrong reason.
      lastEditedAt: null, lastEditedById: null,
    },
  });
}

/** Submit as `token`, returning the created request. */
async function submit(
  app: FastifyInstance,
  token: string,
  changes: Record<string, unknown>,
  note?: string,
): Promise<WireChange> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/cadres/${cadreId}/changes`,
    headers: auth(token),
    payload: { changes, note },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as WireChange;
}

beforeAll(async () => {
  const mk = async (phone: string, role: 'super_admin' | 'admin' | 'officer' | 'viewer', name: string) =>
    prisma.user.upsert({
      where: { phone }, update: { deletedAt: null, role, name }, create: { phone, name, role },
    });

  superId = (await mk(PHONES[0]!, 'super_admin', 'Chg Super')).id;
  adminId = (await mk(PHONES[1]!, 'admin', 'Chg Admin')).id;
  officerId = (await mk(PHONES[2]!, 'officer', 'Chg Officer')).id;
  viewerId = (await mk(PHONES[3]!, 'viewer', 'Chg Viewer')).id;

  await prisma.cadreChangeRequest.deleteMany({ where: { cadre: { name: CADRE_NAME } } });
  await prisma.cadre.deleteMany({ where: { name: CADRE_NAME } });
  const cadre = await prisma.cadre.create({
    data: {
      name: CADRE_NAME, phone: ORIGINAL_PHONE, thana: 'बीजापुर', currentAddress: ORIGINAL_ADDRESS,
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
  const rows = await prisma.cadreChangeRequest.findMany({ where: { cadreId }, select: { id: true } });
  const ids = rows.map((r) => String(r.id));
  if (ids.length > 0) {
    await prisma.auditLog.deleteMany({ where: { entityType: 'cadre_change_request', entityId: { in: ids } } });
  }
  await prisma.cadreChangeRequest.deleteMany({ where: { cadreId } });
  await resetCadre();
});

afterAll(async () => {
  await prisma.cadreChangeRequest.deleteMany({ where: { cadreId } });
  await prisma.cadre.deleteMany({ where: { name: CADRE_NAME } });
  await prisma.$disconnect();
});

describe('cadre change requests (ADR-026)', () => {
  // ── The ladder ─────────────────────────────────────────────────────────────

  it('officer → admin → super_admin: NOT applied until the last rung signs', async () => {
    const app = await makeApp();
    const req = await submit(app, officerToken, { phone: '+910000000099' }, 'नंबर बदल गया है');

    expect(req.status).toBe('pending');
    expect(req.needsAdmin).toBe(true);
    expect(req.needsSuperAdmin).toBe(true);
    expect(req.awaitingRole).toBe('admin');
    // The old value is captured as evidence for the approver and the drift check.
    expect(req.changes.phone).toEqual({ old: ORIGINAL_PHONE, new: '+910000000099' });
    // Every approver sees who proposed it.
    expect(req.submittedBy.id).toBe(officerId);

    // Admin signs the first rung — the cadre must NOT change yet.
    const a = await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/approve`, headers: auth(adminToken) });
    expect(a.statusCode).toBe(200);
    const afterAdmin = a.json() as WireChange;
    expect(afterAdmin.status).toBe('pending');
    expect(afterAdmin.awaitingRole).toBe('super_admin');
    expect((await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } })).phone).toBe(ORIGINAL_PHONE);

    // Super admin signs the last rung — now it applies, in the same transaction.
    const s = await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/approve`, headers: auth(superToken) });
    expect(s.statusCode).toBe(200);
    expect((s.json() as WireChange).status).toBe('applied');
    expect((await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } })).phone).toBe('+910000000099');
    await app.close();
  });

  it('admin submits → needs only super_admin', async () => {
    const app = await makeApp();
    const req = await submit(app, adminToken, { currentAddress: 'नया पता' });
    expect(req.needsAdmin).toBe(false);
    expect(req.needsSuperAdmin).toBe(true);
    expect(req.awaitingRole).toBe('super_admin');

    const s = await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/approve`, headers: auth(superToken) });
    expect((s.json() as WireChange).status).toBe('applied');
    expect((await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } })).currentAddress).toBe('नया पता');
    await app.close();
  });

  it('super_admin submits → applied immediately, still recorded in the trail', async () => {
    const app = await makeApp();
    const req = await submit(app, superToken, { currentAddress: 'सुपर पता' });
    expect(req.status).toBe('applied');
    expect(req.needsAdmin).toBe(false);
    expect(req.needsSuperAdmin).toBe(false);
    expect(req.awaitingRole).toBeUndefined();
    expect((await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } })).currentAddress).toBe('सुपर पता');
    // The row exists even though nobody approved it — an unapproved-but-applied
    // edit still belongs in history.
    expect(await prisma.cadreChangeRequest.count({ where: { id: req.id } })).toBe(1);
    await app.close();
  });

  // ── ADR-036: dateOfBirth + relations go through the approval chain ──────────

  it('applies dateOfBirth (as a Date) and the three relation names', async () => {
    const app = await makeApp();
    const req = await submit(app, superToken, {
      dateOfBirth: '1992-03-25T00:00:00.000Z',
      fatherName: 'राम सिंह',
      motherName: 'गीता देवी',
      spouseName: 'सुनीता',
    });
    expect(req.status).toBe('applied');

    const c = await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } });
    // Coerced to a real Date (DATE_FIELDS), not left a string.
    expect(c.dateOfBirth).toBeInstanceOf(Date);
    expect(c.dateOfBirth?.toISOString().slice(0, 10)).toBe('1992-03-25');
    expect(c.fatherName).toBe('राम सिंह');
    expect(c.motherName).toBe('गीता देवी');
    expect(c.spouseName).toBe('सुनीता');
    await app.close();
  });

  it('rejects a non-datetime dateOfBirth at submit (before any approval)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/changes`, headers: auth(superToken),
      payload: { changes: { dateOfBirth: '1992-03-25' } }, // date-only, not ISO datetime
    });
    // The schema wants an offset datetime; a bad value must fail at the edge, not at apply.
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('viewer cannot propose (403)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/changes`, headers: auth(viewerToken),
      payload: { changes: { phone: '+910000000098' } },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('officer cannot approve anything (403)', async () => {
    const app = await makeApp();
    const req = await submit(app, officerToken, { phone: '+910000000097' });
    const res = await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/approve`, headers: auth(officerToken) });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('an approver cannot approve their own proposal', async () => {
    const app = await makeApp();
    // Admin proposes; only super_admin is left to sign — but admin outranks nothing
    // here and must not self-clear.
    const req = await submit(app, adminToken, { currentAddress: 'स्वयं' });
    const res = await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/approve`, headers: auth(adminToken) });
    expect(res.statusCode).toBe(403);
    expect((await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } })).currentAddress).toBe(ORIGINAL_ADDRESS);
    await app.close();
  });

  // ADR-028. This test previously asserted the OPPOSITE — that a super_admin could
  // sign the admin rung so a request could not deadlock without an admin. That was
  // wrong: it let one person complete a two-person review by clicking approve
  // twice, which is exactly what the ladder exists to prevent.
  it('super_admin CANNOT pre-empt the admin rung — two people, not one clicking twice', async () => {
    const app = await makeApp();
    const req = await submit(app, officerToken, { currentAddress: 'दो व्यक्ति' });

    const early = await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/approve`, headers: auth(superToken) });
    expect(early.statusCode).toBe(403);
    expect((await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } })).currentAddress).toBe(ORIGINAL_ADDRESS);

    // It is not even in the super_admin's queue yet — nothing for them to act on.
    const q = await app.inject({ method: 'GET', url: '/api/v1/changes?awaitingMe=true&pageSize=50', headers: auth(superToken) });
    expect((q.json() as { data: WireChange[] }).data.some((c) => c.id === req.id)).toBe(false);

    // Admin signs first; only now does it reach the super_admin.
    await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/approve`, headers: auth(adminToken) });
    const q2 = await app.inject({ method: 'GET', url: '/api/v1/changes?awaitingMe=true&pageSize=50', headers: auth(superToken) });
    expect((q2.json() as { data: WireChange[] }).data.some((c) => c.id === req.id)).toBe(true);

    // And ONE approval from the super_admin finishes it — no double-click.
    const done = await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/approve`, headers: auth(superToken) });
    expect((done.json() as WireChange).status).toBe('applied');
    await app.close();
  });

  it('an approved request leaves the admin queue after exactly one approval', async () => {
    const app = await makeApp();
    const req = await submit(app, officerToken, { regiment: 'रेजिमेंट-क' });

    const before = await app.inject({ method: 'GET', url: '/api/v1/changes?awaitingMe=true&pageSize=50', headers: auth(adminToken) });
    expect((before.json() as { data: WireChange[] }).data.some((c) => c.id === req.id)).toBe(true);

    await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/approve`, headers: auth(adminToken) });

    const after = await app.inject({ method: 'GET', url: '/api/v1/changes?awaitingMe=true&pageSize=50', headers: auth(adminToken) });
    expect((after.json() as { data: WireChange[] }).data.some((c) => c.id === req.id)).toBe(false);
    await app.close();
  });

  it('an admin-submitted request goes straight to the super_admin queue', async () => {
    const app = await makeApp();
    // needsAdmin=false, so there is no admin rung to clear first.
    const req = await submit(app, adminToken, { regiment: 'रेजिमेंट-ख' });
    const q = await app.inject({ method: 'GET', url: '/api/v1/changes?awaitingMe=true&pageSize=50', headers: auth(superToken) });
    expect((q.json() as { data: WireChange[] }).data.some((c) => c.id === req.id)).toBe(true);
    const done = await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/approve`, headers: auth(superToken) });
    expect((done.json() as WireChange).status).toBe('applied');
    await app.close();
  });

  // ── Drift ──────────────────────────────────────────────────────────────────

  it('a value that moved after submission goes stale instead of clobbering', async () => {
    const app = await makeApp();
    const req = await submit(app, officerToken, { phone: '+910000000096' });
    await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/approve`, headers: auth(adminToken) });

    // Someone else changes the phone while the request sits awaiting super_admin.
    await prisma.cadre.update({ where: { id: cadreId }, data: { phone: '+910000000077' } });

    const s = await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/approve`, headers: auth(superToken) });
    const out = s.json() as WireChange;
    expect(out.status).toBe('stale');
    expect(out.decidedReason).toContain('phone');
    // The newer value survives — the approval did NOT overwrite it.
    expect((await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } })).phone).toBe('+910000000077');
    await app.close();
  });

  // ── Rejection / cancellation ───────────────────────────────────────────────

  it('rejection is terminal, needs a reason, and keeps the earlier approval on the row', async () => {
    const app = await makeApp();
    const req = await submit(app, officerToken, { phone: '+910000000095' });
    await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/approve`, headers: auth(adminToken) });

    const noReason = await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/reject`, headers: auth(superToken), payload: {} });
    expect(noReason.statusCode).toBe(400);

    const res = await app.inject({
      method: 'POST', url: `/api/v1/changes/${req.id}/reject`, headers: auth(superToken),
      payload: { reason: 'सत्यापन नहीं हुआ' },
    });
    const out = res.json() as WireChange;
    expect(out.status).toBe('rejected');
    expect(out.decidedReason).toBe('सत्यापन नहीं हुआ');
    // The admin who backed it is still on the record.
    expect(out.adminApprovedAt).toBeDefined();
    expect((await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } })).phone).toBe(ORIGINAL_PHONE);

    // Terminal: no second bite.
    const again = await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/approve`, headers: auth(superToken) });
    expect(again.statusCode).toBe(400);
    await app.close();
  });

  it('only the submitter can withdraw their request', async () => {
    const app = await makeApp();
    const req = await submit(app, officerToken, { phone: '+910000000094' });
    const notMine = await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/cancel`, headers: auth(adminToken) });
    expect(notMine.statusCode).toBe(403);
    const mine = await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/cancel`, headers: auth(officerToken) });
    expect((mine.json() as WireChange).status).toBe('cancelled');
    await app.close();
  });

  it('proposing the value the cadre already holds → 400 NO_CHANGE', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/changes`, headers: auth(officerToken),
      payload: { changes: { phone: ORIGINAL_PHONE } },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('NO_CHANGE');
    await app.close();
  });

  // ── Race prevention + edit visibility (ADR-027) ────────────────────────────

  it('a second proposal on the SAME field is refused at submission (409), not left to go stale', async () => {
    const app = await makeApp();
    const first = await submit(app, officerToken, { phone: '+910000000089' });

    const second = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/changes`, headers: auth(adminToken),
      payload: { changes: { phone: '+910000000088' } },
    });
    expect(second.statusCode).toBe(409);
    const err = (second.json() as { error: { code: string; message: string } }).error;
    expect(err.code).toBe('CHANGE_PENDING');
    // The message names who holds the field, so the second officer can go ask them.
    expect(err.message).toContain('Chg Officer');
    expect(err.message).toContain(`#${first.id}`);

    // Only the original is in flight — no silent duplicate was created.
    expect(await prisma.cadreChangeRequest.count({ where: { cadreId, status: 'pending' } })).toBe(1);
    await app.close();
  });

  it('a different field on the same cadre is still allowed', async () => {
    const app = await makeApp();
    await submit(app, officerToken, { phone: '+910000000087' });
    const other = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/changes`, headers: auth(adminToken),
      payload: { changes: { currentAddress: 'दूसरा फ़ील्ड' } },
    });
    expect(other.statusCode).toBe(201);
    await app.close();
  });

  it('the field frees up once the first request is decided', async () => {
    const app = await makeApp();
    const first = await submit(app, officerToken, { phone: '+910000000086' });
    await app.inject({ method: 'POST', url: `/api/v1/changes/${first.id}/cancel`, headers: auth(officerToken) });

    const second = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/changes`, headers: auth(officerToken),
      payload: { changes: { phone: '+910000000085' } },
    });
    expect(second.statusCode).toBe(201);
    await app.close();
  });

  it('pendingFields marks what is in flight, on both the detail and the list', async () => {
    const app = await makeApp();
    const before = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerToken) });
    // Always an array — "nothing pending" must not be indistinguishable from
    // "not computed".
    expect((before.json() as { pendingFields: string[] }).pendingFields).toEqual([]);

    await submit(app, officerToken, { phone: '+910000000084', hasAadhaar: true });

    const detail = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerToken) });
    expect((detail.json() as { pendingFields: string[] }).pendingFields.sort()).toEqual(['hasAadhaar', 'phone']);

    const list = await app.inject({ method: 'GET', url: `/api/v1/cadres?search=${encodeURIComponent(CADRE_NAME)}&pageSize=50`, headers: auth(officerToken) });
    const row = (list.json() as { data: { id: number; pendingFields: string[] }[] }).data.find((c) => c.id === cadreId)!;
    expect(row.pendingFields.sort()).toEqual(['hasAadhaar', 'phone']);
    await app.close();
  });

  it('lastEditedAt/By records the SUBMITTER, not the approver who signed last', async () => {
    const app = await makeApp();
    const req = await submit(app, officerToken, { currentAddress: 'सम्पादित' });
    await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/approve`, headers: auth(adminToken) });
    await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/approve`, headers: auth(superToken) });

    const detail = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerToken) });
    const body = detail.json() as { lastEditedAt?: string; lastEditedBy?: { id: number; name: string } };
    expect(body.lastEditedAt).toBeDefined();
    // The officer proposed it; the approvers only allowed it.
    expect(body.lastEditedBy?.id).toBe(officerId);
    // Cleared, since pendingFields is now empty again.
    expect((detail.json() as { pendingFields: string[] }).pendingFields).toEqual([]);
    await app.close();
  });

  it('a direct tag write also counts as an edit', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'PATCH', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerToken), payload: { alertTag: 'निगरानी' },
    });
    const detail = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerToken) });
    const body = detail.json() as { lastEditedBy?: { id: number } };
    expect(body.lastEditedBy?.id).toBe(officerId);
    await app.close();
  });

  // ── Queues ─────────────────────────────────────────────────────────────────

  it('awaitingMe returns only what the caller can sign next', async () => {
    const app = await makeApp();
    const req = await submit(app, officerToken, { phone: '+910000000093' });

    const adminQ = await app.inject({ method: 'GET', url: '/api/v1/changes?awaitingMe=true&pageSize=50', headers: auth(adminToken) });
    expect((adminQ.json() as { data: WireChange[] }).data.some((c) => c.id === req.id)).toBe(true);

    // Officers approve nothing — an empty queue, not a 403 on a readable list.
    const officerQ = await app.inject({ method: 'GET', url: '/api/v1/changes?awaitingMe=true&pageSize=50', headers: auth(officerToken) });
    expect(officerQ.statusCode).toBe(200);
    expect((officerQ.json() as { total: number }).total).toBe(0);

    // Once admin signs, it leaves the admin queue.
    await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/approve`, headers: auth(adminToken) });
    const adminQ2 = await app.inject({ method: 'GET', url: '/api/v1/changes?awaitingMe=true&pageSize=50', headers: auth(adminToken) });
    expect((adminQ2.json() as { data: WireChange[] }).data.some((c) => c.id === req.id)).toBe(false);
    await app.close();
  });

  it('submittedBy=me is how a submitter learns the outcome (no notifications exist)', async () => {
    const app = await makeApp();
    const req = await submit(app, officerToken, { phone: '+910000000092' });
    await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/approve`, headers: auth(adminToken) });
    await app.inject({
      method: 'POST', url: `/api/v1/changes/${req.id}/reject`, headers: auth(superToken),
      payload: { reason: 'दस्तावेज़ अपूर्ण' },
    });

    const mine = await app.inject({ method: 'GET', url: '/api/v1/changes?submittedBy=me&pageSize=50', headers: auth(officerToken) });
    const row = (mine.json() as { data: WireChange[] }).data.find((c) => c.id === req.id)!;
    expect(row.status).toBe('rejected');
    expect(row.decidedReason).toBe('दस्तावेज़ अपूर्ण');
    await app.close();
  });

  // ── The hardcopy checkbox — the second consumer ─────────────────────────────

  // ADR-029. The four documents are tracked individually. The single
  // `hardcopyDocsExist` flag they replaced could not answer the real question:
  // an officer holding the Aadhaar but not the agreement letter had to lie either
  // way. These tests pin that they move independently.
  it('each hardcopy document rides the chain independently', async () => {
    const app = await makeApp();
    const req = await submit(app, officerToken, { hasAadhaar: true, hasBankAccount: true });
    expect(req.changes.hasAadhaar).toEqual({ old: false, new: true });
    expect(req.changes.hasBankAccount).toEqual({ old: false, new: true });
    // Untouched documents are not in the request at all — so they take no lock.
    expect(req.changes.hasAbProforma).toBeUndefined();

    const before = await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } });
    expect(before.hasAadhaar).toBe(false);

    await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/approve`, headers: auth(adminToken) });
    await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/approve`, headers: auth(superToken) });

    const after = await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } });
    expect(after.hasAadhaar).toBe(true);
    expect(after.hasBankAccount).toBe(true);
    // The two nobody proposed stay false — the whole point of splitting the flag.
    expect(after.hasAbProforma).toBe(false);
    expect(after.hasAgreementLetter).toBe(false);
    await app.close();
  });

  it('one document pending does not lock the other three', async () => {
    const app = await makeApp();
    await submit(app, officerToken, { hasAadhaar: true });
    // A different document is a different field, so ADR-027's per-field lock lets
    // it through.
    const other = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/changes`, headers: auth(adminToken),
      payload: { changes: { hasAgreementLetter: true } },
    });
    expect(other.statusCode).toBe(201);
    // Same document, though, is refused.
    const same = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/changes`, headers: auth(adminToken),
      payload: { changes: { hasAadhaar: true } },
    });
    expect(same.statusCode).toBe(409);
    await app.close();
  });

  it('a proposed avatarKey carries signed previews so the approver can see the photo', async () => {
    const app = await makeApp();
    const req = await submit(app, officerToken, { avatarKey: 'cadres/cadre-1/avatar-test.jpg' });
    const entry = req.changes.avatarKey as { new: string; newUrl?: string; oldUrl?: string };
    expect(entry.new).toBe('cadres/cadre-1/avatar-test.jpg');
    // Without this the approver is shown a key string and asked to approve a photo
    // they cannot see — a rubber stamp, not a decision.
    expect(entry.newUrl).toBeDefined();
    expect(entry.newUrl).toContain('cadres/cadre-1/avatar-test.jpg');
    // No previous photo → nothing to sign.
    expect(entry.oldUrl).toBeUndefined();
    await app.close();
  });

  it('an approved avatarKey becomes the cadre photo and is served as a fresh URL', async () => {
    const app = await makeApp();
    const req = await submit(app, officerToken, { avatarKey: 'cadres/cadre-1/avatar-new.jpg' });
    await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/approve`, headers: auth(adminToken) });
    await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/approve`, headers: auth(superToken) });

    expect((await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } })).avatarKey).toBe('cadres/cadre-1/avatar-new.jpg');

    // The wire entity exposes a signed URL, never the key — ADR-016's lesson.
    const detail = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerToken) });
    const body = detail.json() as Record<string, unknown>;
    expect(body.avatarUrl).toContain('avatar-new.jpg');
    expect(body).not.toHaveProperty('avatarKey');
    await app.close();
  });

  it('a multi-field submission applies as one unit', async () => {
    const app = await makeApp();
    const req = await submit(app, officerToken, { phone: '+910000000091', currentAddress: 'दोनों' });
    expect(Object.keys(req.changes).sort()).toEqual(['currentAddress', 'phone']);
    await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/approve`, headers: auth(adminToken) });
    await app.inject({ method: 'POST', url: `/api/v1/changes/${req.id}/approve`, headers: auth(superToken) });
    const c = await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } });
    expect(c.phone).toBe('+910000000091');
    expect(c.currentAddress).toBe('दोनों');
    await app.close();
  });

  // ── Direct writes ──────────────────────────────────────────────────────────

  it('PATCH /cadres/:id writes tags/aliases immediately, no approval', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerToken),
      payload: { alertTag: 'तत्काल', aliases: ['बब्बू'] },
    });
    expect(res.statusCode).toBe(204);
    const c = await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } });
    expect(c.alertTag).toBe('तत्काल');
    expect(c.aliases).toEqual(['बब्बू']);
    // No approval was created — these are outside the chain by design.
    expect(await prisma.cadreChangeRequest.count({ where: { cadreId } })).toBe(0);
    await app.close();
  });

  // ── ADR-032: alertDate is derived from the tag write ───────────────────────
  //
  // The card labels this date "अलर्ट दर्ज होने की तारीख". Before ADR-032 nothing
  // wrote the column at all, so the label would have described a seed value that
  // never moved — a claim the app could not honour (Sampark-Mobile#6).

  it('PATCH stamps alertDate when a tag is set', async () => {
    const app = await makeApp();
    const before = Date.now();
    await app.inject({
      method: 'PATCH', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerToken),
      payload: { alertTag: 'तत्काल' },
    });
    const c = await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } });
    expect(c.alertDate).not.toBeNull();
    expect(c.alertDate!.getTime()).toBeGreaterThanOrEqual(before);
    await app.close();
  });

  it('PATCH clears alertDate when the tag is cleared — no alert, no alert date', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'PATCH', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerToken),
      payload: { alertTag: 'तत्काल' },
    });
    await app.inject({
      method: 'PATCH', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerToken),
      payload: { alertTag: null },
    });
    const c = await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } });
    expect(c.alertTag).toBeNull();
    expect(c.alertDate).toBeNull();
    await app.close();
  });

  it('PATCH leaves alertDate untouched on an alias-only write', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'PATCH', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerToken),
      payload: { alertTag: 'तत्काल' },
    });
    const stamped = (await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } })).alertDate;

    await app.inject({
      method: 'PATCH', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerToken),
      payload: { aliases: ['बब्बू'] },
    });
    const c = await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } });
    // Renaming someone is not re-recording their alert.
    expect(c.alertDate).toEqual(stamped);
    await app.close();
  });

  // ── ADR-033: alertLevel is derived from the tag ────────────────────────────

  it('PATCH derives alertLevel from the tag — a critical tag cannot sit on a normal cadre', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'PATCH', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerToken),
      payload: { alertTag: 'तत्काल' }, // CRITICAL_TAGS
    });
    expect((await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } })).alertLevel).toBe('critical');

    await app.inject({
      method: 'PATCH', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerToken),
      payload: { alertTag: 'निगरानी' }, // WARNING_TAGS
    });
    expect((await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } })).alertLevel).toBe('warning');
    await app.close();
  });

  it('PATCH drops alertLevel to normal when the tag is cleared', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'PATCH', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerToken),
      payload: { alertTag: 'तत्काल' },
    });
    await app.inject({
      method: 'PATCH', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerToken),
      payload: { alertTag: null },
    });
    const c = await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } });
    expect(c.alertLevel).toBe('normal');
    expect(c.alertTag).toBeNull();
    await app.close();
  });

  it('PATCH rejects a tag outside the catalogue — it would silently become normal', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerToken),
      payload: { alertTag: 'बहुत ज़रूरी' }, // plausible, but not in the catalogue
    });
    expect(res.statusCode).toBe(400);
    // Unchanged: a rejected write must not have moved the level either.
    expect((await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } })).alertLevel).toBe('normal');
    await app.close();
  });

  it('PATCH rejects an approval-gated field instead of silently ignoring it', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerToken),
      payload: { phone: '+910000000090' },
    });
    // A 204 here with no phone change would be a write that lies about succeeding.
    expect(res.statusCode).toBe(400);
    expect((await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } })).phone).toBe(ORIGINAL_PHONE);
    await app.close();
  });

  it('PATCH is refused for viewers (403)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      // A VALID tag on purpose (ADR-033 made the field an enum): an invalid one
      // would 400 at the schema before the role check ever runs, and the test would
      // pass while proving nothing about viewers.
      method: 'PATCH', url: `/api/v1/cadres/${cadreId}`, headers: auth(viewerToken), payload: { alertTag: 'तत्काल' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
