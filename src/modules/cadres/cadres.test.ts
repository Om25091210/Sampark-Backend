import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';

const prisma = new PrismaClient();
const config = testConfig();
const PHONES = ['+919000000010', '+919000000011', '+919000000012', '+919000000013'];
// ADR-038 import fixtures: unique name + serial prefixes so cleanup and search scope
// to this file's own rows (tests share one DB, run in parallel).
const IMPORT_TOKEN = 'IMPFIXTURE';
// SDR-007 machine key used by the import tests (>= 32 chars, like a real one).
const IMPORT_KEY = 'import-test-key-that-is-32-plus-characters-long';
// Unique, searchable name prefixes for this file's own fixtures — see beforeAll.
const PAGE_TOKEN = 'PGNFIXTURE';
const ORIGIN_TOKEN = 'ORGFIXTURE';
const ALERT_TOKEN = 'ALTFIXTURE';
const FACET_TOKEN = 'FCTFIXTURE';
// Design-Docs#8 avatar-backfill fixtures — own prefix, same cleanup discipline.
const AVATAR_TOKEN = 'AVTFIXTURE';
const DUE_NAME = 'TEST CADRE DUE';
// A cadre reporting on this date is next due 30 days later (ADR-022).
const DUE_REPORT_AT = new Date('2026-06-01T00:00:00.000Z');
const DUE_EXPECTED = new Date('2026-07-01T00:00:00.000Z').toISOString();

let adminId = 0;
let officerAId = 0;
let officerBId = 0;
let superAdminId = 0;
let cadreId = 0;
let dueCadreId = 0;
let adminToken = '';
let officerToken = '';
let superAdminToken = '';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const makeApp = (): Promise<FastifyInstance> => buildApp({ config, prisma, logger: false });

beforeAll(async () => {
  const admin = await prisma.user.upsert({
    // ADR-044. Transfer is scoped at BOTH ends, so this SDOP must hold the sub-division
    // that the fixture cadre and the target officer are both in.
    where: { phone: PHONES[0] },
    update: { deletedAt: null, role: 'admin', name: 'Test Admin', subDivision: 'बीजापुर' },
    create: { phone: PHONES[0]!, name: 'Test Admin', role: 'admin', subDivision: 'बीजापुर' },
  });
  const officerA = await prisma.user.upsert({
    where: { phone: PHONES[1] },
    update: { deletedAt: null, role: 'officer', name: 'Test Officer A', thana: 'बीजापुर' },
    create: { phone: PHONES[1]!, name: 'Test Officer A', role: 'officer', thana: 'बीजापुर' },
  });
  const officerB = await prisma.user.upsert({
    where: { phone: PHONES[2] },
    update: { deletedAt: null, role: 'officer', name: 'Test Officer B', thana: 'बीजापुर' },
    create: { phone: PHONES[2]!, name: 'Test Officer B', role: 'officer', thana: 'बीजापुर' },
  });
  const superAdmin = await prisma.user.upsert({
    where: { phone: PHONES[3] }, update: { deletedAt: null, role: 'super_admin', name: 'Test Super Admin' },
    create: { phone: PHONES[3]!, name: 'Test Super Admin', role: 'super_admin' },
  });
  adminId = admin.id;
  officerAId = officerA.id;
  officerBId = officerB.id;
  superAdminId = superAdmin.id;

  await prisma.cadre.deleteMany({ where: { name: 'TEST CADRE ALPHA' } });
  const cadre = await prisma.cadre.create({
    data: {
      name: 'TEST CADRE ALPHA', phone: '+910000000000', thana: 'बीजापुर',
      currentAddress: 'Test address', designation: 'Test', category: 'surrendered',
      alertLevel: 'normal', aliases: ['alpha-x'], assignedOfficerId: officerAId,
      // ADR-036. A fixed birth date so the derived age is assertable, plus relations.
      dateOfBirth: new Date('1990-06-15'), fatherName: 'पिता आल्फा',
      motherName: 'माता आल्फा', spouseName: 'जीवनसाथी आल्फा',
    },
  });
  cadreId = cadre.id;

  // Pagination fixture. The pagination test must NOT depend on how many cadres
  // happen to exist globally: CI runs `prisma migrate deploy` with no seed, and
  // test files run in parallel against one database, so the global cadre count is
  // shared mutable state. These three rows carry a unique token so the test can
  // page over exactly its own data via `search`.
  await prisma.cadre.deleteMany({ where: { name: { startsWith: PAGE_TOKEN } } });
  await prisma.cadre.createMany({
    data: [1, 2, 3].map((n) => ({
      name: `${PAGE_TOKEN}-${n}`, phone: `+91000000010${n}`, thana: 'पेजिनेशन',
      currentAddress: 'Pagination fixture', designation: 'Fixture',
      category: 'surrendered' as const, alertLevel: 'normal' as const, aliases: [],
    })),
  });

  // Surrender-origin fixture (ADR-019). Two district + one other, plus a thana
  // cadre that must carry NO origin at all — the tiles split surrendered cadres,
  // and a non-surrendered row has no origin to speak of.
  await prisma.cadre.deleteMany({ where: { name: { startsWith: ORIGIN_TOKEN } } });
  await prisma.cadre.createMany({
    data: [
      { name: `${ORIGIN_TOKEN}-D1`, surrenderOrigin: 'district' as const, category: 'surrendered' as const },
      { name: `${ORIGIN_TOKEN}-D2`, surrenderOrigin: 'district' as const, category: 'surrendered' as const },
      { name: `${ORIGIN_TOKEN}-O1`, surrenderOrigin: 'other' as const, category: 'surrendered' as const },
      { name: `${ORIGIN_TOKEN}-T1`, surrenderOrigin: null, category: 'thana' as const },
    ].map((c, i) => ({
      ...c, phone: `+91000000020${i}`, thana: 'ओरिजिन',
      currentAddress: 'Origin fixture', designation: 'Fixture',
      alertLevel: 'normal' as const, aliases: [],
    })),
  });

  // Alert-severity fixture (ADR-020) — one row at each level so the alertLevel
  // filter can be shown to select exactly the matching severity.
  await prisma.cadre.deleteMany({ where: { name: { startsWith: ALERT_TOKEN } } });
  await prisma.cadre.createMany({
    data: [
      { name: `${ALERT_TOKEN}-C`, alertLevel: 'critical' as const },
      { name: `${ALERT_TOKEN}-W`, alertLevel: 'warning' as const },
      { name: `${ALERT_TOKEN}-N`, alertLevel: 'normal' as const },
    ].map((c, i) => ({
      ...c, phone: `+91000000021${i}`, thana: 'अलर्ट',
      currentAddress: 'Alert fixture', designation: 'Fixture',
      category: 'thana' as const, aliases: [],
    })),
  });

  // Thana/designation facet fixture (ADR-033). Shaped like the real roster, which is
  // what the old hardcoded sheet got wrong: thanas are compound ("बीजापुर / गंगालूर",
  // so equality on "बीजापुर" misses it) and designations are Devanagari, never the
  // Latin rank acronyms the sheet used to offer.
  await prisma.cadre.deleteMany({ where: { name: { startsWith: FACET_TOKEN } } });
  await prisma.cadre.createMany({
    data: [
      { n: 1, thana: `${FACET_TOKEN} बीजापुर / गंगालूर`, designation: `${FACET_TOKEN} दस्ते का सदस्य` },
      { n: 2, thana: `${FACET_TOKEN} दंतेवाड़ा`, designation: `${FACET_TOKEN} सीनियर कैडर` },
      { n: 3, thana: `${FACET_TOKEN} बीजापुर / गंगालूर`, designation: `${FACET_TOKEN} सीनियर कैडर` },
    ].map((c) => ({
      name: `${FACET_TOKEN}-${c.n}`, phone: `+91000000030${c.n}`,
      thana: c.thana, designation: c.designation,
      currentAddress: 'Facet fixture', category: 'surrendered' as const,
      alertLevel: 'normal' as const, aliases: [],
    })),
  });

  // Reporting-deadline fixture (ADR-022): a cadre with TWO reports. nextReportingDueAt
  // must be computed from the NEWEST (DUE_REPORT_AT), not the older one, + 30 days.
  await prisma.cadre.deleteMany({ where: { name: DUE_NAME } });
  const dueCadre = await prisma.cadre.create({
    data: {
      name: DUE_NAME, phone: '+910000000900', thana: 'ड्यू', currentAddress: 'Due fixture',
      designation: 'Fixture', category: 'thana', alertLevel: 'normal', aliases: [],
    },
  });
  dueCadreId = dueCadre.id;
  await prisma.report.createMany({
    data: [
      { cadreId: dueCadreId, reportedById: officerAId, reportingPlace: 'thana', specificLocation: 'x',
        personStatus: 'alive', currentPhone: '+910', currentActivity: 'old', reportedAt: new Date('2026-04-01T00:00:00.000Z') },
      { cadreId: dueCadreId, reportedById: officerAId, reportingPlace: 'thana', specificLocation: 'x',
        personStatus: 'alive', currentPhone: '+910', currentActivity: 'new', reportedAt: DUE_REPORT_AT },
    ],
  });

  adminToken = await signAccessToken({ sub: adminId, role: 'admin' }, config.jwtSecret, '15m');
  officerToken = await signAccessToken({ sub: officerAId, role: 'officer' }, config.jwtSecret, '15m');
  superAdminToken = await signAccessToken({ sub: superAdminId, role: 'super_admin' }, config.jwtSecret, '15m');
});

