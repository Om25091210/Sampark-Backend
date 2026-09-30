import { z } from 'zod';
import { nfc } from '../../lib/text.js';

// Dashboard summary counts (ADR-020). Response is a camelCase entity, per the
// query/entity casing rule. There is no request body or query — it is a single
// snapshot for the home dashboard.
//
// The two windows below are the domain's reporting cadence, not arbitrary:
//   - reportsThisWeek : activity pulse, rolling 7 days.
//   - pendingReporting: cadres overdue on the ~monthly (30-day) check-in — the
//     same cadence step 6 (`nextReportingDueAt = lastReportAt + 30d`) uses.
export const dashboardStatsResponse = z.object({
  totalCadres: z.number().int(),
  // Cadres at alertLevel=critical — the "सक्रिय अलर्ट" tier (see CadreCard).
  activeAlerts: z.number().int(),
  // Reports filed in the last 7 days.
  reportsThisWeek: z.number().int(),
  // Cadres with NO report in the last 30 days (includes never-reported).
  pendingReporting: z.number().int(),
  // ADR-041. The 4 reporting-recency tiers (ADR-039's card system) as counts that
  // PARTITION every live cadre by days since their latest report. Thresholds are
  // multiples of the 30-day cadence (≤30 / 30-60 / 60-90 / >90); `overdue3m` includes
  // never-reported (no-grace, ADR-031). The four sum to `totalCadres`.
  reportingRecency: z.object({
    current: z.number().int(),    // सामान्य
    overdue1m: z.number().int(),  // सतर्क
    overdue2m: z.number().int(),  // जोखिम
    overdue3m: z.number().int(),  // उच्च जोखिम
  }),
  // Per-category counts backing the dashboard grid tiles. `surrendered` splits on
  // surrenderOrigin (ADR-019) because the dashboard shows the two as separate tiles.
  byCategory: z.object({
    surrendered: z.object({
      district: z.number().int(),
      other: z.number().int(),
      // This task. Sub-split of `other` for the दीगर जिला/राज्य tabs on that tile.
      // A cadre with surrenderOrigin='other' but no otherOriginType yet counts toward
      // `other`/`total` but neither of these two — same "invisible to the sub-bucket
      // until classified" rule ADR-019 already uses one level up.
      otherDistrict: z.number().int(),
      otherState: z.number().int(),
      total: z.number().int(),
    }),
    thana: z.number().int(),
    jail: z.number().int(),
  }),
  // सामान्य/अति-आवश्यक/चेतावनी as PERCENTAGES of every live cadre in scope — guaranteed
  // to sum to exactly 100 (largest-remainder rounding, see percentagesOf100 in the
  // service), not raw counts the client would otherwise have to turn into a share
  // itself. `AlertLevel` is a strict 3-value partition, so these three cover every
  // live cadre with none left over.
  alertLevelBreakdown: z.object({
    normal: z.number().int(),
    warning: z.number().int(),
    critical: z.number().int(),
  }),
});

export type DashboardStats = z.infer<typeof dashboardStatsResponse>;

// This task. Scopes the snapshot to one category-section screen (the mobile
// cadres/[category] list, opened from one of the four dashboard grid tiles) —
// same category/surrenderOrigin/otherOriginType vocabulary `GET /cadres` already
// filters on, so a tile's count on that screen equals the length of the list
// under it. Undefined/'all' keeps the original caller-wide snapshot.
export const dashboardQuery = z.object({
  category: z.enum(['surrendered', 'jail', 'thana', 'all']).optional(),
  surrenderOrigin: z.enum(['district', 'other']).optional(),
  otherOriginType: z.enum(['other_district', 'other_state']).optional(),
});

export type DashboardQuery = z.infer<typeof dashboardQuery>;

