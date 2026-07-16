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