afterEach(async () => {
  // Undo transfer side effects so each test starts from a known state.
  await prisma.auditLog.deleteMany({ where: { entityType: 'cadre', entityId: String(cadreId) } });
  await prisma.outboxEvent.deleteMany({ where: { aggregateType: 'cadre', aggregateId: String(cadreId) } });
  await prisma.cadre.update({ where: { id: cadreId }, data: { assignedOfficerId: officerAId } });
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { entityType: 'cadre', entityId: String(cadreId) } });
  await prisma.outboxEvent.deleteMany({ where: { aggregateType: 'cadre', aggregateId: String(cadreId) } });
  await prisma.cadre.deleteMany({ where: { id: cadreId } });
  await prisma.cadre.deleteMany({ where: { name: { startsWith: PAGE_TOKEN } } });
  await prisma.cadre.deleteMany({ where: { name: { startsWith: ORIGIN_TOKEN } } });
  await prisma.cadre.deleteMany({ where: { name: { startsWith: ALERT_TOKEN } } });
  await prisma.cadre.deleteMany({ where: { name: { startsWith: FACET_TOKEN } } });
  await prisma.report.deleteMany({ where: { cadreId: dueCadreId } });
  await prisma.cadre.deleteMany({ where: { name: DUE_NAME } });
  // ADR-038 import fixtures + their audit rows.
  const imported = await prisma.cadre.findMany({
    where: { name: { startsWith: IMPORT_TOKEN } }, select: { id: true },
  });
  await prisma.auditLog.deleteMany({
    where: { entityType: 'cadre', entityId: { in: imported.map((c) => String(c.id)) } },
  });
  await prisma.cadre.deleteMany({ where: { name: { startsWith: IMPORT_TOKEN } } });
  // Design-Docs#8 avatar-backfill fixtures + their audit rows.
  const backfilled = await prisma.cadre.findMany({
    where: { name: { startsWith: AVATAR_TOKEN } }, select: { id: true },
  });
  await prisma.auditLog.deleteMany({
    where: { entityType: 'cadre', entityId: { in: backfilled.map((c) => String(c.id)) } },
  });
  await prisma.cadre.deleteMany({ where: { name: { startsWith: AVATAR_TOKEN } } });
  await prisma.user.deleteMany({ where: { phone: { in: PHONES } } });
  await prisma.$disconnect();
});

// ADR-036. True if today (UTC) is before June 15 — i.e. the 06-15 birthday has not
// happened yet this year, so the derived age is one less than the year difference.
// Mirrors deriveAge's own comparison so the assertion stays correct on any run date.
function isBeforeJun15Today(): boolean {
  const now = new Date();
  const m = now.getUTCMonth();
  return m < 5 || (m === 5 && now.getUTCDate() < 15);
}

interface ListBody {
  data: Array<{ id: number; category: string; surrenderOrigin?: string } & Record<string, unknown>>;
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

describe('cadres', () => {
  it('GET /cadres without a token → 401', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/cadres' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('GET /cadres returns a paginated, camelCase list (no internal fields)', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/cadres?pageSize=50', headers: auth(superAdminToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ListBody;
    expect(body).toMatchObject({ page: 1, pageSize: 50 });
    expect(typeof body.total).toBe('number');
    expect(typeof body.hasMore).toBe('boolean');
    const mine = body.data.find((c) => c.id === cadreId);
    expect(mine).toBeDefined();
    expect(mine).toMatchObject({ currentAddress: 'Test address', category: 'surrendered', alertLevel: 'normal' });
    // ADR-018 reversed this: `assignedOfficerId` used to be an internal column and
    // is now deliberately on the wire — the clients need it for "my cadres" and for
    // the admin assignment UI. It is not sensitive; any authenticated user can
    // already page through every cadre.
    expect(mine).toHaveProperty('assignedOfficerId', officerAId);
    expect(mine).not.toHaveProperty('deletedAt');
    await app.close();
  });

  it('filters by category', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/cadres?category=surrendered&pageSize=50', headers: auth(superAdminToken) });
    const body = res.json() as ListBody;
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((c) => c.category === 'surrendered')).toBe(true);
    await app.close();
  });

  it('search matches the register serial number (BE#15)', async () => {
    const app = await makeApp();
    // Self-contained: ALPHA must stay serial-less for the "absent when unset" test,
    // so this makes its own row and cleans it up.
    const serial = 'SNTEST/2026/0001';
    const c = await prisma.cadre.create({
      data: {
        name: 'SN SEARCH FIXTURE', phone: '+910000000555', thana: 'x',
        currentAddress: 'x', designation: 'x', category: 'thana', alertLevel: 'normal',
        aliases: [], serialNumber: serial,
      },
    });
    try {
      // A fragment of the serial must find it — an officer reads a partial off the register.
      const res = await app.inject({
        method: 'GET', url: '/api/v1/cadres?search=SNTEST&pageSize=50', headers: auth(superAdminToken),
      });
      const body = res.json() as ListBody;
      expect(body.data.some((r) => (r as { serialNumber?: string }).serialNumber === serial)).toBe(true);
    } finally {
      await prisma.cadre.delete({ where: { id: c.id } });
      await app.close();
    }
  });

