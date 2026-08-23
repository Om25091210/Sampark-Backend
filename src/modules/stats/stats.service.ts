import type { FastifyBaseLogger } from 'fastify';
import {
  CANONICAL_THANAS,
  cadreScopeWhere,
  subDivisionForThana,
  thanasForSubDivision,
  type CadreScope,
} from '../../lib/scope.js';
import { nfc } from '../../lib/text.js';
import { Prisma, type PrismaClient } from '@prisma/client';
import { REPORTING_CADENCE_DAYS } from '../../lib/serialize.js';
import { recencyTierWhere, pendingReportingWhere } from '../../lib/recency.js';
import type {
  DashboardStats,
  HierarchyRow,
  HierarchyStats,
  HierarchyThanaRow,
  OfficerStats,
} from './stats.schema.js';

export interface StatsDeps {
  prisma: PrismaClient;
  log: FastifyBaseLogger;
}

export interface StatsService {
  // ADR-044. Every count is scoped. An unscoped total is a leak in its own right: it tells
  // a thana officer exactly how many cadres exist district-wide, which is the number the
  // scoping was introduced to withhold.
  dashboard(scope: CadreScope): Promise<DashboardStats>;
  /** ADR-031. The caller's own numbers. Aggregated in SQL, never over one page. */
  forOfficer(officerId: number, scope: CadreScope): Promise<OfficerStats>;
  /** ADR-055. The rolled-up view: an SDOP's own officers, or HQ's own SDOPs, or
   *  (this task) every thana in scope when `by: 'thana'` is passed. */
  hierarchy(scope: CadreScope, opts?: { by?: 'thana' }): Promise<HierarchyStats>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS_SHOWN = 6;

/** Turns raw counts into integer percentages that sum to EXACTLY 100 (largest-
 *  remainder method) — independent per-count rounding can drift a point off 100
 *  (e.g. 33.3/33.3/33.4 all floor to 33 = 99), which fails the "reads as a whole"
 *  point of a percentage breakdown. All-zero input returns all zeros, not NaN. */
function percentagesOf100(counts: readonly number[]): number[] {
  const total = counts.reduce((s, c) => s + c, 0);
  if (total === 0) return counts.map(() => 0);
  const raw = counts.map((c) => (c / total) * 100);
  const floors = raw.map(Math.floor);
  const remainder = 100 - floors.reduce((s, f) => s + f, 0);
  // Every index below comes from mapping/sorting the SAME fixed-length `floors`
  // array, so the `!` assertions are in-range by construction, not a leap of faith.
  const byFracDesc = raw
    .map((r, i) => ({ i, frac: r - floors[i]! }))
    .sort((a, b) => b.frac - a.frac);
  const result = [...floors];
  for (let k = 0; k < remainder; k++) {
    const idx = byFracDesc[k]!.i;
    result[idx] = result[idx]! + 1;
  }
  return result;
}

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

// ADR-060. Explicit assignment (Cadre.assignedOfficerId) and thana jurisdiction
// work TOGETHER, not either/or: a cadre with no explicit assignment still falls
// to an officer by default when their thana has exactly one officer posted to
// it. When a thana has zero or several officers, thana-match alone cannot pick
// ONE of them without guessing, so the cadre stays unattributed at the officer
// level (it still counts fine at the thana/SDOP level, which never depended on
// assignedOfficerId to begin with). Shared by forOfficer() (a single caller) and
// hierarchy()'s officer grouping + unassignedCadres (every officer at once), so
// the two can never resolve "who does this cadre belong to" differently.
const SOLE_OFFICER_BY_THANA_CTE = Prisma.sql`
  sole_officer_by_thana AS (
    SELECT thana, MIN(id) AS officer_id
    FROM users
    WHERE role = 'officer' AND deleted_at IS NULL AND thana IS NOT NULL
    GROUP BY thana
    HAVING COUNT(*) = 1
  )
`;

export function makeStatsService({ prisma }: StatsDeps): StatsService {
  return {
    async dashboard(scope) {
      const now = Date.now();
      const weekAgo = new Date(now - 7 * DAY_MS);

      // ADR-044. Two predicates, because `Cadre` and `Report` scope differently: a cadre
      // is scoped on its OWN thana, a report through its cadre relation. They were one
      // object before scoping and the compiler caught the conflation.
      const live = { deletedAt: null, ...cadreScopeWhere(scope) };
      const liveReports: Prisma.ReportWhereInput = {
        deletedAt: null,
        ...(scope.kind === 'all' ? {} : { cadre: { thana: { in: [...scope.thanas] } } }),
      };

      // One transaction so every count reflects the same snapshot — a cadre created
      // mid-read must not land in the total but not the category breakdown. Plain
      // counts (not groupBy): only three categories and two origins, and each is a
      // cheap indexed count, so the extra round-trips are negligible at this scale.
      const [
        surrenderedTotal,
        surrenderedDistrict,
        surrenderedOther,
        surrenderedOtherDistrict,
        surrenderedOtherState,
        thana,
        jail,
        activeAlerts,
        alertWarning,
        alertNormal,
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
        // This task. The दीगर जिला/राज्य tabs — sub-split of the 'other' bucket above.
        prisma.cadre.count({
          where: { ...live, category: 'surrendered', surrenderOrigin: 'other', otherOriginType: 'other_district' },
        }),
        prisma.cadre.count({
          where: { ...live, category: 'surrendered', surrenderOrigin: 'other', otherOriginType: 'other_state' },
        }),
        prisma.cadre.count({ where: { ...live, category: 'thana' } }),
        prisma.cadre.count({ where: { ...live, category: 'jail' } }),
        prisma.cadre.count({ where: { ...live, alertLevel: 'critical' } }),
        prisma.cadre.count({ where: { ...live, alertLevel: 'warning' } }),
        prisma.cadre.count({ where: { ...live, alertLevel: 'normal' } }),
        prisma.report.count({ where: { ...liveReports, reportedAt: { gte: weekAgo } } }),
        // Cadres with no live report in the last 30 days — the "overdue on the monthly
        // check-in" count. `none` covers never-reported too (an empty relation matches).
        // Shared with `/cadres?pendingReporting` (pendingReportingWhere) so the tile's
        // count always equals the length of the list it drills into.
        prisma.cadre.count({ where: { ...live, ...pendingReportingWhere() } }),
        // ADR-041/046. The four recency tiers — now PER-CATEGORY, via the shared
        // recencyTierWhere (the same builder /cadres?recency uses, so a tile's count
        // equals the length of the list it drills into). Still disjoint and exhaustive:
        // each live cadre falls in exactly one tier (jail/death in `current` only), so the
        // four sum to totalCadres. सामान्य / सतर्क / जोखिम / उच्च जोखिम.
        prisma.cadre.count({ where: { ...live, ...recencyTierWhere('current') } }),
        prisma.cadre.count({ where: { ...live, ...recencyTierWhere('overdue1m') } }),
        prisma.cadre.count({ where: { ...live, ...recencyTierWhere('overdue2m') } }),
        prisma.cadre.count({ where: { ...live, ...recencyTierWhere('overdue3m') } }),
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
          // two need not sum to the total. That gap is the unclassified set. Same rule
          // one level down: an 'other'-origin cadre with no otherOriginType yet counts
          // toward `other` but neither `otherDistrict` nor `otherState`.
          surrendered: {
            district: surrenderedDistrict,
            other: surrenderedOther,
            otherDistrict: surrenderedOtherDistrict,
            otherState: surrenderedOtherState,
            total: surrenderedTotal,
          },
          thana,
          jail,
        },
        // Order matches the schema comment (सामान्य/अति-आवश्यक/चेतावनी): normal,
        // critical, warning counts turn into percentages that sum to exactly 100.
        alertLevelBreakdown: (() => {
          const pct = percentagesOf100([alertNormal, activeAlerts, alertWarning]);
          return { normal: pct[0]!, critical: pct[1]!, warning: pct[2]! };
        })(),
      };
    },

    async forOfficer(officerId, scope) {
      const now = new Date();
      const monthAgo = new Date(now.getTime() - 30 * DAY_MS);
      // Scoped as well as assigned. `assignedOfficerId` alone is not a boundary (backend
      // CLAUDE.md is explicit that it is a filter), and a cadre could remain assigned to an
      // officer after being moved to another station.
      const live = { deletedAt: null, ...cadreScopeWhere(scope) };

      // ADR-060. Explicit assignment (assignedOfficerId) and thana jurisdiction are
      // not either/or -- a cadre with no explicit assignment still falls to this
      // officer by default IF they are the only officer posted to their own thana
      // (the common case, and the one Om described: "cadres fall under officers
      // based on thana as well as when assigned"). When a thana has more than one
      // officer, an unassigned cadre there cannot be credited to just one of them
      // without guessing, so it stays out of `mine` until someone explicitly
      // assigns it (same gap /stats/hierarchy's unassignedCadres now surfaces).
      const me = await prisma.user.findUnique({
        where: { id: officerId },
        select: { thana: true, role: true },
      });
      const soleOfficerAtMyThana =
        me?.role === 'officer' && me.thana !== null
          ? (await prisma.user.count({ where: { role: 'officer', deletedAt: null, thana: me.thana } })) === 1
          : false;
      const mine: Prisma.CadreWhereInput = soleOfficerAtMyThana
        ? { ...live, OR: [{ assignedOfficerId: officerId }, { assignedOfficerId: null }] }
        : { ...live, assignedOfficerId: officerId };

      // The window start: the first day of the IST month `MONTHS_SHOWN - 1` back.
      // Converted to the UTC instant that IST midnight corresponds to, so the SQL
      // range and the bucketing agree on where a month begins.
      const firstKey = istMonthKey(now, MONTHS_SHOWN - 1);
      const windowStart = new Date(Date.parse(`${firstKey}-01T00:00:00.000Z`) - 330 * 60 * 1000);

      const myReports = { deletedAt: null, reportedById: officerId, ...(scope.kind === 'all' ? {} : { cadre: { thana: { in: [...scope.thanas] } } }) };

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

    async hierarchy(scope, opts) {
      const monthAgo = new Date(Date.now() - REPORTING_CADENCE_DAYS * DAY_MS);

      // Cadres nobody is responsible for — a staffing gap, not a specific officer's
      // lapse (ADR-055 Context §2). Shared by every branch below, so computed once.
      // ADR-060. NOT simply "assignedOfficerId IS NULL" anymore -- a cadre with no
      // explicit assignment is still someone's by thana jurisdiction when their
      // thana has exactly one officer (see SOLE_OFFICER_BY_THANA_CTE below and
      // forOfficer's matching logic above). Only a cadre neither explicitly
      // assigned NOR resolvable that way is a genuine staffing gap.
      const unassignedRows = await prisma.$queryRaw<{ count: bigint }[]>`
        WITH ${SOLE_OFFICER_BY_THANA_CTE}
        SELECT COUNT(*) AS count
        FROM cadres c
        LEFT JOIN sole_officer_by_thana so ON so.thana = c.thana
        WHERE c.deleted_at IS NULL
          AND c.assigned_officer_id IS NULL
          AND so.officer_id IS NULL
          ${scope.kind === 'all' ? Prisma.empty : Prisma.sql`AND c.thana IN (${Prisma.join(scope.thanas)})`}
      `;
      const unassignedCadres = Number(unassignedRows[0]?.count ?? 0);

      const rollup = (rows: ReadonlyArray<{ assignedCadres: number; currentCadres: number }>) => {
        const totalAssigned = rows.reduce((s, r) => s + r.assignedCadres, 0);
        const totalCurrent = rows.reduce((s, r) => s + r.currentCadres, 0);
        return {
          totalAssigned,
          totalCurrent,
          // The aggregate ratio, not an average of each row's own percentage
          // (ADR-055 Context §1) — a lightly-loaded row cannot swing this number.
          overallCompletion: totalAssigned === 0 ? 0 : Math.round((totalCurrent / totalAssigned) * 100),
        };
      };

      // This task's extension: one row per THANA in scope, counting every live
      // cadre AT that thana (not just those with an assigned officer) — a thana's
      // reporting completion is a fact about the thana, not about staffing. HQ gets
      // all 22 canonical thanas; an admin gets only their own sub-division's, via
      // the same `cadreScopeWhere` every other scoped query uses (ADR-044).
      if (opts?.by === 'thana') {
        const scopedThanas = scope.kind === 'all' ? CANONICAL_THANAS : scope.thanas;

        const grouped = await prisma.$queryRaw<{ thana: string; assigned: bigint; overdue: bigint }[]>`
          SELECT c.thana AS thana,
                 COUNT(*) AS assigned,
                 COUNT(*) FILTER (
                   WHERE NOT EXISTS (
                     SELECT 1 FROM reports r
                     WHERE r.cadre_id = c.id AND r.deleted_at IS NULL AND r.reported_at >= ${monthAgo}
                   )
                 ) AS overdue
          FROM cadres c
          WHERE c.deleted_at IS NULL
            ${scope.kind === 'all' ? Prisma.empty : Prisma.sql`AND c.thana IN (${Prisma.join(scope.thanas)})`}
          GROUP BY c.thana
        `;
        const byThana = new Map(
          grouped.map((g) => [nfc(g.thana), { assigned: Number(g.assigned), overdue: Number(g.overdue) }]),
        );

        // Every scoped thana gets a row, even one with zero cadres (0/0/0%) — a
        // completion list that silently drops empty thanas hides a data gap as an
        // absence rather than showing it.
        const thanaRows: HierarchyThanaRow[] = scopedThanas.map((t) => {
          const g = byThana.get(nfc(t)) ?? { assigned: 0, overdue: 0 };
          const current = g.assigned - g.overdue;
          return {
            thana: t,
            subDivision: subDivisionForThana(t),
            assignedCadres: g.assigned,
            overdueCadres: g.overdue,
            currentCadres: current,
            reportingCompletion: g.assigned === 0 ? 0 : Math.round((current / g.assigned) * 100),
          };
        });

        return { level: 'thanas', rows: thanaRows, ...rollup(thanaRows), unassignedCadres };
      }

      // The roster to report on: every officer for HQ, just the SDOP's own for an admin.
      const officerWhere: Prisma.UserWhereInput = { role: 'officer', deletedAt: null };
      if (scope.kind !== 'all') officerWhere.thana = { in: [...scope.thanas] };
      const officers = await prisma.user.findMany({
        where: officerWhere,
        select: { id: true, name: true, thana: true },
        orderBy: { name: 'asc' },
      });

      // One grouped query over EVERY live assignment — cheaper and simpler than an
      // `= ANY(...)` array parameter, and the officer list above already bounds which
      // rows of this get used. Same "no live report in REPORTING_CADENCE_DAYS" rule
      // `/stats/me`'s `overdueCadres` uses, so a row here and that officer's own
      // reading of themselves can never disagree.
      // ADR-060. COALESCE onto the sole officer at a cadre's thana when there is no
      // explicit assignment -- same fallback forOfficer() applies for a single
      // caller, extended here to every officer at once via the CTE below.
      const grouped = await prisma.$queryRaw<{ officerId: number; assigned: bigint; overdue: bigint }[]>`
        WITH ${SOLE_OFFICER_BY_THANA_CTE}
        SELECT COALESCE(c.assigned_officer_id, so.officer_id) AS "officerId",
               COUNT(*) AS assigned,
               COUNT(*) FILTER (
                 WHERE NOT EXISTS (
                   SELECT 1 FROM reports r
                   WHERE r.cadre_id = c.id AND r.deleted_at IS NULL AND r.reported_at >= ${monthAgo}
                 )
               ) AS overdue
        FROM cadres c
        LEFT JOIN sole_officer_by_thana so ON so.thana = c.thana AND c.assigned_officer_id IS NULL
        WHERE c.deleted_at IS NULL AND COALESCE(c.assigned_officer_id, so.officer_id) IS NOT NULL
        GROUP BY COALESCE(c.assigned_officer_id, so.officer_id)
      `;
      const byOfficer = new Map(
        grouped.map((g) => [g.officerId, { assigned: Number(g.assigned), overdue: Number(g.overdue) }]),
      );

      const officerRows: HierarchyRow[] = officers.map((o) => {
        const g = byOfficer.get(o.id) ?? { assigned: 0, overdue: 0 };
        const current = g.assigned - g.overdue;
        return {
          id: o.id,
          name: o.name,
          thana: o.thana,
          subDivision: null,
          assignedCadres: g.assigned,
          overdueCadres: g.overdue,
          currentCadres: current,
          // 0 when nothing is assigned — same rule ADR-031 gives a single officer,
          // extended to a row: nothing to report on is not 100% reported.
          reportingCompletion: g.assigned === 0 ? 0 : Math.round((current / g.assigned) * 100),
        };
      });

      if (scope.kind !== 'all') {
        return { level: 'officers', rows: officerRows, ...rollup(officerRows), unassignedCadres };
      }

      // HQ view: bucket the same officer rows into their sub-division's admin, via
      // the fixed 9-entry table `resolveCadreScope` already uses — JS-side grouping
      // over a handful of pre-aggregated rows, not over cadre/report rows.
      const admins = await prisma.user.findMany({
        where: { role: 'admin', deletedAt: null },
        select: { id: true, name: true, subDivision: true },
        orderBy: { name: 'asc' },
      });

      const adminRows: HierarchyRow[] = admins.map((a) => {
        const thanas = thanasForSubDivision(a.subDivision).map(nfc);
        const under = officerRows.filter((o) => o.thana !== null && thanas.includes(nfc(o.thana)));
        const assigned = under.reduce((s, r) => s + r.assignedCadres, 0);
        const overdue = under.reduce((s, r) => s + r.overdueCadres, 0);
        const current = under.reduce((s, r) => s + r.currentCadres, 0);
        return {
          id: a.id,
          name: a.name,
          thana: null,
          subDivision: a.subDivision,
          assignedCadres: assigned,
          overdueCadres: overdue,
          currentCadres: current,
          reportingCompletion: assigned === 0 ? 0 : Math.round((current / assigned) * 100),
        };
      });

      // Top-level totals come from ALL officer rows directly, not from summing the
      // admin rows — an officer whose thana matches no sub-division (bad/legacy data)
      // still counts here even though no admin row claims them (ADR-055 Consequences).
      return { level: 'admins', rows: adminRows, ...rollup(officerRows), unassignedCadres };
    },
  };
}
