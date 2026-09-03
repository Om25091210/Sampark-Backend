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
  // Drill-down for the dashboard's "इस सप्ताह रिपोर्ट" tile — same `reportedAt >=`
  // cutoff /stats/dashboard's reportsThisWeek count uses, so the tile's count
  // always equals the length of the list it opens.
  reportedAfter: z.string().datetime({ offset: true }).optional(),
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
// Exported (not `const`, unlike before this task) so sync.schema.ts's push
// variant can `.extend()` it — `.extend()` only exists on a ZodObject, not on
// the refined `createReportBody` below (a ZodEffects once `.superRefine` wraps
// it). The push variant re-applies `checkDeathRequirements` itself after
// extending, so the two request shapes can never validate death-report
// requirements differently.
export const createReportBodyShape = z.object({
  // Path is authoritative; body `cadre_id` (always sent by the client) is
  // optional here and cross-checked in the route.
  cadre_id: z.number().int().positive().optional(),
  reporting_place: z.enum(['thana', 'village']),
  // This task. NOT required at the object level any more — see the
  // person_status='dead' branch of the superRefine below. Still required for
  // an 'alive' report, enforced there rather than here.
  specific_location: z.string().trim().max(500).optional(),
  person_status: z.enum(['alive', 'dead']),
  current_phone: z.string().trim().max(20).optional(),
  // ADR-050. The three-field split of the old single "वर्तमान विवरण" field.
  // current_activity ("वर्तमान में क्या कार्य कर रहा है") stayed required for an
  // 'alive' report — same enforcement note as specific_location above. The
  // other two are optional regardless: not every report has a
  // related-Maoists angle or extra notes.
  current_activity: z.string().trim().max(1000).optional(),
  surrender_network_details: z.string().trim().max(1000).optional(),
  // This task. Stays optional at this level for an 'alive' report, but becomes
  // the ONE required field for person_status='dead' — where the officer has
  // just marked death, अन्य जानकारी is the only place left to describe what
  // was learned (cause, circumstances, who reported it).
  other_information: z.string().trim().max(1000).optional(),
  // The date the officer picked in the form — the date the reporting actually
  // happened, which is NOT the row's insert time: an offline report composed on
  // Monday may only drain on Thursday. Persisted to `reportedAt`; `createdAt`
  // keeps the true insert time. Offset form accepted (the client sends UTC `Z`).
  // Deliberately NOT rejected when in the future — the mobile drain treats every
  // error the same and drops the action after 3 retries, so a 400 here would
  // silently destroy a field report. The service clamps instead.
  selected_date: z.string().datetime({ offset: true }).optional(),
  // This task. The confirmed date of death, from the create-report.tsx death-date
  // dialog. Required (see superRefine) exactly when person_status='dead' — this is
  // the value report-time death sync proposes as the cadre's deceasedDate,
  // bundled with permanentStatus='deceased' in ONE change request (reports.service.ts).
  // Never persisted on the report row itself: the date of death is a fact about
  // the CADRE, not about this report, and the master profile (once the ladder
  // approves it) is the one authoritative place for it.
  death_date: z.string().datetime({ offset: true }).optional(),
  // Legacy single-photo URL (kept for back-compat with older clients).
  photo_url: z.string().trim().max(2048).optional(),
  // ADR-016: durable S3 keys returned by the upload endpoint. The UI allows up to
  // 3 photos per report; the backend re-signs these keys to URLs on read.
  photo_keys: z.array(z.string().trim().min(1).max(1024)).max(3).optional(),
  // This task. The report's photo capture is three POSITIONAL slots — front /
  // right / left profile — distinct from `photo_keys` above (which is just the
  // report's own photo gallery, order-agnostic). These three are what
  // report-time photo sync (mirrors ADR-052's phone sync) proposes onto the
  // cadre's avatarKey/avatarKey2/avatarKey3. All optional and independent —
  // the client is NOT required to capture all three, only whichever it has.
  front_photo_key: z.string().trim().min(1).max(1024).optional(),
  right_photo_key: z.string().trim().min(1).max(1024).optional(),
  left_photo_key: z.string().trim().min(1).max(1024).optional(),
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

// This task. Every 'alive' report still needs the three fields it always did;
// a 'dead' report needs none of them but DOES need other_information and
// death_date — split out of the base shape (rather than each field's own
// z.string().min(1)) so the message names which branch is missing what, not a
// generic "required" on a field the other branch never asked for. Exported so
// sync.schema.ts's push variant (a `.extend()` of the shape above, so it can't
// use this file's own `.superRefine()`) applies the exact same rule.
export function checkDeathRequirements(
  body: {
    person_status: 'alive' | 'dead';
    specific_location?: string;
    current_phone?: string;
    current_activity?: string;
    other_information?: string;
    death_date?: string;
  },
  ctx: z.RefinementCtx,
): void {
  if (body.person_status === 'dead') {
    if (!body.other_information || body.other_information.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        message: 'other_information is required when person_status is dead',
        path: ['other_information'],
      });
    }
    if (!body.death_date) {
      ctx.addIssue({
        code: 'custom',
        message: 'death_date is required when person_status is dead',
        path: ['death_date'],
      });
    }
  } else {
    if (!body.specific_location || body.specific_location.trim() === '') {
      ctx.addIssue({ code: 'custom', message: 'specific_location is required', path: ['specific_location'] });
    }
    if (!body.current_phone || body.current_phone.trim() === '') {
      ctx.addIssue({ code: 'custom', message: 'current_phone is required', path: ['current_phone'] });
    }
    if (!body.current_activity || body.current_activity.trim() === '') {
      ctx.addIssue({ code: 'custom', message: 'current_activity is required', path: ['current_activity'] });
    }
  }
}

export const createReportBody = createReportBodyShape.superRefine(checkDeathRequirements);

export type ListReportsQuery = z.infer<typeof listReportsQuery>;
export type CreateReportBody = z.infer<typeof createReportBody>;