  it('paginates (pageSize=2) over its own fixture, not the whole table', async () => {
    const app = await makeApp();

    // Scoped by `search` to this file's 3 fixture rows. Asserting against the
    // global cadre count would make this test depend on the seed (absent in CI)
    // and on whatever other parallel test files have created or deleted.
    const p1 = await app.inject({
      method: 'GET', url: `/api/v1/cadres?search=${PAGE_TOKEN}&pageSize=2`, headers: auth(superAdminToken),
    });
    const first = p1.json() as ListBody;
    expect(first.total).toBe(3);
    expect(first.data.length).toBe(2);
    expect(first.hasMore).toBe(true);

    const p2 = await app.inject({
      method: 'GET', url: `/api/v1/cadres?search=${PAGE_TOKEN}&pageSize=2&page=2`, headers: auth(superAdminToken),
    });
    const second = p2.json() as ListBody;
    expect(second.data.length).toBe(1);
    expect(second.hasMore).toBe(false);

    // No row appears on both pages.
    const ids = [...first.data, ...second.data].map((c) => c.id);
    expect(new Set(ids).size).toBe(3);
    await app.close();
  });

  // ── Surrender origin (ADR-019) ──────────────────────────────────────────────
  //
  // The dashboard's two surrendered tiles differ ONLY by this filter, so the thing
  // worth proving is that they partition: same category, disjoint result sets, and
  // together they account for every classified surrendered cadre in the fixture.
  // Scoped by `search` to this file's own rows — CI has no seed data.

  it('surrenderOrigin splits the surrendered cadres into two disjoint sets', async () => {
    const app = await makeApp();
    const q = (origin: string) =>
      `/api/v1/cadres?search=${ORIGIN_TOKEN}&category=surrendered&surrenderOrigin=${origin}&pageSize=50`;

    const d = (await app.inject({ method: 'GET', url: q('district'), headers: auth(superAdminToken) })).json() as ListBody;
    const o = (await app.inject({ method: 'GET', url: q('other'), headers: auth(superAdminToken) })).json() as ListBody;

    expect(d.total).toBe(2);
    expect(o.total).toBe(1);
    expect(d.data.every((c) => c.surrenderOrigin === 'district')).toBe(true);
    expect(o.data.every((c) => c.surrenderOrigin === 'other')).toBe(true);

    // The bug this replaces: both tiles returned the same list. They must not overlap.
    const districtIds = new Set(d.data.map((c) => c.id));
    expect(o.data.some((c) => districtIds.has(c.id))).toBe(false);
    await app.close();
  });