// ─── Officer stats (ADR-031) ──────────────────────────────────────────────────
//
// The caller's OWN numbers. `/stats/dashboard` is org-wide and admin+ (ADR-030);
// this is the same shape of question asked about one officer, so it is open to any
// authenticated caller — it only ever describes them.
//
// Every field here is aggregated in SQL over the officer's whole history. It is
// deliberately NOT computed client-side from `GET /reports?reportedBy=me&pageSize=50`:
// that would silently be wrong for any officer with more than a page of reports —
// the same defect as the master filter (Sampark-Mobile#2).
export const officerStatsResponse = z.object({
  // Cadres assigned to the caller.
  assignedCadres: z.number().int(),
  // Of those, how many have NO live report in the last 30 days — the same rule
  // `/stats/dashboard`'s `pendingReporting` uses, so "विलंबित" means the same thing
  // to an officer and to an admin looking at the same people.
  overdueCadres: z.number().int(),
  // assignedCadres - overdueCadres. Sent rather than left to client subtraction so
  // the two can never disagree mid-refresh.
  currentCadres: z.number().int(),
  // currentCadres / assignedCadres as a 0-100 integer. **0 when nothing is assigned**
  // — an officer with no cadres is not 100% complete, they have nothing to complete.
  reportingCompletion: z.number().int(),
  // Every report the caller has ever filed.
  totalReports: z.number().int(),
  // The caller's change requests still awaiting a decision (ADR-026).
  pendingChanges: z.number().int(),
  // Last 6 calendar months INCLUDING the current one, oldest first. Always exactly
  // 6 entries — months with no reports are returned as 0 rather than omitted, so the
  // client never has to invent a gap. `month` is `YYYY-MM` in **IST** (ADR-024): a
  // report filed 00:30 IST on the 1st belongs to that month, not the previous one.
  monthlyActivity: z.array(z.object({ month: z.string(), reports: z.number().int() })),
  // The caller's reports split by where the reporting happened.
  reportsByPlace: z.object({ thana: z.number().int(), village: z.number().int() }),
  // The caller's ASSIGNED cadres by category.
  cadresByCategory: z.object({
    surrendered: z.number().int(),
    jail: z.number().int(),
    thana: z.number().int(),
  }),
});

export type OfficerStats = z.infer<typeof officerStatsResponse>;

// ─── Hierarchy rollup (ADR-055) ────────────────────────────────────────────────
//
// The rolled-up view nobody above an officer had: an SDOP sees each of their own
// officers side by side; HQ sees each SDOP's consolidated number. Same admin+ gate
// as `/stats/dashboard` (ADR-030) — this is also an aggregate over people other
// than the caller, not something an officer could assemble from what they can see.
export const hierarchyRow = z.object({
  id: z.number().int(),
  name: z.string(),
  // Exactly one of the two is set, matching `level`: an officer row carries `thana`
  // (their station), an admin row carries `subDivision` (their SDOP division).
  thana: z.string().nullable(),
  subDivision: z.string().nullable(),
  assignedCadres: z.number().int(),
  // Same flat 30-day rule `/stats/me` uses (not the ADR-046 per-category cadence) —
  // this screen's numbers must never disagree with an officer's own reading of them.
  overdueCadres: z.number().int(),
  currentCadres: z.number().int(),
  reportingCompletion: z.number().int(),
});

export type HierarchyRow = z.infer<typeof hierarchyRow>;

// A THANA-level row (this task's extension of ADR-055): the dashboard's third card
// wants a per-thana completion breakdown, not per-officer or per-SDOP. Unlike
// `hierarchyRow`, "assignedCadres" here means every live cadre AT that thana
// (Cadre.thana), not just those with an assigned officer — a thana's reporting
// completion is a fact about the thana, not about staffing.
//
// Also unlike `hierarchyRow`: `currentCadres`/`overdueCadres`/`reportingCompletion`
// here are COVERAGE ("has this cadre ever had a live report filed, at all"), not
// RECENCY ("within the last REPORTING_CADENCE_DAYS", which is what those same
// field names mean on `hierarchyRow` and on `/stats/me`). A deliberate, client-
// requested divergence — see stats.service.ts's `hierarchy()` thana branch for
// the reasoning. Same field NAMES on purpose (the client already reads
// `reportingCompletion` off a thana row and needs no contract change), different
// MEANING — this is its own schema, never shared with `hierarchyRow`, precisely
// so the two can diverge like this safely.
export const hierarchyThanaRow = z.object({
  thana: z.string(),
  subDivision: z.string().nullable(),
  assignedCadres: z.number().int(),
  overdueCadres: z.number().int(),
  currentCadres: z.number().int(),
  reportingCompletion: z.number().int(),
});

export type HierarchyThanaRow = z.infer<typeof hierarchyThanaRow>;

const hierarchyRollupFields = {
  // SUM(currentCadres) / SUM(assignedCadres) across `rows` — the aggregate ratio,
  // never an average of each row's own percentage (ADR-055 Context §1).
  totalAssigned: z.number().int(),
  totalCurrent: z.number().int(),
  overallCompletion: z.number().int(),
  // Cadres in the caller's scope with no assigned officer. Excluded from the ratio
  // above — a staffing gap is not a specific officer's reporting lapse (ADR-055
  // Context §2) — and surfaced here instead of averaged away.
  unassignedCadres: z.number().int(),
};

