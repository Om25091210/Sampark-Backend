import type { FastifyBaseLogger } from 'fastify';
import { Prisma, type PrismaClient } from '@prisma/client';
import { REPORTING_CADENCE_DAYS } from '../../lib/serialize.js';
import type { DashboardStats, OfficerStats } from './stats.schema.js';

export interface StatsDeps {
  prisma: PrismaClient;
  log: FastifyBaseLogger;
}

export interface StatsService {
  dashboard(): Promise<DashboardStats>;
  /** ADR-031. The caller's own numbers. Aggregated in SQL, never over one page. */
  forOfficer(officerId: number): Promise<OfficerStats>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS_SHOWN = 6;

// ADR-024/031. Every date the officer thinks about is an IST date. `reported_at` is
// stored naive-UTC, so bucketing by month without converting would file a report
// made at 00:30 IST on the 1st into the previous month — the same class of bug the
// report-log date filter exists to avoid.
const IST = 'Asia/Kolkata';

/** `YYYY-MM` for the IST month `n` months before the current IST month. */
function istMonthKey(d: Date, monthsAgo: number): string {
  const ist = new Date(d.getTime() + 330 * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth() - monthsAgo;
  const shifted = new Date(Date.UTC(y, m, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function makeStatsService({ prisma }: StatsDeps): StatsService {
  return {
    async dashboard() {
      const now = Date.now();
      const weekAgo = new Date(now - 7 * DAY_MS);
      // ADR-041. Recency boundaries as multiples of the reporting cadence, so the
      // dashboard tiers can never drift from the card's (CadreCard) or the /cadres
      // `recency` filter's — they all step off the same 30-day constant.
      const cadence = REPORTING_CADENCE_DAYS;
      const monthAgo = new Date(now - cadence * DAY_MS); // 30d — pendingReporting + tier boundary
      const twoMonthsAgo = new Date(now - cadence * 2 * DAY_MS); // 60d
      const threeMonthsAgo = new Date(now - cadence * 3 * DAY_MS); // 90d

      const live = { deletedAt: null };

      // One transaction so every count reflects the same snapshot — a cadre created
      // mid-read must not land in the total but not the category breakdown. Plain
      // counts (not groupBy): only three categories and two origins, and each is a
      // cheap indexed count, so the extra round-trips are negligible at this scale.
      const [
        surrenderedTotal,
        surrenderedDistrict,
        surrenderedOther,
        thana,
        jail,
        activeAlerts,
        reportsThisWeek,
        pendingReporting,
        rcCurrent,
        rcOverdue1m,
        rcOverdue2m,
        rcOverdue3m,
      ] = await prisma.$transaction([
        prisma.cadre.count({ where: { ...live, category: 'surrendered' } }),
        prisma.cadre.count({ where: { ...live, category: 'surrendered', surrenderOrigin: 'district' } }),
        prisma.cadre.count({ where: { ...live, category: 'surrendered', surrenderOrigin: 'other' } }),
        prisma.cadre.count({ where: { ...live, category: 'thana' } }),
        prisma.cadre.count({ where: { ...live, category: 'jail' } }),
        prisma.cadre.count({ where: { ...live, alertLevel: 'critical' } }),
        prisma.report.count({ where: { ...live, reportedAt: { gte: weekAgo } } }),
        // Cadres with no live report in the last 30 days — the "overdue on the monthly
        // check-in" count. `none` covers never-reported too (an empty relation matches).
        prisma.cadre.count({
          where: { ...live, reports: { none: { deletedAt: null, reportedAt: { gte: monthAgo } } } },
        }),
        // ADR-041. The four recency tiers — disjoint windows, so each live cadre falls
        // in exactly one and the four sum to totalCadres.
        // सामान्य: reported within 30d.
        prisma.cadre.count({
          where: { ...live, reports: { some: { deletedAt: null, reportedAt: { gte: monthAgo } } } },
        }),
        // सतर्क: latest report in [60d, 30d) — some within 60d, none within 30d.
        prisma.cadre.count({
          where: {
            ...live,
            AND: [
              { reports: { some: { deletedAt: null, reportedAt: { gte: twoMonthsAgo } } } },
              { reports: { none: { deletedAt: null, reportedAt: { gte: monthAgo } } } },
            ],
          },
        }),
        // जोखिम: latest report in [90d, 60d).
        prisma.cadre.count({
          where: {
            ...live,
            AND: [
              { reports: { some: { deletedAt: null, reportedAt: { gte: threeMonthsAgo } } } },
              { reports: { none: { deletedAt: null, reportedAt: { gte: twoMonthsAgo } } } },
            ],
          },
        }),
        // उच्च जोखिम: nothing within 90d (includes never-reported — no grace, ADR-031).
        prisma.cadre.count({
          where: { ...live, reports: { none: { deletedAt: null, reportedAt: { gte: threeMonthsAgo } } } },
        }),
      ]);

      return {
        // The three categories partition every live cadre, so their sum is the total.
        totalCadres: surrenderedTotal + thana + jail,
        activeAlerts,
        reportsThisWeek,
        pendingReporting,
        reportingRecency: {
          current: rcCurrent,
          overdue1m: rcOverdue1m,
          overdue2m: rcOverdue2m,
          overdue3m: rcOverdue3m,
        },
        byCategory: {
          // A surrendered cadre with a NULL origin (ADR-019) is invisible to both
          // tiles: it counts toward `total` but neither `district` nor `other`, so the
          // two need not sum to the total. That gap is the unclassified set.
          surrendered: { district: surrenderedDistrict, other: surrenderedOther, total: surrenderedTotal },
          thana,
          jail,
        },
      };
    },

    async forOfficer(officerId) {
      const now = new Date();
      const monthAgo = new Date(now.getTime() - 30 * DAY_MS);
      const live = { deletedAt: null };
      const mine = { ...live, assignedOfficerId: officerId };

      // The window start: the first day of the IST month `MONTHS_SHOWN - 1` back.
      // Converted to the UTC instant that IST midnight corresponds to, so the SQL
      // range and the bucketing agree on where a month begins.
      const firstKey = istMonthKey(now, MONTHS_SHOWN - 1);
      const windowStart = new Date(Date.parse(`${firstKey}-01T00:00:00.000Z`) - 330 * 60 * 1000);

      const myReports = { ...live, reportedById: officerId };

      // Plain counts rather than groupBy — three categories and two places, each a
      // cheap indexed count. Same call the dashboard makes above, and for the same
      // reason: groupBy inside $transaction loses its inference and buys nothing at
      // this cardinality. One transaction so every number is the same snapshot.
      const [
        assignedCadres,
        overdueCadres,
        totalReports,
        pendingChanges,
        catSurrendered,
        catJail,
        catThana,
        placeThana,
        placeVillage,
        monthly,
      ] = await prisma.$transaction([
        prisma.cadre.count({ where: mine }),
        // Same rule as the dashboard's `pendingReporting`, scoped to this officer:
        // no live report in the last 30 days. `none` covers never-reported.
        prisma.cadre.count({
          where: { ...mine, reports: { none: { deletedAt: null, reportedAt: { gte: monthAgo } } } },
        }),
        prisma.report.count({ where: myReports }),
        prisma.cadreChangeRequest.count({ where: { submittedById: officerId, status: 'pending' } }),
        prisma.cadre.count({ where: { ...mine, category: 'surrendered' } }),
        prisma.cadre.count({ where: { ...mine, category: 'jail' } }),
        prisma.cadre.count({ where: { ...mine, category: 'thana' } }),
        prisma.report.count({ where: { ...myReports, reportingPlace: 'thana' } }),
        prisma.report.count({ where: { ...myReports, reportingPlace: 'village' } }),
        // Raw SQL because the bucket is a timezone-converted date_trunc, which
        // Prisma's typed groupBy cannot express. Parameterised — never interpolated.
        prisma.$queryRaw<{ month: string; reports: bigint }[]>`
          SELECT to_char(
                   date_trunc('month', r.reported_at AT TIME ZONE 'UTC' AT TIME ZONE ${IST}),
                   'YYYY-MM'
                 ) AS month,
                 count(*) AS reports
          FROM reports r
          WHERE r.reported_by_id = ${officerId}
            AND r.deleted_at IS NULL
            AND r.reported_at >= ${windowStart}
          GROUP BY 1
          ORDER BY 1
        `,
      ]);

      // Fill every month in the window. A month with no reports is a real 0, not a
      // gap for the chart to guess at.
      const found = new Map(monthly.map((r) => [r.month, Number(r.reports)]));
      const monthlyActivity = Array.from({ length: MONTHS_SHOWN }, (_, i) => {
        const month = istMonthKey(now, MONTHS_SHOWN - 1 - i);
        return { month, reports: found.get(month) ?? 0 };
      });

      const currentCadres = assignedCadres - overdueCadres;

      return {
        assignedCadres,
        overdueCadres,
        currentCadres,
        // 0 when nothing is assigned: an officer with no cadres has not achieved
        // 100% reporting, they have nothing to report on. Claiming 100% would be
        // the most flattering possible lie.
        reportingCompletion:
          assignedCadres === 0 ? 0 : Math.round((currentCadres / assignedCadres) * 100),
        totalReports,
        pendingChanges,
        monthlyActivity,
        reportsByPlace: { thana: placeThana, village: placeVillage },
        cadresByCategory: { surrendered: catSurrendered, jail: catJail, thana: catThana },
      };
    },
  };
}
