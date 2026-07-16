import { z } from 'zod';

// Path params. Reports are always addressed under their cadre.
export const reportCadreParam = z.object({ cadreId: z.coerce.number().int().positive() });
export const reportDetailParams = z.object({
  cadreId: z.coerce.number().int().positive(),
  reportId: z.coerce.number().int().positive(),
});

// List query params are camelCase (per the client contract).
//
// ADR-024: the per-cadre report log filters by DATE ONLY — free-text `search` was
// removed. A cadre's log is a chronological record an officer scans by "when",
// not by remembering a phrase someone typed into `currentActivity`. An old client
// still sending `search` is not rejected: Zod's non-strict parse strips unknown
// keys, so the param is ignored rather than 400-ing a field officer mid-task.
//
// `date` is a CALENDAR DAY in India Standard Time (see the range helper in the
// service), not a UTC day and not a timestamp.
export const listReportsQuery = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00.000Z`)), 'date is not a real calendar date')
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(15),
});

// The aggregate feed (ADR-021): reports across every cadre, for the officer's own
// "reporting record". `reportedBy=me` resolves to the caller in the route;
// `reportedBy=<officerId>` scopes to that officer. Like ADR-018's `assignedTo`, it
// is a filter, not an access boundary — the per-cadre feed is already open to any
// authenticated user.
export const listAllReportsQuery = z.object({
  reportedBy: z.union([z.literal('me'), z.coerce.number().int().positive()]).optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(15),
});

export type ListAllReportsQuery = z.infer<typeof listAllReportsQuery>;

// What the service receives after the route resolves the `me` sentinel.
export type ResolvedListAllReportsQuery = Omit<ListAllReportsQuery, 'reportedBy'> & {
  reportedBy?: number;
};

// Create body is snake_case (per the client contract). Unknown keys the client
// sends but the core contract doesn't model are stripped by Zod's default
// (non-strict) parse.
export const createReportBody = z.object({
  // Path is authoritative; body `cadre_id` (always sent by the client) is
  // optional here and cross-checked in the route.
  cadre_id: z.number().int().positive().optional(),
  reporting_place: z.enum(['thana', 'village']),
  specific_location: z.string().trim().min(1).max(500),
  person_status: z.enum(['alive', 'dead']),
  current_phone: z.string().trim().min(1).max(20),
  current_activity: z.string().trim().min(1).max(1000),
  // The date the officer picked in the form — the date the reporting actually
  // happened, which is NOT the row's insert time: an offline report composed on
  // Monday may only drain on Thursday. Persisted to `reportedAt`; `createdAt`
  // keeps the true insert time. Offset form accepted (the client sends UTC `Z`).
  // Deliberately NOT rejected when in the future — the mobile drain treats every
  // error the same and drops the action after 3 retries, so a 400 here would
  // silently destroy a field report. The service clamps instead.
  selected_date: z.string().datetime({ offset: true }).optional(),
  // Legacy single-photo URL (kept for back-compat with older clients).
  photo_url: z.string().trim().max(2048).optional(),
  // ADR-016: durable S3 keys returned by the upload endpoint. The UI allows up to
  // 3 photos per report; the backend re-signs these keys to URLs on read.
  photo_keys: z.array(z.string().trim().min(1).max(1024)).max(3).optional(),
  gps_coords: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
      address: z.string().max(500),
    })
    .optional(),
  is_home_address: z.boolean().optional(),
  // ADR-013: client-generated UUID v4, unique per logical action, stable across
  // offline retries. Optional for now; effectively required once the mobile sync
  // change ships. When present, the create dedupes on it.
  idempotency_key: z.string().uuid().optional(),
});

export type ListReportsQuery = z.infer<typeof listReportsQuery>;
export type CreateReportBody = z.infer<typeof createReportBody>;