// `level` tells the client which row shape came back — 'thanas' is requested with
// `?by=thana`; 'officers'/'admins' is the original ADR-055 behaviour, unchanged.
export const hierarchyStatsResponse = z.discriminatedUnion('level', [
  z.object({ level: z.literal('officers'), rows: z.array(hierarchyRow), ...hierarchyRollupFields }),
  z.object({ level: z.literal('admins'), rows: z.array(hierarchyRow), ...hierarchyRollupFields }),
  z.object({ level: z.literal('thanas'), rows: z.array(hierarchyThanaRow), ...hierarchyRollupFields }),
]);

export type HierarchyStats = z.infer<typeof hierarchyStatsResponse>;

// `?by=thana` opts into the thana-level breakdown; omitted keeps the original
// officer/admin behaviour.
//
// `?by=officer` (web stats page) opts an HQ caller into the per-OFFICER rows an SDOP
// already gets by default — HQ's default is one row per SDOP, which cannot show how
// individual officers compare. Same row shape and rule as the SDOP's own view.
export const hierarchyQuery = z.object({
  by: z.enum(['thana', 'officer']).optional(),
});

export type HierarchyQuery = z.infer<typeof hierarchyQuery>;

// ─── Daily reporting series (web stats page) ───────────────────────────────────
//
// One row per IST calendar day in [from, to], gaps filled with 0 — a day nobody
// reported is a real 0, not a hole for the chart to guess at. Two measures per day:
//   - reports:       every live report filed that day.
//   - uniqueCadres:  how many DIFFERENT cadres those reports covered (a cadre reported
//                    three times in a day counts once).
// `totals.uniqueCadres` is the distinct count over the WHOLE range, deliberately NOT the
// sum of the daily figures: a cadre reported on five different days is one cadre, and
// summing would count them five times.
const MAX_DAILY_SPAN_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

// `YYYY-MM-DD`, an IST calendar day. The round-trip check rejects a day that only looks
// valid ("2026-02-31") — Date.parse would otherwise roll it into March silently.
const istDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((v) => {
    const t = Date.parse(`${v}T00:00:00.000Z`);
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
  }, 'not a real calendar date');

// Narrow WITHIN the caller's scope, never beyond it — an officer asking for another
// thana gets an empty result, not that thana's numbers (ADR-044). Shared by every
// stats query below that accepts a region filter.
const thanaFilter = z.string().trim().min(1).max(100).transform(nfc).optional();
const subDivisionFilter = z.string().trim().min(1).max(100).transform(nfc).optional();

export const reportsDailyQuery = z
  .object({
    // Both or neither: omitted means "the last 30 IST days, today included".
    from: istDay.optional(),
    to: istDay.optional(),
    thana: thanaFilter,
    subDivision: subDivisionFilter,
  })
  .refine((q) => (q.from === undefined) === (q.to === undefined), {
    message: 'from and to must be given together',
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: 'from must not be after to',
  })
  .refine(
    (q) =>
      q.from === undefined ||
      q.to === undefined ||
      (Date.parse(`${q.to}T00:00:00.000Z`) - Date.parse(`${q.from}T00:00:00.000Z`)) / DAY_MS + 1 <=
        MAX_DAILY_SPAN_DAYS,
    { message: `range must not exceed ${MAX_DAILY_SPAN_DAYS} days` },
  );

export type ReportsDailyQuery = z.infer<typeof reportsDailyQuery>;

export const reportsDailyResponse = z.object({
  from: z.string(),
  to: z.string(),
  days: z.array(
    z.object({
      date: z.string(),
      reports: z.number().int(),
      uniqueCadres: z.number().int(),
    }),
  ),
  totals: z.object({
    reports: z.number().int(),
    uniqueCadres: z.number().int(),
  }),
});

export type ReportsDailyStats = z.infer<typeof reportsDailyResponse>;

// ─── Recency by thana (web stats page) ─────────────────────────────────────────
//
// The four ADR-041/046 recency tiers per thana. Built from the SAME `recencyTierWhere`
// the dashboard and `GET /cadres?recency` use, so a thana's tier count always equals the
// length of the list it would drill into. Every thana in scope gets a row, even at 0.
export const recencyByThanaRow = z.object({
  thana: z.string(),
  subDivision: z.string().nullable(),
  current: z.number().int(),
  overdue1m: z.number().int(),
  overdue2m: z.number().int(),
  overdue3m: z.number().int(),
  total: z.number().int(),
});

export const recencyByThanaResponse = z.object({ rows: z.array(recencyByThanaRow) });

export type RecencyByThanaRow = z.infer<typeof recencyByThanaRow>;
export type RecencyByThanaStats = z.infer<typeof recencyByThanaResponse>;

