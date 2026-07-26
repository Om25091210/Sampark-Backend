import type { FastifyInstance } from 'fastify';
import { makeStatsService } from './stats.service.js';
import { hierarchyQuery } from './stats.schema.js';
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
          'for an officer, sub-division for an admin, everything for super_admin).',
        security: bearerAuth,
        response: { 200: jsonResponse('Dashboard stats', EXAMPLE_DASHBOARD_STATS) },
      },
    },
    async (request) => service.dashboard(request.scope!),
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
          'counting every live cadre at that thana rather than just assigned ones.',
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
}
