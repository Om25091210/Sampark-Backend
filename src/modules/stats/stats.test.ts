import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';
import type {
  CadreProfileStats,
  HierarchyStats,
  OfficerStats,
  RecencyByThanaStats,
  ReportsDailyStats,
  SurrendersStats,
} from './stats.schema.js';

const prisma = new PrismaClient();
const config = testConfig();
// Unique to this file. Test files run in parallel against one DB and delete their
// own fixtures by phone in afterAll — a shared number would let one file delete a
// user another still references (an FK failure on the other's report.create).
// In use elsewhere: 10-12 cadres, 30-31 reports, 40-42 reports-media, 50-53 officers.
// ADR-030: two users now — the endpoint is admin+, and the officer exists to prove
// it is refused rather than merely hidden in the UI.
const PHONE = '+919000000060';
const ADMIN_PHONE = '+919000000061';
const HQ_PHONE = '+919000000062';
const TOKEN = 'STATFIXTURE';

// ADR-055. A SECOND admin/officer pair, posted to a REAL sub-division/thana (unlike
// the fixtures above, whose thana 'स्टैट' and subDivision-less admin are deliberately
// outside the jurisdiction table) — /stats/hierarchy's officer→sub-division bucketing
// only exercises real code paths when the thana actually resolves to one of the 9.
// 'गंगालूर' is a single-thana sub-division, so this admin's scope is exactly one thana.
const SDOP_ADMIN_PHONE = '+919000000063';
const SDOP_OFFICER_PHONE = '+919000000064';
const SDOP_SUB_DIVISION = 'गंगालूर';
const SDOP_THANA = 'गंगालूर';

// ADR-060. Fake, file-unique thana names (never a real canonical one, so scope
// resolution/sub-division bucketing never touches them) so "is this the sole
// officer at this thana" is deterministic under Vitest's parallel test files —
// a real thana like 'गंगालूर' can pick up an officer fixture from ANOTHER file
// (users.test.ts does exactly that) and make a sole-officer assertion flaky.
const SOLE_THANA = 'स्टैट-एकल';
const SOLE_OFFICER_PHONE = '+919000000065';
const MULTI_THANA = 'स्टैट-बहु';
const MULTI_OFFICER_A_PHONE = '+919000000066';
const MULTI_OFFICER_B_PHONE = '+919000000067';

let officerId = 0;
let officerToken = '';
let adminId = 0;
let adminToken = '';
let hqToken = '';
let sdopAdminId = 0;
let sdopAdminName = '';
let sdopAdminToken = '';
let sdopOfficerId = 0;
let sdopOfficerName = '';
let soleOfficerId = 0;
let soleOfficerToken = '';
let multiOfficerAId = 0;
let multiOfficerAToken = '';
let multiOfficerBToken = '';
const cadreIds: number[] = [];
const sdopCadreIds: number[] = [];
const attributionCadreIds: number[] = [];

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const makeApp = (): Promise<FastifyInstance> => buildApp({ config, prisma, logger: false });

const DAY_MS = 24 * 60 * 60 * 1000;

interface Stats {
  totalCadres: number;
  activeAlerts: number;
  reportsThisWeek: number;
  pendingReporting: number;
  reportingRecency: { current: number; overdue1m: number; overdue2m: number; overdue3m: number };
  byCategory: {
    surrendered: { district: number; other: number; otherDistrict: number; otherState: number; total: number };
    thana: number;
    jail: number;
  };
  alertLevelBreakdown: { normal: number; warning: number; critical: number };
}