  it('a non-surrendered cadre carries no surrenderOrigin on the wire', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/cadres?search=${ORIGIN_TOKEN}&category=thana&pageSize=50`,
      headers: auth(superAdminToken),
    });
    const body = res.json() as ListBody;
    expect(body.total).toBe(1);
    expect(body.data[0]).not.toHaveProperty('surrenderOrigin');
    await app.close();
  });

  it('filters by alertLevel (the "सक्रिय अलर्ट" tile drill-down, ADR-020)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/cadres?search=${ALERT_TOKEN}&alertLevel=critical&pageSize=50`,
      headers: auth(superAdminToken),
    });
    const body = res.json() as ListBody;
    expect(body.total).toBe(1); // only the -C row, not -W or -N
    expect(body.data.every((c) => (c as { alertLevel?: string }).alertLevel === 'critical')).toBe(true);
    await app.close();
  });

  // ── ADR-033: multi-value facets, resolved server-side ──────────────────────
  //
  // These used to be narrowed client-side over ONE fetched page, so anyone past
  // page 1 silently vanished from a filtered list.

  it('alertLevel accepts several values at once (critical OR warning)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cadres?search=${ALERT_TOKEN}&alertLevel=critical&alertLevel=warning&pageSize=50`,
      headers: auth(superAdminToken),
    });
    const body = res.json() as ListBody;
    expect(body.total).toBe(2); // -C and -W, never -N
    expect(body.data.map((c) => (c as { alertLevel?: string }).alertLevel).sort())
      .toEqual(['critical', 'warning']);
    await app.close();
  });

  it('thana matches as a substring — "गंगालूर" finds "बीजापुर / गंगालूर"', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cadres?search=${FACET_TOKEN}&thana=${encodeURIComponent('गंगालूर')}&pageSize=50`,
      headers: auth(superAdminToken),
    });
    const body = res.json() as ListBody;
    // An equality match would return 0 here — that was the old sheet's bug.
    expect(body.total).toBe(2);
    await app.close();
  });

  it('designation filters on the real Devanagari value, not a Latin acronym', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cadres?search=${FACET_TOKEN}&designation=${encodeURIComponent('सीनियर')}&pageSize=50`,
      headers: auth(superAdminToken),
    });
    const body = res.json() as ListBody;
    expect(body.total).toBe(2);
    await app.close();
  });

  it('facets AND together, values within a facet OR', async () => {
    const app = await makeApp();
    const url =
      `/api/v1/cadres?search=${FACET_TOKEN}` +
      `&thana=${encodeURIComponent('गंगालूर')}` +
      `&designation=${encodeURIComponent('सीनियर')}&pageSize=50`;
    const res = await app.inject({ method: 'GET', url, headers: auth(superAdminToken) });
    const body = res.json() as ListBody;
    // Only -3 is both in गंगालूर AND a सीनियर कैडर.
    expect(body.total).toBe(1);
    expect(body.data[0]!.name).toBe(`${FACET_TOKEN}-3`);
    await app.close();
  });

  it('search NARROWS a facet filter rather than widening it', async () => {
    const app = await makeApp();
    // If thana were written into the top-level OR that search owns, these would
    // widen each other and this would return every गंगालूर cadre in the table.
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cadres?search=${FACET_TOKEN}-2&thana=${encodeURIComponent('गंगालूर')}&pageSize=50`,
      headers: auth(superAdminToken),
    });
    const body = res.json() as ListBody;
    expect(body.total).toBe(0); // -2 is in दंतेवाड़ा, so the AND is empty
    await app.close();
  });

  it('GET /cadres/facets returns distinct real values, and requires auth', async () => {
    const app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/v1/cadres/facets' })).statusCode).toBe(401);

    const res = await app.inject({
      method: 'GET', url: '/api/v1/cadres/facets', headers: auth(superAdminToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { thanas: string[]; designations: string[] };

    // Distinct: two cadres share this thana, it must appear once.
    const mine = body.thanas.filter((t) => t.startsWith(FACET_TOKEN));
    expect(mine).toEqual([`${FACET_TOKEN} दंतेवाड़ा`, `${FACET_TOKEN} बीजापुर / गंगालूर`]);

    const desigs = body.designations.filter((d) => d.startsWith(FACET_TOKEN));
    expect(desigs.sort()).toEqual([`${FACET_TOKEN} दस्ते का सदस्य`, `${FACET_TOKEN} सीनियर कैडर`]);
    await app.close();
  });

  it('rejects an unknown alertLevel with 400', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/cadres?alertLevel=urgent', headers: auth(superAdminToken),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects an unknown surrenderOrigin with 400', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/cadres?surrenderOrigin=bijapur', headers: auth(superAdminToken),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    await app.close();
  });

  it('rejects pageSize over the max (51) with 400', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/cadres?pageSize=51', headers: auth(superAdminToken) });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    await app.close();
  });

  it('GET /cadres/:id returns the cadre', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}`, headers: auth(superAdminToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: cadreId, name: 'TEST CADRE ALPHA', category: 'surrendered' });
    await app.close();
  });

  it('serves dateOfBirth, derived age, and the relation names (ADR-036)', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}`, headers: auth(superAdminToken) });
    const c = res.json() as {
      dateOfBirth?: string; age?: number; fatherName?: string; motherName?: string; spouseName?: string;
    };
    // Date part only — no spurious time component on the wire.
    expect(c.dateOfBirth).toBe('1990-06-15');
    // Derived, not stored: whole years from 1990-06-15 to today.
    const expected = new Date().getUTCFullYear() - 1990 - (isBeforeJun15Today() ? 1 : 0);
    expect(c.age).toBe(expected);
    expect(c.fatherName).toBe('पिता आल्फा');
    expect(c.motherName).toBe('माता आल्फा');
    expect(c.spouseName).toBe('जीवनसाथी आल्फा');
    await app.close();
  });

  it('a cadre with no birth date has neither dateOfBirth nor age (ADR-036)', async () => {
    const app = await makeApp();
    // The ALERT fixtures carry no dateOfBirth.
    const res = await app.inject({
      method: 'GET', url: `/api/v1/cadres?search=${ALERT_TOKEN}&pageSize=1`, headers: auth(superAdminToken),
    });
    const row = (res.json() as ListBody).data[0] as { dateOfBirth?: string; age?: number };
    expect(row.dateOfBirth).toBeUndefined();
    expect(row.age).toBeUndefined();
    await app.close();
  });

  it('nextReportingDueAt = latest report date + 30 days (ADR-022)', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${dueCadreId}`, headers: auth(superAdminToken) });
    expect(res.statusCode).toBe(200);
    // Computed from the NEWER report (DUE_REPORT_AT), not the April one.
    expect((res.json() as { nextReportingDueAt?: string }).nextReportingDueAt).toBe(DUE_EXPECTED);
    await app.close();
  });

  it('a cadre with no reports has no nextReportingDueAt (no baseline)', async () => {
    const app = await makeApp();
    // The ALPHA fixture cadre has no reports.
    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}`, headers: auth(superAdminToken) });
    expect(res.json()).not.toHaveProperty('nextReportingDueAt');
    await app.close();
  });

  it('lastReportedAt is the latest report date itself, the baseline the due date derives from (ADR-023)', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${dueCadreId}`, headers: auth(superAdminToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { lastReportedAt?: string; nextReportingDueAt?: string };
    // The newer report, not the April one — same row nextReportingDueAt counts from.
    expect(body.lastReportedAt).toBe(DUE_REPORT_AT.toISOString());
    // The pair must stay exactly one cadence apart. This is the point of shipping
    // lastReportedAt at all: the client derives "time since last contact" from it
    // instead of keeping its own copy of the 30-day cadence to subtract.
    const gapDays =
      (Date.parse(body.nextReportingDueAt!) - Date.parse(body.lastReportedAt!)) / 86_400_000;
    expect(gapDays).toBe(30);
    await app.close();
  });

  it('a cadre with no reports has no lastReportedAt either', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}`, headers: auth(superAdminToken) });
    expect(res.json()).not.toHaveProperty('lastReportedAt');
    await app.close();
  });

  // ── ADR-041: reporting-recency tier filter ──────────────────────────────────

  it('recency filter buckets a cadre by days since its last report (सतर्क)', async () => {
    const app = await makeApp();
    // A dedicated fixture reporting 45 days ago → always सतर्क (30–60d), whatever the run date.
    const c = await prisma.cadre.create({
      data: {
        name: 'RECENCY FIXTURE', phone: '+910000000777', thana: 'x', currentAddress: 'x',
        designation: 'x', category: 'thana', alertLevel: 'normal', aliases: [],
      },
    });
    await prisma.report.create({
      data: {
        cadreId: c.id, reportedById: officerAId, reportingPlace: 'thana', specificLocation: 'x',
        personStatus: 'alive', currentPhone: '+910', currentActivity: 'y',
        reportedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000),
      },
    });
    try {
      const inTier = async (tier: string): Promise<boolean> => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/cadres?search=${encodeURIComponent('RECENCY FIXTURE')}&recency=${tier}&pageSize=50`,
          headers: auth(superAdminToken),
        });
        return (res.json() as ListBody).data.some((r) => r.id === c.id);
      };
      expect(await inTier('overdue1m')).toBe(true); // 45d → सतर्क
      expect(await inTier('current')).toBe(false); // not सामान्य
      expect(await inTier('overdue3m')).toBe(false); // not उच्च जोखिम
    } finally {
      await prisma.report.deleteMany({ where: { cadreId: c.id } });
      await prisma.cadre.delete({ where: { id: c.id } });
      await app.close();
    }
  });

  it('recency=overdue3m includes a never-reported cadre (no grace, ADR-031/041)', async () => {
    const app = await makeApp();
    // The ALPHA fixture has no reports → most overdue.
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cadres?recency=overdue3m&search=${encodeURIComponent('TEST CADRE ALPHA')}&pageSize=50`,
      headers: auth(superAdminToken),
    });
    expect((res.json() as ListBody).data.some((c) => c.id === cadreId)).toBe(true);
    await app.close();
  });

  it('serialNumber is absent when unset, and never falls back to id (ADR-025)', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}`, headers: auth(superAdminToken) });
    expect(res.statusCode).toBe(200);
    // The fixture has no serial. It must be omitted — NOT filled in from `id`,
    // which is an unrelated surrogate key the import will reassign.
    expect(res.json()).not.toHaveProperty('serialNumber');
    await app.close();
  });

  it('serialNumber is serialized when set (ADR-025)', async () => {
    const app = await makeApp();
    await prisma.cadre.update({ where: { id: dueCadreId }, data: { serialNumber: 'BJP/2024/0731' } });
    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${dueCadreId}`, headers: auth(superAdminToken) });
    expect((res.json() as { serialNumber?: string }).serialNumber).toBe('BJP/2024/0731');
    await prisma.cadre.update({ where: { id: dueCadreId }, data: { serialNumber: null } });
    await app.close();
  });

  it('nextReportingDueAt is present in the list too, not only the detail', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/cadres?search=${encodeURIComponent(DUE_NAME)}&pageSize=50`, headers: auth(superAdminToken),
    });
    const body = res.json() as ListBody;
    const due = body.data.find((c) => c.id === dueCadreId);
    expect(due).toHaveProperty('nextReportingDueAt', DUE_EXPECTED);
    await app.close();
  });

  it('GET /cadres/:id → 404 for unknown id', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/cadres/99999999', headers: auth(superAdminToken) });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('transfer is forbidden for officers (403)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/transfer`,
      headers: auth(officerToken), payload: { to_officer_id: officerBId },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('admin transfer → 204, reassigns, and writes audit + outbox atomically', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/transfer`,
      headers: auth(adminToken), payload: { to_officer_id: officerBId },
    });
    expect(res.statusCode).toBe(204);

    const updated = await prisma.cadre.findUniqueOrThrow({ where: { id: cadreId } });
    expect(updated.assignedOfficerId).toBe(officerBId);

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'cadre', entityId: String(cadreId), action: 'cadre.transfer' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.hash).toBeTruthy();
    expect(audit?.prevHash).toBeTruthy();

    const event = await prisma.outboxEvent.findFirst({
      where: { aggregateType: 'cadre', aggregateId: String(cadreId), eventType: 'cadre.transferred' },
    });
    expect(event).not.toBeNull();
    await app.close();
  });

  it('transfer with missing to_officer_id → 400', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/transfer`,
      headers: auth(adminToken), payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('transfer unknown cadre → 404', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/cadres/99999999/transfer',
      headers: auth(adminToken), payload: { to_officer_id: officerBId },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('transfer to an unknown officer → 400 INVALID_OFFICER', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/transfer`,
      headers: auth(adminToken), payload: { to_officer_id: 99999999 },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_OFFICER');
    await app.close();
  });
});

