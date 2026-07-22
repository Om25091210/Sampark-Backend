import type { FastifyInstance } from 'fastify';
import { makeStatsService } from './stats.service.js';
import { bearerAuth, jsonResponse } from '../../lib/openapi.js';

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
      // ADR-030: admin+. These are ORG-WIDE supervisory counts — every cadre, every
      // alert, everyone's reports. ADR-020 built them for the admin dashboard and
      // never gated them, so any authenticated user could read the whole
      // organisation's posture; an officer's own home rendered them.
      //
      // Unlike `assignedTo=me` (a filter over data the caller can already page
      // through), this is a genuine access boundary: an aggregate is not something
      // an officer could assemble for themselves from what they are allowed to see.
      preHandler: [app.authenticate, app.requireRole('admin', 'super_admin')],
      schema: {
        tags: ['Stats'],
        summary: 'Dashboard summary counts (admin+)',
        description:
          'Home-dashboard snapshot: total cadres, active (critical) alerts, reports in the ' +
          'last 7 days, cadres overdue on the 30-day reporting cadence, and per-category counts ' +
          '(surrendered split by origin per ADR-019). Admin+ only — org-wide supervisory data.',
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
}
