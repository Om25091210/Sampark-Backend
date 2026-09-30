import type { FastifyInstance } from 'fastify';
import { makeStatsService } from './stats.service.js';
import {
  cadreProfileQuery,
  dashboardQuery,
  hierarchyQuery,
  reportsDailyQuery,
  surrendersQuery,
} from './stats.schema.js';
import { bearerAuth, jsonResponse, zodToJson } from '../../lib/openapi.js';

const EXAMPLE_DASHBOARD_STATS = {
  totalCadres: 4868,
  activeAlerts: 12,
  reportsThisWeek: 34,
  pendingReporting: 7,
  byCategory: {
    surrendered: { district: 1478, other: 312, total: 1790 },
    thana: 3000,
    jail: 78,
  },
  alertLevelBreakdown: { normal: 79, warning: 18, critical: 3 },
};

const EXAMPLE_HIERARCHY_STATS = {
  level: 'officers',
  rows: [
    { id: 12, name: 'SHOGNGL07', thana: 'गंगालूर', subDivision: null, assignedCadres: 6, overdueCadres: 1, currentCadres: 5, reportingCompletion: 83 },
  ],
  totalAssigned: 6,
  totalCurrent: 5,
  overallCompletion: 83,
  unassignedCadres: 2,
};

const EXAMPLE_OFFICER_STATS = {
  assignedCadres: 4,
  overdueCadres: 1,
  currentCadres: 3,
  reportingCompletion: 75,
  totalReports: 12,
  pendingChanges: 0,
  monthlyActivity: [
    { month: '2026-02', reports: 1 },
    { month: '2026-03', reports: 0 },
    { month: '2026-04', reports: 2 },
    { month: '2026-05', reports: 4 },
    { month: '2026-06', reports: 3 },
    { month: '2026-07', reports: 2 },
  ],
  reportsByPlace: { thana: 9, village: 3 },
  cadresByCategory: { surrendered: 2, jail: 1, thana: 1 },
};

const EXAMPLE_REPORTS_DAILY = {
  from: '2026-09-01',
  to: '2026-09-03',
  days: [
    { date: '2026-09-01', reports: 14, uniqueCadres: 11 },
    { date: '2026-09-02', reports: 0, uniqueCadres: 0 },
    { date: '2026-09-03', reports: 9, uniqueCadres: 9 },
  ],
  totals: { reports: 23, uniqueCadres: 19 },
};

