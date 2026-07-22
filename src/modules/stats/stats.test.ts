import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';
import type { OfficerStats } from './stats.schema.js';

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

let officerId = 0;
let officerToken = '';
let adminId = 0;
let adminToken = '';
let hqToken = '';
const cadreIds: number[] = [];

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
    surrendered: { district: number; other: number; total: number };
    thana: number;
    jail: number;
  };
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
    data: { ...base, name: `${TOKEN}-OTHER`, category: 'surrendered', surrenderOrigin: 'other', alertLevel: 'normal' },
  }); // other +1, gets a fresh report -> NOT pending, reportsThisWeek +1
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
});

afterAll(async () => {
  await prisma.report.deleteMany({ where: { cadreId: { in: cadreIds } } });
  await prisma.cadre.deleteMany({ where: { name: { startsWith: TOKEN } } });
  // Both fixture users — leaving the admin behind would let it drift into another
  // file's assertions (Sampark-Backend#3).
  await prisma.user.deleteMany({ where: { phone: { in: [PHONE, ADMIN_PHONE, HQ_PHONE] } } });
  await prisma.$disconnect();
});

describe('stats', () => {
  it('GET /stats/dashboard without a token → 401', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/stats/dashboard' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  // ADR-030. These are org-wide supervisory counts — every cadre, every alert,
  // everyone's reports. This endpoint previously took `[app.authenticate]` only, so
  // an officer's own home screen rendered the whole organisation's posture, and any
  // officer could curl it. Unlike `assignedTo=me` (a filter over rows the caller can
  // already page through), an aggregate is not something an officer could assemble
  // for themselves — so it is a real access boundary, not a view concern.
  it('an officer is refused (403) — the aggregate is not theirs to read', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/stats/dashboard', headers: auth(officerToken),
    });
    expect(res.statusCode).toBe(403);
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
      s.byCategory.surrendered.district, s.byCategory.surrendered.other, s.byCategory.surrendered.total,
      s.byCategory.thana, s.byCategory.jail]) {
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }
    await app.close();
  });

  it('the three categories partition the total, and origin is a subset of surrendered', async () => {
    // Exact invariants — true no matter what other test files have in the table.
    const app = await makeApp();
    const s = (await app.inject({ method: 'GET', url: '/api/v1/stats/dashboard', headers: auth(hqToken) })).json() as Stats;
    expect(s.totalCadres).toBe(s.byCategory.surrendered.total + s.byCategory.thana + s.byCategory.jail);
    // district + other ≤ total: a surrendered cadre may have a NULL origin (ADR-019),
    // so the two tiles need not sum to the surrendered total.
    expect(s.byCategory.surrendered.district + s.byCategory.surrendered.other)
      .toBeLessThanOrEqual(s.byCategory.surrendered.total);
    await app.close();
  });

  it('each fixture row is reflected in its field (counts are live, not hardcoded)', async () => {
    const app = await makeApp();
    const s = (await app.inject({ method: 'GET', url: '/api/v1/stats/dashboard', headers: auth(hqToken) })).json() as Stats;
    // Lower bounds: my fixture contributes at least this much; parallel data only adds.
    expect(s.byCategory.surrendered.district).toBeGreaterThanOrEqual(1);
    expect(s.byCategory.surrendered.other).toBeGreaterThanOrEqual(1);
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
});
