import { z } from 'zod';

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
  // Per-category counts backing the dashboard grid tiles. `surrendered` splits on
  // surrenderOrigin (ADR-019) because the dashboard shows the two as separate tiles.
  byCategory: z.object({
    surrendered: z.object({
      district: z.number().int(),
      other: z.number().int(),
      total: z.number().int(),
    }),
    thana: z.number().int(),
    jail: z.number().int(),
  }),
});

export type DashboardStats = z.infer<typeof dashboardStatsResponse>;