// Stats. Two endpoints, two different questions:
//   /stats/dashboard — ORG-WIDE, admin+ (ADR-030).
//   /stats/me        — the CALLER's own, any authenticated user (ADR-031).
//
// This file used to carry the reasoning that shipped a leak: "aggregate counts an
// authenticated user could already derive by paging the cadre list, so there is no
// access boundary to add — the same reasoning as the `assignedTo` filter". That is
// wrong and is corrected in ADR-030. `assignedTo=me` narrows rows the caller can
// already fetch; an AGGREGATE is a new fact about the whole force that no amount of
// paging hands them. The rule the two endpoints below encode: scoping to the caller
// needs no gate, summarising everyone does.
export async function statsRoutes(app: FastifyInstance): Promise<void> {
  const service = makeStatsService({ prisma: app.prisma, log: app.log });

  app.get(
    '/stats/dashboard',
    {
      // ADR-030 (revised this task, item 4). Originally admin+ only: ADR-020 built
      // these counts unscoped and unbounded, so any authenticated user reading them
      // got the WHOLE organisation's posture. ADR-044 scoping has since made every
      // number here pass through `cadreScopeWhere(scope)` — a super_admin gets
      // everything, an admin gets their sub-division, and (as of this task) an
      // OFFICER gets exactly their own single thana. That officer scope is no wider
      // than what `GET /cadres` already hands them (open to any authenticated
      // user, ADR-044-scoped) — the same "scoping to the caller needs no gate"
      // reasoning ADR-031 draws for `/stats/me`. What ADR-030 actually guards
      // against — an officer reading counts OUTSIDE their own scope — is still
      // fully enforced by `cadreScopeWhere`, not by the role check.
      preHandler: [app.authenticate, app.requireRole('officer', 'admin', 'super_admin')],
      schema: {
        tags: ['Stats'],
        summary: 'Dashboard summary counts, scoped to the caller (officer+)',
        description:
          'Home-dashboard snapshot: total cadres, active (critical) alerts, reports in the ' +
          'last 7 days, cadres overdue on the 30-day reporting cadence, and per-category counts ' +
          '(surrendered split by origin per ADR-019) — all scoped to the caller (their own thana ' +
          'for an officer, sub-division for an admin, everything for super_admin). Optional ' +
          '`category`/`surrenderOrigin`/`otherOriginType` (same vocabulary as GET /cadres) narrow ' +
          'the same snapshot to one category-section screen instead of the whole caller scope.',
        security: bearerAuth,
        querystring: zodToJson(dashboardQuery),
        response: { 200: jsonResponse('Dashboard stats', EXAMPLE_DASHBOARD_STATS) },
      },
    },
    async (request) => {
      const filter = dashboardQuery.parse(request.query);
      return service.dashboard(request.scope!, filter);
    },
  );

  // ADR-031. The caller's OWN numbers. No role gate beyond authentication: unlike
  // /stats/dashboard (org-wide, admin+ per ADR-030) this only ever describes the
  // caller, so there is nothing here they are not entitled to. The officer id comes
  // from the token, never a query param — a `?officerId=` would turn a personal
  // endpoint into an oversight one and re-open exactly the hole ADR-030 closed.
  app.get(
    '/stats/me',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Stats'],
        summary: 'The caller’s own reporting stats',
        description:
          'Personal summary for the officer dashboard: assigned cadres, how many are overdue on the ' +
          '30-day cadence (same rule as /stats/dashboard’s pendingReporting), reporting completion, ' +
          'total reports, pending change requests, a 6-month activity series (IST months, gaps filled ' +
          'with 0), reports by place, and assigned cadres by category. Aggregated in SQL over the ' +
          'officer’s whole history — not a page of it.',
        security: bearerAuth,
        response: { 200: jsonResponse('Officer stats', EXAMPLE_OFFICER_STATS) },
      },
    },
    async (request) => service.forOfficer(request.authUser!.sub, request.scope!),
  );

  // ADR-055. The rolled-up view: an SDOP sees each of their own officers side by
  // side, HQ sees each SDOP's consolidated number. Same admin+ gate as
  // /stats/dashboard (ADR-030) — which row shape comes back is derived from the
  // caller's own resolved scope (ADR-044), not a second role check.
  app.get(
    '/stats/hierarchy',
    {
      preHandler: [app.authenticate, app.requireRole('admin', 'super_admin')],
      schema: {
        tags: ['Stats'],
        summary:
          'Rolled-up completion by officer (SDOP caller), by SDOP (HQ caller), or by thana (?by=thana)',
        description:
          'An SDOP (admin) gets one row per officer in their own sub-division. HQ (super_admin) ' +
          'gets one row per SDOP, each summing that SDOP\'s officer rows. Every row is shaped like ' +
          '/stats/me (assignedCadres/overdueCadres/currentCadres/reportingCompletion, same flat ' +
          '30-day overdue rule). The response also carries the group rollup as an aggregate ratio ' +
          '(SUM currentCadres / SUM assignedCadres — never an average of the rows\' own percentages) ' +
          'and unassignedCadres, excluded from that ratio because a cadre nobody is assigned to is a ' +
          'staffing gap, not a specific officer\'s reporting lapse. `?by=thana` returns one row per ' +
          'thana in the caller\'s scope instead (HQ: all 22; admin: their own sub-division\'s), ' +
          'counting every live cadre at that thana rather than just assigned ones. `?by=officer` ' +
          'gives an HQ caller the per-officer rows an SDOP already gets by default.',
        security: bearerAuth,
        querystring: zodToJson(hierarchyQuery),
        response: { 200: jsonResponse('Hierarchy stats', EXAMPLE_HIERARCHY_STATS) },
      },
    },
    async (request) => {
      const { by } = hierarchyQuery.parse(request.query);
      return service.hierarchy(request.scope!, { by });
    },
  );

  // Web stats page — the four endpoints below share /stats/dashboard's officer+ gate and
  // scoping: every number is bounded by the caller's own scope (ADR-044), so an officer
  // reads only their own thana and an SDOP only their sub-division.
  app.get(
    '/stats/recency-by-thana',
    {
      preHandler: [app.authenticate, app.requireRole('officer', 'admin', 'super_admin')],
      schema: {
        tags: ['Stats'],
        summary: 'Reporting-recency tier counts per thana, scoped to the caller (officer+)',
        description:
          'One row per thana in the caller\'s scope (HQ: all 22), each with the four ADR-041/046 ' +
          'recency tiers — built from the same clause as `GET /cadres?recency`, so a count equals ' +
          'the list it drills into. The four sum to `total`. जेल/जमानत is excluded.',
        security: bearerAuth,
        response: {
          200: jsonResponse('Recency by thana', {
            rows: [{ thana: 'गंगालूर', subDivision: 'गंगालूर', current: 8, overdue1m: 2, overdue2m: 1, overdue3m: 3, total: 14 }],
          }),
        },
      },
    },
    async (request) => service.recencyByThana(request.scope!),
  );

  app.get(
    '/stats/cadre-profile',
    {
      preHandler: [app.authenticate, app.requireRole('officer', 'admin', 'super_admin')],
      schema: {
        tags: ['Stats'],
        summary: 'Who is on the register: gender, age, caste, rank, grade, fill rates (officer+)',
        description:
          'Distributions over the Maoist register (जेल/जमानत excluded), scoped to the caller. Every ' +
          'distribution carries an `unknown` bucket and `coverage` counts the rows with each field ' +
          'filled — gender, caste, DOB and district are nullable and must not read as complete. ' +
          'Age is derived from dateOfBirth. Open-ended text fields return their top 10 plus `other`. ' +
          'Optional `category`, `thana`, `subDivision` narrow within the caller\'s scope.',
        security: bearerAuth,
        querystring: zodToJson(cadreProfileQuery),
        response: {
          200: jsonResponse('Cadre profile', {
            total: 1790,
            gender: { male: 1400, female: 300, unknown: 90 },
            age: { bands: [{ band: '30-39', male: 500, female: 100, unknownGender: 20 }], noDob: 210 },
            caste: { rows: [{ label: 'गोंड', count: 900 }], other: 120, unknown: 320 },
            coverage: { dateOfBirth: 1580, gender: 1700, caste: 1470, district: 1200, post: 1478, rankClass: 900, grade: 1500, photo: 1100 },
          }),
        },
      },
    },
    async (request) => service.cadreProfile(request.scope!, cadreProfileQuery.parse(request.query)),
  );

  app.get(
    '/stats/surrenders',
    {
      preHandler: [app.authenticate, app.requireRole('officer', 'admin', 'super_admin')],
      schema: {
        tags: ['Stats'],
        summary: 'Surrendered register by surrender year, with a reporting cohort (officer+)',
        description:
          'One row per surrender year (from surrenderDate, else the 4 digits of the free-text ' +
          'surrenderYear; a row with neither is `year: null`, last). Each carries the origin split ' +
          '(ADR-019), the DVCM/ACM/PM split, and a cohort: active (no permanent mark), how many of ' +
          'those reported in the last 30 days, and how many are exempt (deceased / untraceable / ' +
          'other). Scoped to the caller; optional `thana`/`subDivision` narrow within it.',
        security: bearerAuth,
        querystring: zodToJson(surrendersQuery),
        response: {
          200: jsonResponse('Surrender trend', {
            total: 1790,
            years: [
              {
                year: '2024', total: 210, district: 150, otherDistrict: 30, otherState: 20, unclassified: 10,
                DVCM: 5, ACM: 40, PM: 150, otherRank: 15, active: 200, activeRecent: 160, deceased: 6, untraceable: 4, otherExempt: 0,
              },
            ],
          }),
        },
      },
    },
    async (request) => service.surrenders(request.scope!, surrendersQuery.parse(request.query)),
  );

  app.get(
    '/stats/reports/daily',
    {
      preHandler: [app.authenticate, app.requireRole('officer', 'admin', 'super_admin')],
      schema: {
        tags: ['Stats'],
        summary: 'Reports and distinct cadres reported per IST day, scoped to the caller (officer+)',
        description:
          'One row per IST calendar day in [from, to] (default: the last 30 days), gaps filled with ' +
          '0. `reports` counts every live report that day; `uniqueCadres` counts how many different ' +
          'cadres they covered. `totals.uniqueCadres` is distinct over the whole range, not the sum ' +
          'of the daily figures. Range is capped at 366 days. Optional `thana`/`subDivision` narrow ' +
          'within the caller\'s scope, never beyond it. जेल/जमानत is excluded, as on the dashboard.',
        security: bearerAuth,
        querystring: zodToJson(reportsDailyQuery),
        response: { 200: jsonResponse('Daily reporting series', EXAMPLE_REPORTS_DAILY) },
      },
    },
    async (request) => service.reportsDaily(request.scope!, reportsDailyQuery.parse(request.query)),
  );
}