beforeAll(async () => {
  const officer = await prisma.user.upsert({
    // ADR-044: posted to the fixture cadres' station.
    where: { phone: PHONE },
    update: { deletedAt: null, role: 'officer', name: 'Stats Officer', thana: 'स्टैट' },
    create: { phone: PHONE, name: 'Stats Officer', role: 'officer', thana: 'स्टैट' },
  });
  officerId = officer.id;
  officerToken = await signAccessToken({ sub: officerId, role: 'officer' }, config.jwtSecret, '15m');

  const admin = await prisma.user.upsert({
    where: { phone: ADMIN_PHONE }, update: { deletedAt: null, role: 'admin', name: 'Stats Admin' },
    create: { phone: ADMIN_PHONE, name: 'Stats Admin', role: 'admin' },
  });
  adminId = admin.id;
  adminToken = await signAccessToken({ sub: adminId, role: 'admin' }, config.jwtSecret, '15m');

  // ADR-044. The dashboard assertions below are written against WHOLE-TABLE counts, which
  // is an HQ view by definition — an SDOP's dashboard is deliberately their sub-division
  // only. So the org-dashboard reads use a super_admin; the admin token stays for the
  // role-gating assertions (officer -> 403), which is what it was really there to prove.
  const hqId = (
    await prisma.user.upsert({
      where: { phone: HQ_PHONE },
      update: { deletedAt: null, role: 'super_admin', name: 'Stats HQ' },
      create: { phone: HQ_PHONE, name: 'Stats HQ', role: 'super_admin' },
    })
  ).id;
  hqToken = await signAccessToken({ sub: hqId, role: 'super_admin' }, config.jwtSecret, '15m');

  // ADR-055 fixtures — a real SDOP/officer pair so the hierarchy endpoint's scope
  // resolution and sub-division bucketing exercise their actual code paths.
  const sdopAdmin = await prisma.user.upsert({
    where: { phone: SDOP_ADMIN_PHONE },
    update: { deletedAt: null, role: 'admin', name: 'Hierarchy SDOP', subDivision: SDOP_SUB_DIVISION },
    create: { phone: SDOP_ADMIN_PHONE, name: 'Hierarchy SDOP', role: 'admin', subDivision: SDOP_SUB_DIVISION },
  });
  sdopAdminId = sdopAdmin.id;
  sdopAdminName = sdopAdmin.name;
  sdopAdminToken = await signAccessToken({ sub: sdopAdminId, role: 'admin' }, config.jwtSecret, '15m');

  const sdopOfficer = await prisma.user.upsert({
    where: { phone: SDOP_OFFICER_PHONE },
    update: { deletedAt: null, role: 'officer', name: 'Hierarchy Officer', thana: SDOP_THANA },
    create: { phone: SDOP_OFFICER_PHONE, name: 'Hierarchy Officer', role: 'officer', thana: SDOP_THANA },
  });
  sdopOfficerId = sdopOfficer.id;
  sdopOfficerName = sdopOfficer.name;

  await prisma.cadre.deleteMany({ where: { name: { startsWith: TOKEN } } });

  const base = {
    phone: '+910000000300', thana: 'स्टैट', currentAddress: 'Stats fixture',
    designation: 'Fixture', aliases: [] as string[],
    // ADR-031: assigned to this file's officer so /stats/me has something that is
    // genuinely THEIRS to count. Harmless to the dashboard assertions — those count
    // the whole table regardless of assignment.
    assignedOfficerId: officerId,
  };

  // A distinctive sub-population so the endpoint's fields can be shown to reflect
  // real queries rather than hardcoded numbers. The dashboard stats count the WHOLE
  // table (they cannot be scoped by search), and Vitest runs files in parallel
  // against one database — so, per ADR-018, exact global counts are NOT asserted.
  // What IS asserted: the partition/subset math (exact, true regardless of other
  // rows) and that each fixture row moves its field (robust lower bounds).
  const cAlert = await prisma.cadre.create({
    data: { ...base, name: `${TOKEN}-ALERT`, category: 'surrendered', surrenderOrigin: 'district', alertLevel: 'critical' },
  }); // district +1, activeAlerts +1, never-reported -> pending +1
  const cOther = await prisma.cadre.create({
    data: {
      ...base, name: `${TOKEN}-OTHER`, category: 'surrendered',
      surrenderOrigin: 'other', otherOriginType: 'other_state', alertLevel: 'normal',
    },
  }); // other +1, otherState +1, gets a fresh report -> NOT pending, reportsThisWeek +1
  const cThana = await prisma.cadre.create({
    data: { ...base, name: `${TOKEN}-THANA`, category: 'thana', alertLevel: 'normal' },
  }); // thana +1, only a stale (40d) report -> pending +1, NOT in reportsThisWeek
  cadreIds.push(cAlert.id, cOther.id, cThana.id);

  await prisma.report.create({
    data: {
      cadreId: cOther.id, reportedById: officerId, reportingPlace: 'thana',
      specificLocation: 'x', personStatus: 'alive', currentPhone: '+910', currentActivity: 'y',
      reportedAt: new Date(Date.now() - 2 * DAY_MS), // within the 7-day and 30-day windows
    },
  });
  await prisma.report.create({
    data: {
      cadreId: cThana.id, reportedById: officerId, reportingPlace: 'thana',
      specificLocation: 'x', personStatus: 'alive', currentPhone: '+910', currentActivity: 'y',
      reportedAt: new Date(Date.now() - 40 * DAY_MS), // older than 30 days -> still pending
    },
  });

  // ADR-055. Two cadres assigned to the SDOP's officer: one current, one overdue —
  // so /stats/hierarchy's officer row and rollup have known, exact numbers.
  const sdopBase = {
    phone: '+910000000301', thana: SDOP_THANA, currentAddress: 'Hierarchy fixture',
    designation: 'Fixture', aliases: [] as string[], assignedOfficerId: sdopOfficerId,
  };
  const sCurrent = await prisma.cadre.create({
    data: { ...sdopBase, name: `${TOKEN}-SDOP-CURRENT`, category: 'thana', alertLevel: 'normal' },
  });
  const sOverdue = await prisma.cadre.create({
    data: { ...sdopBase, name: `${TOKEN}-SDOP-OVERDUE`, category: 'thana', alertLevel: 'normal' },
  });
  sdopCadreIds.push(sCurrent.id, sOverdue.id);
  await prisma.report.create({
    data: {
      cadreId: sCurrent.id, reportedById: sdopOfficerId, reportingPlace: 'thana',
      specificLocation: 'x', personStatus: 'alive', currentPhone: '+910', currentActivity: 'y',
      reportedAt: new Date(Date.now() - 2 * DAY_MS), // within 30 days -> current
    },
  });
  // sOverdue gets no report at all -> never-reported, counts as overdue.

  // ADR-060 fixtures — thana jurisdiction and explicit assignment working
  // together, not either/or.
  const soleOfficer = await prisma.user.upsert({
    where: { phone: SOLE_OFFICER_PHONE },
    update: { deletedAt: null, role: 'officer', name: 'Sole Officer', thana: SOLE_THANA },
    create: { phone: SOLE_OFFICER_PHONE, name: 'Sole Officer', role: 'officer', thana: SOLE_THANA },
  });
  soleOfficerId = soleOfficer.id;
  soleOfficerToken = await signAccessToken({ sub: soleOfficerId, role: 'officer' }, config.jwtSecret, '15m');

  const multiOfficerA = await prisma.user.upsert({
    where: { phone: MULTI_OFFICER_A_PHONE },
    update: { deletedAt: null, role: 'officer', name: 'Multi Officer A', thana: MULTI_THANA },
    create: { phone: MULTI_OFFICER_A_PHONE, name: 'Multi Officer A', role: 'officer', thana: MULTI_THANA },
  });
  multiOfficerAId = multiOfficerA.id;
  multiOfficerAToken = await signAccessToken({ sub: multiOfficerAId, role: 'officer' }, config.jwtSecret, '15m');

  const multiOfficerB = await prisma.user.upsert({
    where: { phone: MULTI_OFFICER_B_PHONE },
    update: { deletedAt: null, role: 'officer', name: 'Multi Officer B', thana: MULTI_THANA },
    create: { phone: MULTI_OFFICER_B_PHONE, name: 'Multi Officer B', role: 'officer', thana: MULTI_THANA },
  });
  multiOfficerBToken = await signAccessToken({ sub: multiOfficerB.id, role: 'officer' }, config.jwtSecret, '15m');

  await prisma.cadre.deleteMany({ where: { name: { startsWith: `${TOKEN}-ATTR` } } });

  const attrBase = { phone: '+910000000302', currentAddress: 'Attribution fixture', designation: 'Fixture', aliases: [] as string[] };

  // No explicit assignment, but Sole Officer is the ONLY officer at SOLE_THANA
  // -> must fall to them by thana jurisdiction.
  const soleUnassigned = await prisma.cadre.create({
    data: { ...attrBase, name: `${TOKEN}-ATTR-SOLE-UNASSIGNED`, thana: SOLE_THANA, category: 'thana', alertLevel: 'normal' },
  });
  // No explicit assignment, and MULTI_THANA has TWO officers -> ambiguous,
  // must NOT be credited to either one.
  const multiUnassigned = await prisma.cadre.create({
    data: { ...attrBase, name: `${TOKEN}-ATTR-MULTI-UNASSIGNED`, thana: MULTI_THANA, category: 'thana', alertLevel: 'normal' },
  });
  // Explicitly assigned to Multi Officer A -- proves explicit assignment is
  // still respected per-officer even when they share a thana with another
  // officer (who must NOT also see it, whether via explicit match or fallback).
  const multiAssignedToA = await prisma.cadre.create({
    data: { ...attrBase, name: `${TOKEN}-ATTR-MULTI-ASSIGNED-A`, thana: MULTI_THANA, category: 'thana', alertLevel: 'normal', assignedOfficerId: multiOfficerAId },
  });
  attributionCadreIds.push(soleUnassigned.id, multiUnassigned.id, multiAssignedToA.id);
});

afterAll(async () => {
  await prisma.report.deleteMany({ where: { cadreId: { in: [...cadreIds, ...sdopCadreIds] } } });
  await prisma.cadre.deleteMany({ where: { name: { startsWith: TOKEN } } });
  // All fixture users — leaving one behind would let it drift into another file's
  // assertions (Sampark-Backend#3).
  const phones = [
    PHONE, ADMIN_PHONE, HQ_PHONE, SDOP_ADMIN_PHONE, SDOP_OFFICER_PHONE,
    SOLE_OFFICER_PHONE, MULTI_OFFICER_A_PHONE, MULTI_OFFICER_B_PHONE,
  ];
  await prisma.notification.deleteMany({ where: { user: { phone: { in: phones } } } });
  await prisma.user.deleteMany({ where: { phone: { in: phones } } });
  await prisma.$disconnect();
});