// ── Bulk historical import (ADR-038 / SDR-007) ────────────────────────────────
describe('cadres import (ADR-038)', () => {
  // An app whose config carries the SDR-007 machine key, so the key path is live.
  const keyedApp = (): Promise<FastifyInstance> =>
    buildApp({ config: testConfig({ importApiKey: IMPORT_KEY }), prisma, logger: false });
  const importAuth = { 'x-sampark-import-key': IMPORT_KEY };
  const url = '/api/v1/cadres/import';

  // A row exercising every column, so the GET-verify can prove each landed.
  const fullRow = (serialNumber: string, name: string) => ({
    serialNumber,
    name,
    phone: '9812300001',
    thana: 'भोपालपटनम',
    currentAddress: 'अस्पतालपारा बीजापुर',
    permanentAddress: 'बन्देपारा',
    designation: 'एसीएम sector member',
    category: 'surrendered',
    alertLevel: 'normal',
    filter: 'ACM',
    surrenderDate: '2009-03-22',
    surrenderLocation: 'मद्देड़ जिला बीजापुर',
    surrenderOrigin: 'district',
    surrenderYear: '2009',
    regiment: 'मद्देड़ क्षेत्र एलओएस',
    subDivision: 'भोपालपटनम',
    fatherName: 'मुण्डैया मिच्चा',
    motherName: null,
    spouseName: null,
    incident: '(सुधार नोट)',
    gender: 'male',
    caste: 'मुरिया',
    dateOfBirth: '1982-01-15',
    aliases: ['उपनाम एक'],
  });

  interface ImportResp {
    results: Array<{ serialNumber: string | null; status: string; cadreId?: number; error?: string }>;
  }

  it('rejects an unauthenticated call (no key, no token) with 401', async () => {
    const app = await keyedApp();
    const res = await app.inject({ method: 'POST', url, payload: { cadres: [fullRow(`${IMPORT_TOKEN}-U1`, `${IMPORT_TOKEN} u1`)] } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects an officer JWT with 403 (not super_admin)', async () => {
    const app = await keyedApp();
    const res = await app.inject({
      method: 'POST', url, headers: auth(officerToken),
      payload: { cadres: [fullRow(`${IMPORT_TOKEN}-U2`, `${IMPORT_TOKEN} u2`)] },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects an admin JWT with 403 (import is super_admin-tier)', async () => {
    const app = await keyedApp();
    const res = await app.inject({
      method: 'POST', url, headers: auth(adminToken),
      payload: { cadres: [fullRow(`${IMPORT_TOKEN}-U3`, `${IMPORT_TOKEN} u3`)] },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects a wrong machine key with 401 (no fall-through to JWT)', async () => {
    const app = await keyedApp();
    const res = await app.inject({
      method: 'POST', url, headers: { 'x-sampark-import-key': 'the-wrong-key-entirely-but-long-enough' },
      payload: { cadres: [fullRow(`${IMPORT_TOKEN}-U4`, `${IMPORT_TOKEN} u4`)] },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_IMPORT_KEY');
    await app.close();
  });

  it('machine key: imports a batch, persisting EVERY field (verified via GET), audited to a null actor', async () => {
    const app = await keyedApp();
    const serial = `${IMPORT_TOKEN}-1`;
    const res = await app.inject({
      method: 'POST', url, headers: importAuth,
      payload: { cadres: [fullRow(serial, `${IMPORT_TOKEN} पूर्ण एक`)] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ImportResp;
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ serialNumber: serial, status: 'created' });
    const cadreId = body.results[0]!.cadreId!;
    expect(typeof cadreId).toBe('number');

    // Verify field-by-field via GET — not just that a 200 came back (ADR-019/020/021 standard).
    const list = await app.inject({
      method: 'GET', url: `/api/v1/cadres?search=${IMPORT_TOKEN}&pageSize=50`, headers: auth(superAdminToken),
    });
    const row = (list.json() as ListBody).data.find(
      (c) => (c as { serialNumber?: string }).serialNumber === serial,
    ) as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      serialNumber: serial,
      name: `${IMPORT_TOKEN} पूर्ण एक`,
      phone: '9812300001',
      thana: 'भोपालपटनम',
      currentAddress: 'अस्पतालपारा बीजापुर',
      permanentAddress: 'बन्देपारा',
      designation: 'एसीएम sector member',
      category: 'surrendered',
      alertLevel: 'normal',
      filter: 'ACM',
      surrenderLocation: 'मद्देड़ जिला बीजापुर',
      surrenderOrigin: 'district',
      surrenderYear: '2009',
      regiment: 'मद्देड़ क्षेत्र एलओएस',
      subDivision: 'भोपालपटनम',
      fatherName: 'मुण्डैया मिच्चा',
      incident: '(सुधार नोट)',
      // ADR-038 — the two new columns.
      gender: 'male',
      caste: 'मुरिया',
      // ADR-036 — date-only on the wire, age derived.
      dateOfBirth: '1982-01-15',
      aliases: ['उपनाम एक'],
    });
    // Dates: surrenderDate is a full timestamp column, DOB is date-only.
    expect(row!.surrenderDate).toBe('2009-03-22T00:00:00.000Z');
    expect(typeof row!.age).toBe('number');

    // Audit: a null-actor `cadre.import` row (the machine credential is not a user).
    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'cadre', entityId: String(cadreId), action: 'cadre.import' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorId).toBeNull();
    await app.close();
  });

  it('super_admin JWT imports without the machine key, audited to that super_admin', async () => {
    // No key on this app's config — only the JWT path is available.
    const app = await buildApp({ config, prisma, logger: false });
    const serial = `${IMPORT_TOKEN}-2`;
    const res = await app.inject({
      method: 'POST', url, headers: auth(superAdminToken),
      payload: { cadres: [fullRow(serial, `${IMPORT_TOKEN} सुपर एडमिन`)] },
    });
    expect(res.statusCode).toBe(200);
    const cadreId = (res.json() as ImportResp).results[0]!.cadreId!;
    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'cadre', entityId: String(cadreId), action: 'cadre.import' },
    });
    expect(audit?.actorId).toBe(superAdminId);
    await app.close();
  });

  it('upserts by serialNumber — a re-sent serial is skipped_duplicate, never a second row', async () => {
    const app = await keyedApp();
    const serial = `${IMPORT_TOKEN}-3`;
    const first = await app.inject({
      method: 'POST', url, headers: importAuth,
      payload: { cadres: [fullRow(serial, `${IMPORT_TOKEN} मूल`)] },
    });
    const firstId = (first.json() as ImportResp).results[0]!.cadreId!;

    // Same serial, different name — must NOT create a second row or overwrite the first.
    const second = await app.inject({
      method: 'POST', url, headers: importAuth,
      payload: { cadres: [fullRow(serial, `${IMPORT_TOKEN} डुप्लिकेट`)] },
    });
    const r = (second.json() as ImportResp).results[0]!;
    expect(r.status).toBe('skipped_duplicate');
    expect(r.cadreId).toBe(firstId);

    expect(await prisma.cadre.count({ where: { serialNumber: serial } })).toBe(1);
    const kept = await prisma.cadre.findFirstOrThrow({ where: { serialNumber: serial } });
    expect(kept.name).toBe(`${IMPORT_TOKEN} मूल`); // untouched — skip, not update
    await app.close();
  });

  it('a duplicate WITHIN one batch: first created, second skipped', async () => {
    const app = await keyedApp();
    const serial = `${IMPORT_TOKEN}-4`;
    const res = await app.inject({
      method: 'POST', url, headers: importAuth,
      payload: { cadres: [fullRow(serial, `${IMPORT_TOKEN} इंट्रा-1`), fullRow(serial, `${IMPORT_TOKEN} इंट्रा-2`)] },
    });
    const results = (res.json() as ImportResp).results;
    expect(results[0]!.status).toBe('created');
    expect(results[1]!.status).toBe('skipped_duplicate');
    expect(await prisma.cadre.count({ where: { serialNumber: serial } })).toBe(1);
    await app.close();
  });

  it('reports a bad row as `error` (with the field) without failing the rest of the batch', async () => {
    const app = await keyedApp();
    const good1 = fullRow(`${IMPORT_TOKEN}-5`, `${IMPORT_TOKEN} अच्छा एक`);
    const bad = { ...fullRow(`${IMPORT_TOKEN}-6`, `${IMPORT_TOKEN} खराब`), currentAddress: '' };
    const good2 = fullRow(`${IMPORT_TOKEN}-7`, `${IMPORT_TOKEN} अच्छा दो`);
    const res = await app.inject({ method: 'POST', url, headers: importAuth, payload: { cadres: [good1, bad, good2] } });
    expect(res.statusCode).toBe(200);
    const results = (res.json() as ImportResp).results;
    expect(results[0]!.status).toBe('created');
    expect(results[1]!.status).toBe('error');
    expect(results[1]!.serialNumber).toBe(`${IMPORT_TOKEN}-6`);
    expect(results[1]!.error).toContain('currentAddress');
    expect(results[2]!.status).toBe('created');
    // The bad row created nothing; the two good ones persisted.
    expect(await prisma.cadre.count({ where: { serialNumber: `${IMPORT_TOKEN}-6` } })).toBe(0);
    expect(await prisma.cadre.count({ where: { serialNumber: `${IMPORT_TOKEN}-5` } })).toBe(1);
    expect(await prisma.cadre.count({ where: { serialNumber: `${IMPORT_TOKEN}-7` } })).toBe(1);
    await app.close();
  });

  it('rejects a batch over 200 rows with 400 (envelope validation)', async () => {
    const app = await keyedApp();
    const cadres = Array.from({ length: 201 }, () => ({}));
    const res = await app.inject({ method: 'POST', url, headers: importAuth, payload: { cadres } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    await app.close();
  });

  it('rejects an empty cadres array with 400', async () => {
    const app = await keyedApp();
    const res = await app.inject({ method: 'POST', url, headers: importAuth, payload: { cadres: [] } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

// ── Bulk avatar backfill (Design-Docs#8) ──────────────────────────────────────
describe('cadres avatar backfill (Design-Docs#8)', () => {
  const url = '/api/v1/cadres/avatar-backfill';
  // A real 1x1 PNG — the type is sniffed from actual magic bytes, so a placeholder
  // string would not survive it.
  const PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  // JPEG needs only its FF D8 FF start-of-image marker to be identified.
  const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64');

  interface BackfillResp {
    results: Array<{
      serialNumber: string | null;
      status: string;
      cadreId?: number;
      avatarKey?: string;
      error?: string;
    }>;
  }

  // A cadre that exists but has no photo yet — the backfill's actual target.
  const makeTarget = async (suffix: string): Promise<{ id: number; serial: string }> => {
    const serial = `${AVATAR_TOKEN}-${suffix}`;
    const c = await prisma.cadre.create({
      data: {
        name: `${AVATAR_TOKEN} ${suffix}`, phone: '+910000000001', thana: 'बीजापुर',
        currentAddress: 'Test address', designation: 'Test', category: 'surrendered',
        alertLevel: 'normal', serialNumber: serial, subDivision: 'बीजापुर',
      },
    });
    return { id: c.id, serial };
  };

  it('rejects an unauthenticated call with 401', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url, payload: { avatars: [] } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects an officer JWT with 403', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url, headers: auth(officerToken),
      payload: { avatars: [{ serialNumber: 'x', base64Image: PNG_B64 }] },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects an admin JWT with 403 (backfill is super_admin-tier)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url, headers: auth(adminToken),
      payload: { avatars: [{ serialNumber: 'x', base64Image: PNG_B64 }] },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  // The distinguishing auth rule: unlike /cadres/import, the SDR-007 machine key is
  // NOT a way in here, because this writes over records that already exist.
  it('rejects the SDR-007 machine key with 401 — not accepted on this route', async () => {
    const app = await buildApp({
      config: testConfig({ importApiKey: IMPORT_KEY }), prisma, logger: false,
    });
    const res = await app.inject({
      method: 'POST', url, headers: { 'x-sampark-import-key': IMPORT_KEY },
      payload: { avatars: [{ serialNumber: 'x', base64Image: PNG_B64 }] },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('sets avatarKey directly, bypassing the ADR-026 ladder, and audits the super_admin', async () => {
    const app = await makeApp();
    const { id, serial } = await makeTarget('1');

    const res = await app.inject({
      method: 'POST', url, headers: auth(superAdminToken),
      payload: { avatars: [{ serialNumber: serial, base64Image: PNG_B64 }] },
    });
    expect(res.statusCode).toBe(200);
    const results = (res.json() as BackfillResp).results;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ serialNumber: serial, status: 'updated', cadreId: id });
    expect(results[0]!.avatarKey).toMatch(new RegExp(`^cadres/cadre-${id}/avatar-.*\\.png$`));

    // The column is written directly — no change request was created.
    const row = await prisma.cadre.findUniqueOrThrow({ where: { id } });
    expect(row.avatarKey).toBe(results[0]!.avatarKey);
    expect(await prisma.cadreChangeRequest.count({ where: { cadreId: id } })).toBe(0);

    // The photo is served as a signed URL, and the key itself never goes on the wire.
    const get = await app.inject({
      method: 'GET', url: `/api/v1/cadres/${id}`, headers: auth(superAdminToken),
    });
    const body = get.json() as Record<string, unknown>;
    expect(body.avatarUrl).toContain('avatar-');
    expect(body).not.toHaveProperty('avatarKey');

    // Bypassing approval makes the audit row the only account of who did this.
    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'cadre', entityId: String(id), action: 'cadre.avatar_backfill' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorId).toBe(superAdminId);
    await app.close();
  });

  it('skips a cadre that already has a photo — a re-run cannot clobber it', async () => {
    const app = await makeApp();
    const { id, serial } = await makeTarget('2');
    const first = await app.inject({
      method: 'POST', url, headers: auth(superAdminToken),
      payload: { avatars: [{ serialNumber: serial, base64Image: PNG_B64 }] },
    });
    const originalKey = (first.json() as BackfillResp).results[0]!.avatarKey;

    const second = await app.inject({
      method: 'POST', url, headers: auth(superAdminToken),
      payload: { avatars: [{ serialNumber: serial, base64Image: JPEG_B64 }] },
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as BackfillResp).results[0]).toMatchObject({
      serialNumber: serial, status: 'skipped_has_avatar', cadreId: id, avatarKey: originalKey,
    });
    // Unchanged on disk, and the skip wrote no second audit row.
    expect((await prisma.cadre.findUniqueOrThrow({ where: { id } })).avatarKey).toBe(originalKey);
    expect(await prisma.auditLog.count({
      where: { entityType: 'cadre', entityId: String(id), action: 'cadre.avatar_backfill' },
    })).toBe(1);
    await app.close();
  });

  it('reports an unmatched serial as not_found without failing the batch', async () => {
    const app = await makeApp();
    const { serial } = await makeTarget('3');
    const res = await app.inject({
      method: 'POST', url, headers: auth(superAdminToken),
      payload: {
        avatars: [
          { serialNumber: `${AVATAR_TOKEN}-NOSUCHSERIAL`, base64Image: PNG_B64 },
          { serialNumber: serial, base64Image: JPEG_B64 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const results = (res.json() as BackfillResp).results;
    expect(results[0]).toMatchObject({ status: 'not_found' });
    expect(results[0]!.cadreId).toBeUndefined();
    // Order is preserved and the good row still landed — as a .jpg, from its bytes.
    expect(results[1]).toMatchObject({ serialNumber: serial, status: 'updated' });
    expect(results[1]!.avatarKey).toMatch(/\.jpg$/);
    await app.close();
  });

  it('rejects a non-image payload per-row, leaving the rest of the batch intact', async () => {
    const app = await makeApp();
    const good = await makeTarget('4');
    const bad = await makeTarget('5');
    const res = await app.inject({
      method: 'POST', url, headers: auth(superAdminToken),
      payload: {
        avatars: [
          // Valid base64, but the bytes are a PDF header — not an image.
          {
            serialNumber: bad.serial,
            base64Image: Buffer.from('%PDF-1.7 not an image').toString('base64'),
          },
          { serialNumber: good.serial, base64Image: PNG_B64 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const results = (res.json() as BackfillResp).results;
    expect(results[0]).toMatchObject({ serialNumber: bad.serial, status: 'error' });
    expect(results[0]!.error).toContain('neither JPEG nor PNG');
    expect(results[1]).toMatchObject({ serialNumber: good.serial, status: 'updated' });
    // The rejected row stayed photoless.
    expect((await prisma.cadre.findUniqueOrThrow({ where: { id: bad.id } })).avatarKey).toBeNull();
    await app.close();
  });

  it('accepts a data: URI prefix, since that is what an encoder often emits', async () => {
    const app = await makeApp();
    const { serial } = await makeTarget('6');
    const res = await app.inject({
      method: 'POST', url, headers: auth(superAdminToken),
      payload: { avatars: [{ serialNumber: serial, base64Image: `data:image/png;base64,${PNG_B64}` }] },
    });
    expect((res.json() as BackfillResp).results[0]).toMatchObject({
      serialNumber: serial, status: 'updated',
    });
    await app.close();
  });

  it('reports a row missing base64Image as that row error, not a failed batch', async () => {
    const app = await makeApp();
    const { serial } = await makeTarget('7');
    const res = await app.inject({
      method: 'POST', url, headers: auth(superAdminToken),
      payload: { avatars: [{ serialNumber: serial }, { serialNumber: serial, base64Image: PNG_B64 }] },
    });
    expect(res.statusCode).toBe(200);
    const results = (res.json() as BackfillResp).results;
    expect(results[0]).toMatchObject({ serialNumber: serial, status: 'error' });
    expect(results[0]!.error).toContain('base64Image');
    expect(results[1]).toMatchObject({ status: 'updated' });
    await app.close();
  });

  it('rejects a batch over the row cap with 400 (envelope validation)', async () => {
    const app = await makeApp();
    const avatars = Array.from({ length: 21 }, () => ({}));
    const res = await app.inject({
      method: 'POST', url, headers: auth(superAdminToken), payload: { avatars },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    await app.close();
  });

  it('rejects an empty avatars array with 400', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url, headers: auth(superAdminToken), payload: { avatars: [] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  // The route raises Fastify's 1 MiB default; without that override a full batch of
  // real photos would 413 before any handler ran.
  it('accepts a body larger than the 1 MiB Fastify default', async () => {
    const app = await makeApp();
    const { serial } = await makeTarget('8');
    // ~2 MiB of "JPEG": the SOI marker plus padding, so it still sniffs as one.
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2 * 1024 * 1024, 0x20)]);
    const res = await app.inject({
      method: 'POST', url, headers: auth(superAdminToken),
      payload: { avatars: [{ serialNumber: serial, base64Image: big.toString('base64') }] },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as BackfillResp).results[0]).toMatchObject({ status: 'updated' });
    await app.close();
  });
});

// ── Thana transfer (ADR-046) ──────────────────────────────────────────────────
// Moves a cadre to another station. ADR-044 is enforced on BOTH ends: the cadre must
// be in the caller's scope to be found, and the destination thana must be admitted by
// it. adminToken is scoped to the बीजापुर sub-division (thanas: [बीजापुर]); superAdmin
// is unrestricted. गंगालूर and पामेड़ are canonical thanas in OTHER sub-divisions.
describe('cadres thana transfer (ADR-046)', () => {
  const TXN_TOKEN = 'TXNFIXTURE';
  const created: number[] = [];
  const makeCadre = async (suffix: string, thana: string): Promise<number> => {
    const c = await prisma.cadre.create({
      data: {
        name: `${TXN_TOKEN} ${suffix}`, phone: '+910000000501', thana,
        currentAddress: 'Txn fixture', designation: 'Fixture', category: 'surrendered',
        alertLevel: 'normal', aliases: [], assignedOfficerId: officerAId,
      },
    });
    created.push(c.id);
    return c.id;
  };

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: 'cadre', entityId: { in: created.map(String) } } });
    await prisma.outboxEvent.deleteMany({ where: { aggregateType: 'cadre', aggregateId: { in: created.map(String) } } });
    await prisma.cadre.deleteMany({ where: { id: { in: created } } });
  });

  it('is forbidden for officers (403)', async () => {
    const app = await makeApp();
    const id = await makeCadre('officer-403', 'बीजापुर');
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${id}/thana-transfer`,
      headers: auth(officerToken), payload: { thana: 'गंगालूर' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('super_admin move → 204, changes thana, clears the assignment, audits + outboxes', async () => {
    const app = await makeApp();
    const id = await makeCadre('happy', 'बीजापुर');
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${id}/thana-transfer`,
      headers: auth(superAdminToken), payload: { thana: 'गंगालूर' },
    });
    expect(res.statusCode).toBe(204);

    const updated = await prisma.cadre.findUniqueOrThrow({ where: { id } });
    expect(updated.thana).toBe('गंगालूर');
    // The old station's officer loses scope, so the assignment is cleared.
    expect(updated.assignedOfficerId).toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'cadre', entityId: String(id), action: 'cadre.thana_transfer' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.hash).toBeTruthy();

    const event = await prisma.outboxEvent.findFirst({
      where: { aggregateType: 'cadre', aggregateId: String(id), eventType: 'cadre.thana_transferred' },
    });
    expect(event).not.toBeNull();
    await app.close();
  });

  it('rejects a destination outside the actor jurisdiction → 400 THANA_OUT_OF_SCOPE', async () => {
    const app = await makeApp();
    // In the admin's scope (बीजापुर) so it is found; गंगालूर is a DIFFERENT sub-division.
    const id = await makeCadre('dest-oos', 'बीजापुर');
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${id}/thana-transfer`,
      headers: auth(adminToken), payload: { thana: 'गंगालूर' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('THANA_OUT_OF_SCOPE');
    // Nothing moved.
    expect((await prisma.cadre.findUniqueOrThrow({ where: { id } })).thana).toBe('बीजापुर');
    await app.close();
  });

  it('a cadre outside the actor jurisdiction is a 404 (source end of the scope check)', async () => {
    const app = await makeApp();
    // पामेड़ is outside the admin's बीजापुर scope, so it is indistinguishable from absent.
    const id = await makeCadre('src-oos', 'पामेड़');
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${id}/thana-transfer`,
      headers: auth(adminToken), payload: { thana: 'पामेड़' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('rejects a missing thana with 400', async () => {
    const app = await makeApp();
    const id = await makeCadre('no-thana', 'बीजापुर');
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${id}/thana-transfer`,
      headers: auth(adminToken), payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

// ── priorityCategory backfill (ADR-046) ───────────────────────────────────────
describe('cadres category backfill (ADR-046)', () => {
  const url = '/api/v1/cadres/category-backfill';
  const CAT_TOKEN = 'CATFIXTURE';
  const created: number[] = [];

  interface CatResp {
    results: Array<{ serialNumber: string | null; status: string; cadreId?: number; priorityCategory?: string; error?: string }>;
  }

  const makeTarget = async (suffix: string, grade: 'A' | 'B' | 'C' | 'jail' | 'death' | null = null): Promise<{ id: number; serial: string }> => {
    const serial = `${CAT_TOKEN}-${suffix}`;
    const c = await prisma.cadre.create({
      data: {
        name: `${CAT_TOKEN} ${suffix}`, phone: '+910000000601', thana: 'बीजापुर',
        currentAddress: 'Cat fixture', designation: 'Fixture', category: 'surrendered',
        alertLevel: 'normal', aliases: [], serialNumber: serial, priorityCategory: grade,
      },
    });
    created.push(c.id);
    return { id: c.id, serial };
  };

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: 'cadre', entityId: { in: created.map(String) } } });
    await prisma.cadre.deleteMany({ where: { id: { in: created } } });
  });

  it('rejects an unauthenticated call with 401', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url, payload: { categories: [] } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects an admin JWT with 403 (backfill is super_admin-tier)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url, headers: auth(adminToken),
      payload: { categories: [{ serialNumber: 'x', priorityCategory: 'A' }] },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects the SDR-007 machine key with 401 — not accepted on this route', async () => {
    const app = await buildApp({ config: testConfig({ importApiKey: IMPORT_KEY }), prisma, logger: false });
    const res = await app.inject({
      method: 'POST', url, headers: { 'x-sampark-import-key': IMPORT_KEY },
      payload: { categories: [{ serialNumber: 'x', priorityCategory: 'A' }] },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('sets priorityCategory directly, bypasses the ladder, audits the super_admin, and serializes it', async () => {
    const app = await makeApp();
    const { id, serial } = await makeTarget('set');
    const res = await app.inject({
      method: 'POST', url, headers: auth(superAdminToken),
      payload: { categories: [{ serialNumber: serial, priorityCategory: 'A' }] },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as CatResp).results[0]).toMatchObject({ serialNumber: serial, status: 'updated', cadreId: id, priorityCategory: 'A' });

    const row = await prisma.cadre.findUniqueOrThrow({ where: { id } });
    expect(row.priorityCategory).toBe('A');
    expect(await prisma.cadreChangeRequest.count({ where: { cadreId: id } })).toBe(0);

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'cadre', entityId: String(id), action: 'cadre.category_backfill' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorId).toBe(superAdminId);

    // The grade is on the wire, uppercase (the deliberate ADR-046 deviation).
    const get = await app.inject({ method: 'GET', url: `/api/v1/cadres/${id}`, headers: auth(superAdminToken) });
    expect((get.json() as { priorityCategory?: string }).priorityCategory).toBe('A');
    await app.close();
  });

  it('skips a cadre that already has a grade — a re-run cannot overwrite it', async () => {
    const app = await makeApp();
    const { id, serial } = await makeTarget('already', 'A');
    const res = await app.inject({
      method: 'POST', url, headers: auth(superAdminToken),
      payload: { categories: [{ serialNumber: serial, priorityCategory: 'B' }] },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as CatResp).results[0]).toMatchObject({ serialNumber: serial, status: 'skipped_has_category', cadreId: id, priorityCategory: 'A' });
    expect((await prisma.cadre.findUniqueOrThrow({ where: { id } })).priorityCategory).toBe('A');
    expect(await prisma.auditLog.count({ where: { entityType: 'cadre', entityId: String(id), action: 'cadre.category_backfill' } })).toBe(0);
    await app.close();
  });

  it('reports an unmatched serial as not_found without failing the batch', async () => {
    const app = await makeApp();
    const { serial } = await makeTarget('mixed');
    const res = await app.inject({
      method: 'POST', url, headers: auth(superAdminToken),
      payload: {
        categories: [
          { serialNumber: `${CAT_TOKEN}-NOSUCH`, priorityCategory: 'C' },
          { serialNumber: serial, priorityCategory: 'C' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const results = (res.json() as CatResp).results;
    expect(results[0]).toMatchObject({ status: 'not_found' });
    expect(results[0]!.cadreId).toBeUndefined();
    expect(results[1]).toMatchObject({ serialNumber: serial, status: 'updated', priorityCategory: 'C' });
    await app.close();
  });
});

// ── Per-category recency (ADR-046) ────────────────────────────────────────────
// The recency tiers scale by each cadre's OWN cadence: a grade-A cadre 35 days dark is
// overdue1m, but a grade-C cadre at the same 35 days is still current. jail/death never
// alarm — they are current regardless of how long dark.
describe('cadres per-category recency (ADR-046)', () => {
  const REC_TOKEN = 'RECCATFIXTURE';
  const created: number[] = [];

  const makeGraded = async (suffix: string, grade: 'A' | 'B' | 'C' | 'jail' | 'death', daysDark: number): Promise<number> => {
    const c = await prisma.cadre.create({
      data: {
        name: `${REC_TOKEN} ${suffix}`, phone: '+910000000701', thana: 'बीजापुर',
        currentAddress: 'Rec fixture', designation: 'Fixture', category: 'surrendered',
        alertLevel: 'normal', aliases: [], priorityCategory: grade,
      },
    });
    created.push(c.id);
    await prisma.report.create({
      data: {
        cadreId: c.id, reportedById: officerAId, reportingPlace: 'thana', specificLocation: 'x',
        personStatus: 'alive', currentPhone: '+910', currentActivity: 'y',
        reportedAt: new Date(Date.now() - daysDark * 24 * 60 * 60 * 1000),
      },
    });
    return c.id;
  };

  afterAll(async () => {
    await prisma.report.deleteMany({ where: { cadreId: { in: created } } });
    await prisma.cadre.deleteMany({ where: { id: { in: created } } });
  });

  const inTier = async (app: FastifyInstance, id: number, tier: string): Promise<boolean> => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cadres?search=${encodeURIComponent(REC_TOKEN)}&recency=${tier}&pageSize=50`,
      headers: auth(superAdminToken),
    });
    return (res.json() as ListBody).data.some((r) => r.id === id);
  };

  it('a grade-A cadre 35 days dark is overdue1m, but a grade-C cadre at 35 days is still current', async () => {
    const app = await makeApp();
    const aId = await makeGraded('A35', 'A', 35);
    const cId = await makeGraded('C35', 'C', 35);
    expect(await inTier(app, aId, 'overdue1m')).toBe(true);
    expect(await inTier(app, aId, 'current')).toBe(false);
    expect(await inTier(app, cId, 'current')).toBe(true);
    expect(await inTier(app, cId, 'overdue1m')).toBe(false);
    await app.close();
  });

  it('a jail cadre is always current, however long dark', async () => {
    const app = await makeApp();
    const jId = await makeGraded('JAIL', 'jail', 400);
    expect(await inTier(app, jId, 'current')).toBe(true);
    expect(await inTier(app, jId, 'overdue3m')).toBe(false);
    await app.close();
  });
});
