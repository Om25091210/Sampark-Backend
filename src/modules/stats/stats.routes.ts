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

// Dashboard summary counts (ADR-020). Authenticated, any role: these are aggregate
// counts an authenticated user could already derive by paging the cadre list, so
// there is no access boundary to add — the same reasoning as the `assignedTo`
// filter (ADR-018). Officers see the stats page too, not only admins.
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
    async () => service.dashboard(),
  );
}