describe('stats', () => {
  it('GET /stats/dashboard without a token → 401', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/stats/dashboard' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  // ADR-030 revised (this task, item 4). An officer is now ALLOWED — the leak
  // ADR-030 closed was an UNSCOPED read of the whole force; ADR-044 scoping since
  // makes this call return only the officer's own thana, no wider than what
  // `GET /cadres` already hands them. Asserted EXACTLY (not a lower bound): thana
  // 'स्टैट' is this file's own fixture station, so nothing outside this file's
  // setup can land in the officer's scoped count.
  it('an officer is allowed, and the numbers are scoped to their own thana only', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/stats/dashboard', headers: auth(officerToken),
    });
    expect(res.statusCode).toBe(200);
    const s = res.json() as Stats;
    expect(s.totalCadres).toBe(3); // exactly this file's three थाना-'स्टैट' fixtures
    expect(s.byCategory.surrendered.total).toBe(2);
    expect(s.byCategory.thana).toBe(1);
    await app.close();
  });

  // ── /stats/me (ADR-031) ────────────────────────────────────────────────────

  it('GET /stats/me is the caller’s own — an officer is allowed, and the numbers are exact', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/stats/me', headers: auth(officerToken) });
    expect(res.statusCode).toBe(200);
    const s = res.json() as OfficerStats;

    // Unlike the org dashboard (whose totals move as other test files write), these
    // are EXACT: nothing outside this file can be assigned to this officer.
    expect(s.assignedCadres).toBe(3);
    // ALERT never reported + THANA last reported 40d ago; OTHER reported 2d ago.
    expect(s.overdueCadres).toBe(2);
    expect(s.currentCadres).toBe(1);
    expect(s.totalReports).toBe(2);
    expect(s.reportsByPlace).toEqual({ thana: 2, village: 0 });
    expect(s.cadresByCategory).toEqual({ surrendered: 2, jail: 0, thana: 1 });
    // The three categories partition the officer's assigned cadres.
    expect(s.cadresByCategory.surrendered + s.cadresByCategory.jail + s.cadresByCategory.thana)
      .toBe(s.assignedCadres);
    await app.close();
  });

  it('/stats/me is scoped to the caller, not the whole force', async () => {
    const app = await makeApp();
    // The admin owns no cadres and has filed no reports.
    const res = await app.inject({ method: 'GET', url: '/api/v1/stats/me', headers: auth(adminToken) });
    const s = res.json() as OfficerStats;
    expect(s.assignedCadres).toBe(0);
    expect(s.totalReports).toBe(0);
    // 0 assigned → 0%, NOT 100%. An officer with nothing has not completed
    // everything; claiming 100 would be the most flattering possible lie.
    expect(s.reportingCompletion).toBe(0);
    await app.close();
  });

  it('reportingCompletion is current/assigned as a percentage', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/stats/me', headers: auth(officerToken) });
    const s = res.json() as OfficerStats;
    // 1 of 3 cadres current → 33%. Asserted as a literal, not recomputed from the
    // response: deriving the expectation from the same numbers under test would pass
    // even if the endpoint returned nonsense consistently.
    expect(s.reportingCompletion).toBe(33);
    await app.close();
  });

  // ── ADR-060: thana jurisdiction + explicit assignment work together ────────

  it('a cadre with no explicit assignment falls to the sole officer at its thana', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/stats/me', headers: auth(soleOfficerToken) });
    expect(res.statusCode).toBe(200);
    const s = res.json() as OfficerStats;
    // Sole Officer is the ONLY officer at SOLE_THANA (file-unique, so nothing
    // outside this file's setup can share it) and has exactly one unassigned
    // cadre there -- exact.
    expect(s.assignedCadres).toBe(1);
    await app.close();
  });

  it('a thana with more than one officer does not fall back to either of them, but explicit assignment still works there', async () => {
    const app = await makeApp();
    const [resA, resB] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/v1/stats/me', headers: auth(multiOfficerAToken) }),
      app.inject({ method: 'GET', url: '/api/v1/stats/me', headers: auth(multiOfficerBToken) }),
    ]);
    const sA = resA.json() as OfficerStats;
    const sB = resB.json() as OfficerStats;
    // MULTI_THANA (file-unique) has two officers and two cadres: one explicitly
    // assigned to A, one assigned to neither. A gets exactly the one that is
    // actually theirs (explicit assignment is unaffected by ADR-060) -- NOT
    // both, since thana-match alone cannot resolve the second one for a shared
    // station. B, with no explicit assignment at all, gets neither: thana-match
    // is ambiguous here (two officers), so it never falls back for B either.
    expect(sA.assignedCadres).toBe(1);
    expect(sB.assignedCadres).toBe(0);
    await app.close();
  });

  it('monthlyActivity always returns 6 IST months, oldest first, gaps filled with 0', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/stats/me', headers: auth(officerToken) });
    const s = res.json() as OfficerStats;
    expect(s.monthlyActivity).toHaveLength(6);
    // Every slot present and typed — a chart must never have to invent a gap.
    for (const m of s.monthlyActivity) {
      expect(m.month).toMatch(/^\d{4}-\d{2}$/);
      expect(Number.isInteger(m.reports)).toBe(true);
    }
    // Strictly ascending, and the last is the current IST month.
    const keys = s.monthlyActivity.map((m) => m.month);
    expect([...keys].sort()).toEqual(keys);
    const nowIst = new Date(Date.now() + 330 * 60 * 1000);
    const thisMonth = `${nowIst.getUTCFullYear()}-${String(nowIst.getUTCMonth() + 1).padStart(2, '0')}`;
    expect(keys[keys.length - 1]).toBe(thisMonth);
    await app.close();
  });

  it('a report filed just after IST midnight counts in the IST month, not the UTC one', async () => {
    const app = await makeApp();
    const monthOf = (s: OfficerStats, k: string): number =>
      s.monthlyActivity.find((m) => m.month === k)?.reports ?? 0;
    const fetch = async (): Promise<OfficerStats> =>
      (await app.inject({ method: 'GET', url: '/api/v1/stats/me', headers: auth(officerToken) }))
        .json() as OfficerStats;

    const before = await fetch();
    // Only meaningful while both months sit inside the rolling 6-month window.
    if (!before.monthlyActivity.some((m) => m.month === '2026-07')) {
      await app.close();
      return;
    }
    const juneBefore = monthOf(before, '2026-06');
    const julyBefore = monthOf(before, '2026-07');

    // 2026-06-30T19:00:00Z IS 2026-07-01 00:30 IST. Bucketing on the UTC month files
    // it under June — the officer who wrote it at half past midnight on the 1st would
    // find July empty. Same class of bug as the report-log filter (ADR-024), and a
    // naive `date_trunc('month', reported_at)` fails exactly here.
    const boundary = await prisma.report.create({
      data: {
        cadreId: cadreIds[0]!, reportedById: officerId, reportingPlace: 'thana',
        specificLocation: 'सीमा', personStatus: 'alive', currentPhone: '+910',
        currentActivity: 'boundary', reportedAt: new Date('2026-06-30T19:00:00.000Z'),
      },
    });
    try {
      const after = await fetch();
      // July gained it; June did not move.
      expect(monthOf(after, '2026-07')).toBe(julyBefore + 1);
      expect(monthOf(after, '2026-06')).toBe(juneBefore);
    } finally {
      await prisma.report.delete({ where: { id: boundary.id } });
      await app.close();
    }
  });

  it('returns the full shape with integer counts', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/stats/dashboard', headers: auth(hqToken) });
    expect(res.statusCode).toBe(200);
    const s = res.json() as Stats;
    for (const n of [s.totalCadres, s.activeAlerts, s.reportsThisWeek, s.pendingReporting,
      s.byCategory.surrendered.district, s.byCategory.surrendered.other,
      s.byCategory.surrendered.otherDistrict, s.byCategory.surrendered.otherState,
      s.byCategory.surrendered.total, s.byCategory.thana, s.byCategory.jail]) {
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }
    await app.close();
  });

  it('the three categories partition the total, and origin is a subset of surrendered', async () => {
    // Exact invariants — true no matter what other test files have in the table.
    const app = await makeApp();
    const s = (await app.inject({ method: 'GET', url: '/api/v1/stats/dashboard', headers: auth(hqToken) })).json() as Stats;
    // जेल/जमानत is its own register: it has a count of its own (the 4th home card) but is
    // NOT part of the caller-wide total.
    expect(s.totalCadres).toBe(s.byCategory.surrendered.total + s.byCategory.thana);
    // district + other ≤ total: a surrendered cadre may have a NULL origin (ADR-019),
    // so the two tiles need not sum to the surrendered total.
    expect(s.byCategory.surrendered.district + s.byCategory.surrendered.other)
      .toBeLessThanOrEqual(s.byCategory.surrendered.total);
    // This task: otherDistrict + otherState ≤ other — a cadre with surrenderOrigin='other'
    // may still have a NULL otherOriginType (not yet classified), same rule one level down.
    expect(s.byCategory.surrendered.otherDistrict + s.byCategory.surrendered.otherState)
      .toBeLessThanOrEqual(s.byCategory.surrendered.other);
    await app.close();
  });

  it('each fixture row is reflected in its field (counts are live, not hardcoded)', async () => {
    const app = await makeApp();
    const s = (await app.inject({ method: 'GET', url: '/api/v1/stats/dashboard', headers: auth(hqToken) })).json() as Stats;
    // Lower bounds: my fixture contributes at least this much; parallel data only adds.
    expect(s.byCategory.surrendered.district).toBeGreaterThanOrEqual(1);
    expect(s.byCategory.surrendered.other).toBeGreaterThanOrEqual(1);
    expect(s.byCategory.surrendered.otherState).toBeGreaterThanOrEqual(1);
    expect(s.byCategory.thana).toBeGreaterThanOrEqual(1);
    expect(s.activeAlerts).toBeGreaterThanOrEqual(1);
    expect(s.reportsThisWeek).toBeGreaterThanOrEqual(1); // the 2-day-old report
    expect(s.pendingReporting).toBeGreaterThanOrEqual(2); // never-reported + 40-day-stale
    expect(s.totalCadres).toBeGreaterThanOrEqual(3);
    await app.close();
  });

  // ── ADR-041: reporting-recency tiers ────────────────────────────────────────

  it('reportingRecency partitions the total — four disjoint tiers sum to totalCadres', async () => {
    const app = await makeApp();
    const s = (await app.inject({ method: 'GET', url: '/api/v1/stats/dashboard', headers: auth(hqToken) })).json() as Stats;
    const r = s.reportingRecency;
    for (const n of [r.current, r.overdue1m, r.overdue2m, r.overdue3m]) {
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }
    // Exact invariant regardless of other files' rows: every live cadre is in exactly one tier.
    expect(r.current + r.overdue1m + r.overdue2m + r.overdue3m).toBe(s.totalCadres);
    await app.close();
  });

  it('each recency tier reflects its fixture (2-day → सामान्य, 40-day → सतर्क, never → उच्च जोखिम)', async () => {
    const app = await makeApp();
    const s = (await app.inject({ method: 'GET', url: '/api/v1/stats/dashboard', headers: auth(hqToken) })).json() as Stats;
    expect(s.reportingRecency.current).toBeGreaterThanOrEqual(1);   // OTHER, 2 days ago
    expect(s.reportingRecency.overdue1m).toBeGreaterThanOrEqual(1); // THANA, 40 days ago
    expect(s.reportingRecency.overdue3m).toBeGreaterThanOrEqual(1); // ALERT, never
    await app.close();
  });

  // ── alertLevelBreakdown (this task, item 1) ─────────────────────────────────

  it('alertLevelBreakdown is three integer percentages that sum to exactly 100', async () => {
    const app = await makeApp();
    const s = (await app.inject({ method: 'GET', url: '/api/v1/stats/dashboard', headers: auth(hqToken) })).json() as Stats;
    const b = s.alertLevelBreakdown;
    for (const n of [b.normal, b.warning, b.critical]) {
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }
    // Exact regardless of other files' rows — every live cadre is in exactly one
    // AlertLevel, so their percentage shares always sum to the whole (largest-
    // remainder rounding, never left short or over by a point).
    expect(b.normal + b.warning + b.critical).toBe(100);
    await app.close();
  });

  it('this fixture\'s one critical cadre moves the critical share above zero', async () => {
    const app = await makeApp();
    const s = (await app.inject({ method: 'GET', url: '/api/v1/stats/dashboard', headers: auth(hqToken) })).json() as Stats;
    expect(s.alertLevelBreakdown.critical).toBeGreaterThanOrEqual(1);
    await app.close();
  });

  // ── ?category scoping (this task) ───────────────────────────────────────────
  // The mobile category-section screens (cadres/[category].tsx) show the same
  // reportingRecency summary bar the home dashboard shows for "सभी कैडर", but
  // scoped to one tile — these assert the WHOLE snapshot narrows, not just one field.

  it('?category=surrendered zeroes the other two categories, and totalCadres shrinks to match', async () => {
    const app = await makeApp();
    const s = (
      await app.inject({ method: 'GET', url: '/api/v1/stats/dashboard?category=surrendered', headers: auth(hqToken) })
    ).json() as Stats;
    expect(s.byCategory.thana).toBe(0);
    expect(s.byCategory.jail).toBe(0);
    expect(s.totalCadres).toBe(s.byCategory.surrendered.total);
    expect(s.byCategory.surrendered.total).toBeGreaterThanOrEqual(2); // this file's ALERT + OTHER
    await app.close();
  });

  it('?category=surrendered&surrenderOrigin=district narrows to exactly that dashboard tile\'s rows', async () => {
    const app = await makeApp();
    const s = (
      await app.inject({
        method: 'GET',
        url: '/api/v1/stats/dashboard?category=surrendered&surrenderOrigin=district',
        headers: auth(hqToken),
      })
    ).json() as Stats;
    expect(s.byCategory.surrendered.other).toBe(0);
    expect(s.byCategory.thana).toBe(0);
    expect(s.byCategory.jail).toBe(0);
    expect(s.totalCadres).toBe(s.byCategory.surrendered.district);
    expect(s.byCategory.surrendered.district).toBeGreaterThanOrEqual(1); // this file's ALERT cadre
    await app.close();
  });

  it('reportingRecency still partitions the narrowed total under a category filter', async () => {
    const app = await makeApp();
    const s = (
      await app.inject({ method: 'GET', url: '/api/v1/stats/dashboard?category=thana', headers: auth(hqToken) })
    ).json() as Stats;
    const r = s.reportingRecency;
    expect(r.current + r.overdue1m + r.overdue2m + r.overdue3m).toBe(s.totalCadres);
    expect(s.byCategory.surrendered.total).toBe(0);
    expect(s.reportingRecency.overdue1m).toBeGreaterThanOrEqual(1); // THANA fixture, 40-day report
    await app.close();
  });

  it('an officer\'s category-scoped read is still bounded to their own thana (ADR-044 unchanged)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/stats/dashboard?category=thana', headers: auth(officerToken),
    });
    expect(res.statusCode).toBe(200);
    const s = res.json() as Stats;
    expect(s.byCategory.thana).toBeGreaterThanOrEqual(1); // this file's THANA fixture, at स्टैट
    await app.close();
  });

  it('category=all is the unscoped sentinel, same as omitting it — still partitions to totalCadres', async () => {
    // A single read (never two, per ADR-018 — parallel test files mutate the shared
    // table between requests): the invariant that matters is that the sentinel
    // does NOT narrow anything, which the partition equation already proves.
    const app = await makeApp();
    const s = (
      await app.inject({ method: 'GET', url: '/api/v1/stats/dashboard?category=all', headers: auth(hqToken) })
    ).json() as Stats;
    expect(s.totalCadres).toBe(s.byCategory.surrendered.total + s.byCategory.thana);
    expect(s.byCategory.thana).toBeGreaterThanOrEqual(1); // this file's THANA fixture still visible
    await app.close();
  });

  // ── जेल/जमानत is a separate register ─────────────────────────────────────────
  // Scoped to this file's officer (thana 'स्टैट') so the before/after is exact even
  // with other test files writing to the shared table.

  it('a jail cadre is counted on the jail card only — not in the total, tiers, or officer workload', async () => {
    const app = await makeApp();
    const jail = await prisma.cadre.create({
      data: {
        name: `${TOKEN}-JAIL`, phone: '+910000000302', thana: 'स्टैट', currentAddress: 'Stats fixture',
        designation: 'Fixture', aliases: [], category: 'jail', alertLevel: 'normal', assignedOfficerId: officerId,
      },
    });
    try {
      const dash = async (q = '') =>
        (await app.inject({ method: 'GET', url: `/api/v1/stats/dashboard${q}`, headers: auth(officerToken) })).json() as Stats;
      const all = await dash();
      expect(all.byCategory.jail).toBe(1);
      expect(all.totalCadres).toBe(all.byCategory.surrendered.total + all.byCategory.thana);
      const r = all.reportingRecency;
      expect(r.current + r.overdue1m + r.overdue2m + r.overdue3m).toBe(all.totalCadres);

      // The jail screen's own summary is the jail register.
      const jailOnly = await dash('?category=jail');
      expect(jailOnly.totalCadres).toBe(1);
      expect(jailOnly.byCategory.jail).toBe(1);
      expect(jailOnly.byCategory.surrendered.total + jailOnly.byCategory.thana).toBe(0);

      // A Maoist category screen never shows a jail count.
      expect((await dash('?category=thana')).byCategory.jail).toBe(0);

      const me = (await app.inject({ method: 'GET', url: '/api/v1/stats/me', headers: auth(officerToken) })).json() as OfficerStats;
      expect(me.cadresByCategory.jail).toBe(1);
      expect(me.assignedCadres).toBe(me.cadresByCategory.surrendered + me.cadresByCategory.thana);
    } finally {
      await prisma.cadre.delete({ where: { id: jail.id } });
      await app.close();
    }
  });

  // ── /stats/hierarchy (ADR-055) ──────────────────────────────────────────────

  it('GET /stats/hierarchy without a token → 401', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/stats/hierarchy' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('an officer is refused (403) — same admin+ gate as /stats/dashboard', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/stats/hierarchy', headers: auth(officerToken),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('an SDOP gets one row per officer in their own sub-division, with exact numbers', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/stats/hierarchy', headers: auth(sdopAdminToken),
    });
    expect(res.statusCode).toBe(200);
    // Narrowed at the type level (not just the runtime `expect` below) — `rows`'
    // element shape depends on `level`, and only the 'officers'/'admins' variants
    // carry `name`/`id`.
    const s = res.json() as Extract<HierarchyStats, { level: 'officers' }>;
    expect(s.level).toBe('officers');

    const row = s.rows.find((r) => r.name === sdopOfficerName);
    expect(row).toBeDefined();
    expect(row!.thana).toBe(SDOP_THANA);
    expect(row!.subDivision).toBeNull();
    // Exact: this officer's id is unique to this fixture, so nothing outside this
    // file's setup contributes to their two assigned cadres.
    expect(row!.assignedCadres).toBe(2);
    expect(row!.overdueCadres).toBe(1); // never-reported
    expect(row!.currentCadres).toBe(1); // reported 2 days ago
    expect(row!.reportingCompletion).toBe(50);

    // Group rollup is an invariant regardless of what else shares 'गंगालूर' thana.
    expect(s.totalAssigned).toBe(s.rows.reduce((sum, r) => sum + r.assignedCadres, 0));
    expect(s.totalCurrent).toBe(s.rows.reduce((sum, r) => sum + r.currentCadres, 0));
    expect(s.overallCompletion).toBe(
      s.totalAssigned === 0 ? 0 : Math.round((s.totalCurrent / s.totalAssigned) * 100),
    );
    expect(s.unassignedCadres).toBeGreaterThanOrEqual(0);
    await app.close();
  });

  it('HQ gets one row per SDOP, summing that SDOP\'s officers — the aggregate ratio, not an average', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/stats/hierarchy', headers: auth(hqToken),
    });
    expect(res.statusCode).toBe(200);
    const s = res.json() as Extract<HierarchyStats, { level: 'admins' }>;
    expect(s.level).toBe('admins');

    const row = s.rows.find((r) => r.name === sdopAdminName);
    expect(row).toBeDefined();
    expect(row!.subDivision).toBe(SDOP_SUB_DIVISION);
    expect(row!.thana).toBeNull();
    // Lower bounds, not exact: another test file's fixture could also post an
    // officer to 'गंगालूर' thana, and this row sums EVERY officer there, not just
    // this file's one. What is exact is that this fixture's contribution is present.
    expect(row!.assignedCadres).toBeGreaterThanOrEqual(2);
    expect(row!.overdueCadres).toBeGreaterThanOrEqual(1);
    expect(row!.currentCadres).toBeGreaterThanOrEqual(1);
    expect(row!.reportingCompletion).toBe(
      Math.round((row!.currentCadres / row!.assignedCadres) * 100),
    );

    // NOT exact equality to the sum of admin rows (ADR-055 Consequences): the
    // top-level total is computed from ALL officers directly, and this suite's
    // OTHER fixture officer sits on thana 'स्टैट', which resolves to no sub-division
    // — so they contribute to the total but appear under no admin row.
    expect(s.totalAssigned).toBeGreaterThanOrEqual(s.rows.reduce((sum, r) => sum + r.assignedCadres, 0));
    expect(s.totalCurrent).toBeGreaterThanOrEqual(s.rows.reduce((sum, r) => sum + r.currentCadres, 0));

    // ADR-060. HQ's scope is unrestricted, so this file's genuinely-ambiguous
    // MULTI_THANA cadre (two officers, no explicit assignment, thana-match
    // cannot pick one) is always in view here -- a real lower bound, not the
    // vacuous >=0 this assertion used to be.
    expect(s.unassignedCadres).toBeGreaterThanOrEqual(1);
    await app.close();
  });

  // ── /stats/hierarchy?by=thana (this task, item 1) ───────────────────────────

  it('?by=thana for an SDOP: one row for their own thana, scoped, with exact numbers', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/stats/hierarchy?by=thana', headers: auth(sdopAdminToken),
    });
    expect(res.statusCode).toBe(200);
    const s = res.json() as HierarchyStats;
    expect(s.level).toBe('thanas');

    // गंगालूर is a single-thana sub-division (see scope.ts), so an SDOP scoped to it
    // gets exactly one row — proving the thana breakdown is jurisdiction-scoped
    // (ADR-044), not the whole district.
    expect(s.rows).toHaveLength(1);
    const row = s.rows[0]!;
    expect(row.thana).toBe(SDOP_THANA);
    expect(row.subDivision).toBe(SDOP_SUB_DIVISION);
    // ALL live cadres at this thana, not just assigned ones — but every cadre this
    // suite put at गंगालूर IS assigned, so the count is exact regardless of what
    // other files' fixtures add here.
    expect(row.assignedCadres).toBeGreaterThanOrEqual(2);
    expect(row.overdueCadres).toBeGreaterThanOrEqual(1);
    expect(row.reportingCompletion).toBe(
      row.assignedCadres === 0 ? 0 : Math.round((row.currentCadres / row.assignedCadres) * 100),
    );
    await app.close();
  });

  it('?by=thana for HQ: every canonical thana appears, including ones with zero cadres', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/stats/hierarchy?by=thana', headers: auth(hqToken),
    });
    expect(res.statusCode).toBe(200);
    const s = res.json() as HierarchyStats;
    expect(s.level).toBe('thanas');

    // All 22 canonical thanas are present — an empty one still gets a 0/0/0% row
    // rather than being dropped, so the list reads as a data gap, not a false all-clear.
    expect(s.rows.length).toBe(22);
    const row = s.rows.find((r) => r.thana === SDOP_THANA);
    expect(row).toBeDefined();
    expect(row!.subDivision).toBe(SDOP_SUB_DIVISION);
    expect(row!.assignedCadres).toBeGreaterThanOrEqual(2);

    const empty = s.rows.find((r) => r.assignedCadres === 0);
    if (empty !== undefined) {
      expect(empty.reportingCompletion).toBe(0);
      expect(empty.currentCadres).toBe(0);
    }
    await app.close();
  });

  it('an officer is refused (403) on the thana breakdown too — same admin+ gate', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/stats/hierarchy?by=thana', headers: auth(officerToken),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  // ── /stats/reports/daily (web stats page) ───────────────────────────────────
  // Scoped to this file's officer (thana 'स्टैट', file-unique) so every number below is
  // EXACT — nothing outside this file's setup can land in that thana's series.

  const istDay = (ms: number): string => new Date(ms + 330 * 60 * 1000).toISOString().slice(0, 10);
  const daily = async (app: FastifyInstance, token: string, qs = ''): Promise<{ status: number; body: ReportsDailyStats }> => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/stats/reports/daily${qs}`, headers: auth(token) });
    return { status: res.statusCode, body: res.json() as ReportsDailyStats };
  };
  const dayOf = (s: ReportsDailyStats, key: string) => s.days.find((d) => d.date === key);

  it('GET /stats/reports/daily without a token → 401', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/stats/reports/daily' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('defaults to the last 30 IST days, gap-filled, oldest first — and counts only in-window reports', async () => {
    const app = await makeApp();
    const { status, body } = await daily(app, officerToken);
    expect(status).toBe(200);
    expect(body.days).toHaveLength(30);
    expect(body.to).toBe(istDay(Date.now()));
    expect(body.days.map((d) => d.date)).toEqual([...body.days.map((d) => d.date)].sort());
    // OTHER reported 2 days ago; THANA's report is 40 days old — outside the window.
    expect(body.totals).toEqual({ reports: 1, uniqueCadres: 1 });
    expect(dayOf(body, istDay(Date.now() - 2 * DAY_MS))).toEqual({
      date: istDay(Date.now() - 2 * DAY_MS), reports: 1, uniqueCadres: 1,
    });
    // A day with no reports is a real 0, present in the series.
    expect(dayOf(body, istDay(Date.now() - 5 * DAY_MS))).toMatchObject({ reports: 0, uniqueCadres: 0 });
    await app.close();
  });

  it('a wider explicit range picks up the older report', async () => {
    const app = await makeApp();
    const { body } = await daily(app, officerToken, `?from=${istDay(Date.now() - 89 * DAY_MS)}&to=${istDay(Date.now())}`);
    expect(body.days).toHaveLength(90);
    expect(body.totals).toEqual({ reports: 2, uniqueCadres: 2 });
    await app.close();
  });

  it('uniqueCadres counts a cadre once per day, and the range total is distinct — not the sum of the days', async () => {
    const app = await makeApp();
    // 12:00 IST on the IST day 10 days ago: three reports on one cadre + one on another.
    const noon = new Date(Date.parse(`${istDay(Date.now() - 10 * DAY_MS)}T06:30:00.000Z`));
    const mk = (cadreId: number) =>
      prisma.report.create({
        data: {
          cadreId, reportedById: officerId, reportingPlace: 'thana', specificLocation: 'x',
          personStatus: 'alive', currentPhone: '+910', currentActivity: 'y', reportedAt: noon,
        },
      });
    const made = await Promise.all([mk(cadreIds[0]!), mk(cadreIds[0]!), mk(cadreIds[0]!), mk(cadreIds[1]!)]);
    try {
      const { body } = await daily(app, officerToken);
      const key = istDay(noon.getTime());
      expect(dayOf(body, key)).toEqual({ date: key, reports: 4, uniqueCadres: 2 });
      // OTHER (cadreIds[1]) reported on this day AND 2 days ago; ALERT (cadreIds[0]) only here.
      // Per-day uniques sum to 3, but only 2 different cadres reported in the range.
      expect(body.days.reduce((s, d) => s + d.uniqueCadres, 0)).toBe(3);
      expect(body.totals).toEqual({ reports: 5, uniqueCadres: 2 });
    } finally {
      await prisma.report.deleteMany({ where: { id: { in: made.map((r) => r.id) } } });
      await app.close();
    }
  });

  it('buckets by IST day: 00:30 IST on the 1st is that day, not the previous UTC one', async () => {
    const app = await makeApp();
    // 2026-06-30T19:00:00Z IS 2026-07-01 00:30 IST (same boundary /stats/me's months test uses).
    const boundary = await prisma.report.create({
      data: {
        cadreId: cadreIds[0]!, reportedById: officerId, reportingPlace: 'thana',
        specificLocation: 'सीमा', personStatus: 'alive', currentPhone: '+910',
        currentActivity: 'boundary', reportedAt: new Date('2026-06-30T19:00:00.000Z'),
      },
    });
    try {
      const { body } = await daily(app, officerToken, '?from=2026-06-30&to=2026-07-01');
      expect(dayOf(body, '2026-07-01')).toMatchObject({ reports: 1, uniqueCadres: 1 });
      expect(dayOf(body, '2026-06-30')).toMatchObject({ reports: 0, uniqueCadres: 0 });
    } finally {
      await prisma.report.delete({ where: { id: boundary.id } });
      await app.close();
    }
  });

  it('a jail cadre\'s report is not counted — जेल/जमानत is a separate register', async () => {
    const app = await makeApp();
    const jail = await prisma.cadre.create({
      data: {
        name: `${TOKEN}-DAILY-JAIL`, phone: '+910000000302', thana: 'स्टैट', currentAddress: 'Stats fixture',
        designation: 'Fixture', aliases: [], category: 'jail', alertLevel: 'normal', assignedOfficerId: officerId,
      },
    });
    const rep = await prisma.report.create({
      data: {
        cadreId: jail.id, reportedById: officerId, reportingPlace: 'thana', specificLocation: 'x',
        personStatus: 'alive', currentPhone: '+910', currentActivity: 'y', reportedAt: new Date(Date.now() - DAY_MS),
      },
    });
    try {
      const { body } = await daily(app, officerToken);
      expect(body.totals).toEqual({ reports: 1, uniqueCadres: 1 }); // still just OTHER's
    } finally {
      await prisma.report.delete({ where: { id: rep.id } });
      await prisma.cadre.delete({ where: { id: jail.id } });
      await app.close();
    }
  });

  it('thana filter narrows within scope; an officer cannot widen to another thana', async () => {
    const app = await makeApp();
    const hq = await daily(app, hqToken, `?thana=${encodeURIComponent('स्टैट')}`);
    expect(hq.body.totals).toEqual({ reports: 1, uniqueCadres: 1 });

    // Same officer, asking for a real thana that is NOT theirs → empty, never that thana's data.
    const other = await daily(app, officerToken, `?thana=${encodeURIComponent(SDOP_THANA)}`);
    expect(other.status).toBe(200);
    expect(other.body.days).toHaveLength(30);
    expect(other.body.totals).toEqual({ reports: 0, uniqueCadres: 0 });

    // A sub-division that does not contain the officer's thana likewise intersects to nothing.
    const sd = await daily(app, officerToken, `?subDivision=${encodeURIComponent(SDOP_SUB_DIVISION)}`);
    expect(sd.body.totals).toEqual({ reports: 0, uniqueCadres: 0 });
    await app.close();
  });

  // ── /stats/hierarchy?by=officer (web stats page, Phase 2) ───────────────────

  it('?by=officer gives HQ the per-officer rows an SDOP gets by default', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/stats/hierarchy?by=officer', headers: auth(hqToken) });
    expect(res.statusCode).toBe(200);
    const s = res.json() as Extract<HierarchyStats, { level: 'officers' }>;
    expect(s.level).toBe('officers'); // not 'admins' — HQ's default
    const row = s.rows.find((r) => r.name === sdopOfficerName);
    expect(row).toBeDefined();
    expect(row!.thana).toBe(SDOP_THANA);
    expect(row!.assignedCadres).toBe(2);
    expect(row!.reportingCompletion).toBe(50);
    expect(s.totalAssigned).toBe(s.rows.reduce((sum, r) => sum + r.assignedCadres, 0));

    // Unchanged for everyone else: officers still refused, junk values still rejected.
    expect((await app.inject({ method: 'GET', url: '/api/v1/stats/hierarchy?by=officer', headers: auth(officerToken) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/stats/hierarchy?by=bogus', headers: auth(hqToken) })).statusCode).toBe(400);
    await app.close();
  });

  // ── /stats/recency-by-thana ─────────────────────────────────────────────────

  it('GET /stats/recency-by-thana without a token → 401', async () => {
    const app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/v1/stats/recency-by-thana' })).statusCode).toBe(401);
    await app.close();
  });

  it('recency-by-thana: an officer gets exactly their thana, with the fixture tiers', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/stats/recency-by-thana', headers: auth(officerToken) });
    expect(res.statusCode).toBe(200);
    const s = res.json() as RecencyByThanaStats;
    expect(s.rows).toHaveLength(1);
    // OTHER reported 2d ago, THANA 40d ago, ALERT never — same tiers the dashboard test pins.
    expect(s.rows[0]).toMatchObject({ thana: 'स्टैट', current: 1, overdue1m: 1, overdue2m: 0, overdue3m: 1, total: 3 });
    await app.close();
  });

  it('recency-by-thana: HQ gets all 22 canonical thanas, each partitioned by its four tiers', async () => {
    const app = await makeApp();
    const s = (await app.inject({ method: 'GET', url: '/api/v1/stats/recency-by-thana', headers: auth(hqToken) })).json() as RecencyByThanaStats;
    expect(s.rows).toHaveLength(22);
    for (const r of s.rows) expect(r.current + r.overdue1m + r.overdue2m + r.overdue3m).toBe(r.total);
    const row = s.rows.find((r) => r.thana === SDOP_THANA);
    expect(row?.subDivision).toBe(SDOP_SUB_DIVISION);
    expect(row!.total).toBeGreaterThanOrEqual(2);
    await app.close();
  });

  // ── /stats/cadre-profile ────────────────────────────────────────────────────

  const profile = async (app: FastifyInstance, token: string, qs = ''): Promise<CadreProfileStats> =>
    (await app.inject({ method: 'GET', url: `/api/v1/stats/cadre-profile${qs}`, headers: auth(token) })).json() as CadreProfileStats;
  const profileBase = {
    phone: '+910000000303', thana: 'स्टैट', currentAddress: 'Stats fixture',
    designation: 'Fixture', aliases: [] as string[], alertLevel: 'normal' as const,
  };
  const dobAgo = (years: number, extraDays = 40): Date =>
    new Date(`${istDay(Date.now() - (years * 365.25 + extraDays) * DAY_MS)}T00:00:00.000Z`);

  it('GET /stats/cadre-profile without a token → 401', async () => {
    const app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/v1/stats/cadre-profile' })).statusCode).toBe(401);
    await app.close();
  });

  it('cadre-profile: blank fields are counted as unknown and coverage says so — nothing reads as complete', async () => {
    const app = await makeApp();
    const p = await profile(app, officerToken);
    // This file's three thana-'स्टैट' fixtures set none of the optional fields.
    expect(p.total).toBe(3);
    expect(p.gender).toEqual({ male: 0, female: 0, unknown: 3 });
    expect(p.age.noDob).toBe(3);
    expect(p.age.bands.reduce((s, b) => s + b.male + b.female + b.unknownGender, 0)).toBe(0);
    expect(p.designation).toEqual({ rows: [{ label: 'Fixture', count: 3 }], other: 0, unknown: 0 });
    expect(p.caste).toEqual({ rows: [], other: 0, unknown: 3 });
    expect(p.grade).toEqual({ A: 0, B: 0, C: 0, jail: 0, death: 0, unset: 3 });
    expect(p.rankClass).toEqual({ DVCM: 0, ACM: 0, PM: 0, unset: 3 });
    expect(p.permanentStatus.none).toBe(3);
    expect(Object.values(p.coverage)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    await app.close();
  });

  it('cadre-profile: distributions, age bands and coverage reflect real rows; jail is excluded; category narrows', async () => {
    const app = await makeApp();
    const made = await prisma.cadre.createManyAndReturn({
      data: [
        // 45 y, male, caste (trimmed to match the next), grade A, ACM
        { ...profileBase, name: `${TOKEN}-PROF-1`, category: 'surrendered', gender: 'male', dateOfBirth: dobAgo(45), caste: 'गोंड', district: 'बीजापुर', post: 'PM', priorityCategory: 'A', filter: 'ACM' },
        // 25 y, female, same caste spelled with padding
        { ...profileBase, name: `${TOKEN}-PROF-2`, category: 'surrendered', gender: 'female', dateOfBirth: dobAgo(25), caste: '  गोंड ' },
        // DOB in the future: a data error — joins noDob, never "<20"
        { ...profileBase, name: `${TOKEN}-PROF-3`, category: 'surrendered', gender: 'male', dateOfBirth: new Date(`${istDay(Date.now() + 400 * DAY_MS)}T00:00:00.000Z`) },
        // A jail-register cadre must not touch any number
        { ...profileBase, name: `${TOKEN}-PROF-JAIL`, category: 'jail', gender: 'female', dateOfBirth: dobAgo(33), caste: 'जेल' },
      ],
    });
    try {
      const p = await profile(app, officerToken);
      expect(p.total).toBe(6); // 3 baseline + 3 non-jail extras
      expect(p.gender).toEqual({ male: 2, female: 1, unknown: 3 });
      expect(p.age.bands.find((b) => b.band === '40-49')).toMatchObject({ male: 1, female: 0, unknownGender: 0 });
      expect(p.age.bands.find((b) => b.band === '20-29')).toMatchObject({ male: 0, female: 1, unknownGender: 0 });
      expect(p.age.bands.find((b) => b.band === '30-39')).toMatchObject({ male: 0, female: 0, unknownGender: 0 }); // the jail row's age
      expect(p.age.noDob).toBe(3 + 1); // baseline + the future DOB
      expect(p.caste).toEqual({ rows: [{ label: 'गोंड', count: 2 }], other: 0, unknown: 4 }); // trimmed values merge
      expect(p.district.rows).toEqual([{ label: 'बीजापुर', count: 1 }]);
      expect(p.grade.A).toBe(1);
      expect(p.rankClass).toMatchObject({ ACM: 1, unset: 5 });
      expect(p.coverage).toMatchObject({ dateOfBirth: 3, gender: 3, caste: 2, district: 1, post: 1, rankClass: 1, grade: 1 });

      expect((await profile(app, officerToken, '?category=thana')).total).toBe(1); // only the THANA fixture
      expect((await profile(app, officerToken, '?category=surrendered')).total).toBe(5);
      expect((await profile(app, hqToken, `?thana=${encodeURIComponent('स्टैट')}`)).total).toBe(6);
      // Another thana's data never leaks through the filter.
      expect((await profile(app, officerToken, `?thana=${encodeURIComponent(SDOP_THANA)}`)).total).toBe(0);
    } finally {
      await prisma.cadre.deleteMany({ where: { id: { in: made.map((c) => c.id) } } });
      await app.close();
    }
  });

  it('cadre-profile: a long tail folds into `other` after the top 10', async () => {
    const app = await makeApp();
    const made = await prisma.cadre.createManyAndReturn({
      data: Array.from({ length: 11 }, (_, i) => ({
        ...profileBase, name: `${TOKEN}-PROF-D${i}`, category: 'thana' as const, designation: `D${String(i + 1).padStart(2, '0')}`,
      })),
    });
    try {
      const p = await profile(app, officerToken);
      // 'Fixture' (3) leads; ties among the 11 singles break alphabetically, so D01–D09
      // take the other nine slots and D10, D11 fold into `other`.
      expect(p.designation.rows).toHaveLength(10);
      expect(p.designation.rows[0]).toEqual({ label: 'Fixture', count: 3 });
      expect(p.designation.rows[9]).toEqual({ label: 'D09', count: 1 });
      expect(p.designation.other).toBe(2);
    } finally {
      await prisma.cadre.deleteMany({ where: { id: { in: made.map((c) => c.id) } } });
      await app.close();
    }
  });

  // ── /stats/surrenders ───────────────────────────────────────────────────────

  const surrenders = async (app: FastifyInstance, token: string, qs = ''): Promise<SurrendersStats> =>
    (await app.inject({ method: 'GET', url: `/api/v1/stats/surrenders${qs}`, headers: auth(token) })).json() as SurrendersStats;

  it('GET /stats/surrenders without a token → 401', async () => {
    const app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/v1/stats/surrenders' })).statusCode).toBe(401);
    await app.close();
  });

  it('surrenders: undated surrendered cadres form the last, year-null group — total is never silently short', async () => {
    const app = await makeApp();
    const s = await surrenders(app, officerToken);
    // ALERT (district) + OTHER (other/other_state), neither with a date or year. The THANA
    // fixture is a different register and is not part of this chart.
    expect(s.total).toBe(2);
    expect(s.years).toHaveLength(1);
    expect(s.years[0]).toMatchObject({
      year: null, total: 2, district: 1, otherDistrict: 0, otherState: 1, unclassified: 0,
      active: 2, activeRecent: 1, // OTHER reported 2 days ago; ALERT never
      deceased: 0, untraceable: 0, otherExempt: 0,
    });
    await app.close();
  });

  it('surrenders: year comes from the date or the free-text year; cohort and splits are exact', async () => {
    const app = await makeApp();
    const made = await prisma.cadre.createManyAndReturn({
      data: [
        // 2019 by DATE — district, DVCM
        { ...profileBase, name: `${TOKEN}-SURR-1`, category: 'surrendered', surrenderDate: new Date('2019-03-10T00:00:00.000Z'), surrenderOrigin: 'district', filter: 'DVCM' },
        // 2019 by free-text "2019-20" — other district, PM
        { ...profileBase, name: `${TOKEN}-SURR-2`, category: 'surrendered', surrenderYear: '2019-20', surrenderOrigin: 'other', otherOriginType: 'other_district', filter: 'PM' },
        // 2021 — deceased (exempt), no origin classified, ACM
        { ...profileBase, name: `${TOKEN}-SURR-3`, category: 'surrendered', surrenderYear: '2021', permanentStatus: 'deceased', filter: 'ACM' },
        // other origin but sub-type not classified yet → unclassified, still in the year
        { ...profileBase, name: `${TOKEN}-SURR-4`, category: 'surrendered', surrenderYear: '2021', surrenderOrigin: 'other' },
        // Not in this chart: jail register
        { ...profileBase, name: `${TOKEN}-SURR-JAIL`, category: 'jail', surrenderYear: '2019' },
      ],
    });
    try {
      const s = await surrenders(app, officerToken);
      expect(s.years.map((y) => y.year)).toEqual(['2019', '2021', null]); // ascending, null last
      expect(s.total).toBe(2 + 4);
      expect(s.total).toBe(s.years.reduce((sum, y) => sum + y.total, 0));

      const y2019 = s.years[0]!;
      expect(y2019).toMatchObject({
        total: 2, district: 1, otherDistrict: 1, otherState: 0, unclassified: 0,
        DVCM: 1, ACM: 0, PM: 1, otherRank: 0,
        active: 2, activeRecent: 0, deceased: 0, untraceable: 0, otherExempt: 0,
      });
      const y2021 = s.years[1]!;
      expect(y2021).toMatchObject({
        total: 2, district: 0, unclassified: 2, ACM: 1, otherRank: 1,
        active: 1, deceased: 1, untraceable: 0, otherExempt: 0,
      });

      // Region filters narrow within scope and never past it.
      expect((await surrenders(app, hqToken, `?thana=${encodeURIComponent('स्टैट')}`)).total).toBe(6);
      expect((await surrenders(app, officerToken, `?thana=${encodeURIComponent(SDOP_THANA)}`)).total).toBe(0);
    } finally {
      await prisma.cadre.deleteMany({ where: { id: { in: made.map((c) => c.id) } } });
      await app.close();
    }
  });

  it('rejects a malformed or oversized range with 400', async () => {
    const app = await makeApp();
    for (const qs of [
      '?from=2026-09-10&to=2026-09-01', // from after to
      '?from=2026-09-01', // only one bound
      '?from=2026-02-31&to=2026-03-05', // not a real date
      '?from=2025-01-01&to=2026-09-01', // > 366 days
      '?from=abc&to=def',
    ]) {
      expect((await daily(app, officerToken, qs)).status).toBe(400);
    }
    await app.close();
  });
});
