import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';

const prisma = new PrismaClient();
const config = testConfig();
const PHONES = ['+919000000010', '+919000000011', '+919000000012'];
// Unique, searchable name prefixes for this file's own fixtures — see beforeAll.
const PAGE_TOKEN = 'PGNFIXTURE';
const ORIGIN_TOKEN = 'ORGFIXTURE';
const ALERT_TOKEN = 'ALTFIXTURE';
const FACET_TOKEN = 'FCTFIXTURE';
const DUE_NAME = 'TEST CADRE DUE';
// A cadre reporting on this date is next due 30 days later (ADR-022).
const DUE_REPORT_AT = new Date('2026-06-01T00:00:00.000Z');
const DUE_EXPECTED = new Date('2026-07-01T00:00:00.000Z').toISOString();

let adminId = 0;
let officerAId = 0;
let officerBId = 0;
let cadreId = 0;
let dueCadreId = 0;
let adminToken = '';
let officerToken = '';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const makeApp = (): Promise<FastifyInstance> => buildApp({ config, prisma, logger: false });

beforeAll(async () => {
  const admin = await prisma.user.upsert({
    where: { phone: PHONES[0] }, update: { deletedAt: null, role: 'admin', name: 'Test Admin' },
    create: { phone: PHONES[0]!, name: 'Test Admin', role: 'admin' },
  });
  const officerA = await prisma.user.upsert({
    where: { phone: PHONES[1] }, update: { deletedAt: null, role: 'officer', name: 'Test Officer A' },
    create: { phone: PHONES[1]!, name: 'Test Officer A', role: 'officer' },
  });
  const officerB = await prisma.user.upsert({
    where: { phone: PHONES[2] }, update: { deletedAt: null, role: 'officer', name: 'Test Officer B' },
    create: { phone: PHONES[2]!, name: 'Test Officer B', role: 'officer' },
  });
  adminId = admin.id;
  officerAId = officerA.id;
  officerBId = officerB.id;

  await prisma.cadre.deleteMany({ where: { name: 'TEST CADRE ALPHA' } });
  const cadre = await prisma.cadre.create({
    data: {
      name: 'TEST CADRE ALPHA', phone: '+910000000000', thana: 'बीजापुर सदर',
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
    const res = await app.inject({ method: 'GET', url: '/api/v1/cadres?pageSize=50', headers: auth(officerToken) });
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
    const res = await app.inject({ method: 'GET', url: '/api/v1/cadres?category=surrendered&pageSize=50', headers: auth(officerToken) });
    const body = res.json() as ListBody;
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((c) => c.category === 'surrendered')).toBe(true);
    await app.close();
  });

  it('paginates (pageSize=2) over its own fixture, not the whole table', async () => {
    const app = await makeApp();

    // Scoped by `search` to this file's 3 fixture rows. Asserting against the
    // global cadre count would make this test depend on the seed (absent in CI)
    // and on whatever other parallel test files have created or deleted.
    const p1 = await app.inject({
      method: 'GET', url: `/api/v1/cadres?search=${PAGE_TOKEN}&pageSize=2`, headers: auth(officerToken),
    });
    const first = p1.json() as ListBody;
    expect(first.total).toBe(3);
    expect(first.data.length).toBe(2);
    expect(first.hasMore).toBe(true);

    const p2 = await app.inject({
      method: 'GET', url: `/api/v1/cadres?search=${PAGE_TOKEN}&pageSize=2&page=2`, headers: auth(officerToken),
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

    const d = (await app.inject({ method: 'GET', url: q('district'), headers: auth(officerToken) })).json() as ListBody;
    const o = (await app.inject({ method: 'GET', url: q('other'), headers: auth(officerToken) })).json() as ListBody;

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
      headers: auth(officerToken),
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
      headers: auth(officerToken),
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
      headers: auth(officerToken),
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
      headers: auth(officerToken),
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
      headers: auth(officerToken),
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
    const res = await app.inject({ method: 'GET', url, headers: auth(officerToken) });
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
      headers: auth(officerToken),
    });
    const body = res.json() as ListBody;
    expect(body.total).toBe(0); // -2 is in दंतेवाड़ा, so the AND is empty
    await app.close();
  });

  it('GET /cadres/facets returns distinct real values, and requires auth', async () => {
    const app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/v1/cadres/facets' })).statusCode).toBe(401);

    const res = await app.inject({
      method: 'GET', url: '/api/v1/cadres/facets', headers: auth(officerToken),
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
      method: 'GET', url: '/api/v1/cadres?alertLevel=urgent', headers: auth(officerToken),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects an unknown surrenderOrigin with 400', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/cadres?surrenderOrigin=bijapur', headers: auth(officerToken),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    await app.close();
  });

  it('rejects pageSize over the max (51) with 400', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/cadres?pageSize=51', headers: auth(officerToken) });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    await app.close();
  });

  it('GET /cadres/:id returns the cadre', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: cadreId, name: 'TEST CADRE ALPHA', category: 'surrendered' });
    await app.close();
  });

  it('serves dateOfBirth, derived age, and the relation names (ADR-036)', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerToken) });
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
      method: 'GET', url: `/api/v1/cadres?search=${ALERT_TOKEN}&pageSize=1`, headers: auth(officerToken),
    });
    const row = (res.json() as ListBody).data[0] as { dateOfBirth?: string; age?: number };
    expect(row.dateOfBirth).toBeUndefined();
    expect(row.age).toBeUndefined();
    await app.close();
  });

  it('nextReportingDueAt = latest report date + 30 days (ADR-022)', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${dueCadreId}`, headers: auth(officerToken) });
    expect(res.statusCode).toBe(200);
    // Computed from the NEWER report (DUE_REPORT_AT), not the April one.
    expect((res.json() as { nextReportingDueAt?: string }).nextReportingDueAt).toBe(DUE_EXPECTED);
    await app.close();
  });

  it('a cadre with no reports has no nextReportingDueAt (no baseline)', async () => {
    const app = await makeApp();
    // The ALPHA fixture cadre has no reports.
    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerToken) });
    expect(res.json()).not.toHaveProperty('nextReportingDueAt');
    await app.close();
  });

  it('lastReportedAt is the latest report date itself, the baseline the due date derives from (ADR-023)', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${dueCadreId}`, headers: auth(officerToken) });
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
    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerToken) });
    expect(res.json()).not.toHaveProperty('lastReportedAt');
    await app.close();
  });

  it('serialNumber is absent when unset, and never falls back to id (ADR-025)', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}`, headers: auth(officerToken) });
    expect(res.statusCode).toBe(200);
    // The fixture has no serial. It must be omitted — NOT filled in from `id`,
    // which is an unrelated surrogate key the import will reassign.
    expect(res.json()).not.toHaveProperty('serialNumber');
    await app.close();
  });

  it('serialNumber is serialized when set (ADR-025)', async () => {
    const app = await makeApp();
    await prisma.cadre.update({ where: { id: dueCadreId }, data: { serialNumber: 'BJP/2024/0731' } });
    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${dueCadreId}`, headers: auth(officerToken) });
    expect((res.json() as { serialNumber?: string }).serialNumber).toBe('BJP/2024/0731');
    await prisma.cadre.update({ where: { id: dueCadreId }, data: { serialNumber: null } });
    await app.close();
  });

  it('nextReportingDueAt is present in the list too, not only the detail', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/cadres?search=${encodeURIComponent(DUE_NAME)}&pageSize=50`, headers: auth(officerToken),
    });
    const body = res.json() as ListBody;
    const due = body.data.find((c) => c.id === dueCadreId);
    expect(due).toHaveProperty('nextReportingDueAt', DUE_EXPECTED);
    await app.close();
  });

  it('GET /cadres/:id → 404 for unknown id', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/cadres/99999999', headers: auth(officerToken) });
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