// ─── Cadre profile (web stats page) ────────────────────────────────────────────
//
// Who is on the register. Maoist register only (जेल/जमानत is a separate register, as on
// the dashboard). Every distribution carries its own `unknown` bucket and `coverage`
// says how many rows actually have each field: gender, caste, DOB and district are all
// nullable, and a chart that silently drops the blanks would read as complete when it is
// not. `category` narrows to one register; region filters narrow within the caller's scope.
export const cadreProfileQuery = z.object({
  category: z.enum(['surrendered', 'thana']).optional(),
  thana: thanaFilter,
  subDivision: subDivisionFilter,
});

export type CadreProfileQuery = z.infer<typeof cadreProfileQuery>;

// Top-N of an open-ended free-text field (caste, rank, district): the biggest values,
// then everything else folded into `other` (a long tail is not a chart), then the blanks.
const distribution = z.object({
  rows: z.array(z.object({ label: z.string(), count: z.number().int() })),
  other: z.number().int(),
  unknown: z.number().int(),
});

export type ProfileDistribution = z.infer<typeof distribution>;

export const cadreProfileResponse = z.object({
  total: z.number().int(),
  gender: z.object({ male: z.number().int(), female: z.number().int(), unknown: z.number().int() }),
  // Age is DERIVED from dateOfBirth (ADR-036) — never stored. `noDob` rows cannot be placed
  // in any band and are counted apart rather than guessed.
  age: z.object({
    bands: z.array(
      z.object({
        band: z.string(),
        male: z.number().int(),
        female: z.number().int(),
        unknownGender: z.number().int(),
      }),
    ),
    noDob: z.number().int(),
  }),
  caste: distribution,
  designation: distribution,
  post: distribution,
  district: distribution,
  // The register's priority grade (ADR-046) — `unset` is a cadre with no grade recorded yet.
  grade: z.object({
    A: z.number().int(),
    B: z.number().int(),
    C: z.number().int(),
    jail: z.number().int(),
    death: z.number().int(),
    unset: z.number().int(),
  }),
  // DVCM / ACM / PM rank class.
  rankClass: z.object({
    DVCM: z.number().int(),
    ACM: z.number().int(),
    PM: z.number().int(),
    unset: z.number().int(),
  }),
  // Permanent marks that exempt a cadre from reporting; `none` = no mark.
  permanentStatus: z.object({
    deceased: z.number().int(),
    government_job: z.number().int(),
    gs: z.number().int(),
    living_elsewhere: z.number().int(),
    untraceable: z.number().int(),
    none: z.number().int(),
  }),
  // Rows with each field filled — the fill-rate table.
  coverage: z.object({
    dateOfBirth: z.number().int(),
    gender: z.number().int(),
    caste: z.number().int(),
    district: z.number().int(),
    post: z.number().int(),
    rankClass: z.number().int(),
    grade: z.number().int(),
    photo: z.number().int(),
  }),
});

export type CadreProfileStats = z.infer<typeof cadreProfileResponse>;

// ─── Surrender trend (web stats page) ──────────────────────────────────────────
//
// The surrendered register (category = surrendered) grouped by surrender YEAR. The year
// comes from `surrenderDate` when there is one, else the 4 digits found in the free-text
// `surrenderYear` — older register rows carry only a year. A row with neither lands in the
// `year: null` group, returned last, so the total is never silently short.
//
// Per year: the origin split (ADR-019), the DVCM/ACM/PM split, and a reporting cohort —
// of the cadres who surrendered that year, how many are active (no permanent mark), how
// many of those reported in the last 30 days (the flat rule /stats/me and the hierarchy
// use), and how many are exempt (deceased / untraceable / another permanent mark).
export const surrendersQuery = z.object({
  thana: thanaFilter,
  subDivision: subDivisionFilter,
});

export type SurrendersQuery = z.infer<typeof surrendersQuery>;

export const surrenderYearRow = z.object({
  year: z.string().nullable(),
  total: z.number().int(),
  district: z.number().int(),
  otherDistrict: z.number().int(),
  otherState: z.number().int(),
  // Surrendered but origin (or the district/state sub-type) not classified yet.
  unclassified: z.number().int(),
  DVCM: z.number().int(),
  ACM: z.number().int(),
  PM: z.number().int(),
  otherRank: z.number().int(),
  active: z.number().int(),
  activeRecent: z.number().int(),
  deceased: z.number().int(),
  untraceable: z.number().int(),
  otherExempt: z.number().int(),
});

export const surrendersResponse = z.object({
  total: z.number().int(),
  years: z.array(surrenderYearRow),
});

export type SurrenderYearRow = z.infer<typeof surrenderYearRow>;
export type SurrendersStats = z.infer<typeof surrendersResponse>;
