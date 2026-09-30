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
  DashboardQuery,
  DashboardStats,
  HierarchyRow,
  HierarchyStats,
  HierarchyThanaRow,
  OfficerStats,
  ReportsDailyQuery,
  ReportsDailyStats,
  CadreProfileQuery,
  CadreProfileStats,
  ProfileDistribution,
  RecencyByThanaStats,
  SurrenderYearRow,
  SurrendersQuery,
  SurrendersStats,
} from './stats.schema.js';

export interface StatsDeps {
  prisma: PrismaClient;
  log: FastifyBaseLogger;
}

export interface StatsService {
  // ADR-044. Every count is scoped. An unscoped total is a leak in its own right: it tells
  // a thana officer exactly how many cadres exist district-wide, which is the number the
  // scoping was introduced to withhold.
  // This task. `filter` narrows the SAME snapshot to one category (+ surrenderOrigin/
  // otherOriginType) on top of the role scope above — the caller-wide behaviour when
  // omitted/'all' is unchanged.
  dashboard(scope: CadreScope, filter?: DashboardQuery): Promise<DashboardStats>;
  /** ADR-031. The caller's own numbers. Aggregated in SQL, never over one page. */
  forOfficer(officerId: number, scope: CadreScope): Promise<OfficerStats>;
  /** ADR-055. The rolled-up view: an SDOP's own officers, or HQ's own SDOPs, or
   *  (this task) every thana in scope when `by: 'thana'` is passed. */
  hierarchy(scope: CadreScope, opts?: { by?: 'thana' | 'officer' }): Promise<HierarchyStats>;
  /** Web stats page. Per-thana counts of the four recency tiers. */
  recencyByThana(scope: CadreScope): Promise<RecencyByThanaStats>;
  /** Web stats page. Who is on the register: gender, age, caste, rank, grade, coverage. */
  cadreProfile(scope: CadreScope, query: CadreProfileQuery): Promise<CadreProfileStats>;
  /** Web stats page. The surrendered register by surrender year, with a reporting cohort. */
  surrenders(scope: CadreScope, query: SurrendersQuery): Promise<SurrendersStats>;
  /** Web stats page. Reports and distinct cadres reported per IST day, scoped to the
   *  caller and optionally narrowed (within that scope) to a sub-division or thana. */
  reportsDaily(scope: CadreScope, query: ReportsDailyQuery): Promise<ReportsDailyStats>;
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

const IST_OFFSET_MS = 330 * 60 * 1000;

/** `YYYY-MM-DD` of the IST calendar day `d` falls on. */
function istDayKey(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Every `YYYY-MM-DD` from `from` to `to` inclusive. Both are calendar-day keys, so
 *  stepping in whole UTC days is exact — no DST anywhere in IST. */
function dayKeysBetween(from: string, to: string): string[] {
  const keys: string[] = [];
  const end = Date.parse(`${to}T00:00:00.000Z`);
  for (let t = Date.parse(`${from}T00:00:00.000Z`); t <= end; t += DAY_MS) {
    keys.push(new Date(t).toISOString().slice(0, 10));
  }
  return keys;
}

/** Narrow the caller's scope by an optional sub-division and/or thana filter. Each filter
 *  INTERSECTS the running allow-list (null = unrestricted HQ), so naming a thana outside
 *  the caller's scope ends in an empty list — never that thana's data (ADR-044). */
function narrowThanas(
  scope: CadreScope,
  filters: { thana?: string | undefined; subDivision?: string | undefined },
): readonly string[] | null {
  const restrict = (current: readonly string[] | null, names: readonly string[]): readonly string[] => {
    const wanted = new Set(names.map(nfc));
    return current === null ? [...wanted] : current.filter((t) => wanted.has(nfc(t)));
  };
  let allowed: readonly string[] | null = scope.kind === 'all' ? null : scope.thanas;
  if (filters.subDivision !== undefined) allowed = restrict(allowed, thanasForSubDivision(filters.subDivision));
  if (filters.thana !== undefined) allowed = restrict(allowed, [filters.thana]);
  return allowed;
}

/** `AND c.thana IN (...)` for a narrowed allow-list, or nothing for unrestricted HQ. */
function thanaPredicate(allowed: readonly string[] | null): Prisma.Sql {
  return allowed === null ? Prisma.empty : Prisma.sql`AND c.thana IN (${Prisma.join(allowed)})`;
}

const PROFILE_TOP_N = 10;
const PROFILE_AGE_BANDS: readonly { band: string; min: number; max: number }[] = [
  { band: '<20', min: 0, max: 19 },
  { band: '20-29', min: 20, max: 29 },
  { band: '30-39', min: 30, max: 39 },
  { band: '40-49', min: 40, max: 49 },
  { band: '50-59', min: 50, max: 59 },
  { band: '60+', min: 60, max: Number.POSITIVE_INFINITY },
];

/** Biggest `PROFILE_TOP_N` labelled values, the remainder folded into `other`, blanks apart. */
function toDistribution(rows: readonly { label: string | null; n: bigint }[]): ProfileDistribution {
  const named = rows
    .filter((r): r is { label: string; n: bigint } => r.label !== null)
    .map((r) => ({ label: nfc(r.label), count: Number(r.n) }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'hi'));
  const unknown = rows.filter((r) => r.label === null).reduce((s, r) => s + Number(r.n), 0);
  return {
    rows: named.slice(0, PROFILE_TOP_N),
    other: named.slice(PROFILE_TOP_N).reduce((s, r) => s + r.count, 0),
    unknown,
  };
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
    async dashboard(scope, filter) {
      const now = Date.now();
      const weekAgo = new Date(now - 7 * DAY_MS);

      // This task. The category-section narrowing (on top of the role scope below) —
      // same fields `GET /cadres` filters on, so every count in the response ends up
      // describing the same slice of cadres a category screen's list shows.
      // जेल/जमानत is a SEPARATE register (criminal-case accused, not Maoist cadre): the
      // caller-wide summary ('all' / no category) excludes it entirely, and only the
      // jail card's own count and a category='jail' drill-in see those cadres.
      const categoryScoped = filter?.category !== undefined && filter.category !== 'all';
      const categoryWhere: Prisma.CadreWhereInput =
        filter?.category !== undefined && filter.category !== 'all'
          ? {
              category: filter.category,
              ...(filter.surrenderOrigin !== undefined && { surrenderOrigin: filter.surrenderOrigin }),
              ...(filter.otherOriginType !== undefined && { otherOriginType: filter.otherOriginType }),
            }
          : { category: { not: 'jail' } };

      // ADR-044. Two predicates, because `Cadre` and `Report` scope differently: a cadre
      // is scoped on its OWN thana, a report through its cadre relation. They were one
      // object before scoping and the compiler caught the conflation.
      const live = { deletedAt: null, ...cadreScopeWhere(scope), ...categoryWhere };
      const reportCadreWhere: Prisma.CadreWhereInput = {
        ...(scope.kind === 'all' ? {} : { thana: { in: [...scope.thanas] } }),
        ...categoryWhere,
      };
      const liveReports: Prisma.ReportWhereInput = {
        deletedAt: null,
        ...(Object.keys(reportCadreWhere).length > 0 ? { cadre: reportCadreWhere } : {}),
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
        // This task. `AND: [live, ...]`, NOT `{ ...live, ... }` — a spread would let
        // this query's own literal `category`/`surrenderOrigin` silently CLOBBER
        // whatever `filter` put on `live` (same top-level key, last one wins), which
        // broke exactly the case this task added: querying `thana`'s count while
        // `live` was scoped to category='surrendered' returned the WHOLE thana
        // count, not 0. `AND` keeps both conditions — genuinely contradictory ones
        // (e.g. live's category='surrendered' + this query's category='thana')
        // correctly count 0 rows instead of one silently overriding the other.
        prisma.cadre.count({ where: { AND: [live, { category: 'surrendered' }] } }),
        prisma.cadre.count({ where: { AND: [live, { category: 'surrendered', surrenderOrigin: 'district' }] } }),
        prisma.cadre.count({ where: { AND: [live, { category: 'surrendered', surrenderOrigin: 'other' }] } }),
        // This task. The दीगर जिला/राज्य tabs — sub-split of the 'other' bucket above.
        prisma.cadre.count({
          where: { AND: [live, { category: 'surrendered', surrenderOrigin: 'other', otherOriginType: 'other_district' }] },
        }),
        prisma.cadre.count({
          where: { AND: [live, { category: 'surrendered', surrenderOrigin: 'other', otherOriginType: 'other_state' }] },
        }),
        prisma.cadre.count({ where: { AND: [live, { category: 'thana' }] } }),
        // Scope only, NOT `live`: on the caller-wide summary `live` excludes jail (above),
        // and the home screen's 4th card still needs the jail count. Under a category
        // filter the two are the same query, since categoryWhere never widens past it.
        prisma.cadre.count({
          where: categoryScoped
            ? { AND: [live, { category: 'jail' }] }
            : { deletedAt: null, ...cadreScopeWhere(scope), category: 'jail' },
        }),
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
        // The caller-wide total is the Maoist register only. Under category='jail' the
        // other two are 0 (contradictory AND), so the jail screen's total is its own.
        totalCadres: surrenderedTotal + thana + (filter?.category === 'jail' ? jail : 0),
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

      // जेल/जमानत cadres are a separate register: they stay out of the officer's
      // workload numbers and report totals (the per-category split below still counts
      // them, which is what the jail card reads).
      const mineMaoist: Prisma.CadreWhereInput = { ...mine, category: { not: 'jail' } };
      const myReports = {
        deletedAt: null,
        reportedById: officerId,
        cadre: { category: { not: 'jail' as const }, ...(scope.kind === 'all' ? {} : { thana: { in: [...scope.thanas] } }) },
      };

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
        prisma.cadre.count({ where: mineMaoist }),
        // Same rule as the dashboard's `pendingReporting`, scoped to this officer:
        // no live report in the last 30 days. `none` covers never-reported.
        prisma.cadre.count({
          where: { ...mineMaoist, reports: { none: { deletedAt: null, reportedAt: { gte: monthAgo } } } },
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
          JOIN cadres c ON c.id = r.cadre_id
          WHERE r.reported_by_id = ${officerId}
            AND r.deleted_at IS NULL
            AND c.category <> 'jail'
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
          AND c.category <> 'jail'
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
      //
      // DELIBERATE DIVERGENCE from hierarchyRow's (officer/admin) meaning, per the
      // client's explicit request: `currentCadres` here is COVERAGE — has this cadre
      // EVER had a live report filed, no matter how long ago — not RECENCY (a report
      // within the last REPORTING_CADENCE_DAYS, which is what the officer/admin rows
      // and /stats/me still mean). "थाना पूर्णता दर" is meant to answer "how much of
      // this thana's register has been reported on at all so far", not "how current
      // is it right now" — those are different questions, and conflating them under
      // one number was the bug being fixed here. `hierarchyThanaRow` is its own Zod
      // schema (not shared with hierarchyRow), so this divergence costs nothing on
      // the wire — only the field's MEANING changes, not its name or shape.
      //
      // `EXISTS`, not a `COUNT(r.*) > 0` join, is what makes this a per-CADRE
      // (unique) count rather than a per-REPORT one — a cadre with five reports
      // still contributes exactly one to `assigned`'s COUNT(*) and is filtered in
      // or out of the coverage bucket once, not five times.
      if (opts?.by === 'thana') {
        const scopedThanas = scope.kind === 'all' ? CANONICAL_THANAS : scope.thanas;

        const grouped = await prisma.$queryRaw<{ thana: string; assigned: bigint; reported: bigint }[]>`
          SELECT c.thana AS thana,
                 COUNT(*) AS assigned,
                 COUNT(*) FILTER (
                   WHERE EXISTS (
                     SELECT 1 FROM reports r
                     WHERE r.cadre_id = c.id AND r.deleted_at IS NULL
                   )
                 ) AS reported
          FROM cadres c
          WHERE c.deleted_at IS NULL
            AND c.category <> 'jail'
            ${scope.kind === 'all' ? Prisma.empty : Prisma.sql`AND c.thana IN (${Prisma.join(scope.thanas)})`}
          GROUP BY c.thana
        `;
        const byThana = new Map(
          grouped.map((g) => [nfc(g.thana), { assigned: Number(g.assigned), reported: Number(g.reported) }]),
        );

        // Every scoped thana gets a row, even one with zero cadres (0/0/0%) — a
        // completion list that silently drops empty thanas hides a data gap as an
        // absence rather than showing it.
        const thanaRows: HierarchyThanaRow[] = scopedThanas.map((t) => {
          const g = byThana.get(nfc(t)) ?? { assigned: 0, reported: 0 };
          return {
            thana: t,
            subDivision: subDivisionForThana(t),
            assignedCadres: g.assigned,
            overdueCadres: g.assigned - g.reported,
            currentCadres: g.reported,
            reportingCompletion: g.assigned === 0 ? 0 : Math.round((g.reported / g.assigned) * 100),
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
        WHERE c.deleted_at IS NULL AND c.category <> 'jail'
          AND COALESCE(c.assigned_officer_id, so.officer_id) IS NOT NULL
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

      // An SDOP always gets their officers; `?by=officer` gives HQ the same per-officer
      // view instead of the SDOP roll-up (each row already carries its own thana).
      if (scope.kind !== 'all' || opts?.by === 'officer') {
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

    async reportsDaily(scope, q) {
      const to = q.to ?? istDayKey(new Date());
      const from = q.from ?? new Date(Date.parse(`${to}T00:00:00.000Z`) - 29 * DAY_MS).toISOString().slice(0, 10);
      const dayKeys = dayKeysBetween(from, to);

      const allowed = narrowThanas(scope, q);

      const zeroDays = dayKeys.map((date) => ({ date, reports: 0, uniqueCadres: 0 }));
      if (allowed !== null && allowed.length === 0) {
        return { from, to, days: zeroDays, totals: { reports: 0, uniqueCadres: 0 } };
      }

      // Bounds are IST midnights expressed as the UTC instants they correspond to, so
      // the range and the per-day bucketing below agree on where a day begins
      // (`reported_at` is naive-UTC — same bucketing reasoning as forOfficer's months).
      const start = new Date(Date.parse(`${from}T00:00:00.000Z`) - IST_OFFSET_MS);
      const end = new Date(Date.parse(`${to}T00:00:00.000Z`) + DAY_MS - IST_OFFSET_MS);
      // जेल/जमानत is a separate register (see dashboard()): never part of reporting activity.
      const predicate = Prisma.sql`
        r.deleted_at IS NULL AND c.deleted_at IS NULL AND c.category <> 'jail'
        AND r.reported_at >= ${start} AND r.reported_at < ${end}
        ${thanaPredicate(allowed)}
      `;

      const [daily, total] = await prisma.$transaction([
        prisma.$queryRaw<{ day: string; reports: bigint; cadres: bigint }[]>`
          SELECT to_char((r.reported_at AT TIME ZONE 'UTC' AT TIME ZONE ${IST})::date, 'YYYY-MM-DD') AS day,
                 count(*) AS reports,
                 count(DISTINCT r.cadre_id) AS cadres
          FROM reports r
          JOIN cadres c ON c.id = r.cadre_id
          WHERE ${predicate}
          GROUP BY 1
          ORDER BY 1
        `,
        // Distinct over the whole range in one pass — NOT the sum of `cadres` above.
        prisma.$queryRaw<{ reports: bigint; cadres: bigint }[]>`
          SELECT count(*) AS reports, count(DISTINCT r.cadre_id) AS cadres
          FROM reports r
          JOIN cadres c ON c.id = r.cadre_id
          WHERE ${predicate}
        `,
      ]);

      const found = new Map(daily.map((r) => [r.day, { reports: Number(r.reports), uniqueCadres: Number(r.cadres) }]));
      return {
        from,
        to,
        days: dayKeys.map((date) => ({ date, reports: 0, uniqueCadres: 0, ...found.get(date) })),
        totals: { reports: Number(total[0]?.reports ?? 0), uniqueCadres: Number(total[0]?.cadres ?? 0) },
      };
    },

    async recencyByThana(scope) {
      const scopedThanas = scope.kind === 'all' ? CANONICAL_THANAS : scope.thanas;
      const live: Prisma.CadreWhereInput = {
        deletedAt: null,
        category: { not: 'jail' },
        ...cadreScopeWhere(scope),
      };

      // The four tiers through the shared builder — the SAME clause `/cadres?recency` and
      // the dashboard tiles use, so each count equals the list it would drill into.
      const tiers = ['current', 'overdue1m', 'overdue2m', 'overdue3m'] as const;
      const grouped = await Promise.all(
        tiers.map((tier) =>
          prisma.cadre.groupBy({
            by: ['thana'],
            where: { ...live, ...recencyTierWhere(tier) },
            _count: { _all: true },
          }),
        ),
      );
      const counts = new Map<string, Record<(typeof tiers)[number], number>>();
      grouped.forEach((rows, i) => {
        for (const r of rows) {
          const key = nfc(r.thana);
          const entry = counts.get(key) ?? { current: 0, overdue1m: 0, overdue2m: 0, overdue3m: 0 };
          entry[tiers[i]!] = r._count._all;
          counts.set(key, entry);
        }
      });

      // Every scoped thana gets a row, even one with no cadres — a silently dropped row
      // would hide a data gap as an absence (same rule as hierarchy's thana rows).
      return {
        rows: scopedThanas.map((t) => {
          const c = counts.get(nfc(t)) ?? { current: 0, overdue1m: 0, overdue2m: 0, overdue3m: 0 };
          return {
            thana: t,
            subDivision: subDivisionForThana(t),
            ...c,
            total: c.current + c.overdue1m + c.overdue2m + c.overdue3m,
          };
        }),
      };
    },

    async cadreProfile(scope, q) {
      const allowed = narrowThanas(scope, q);
      const empty = (): ProfileDistribution => ({ rows: [], other: 0, unknown: 0 });
      if (allowed !== null && allowed.length === 0) {
        return {
          total: 0,
          gender: { male: 0, female: 0, unknown: 0 },
          age: { bands: PROFILE_AGE_BANDS.map((b) => ({ band: b.band, male: 0, female: 0, unknownGender: 0 })), noDob: 0 },
          caste: empty(), designation: empty(), post: empty(), district: empty(),
          grade: { A: 0, B: 0, C: 0, jail: 0, death: 0, unset: 0 },
          rankClass: { DVCM: 0, ACM: 0, PM: 0, unset: 0 },
          permanentStatus: { deceased: 0, government_job: 0, gs: 0, living_elsewhere: 0, untraceable: 0, none: 0 },
          coverage: { dateOfBirth: 0, gender: 0, caste: 0, district: 0, post: 0, rankClass: 0, grade: 0, photo: 0 },
        };
      }

      // जेल/जमानत is a separate register (see dashboard()). `::text` on the parameter's
      // column side: Prisma binds a JS string as text, which Postgres will not compare to
      // an enum column directly.
      const base = Prisma.sql`
        c.deleted_at IS NULL AND c.category <> 'jail'
        ${q.category === undefined ? Prisma.empty : Prisma.sql`AND c.category::text = ${q.category}`}
        ${thanaPredicate(allowed)}
      `;
      // `expr` is always one of the fixed column expressions below — never request input.
      const group = (expr: string) =>
        prisma.$queryRaw<{ label: string | null; n: bigint }[]>`
          SELECT ${Prisma.raw(expr)} AS label, count(*) AS n
          FROM cadres c
          WHERE ${base}
          GROUP BY 1
        `;
      const text = (col: string) => `NULLIF(trim(c.${col}), '')`;

      // One transaction so every distribution describes the same snapshot of the register.
      const [ages, caste, designation, post, district, grade, rank, permanent, cov] = await prisma.$transaction([
        prisma.$queryRaw<{ age: number | null; gender: string | null; n: bigint }[]>`
          SELECT age, gender, count(*) AS n FROM (
            SELECT c.gender::text AS gender,
                   CASE WHEN c.date_of_birth IS NULL THEN NULL
                        ELSE EXTRACT(YEAR FROM age((now() AT TIME ZONE ${IST})::date, c.date_of_birth))::int
                   END AS age
            FROM cadres c
            WHERE ${base}
          ) t
          GROUP BY 1, 2
        `,
        group(text('caste')),
        group(text('designation')),
        group(text('post')),
        group(text('district')),
        group('c.priority_category::text'),
        group('c.filter::text'),
        group('c.permanent_status::text'),
        prisma.$queryRaw<
          { total: bigint; dob: bigint; gender: bigint; caste: bigint; district: bigint; post: bigint; rank: bigint; grade: bigint; photo: bigint }[]
        >`
          SELECT count(*) AS total,
                 count(*) FILTER (WHERE c.date_of_birth IS NOT NULL) AS dob,
                 count(*) FILTER (WHERE c.gender IS NOT NULL) AS gender,
                 count(*) FILTER (WHERE NULLIF(trim(c.caste), '') IS NOT NULL) AS caste,
                 count(*) FILTER (WHERE NULLIF(trim(c.district), '') IS NOT NULL) AS district,
                 count(*) FILTER (WHERE NULLIF(trim(c.post), '') IS NOT NULL) AS post,
                 count(*) FILTER (WHERE c.filter IS NOT NULL) AS rank,
                 count(*) FILTER (WHERE c.priority_category IS NOT NULL) AS grade,
                 count(*) FILTER (WHERE c.avatar_key IS NOT NULL OR c.avatar_url IS NOT NULL) AS photo
          FROM cadres c
          WHERE ${base}
        `,
      ]);

      const byLabel = (rows: readonly { label: string | null; n: bigint }[]) =>
        new Map(rows.map((r) => [r.label, Number(r.n)] as const));
      const g = byLabel(grade);
      const rk = byLabel(rank);
      const pm = byLabel(permanent);

      // Age bands × gender. A negative age (a DOB in the future) is a data error, not a
      // newborn: it joins `noDob` rather than being filed under "<20".
      const bands = PROFILE_AGE_BANDS.map((b) => ({ band: b.band, male: 0, female: 0, unknownGender: 0 }));
      let noDob = 0;
      const gender = { male: 0, female: 0, unknown: 0 };
      for (const r of ages) {
        const n = Number(r.n);
        const key = r.gender === 'male' ? 'male' : r.gender === 'female' ? 'female' : 'unknown';
        gender[key] += n;
        if (r.age === null || r.age < 0) {
          noDob += n;
          continue;
        }
        const i = PROFILE_AGE_BANDS.findIndex((b) => r.age! >= b.min && r.age! <= b.max);
        const band = bands[i]!;
        if (key === 'male') band.male += n;
        else if (key === 'female') band.female += n;
        else band.unknownGender += n;
      }

      const c = cov[0];
      const total = Number(c?.total ?? 0);
      return {
        total,
        gender,
        age: { bands, noDob },
        caste: toDistribution(caste),
        designation: toDistribution(designation),
        post: toDistribution(post),
        district: toDistribution(district),
        grade: {
          A: g.get('A') ?? 0, B: g.get('B') ?? 0, C: g.get('C') ?? 0,
          jail: g.get('jail') ?? 0, death: g.get('death') ?? 0, unset: g.get(null) ?? 0,
        },
        rankClass: { DVCM: rk.get('DVCM') ?? 0, ACM: rk.get('ACM') ?? 0, PM: rk.get('PM') ?? 0, unset: rk.get(null) ?? 0 },
        permanentStatus: {
          deceased: pm.get('deceased') ?? 0,
          government_job: pm.get('government_job') ?? 0,
          gs: pm.get('gs') ?? 0,
          living_elsewhere: pm.get('living_elsewhere') ?? 0,
          untraceable: pm.get('untraceable') ?? 0,
          none: pm.get(null) ?? 0,
        },
        coverage: {
          dateOfBirth: Number(c?.dob ?? 0),
          gender: Number(c?.gender ?? 0),
          caste: Number(c?.caste ?? 0),
          district: Number(c?.district ?? 0),
          post: Number(c?.post ?? 0),
          rankClass: Number(c?.rank ?? 0),
          grade: Number(c?.grade ?? 0),
          photo: Number(c?.photo ?? 0),
        },
      };
    },

    async surrenders(scope, q) {
      const allowed = narrowThanas(scope, q);
      if (allowed !== null && allowed.length === 0) return { total: 0, years: [] };
      const monthAgo = new Date(Date.now() - REPORTING_CADENCE_DAYS * DAY_MS);

      // Year = the surrender date's year, else the first 4 digits of the free-text year
      // ("2019", "2019-20"). `[0-9]{4}` rather than `\d`: a template literal would eat the
      // backslash. A row with neither has a NULL year and forms the last group.
      const rows = await prisma.$queryRaw<
        {
          year: string | null; total: bigint; district: bigint; other_district: bigint; other_state: bigint;
          dvcm: bigint; acm: bigint; pm: bigint; active: bigint; active_recent: bigint; deceased: bigint; untraceable: bigint;
        }[]
      >`
        SELECT COALESCE(to_char(c.surrender_date, 'YYYY'), substring(c.surrender_year from '[0-9]{4}')) AS year,
               count(*) AS total,
               count(*) FILTER (WHERE c.surrender_origin = 'district') AS district,
               count(*) FILTER (WHERE c.surrender_origin = 'other' AND c.other_origin_type = 'other_district') AS other_district,
               count(*) FILTER (WHERE c.surrender_origin = 'other' AND c.other_origin_type = 'other_state') AS other_state,
               count(*) FILTER (WHERE c.filter = 'DVCM') AS dvcm,
               count(*) FILTER (WHERE c.filter = 'ACM') AS acm,
               count(*) FILTER (WHERE c.filter = 'PM') AS pm,
               count(*) FILTER (WHERE c.permanent_status IS NULL) AS active,
               count(*) FILTER (
                 WHERE c.permanent_status IS NULL
                   AND EXISTS (
                     SELECT 1 FROM reports r
                     WHERE r.cadre_id = c.id AND r.deleted_at IS NULL AND r.reported_at >= ${monthAgo}
                   )
               ) AS active_recent,
               count(*) FILTER (WHERE c.permanent_status = 'deceased') AS deceased,
               count(*) FILTER (WHERE c.permanent_status = 'untraceable') AS untraceable
        FROM cadres c
        WHERE c.deleted_at IS NULL AND c.category = 'surrendered'
          ${thanaPredicate(allowed)}
        GROUP BY 1
        ORDER BY 1 NULLS LAST
      `;

      const years: SurrenderYearRow[] = rows.map((r) => {
        const total = Number(r.total);
        const district = Number(r.district);
        const otherDistrict = Number(r.other_district);
        const otherState = Number(r.other_state);
        const [DVCM, ACM, PM] = [Number(r.dvcm), Number(r.acm), Number(r.pm)];
        const active = Number(r.active);
        const deceased = Number(r.deceased);
        const untraceable = Number(r.untraceable);
        return {
          year: r.year,
          total,
          district,
          otherDistrict,
          otherState,
          unclassified: total - district - otherDistrict - otherState,
          DVCM,
          ACM,
          PM,
          otherRank: total - DVCM - ACM - PM,
          active,
          activeRecent: Number(r.active_recent),
          deceased,
          untraceable,
          otherExempt: total - active - deceased - untraceable,
        };
      });
      return { total: years.reduce((s, y) => s + y.total, 0), years };
    },
  };
}
