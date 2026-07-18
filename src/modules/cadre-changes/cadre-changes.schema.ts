import { z } from 'zod';
import { ALERT_TAGS } from '../../lib/alert-tags.js';
import { APPROVAL_FIELDS } from './cadre-changes.policy.js';

// ─── Cadre change requests (ADR-026) ──────────────────────────────────────────
//
// Request bodies are snake_case, entity responses camelCase — the existing client
// contract, not a new convention.

// Per-field value validation. A change request writes real cadre columns, so the
// proposed values get the same scrutiny a direct write would: without this, the
// approval chain becomes a laundering route for values Zod would reject anywhere
// else, and the failure surfaces at APPLY time — after two people approved it.
const fieldValue = {
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(1).max(20),
  thana: z.string().trim().min(1).max(200),
  currentAddress: z.string().trim().min(1).max(500),
  permanentAddress: z.string().trim().max(500).nullable(),
  designation: z.string().trim().min(1).max(300),
  incident: z.string().trim().max(4000).nullable(),
  verificationOffice: z.string().trim().max(300).nullable(),
  supervisoryOffice: z.string().trim().max(300).nullable(),
  surrenderDate: z.string().datetime({ offset: true }).nullable(),
  surrenderLocation: z.string().trim().max(500).nullable(),
  surrenderOrigin: z.enum(['district', 'other']).nullable(),
  surrenderYear: z.string().trim().max(10).nullable(),
  regiment: z.string().trim().max(200).nullable(),
  familyGroupInfo: z.string().trim().max(2000).nullable(),
  subDivision: z.string().trim().max(200).nullable(),
  hasAadhaar: z.boolean(),
  hasBankAccount: z.boolean(),
  hasAbProforma: z.boolean(),
  hasAgreementLetter: z.boolean(),
  // A key returned by POST /cadres/:cadreId/avatar/upload — never a URL, and never
  // a path the client invents: an unchecked string here would let a caller point a
  // cadre's photo at any object in the bucket.
  avatarKey: z.string().trim().min(1).max(1024).nullable(),
  // ADR-036. An ISO datetime like surrenderDate; the service coerces it to a Date
  // (DATE_FIELDS) and the column is `@db.Date`, so only the date part is stored.
  // A future birth date is not validated here — it is nonsensical but harmless, and
  // the register may carry a bad value the import must round-trip faithfully rather
  // than reject.
  dateOfBirth: z.string().datetime({ offset: true }).nullable(),
  fatherName: z.string().trim().max(200).nullable(),
  motherName: z.string().trim().max(200).nullable(),
  spouseName: z.string().trim().max(200).nullable(),
} as const satisfies Record<(typeof APPROVAL_FIELDS)[number], z.ZodTypeAny>;

export const changeableFieldsSchema = z.object(fieldValue).partial();
export type ChangeableFields = z.infer<typeof changeableFieldsSchema>;

export const submitChangeBody = z.object({
  // The proposed values, keyed by cadre field. At least one required — an empty
  // request would occupy an approver for nothing.
  changes: changeableFieldsSchema.refine(
    (c) => Object.keys(c).length > 0,
    'at least one field must be proposed',
  ),
  note: z.string().trim().max(1000).optional(),
});

export const rejectChangeBody = z.object({
  // Required, not optional. An officer told only "rejected" learns nothing and
  // resubmits the same thing — which wastes the approver's time next, not theirs.
  reason: z.string().trim().min(1).max(1000),
});

export const listChangesQuery = z.object({
  status: z.enum(['pending', 'applied', 'rejected', 'cancelled', 'stale']).optional(),
  // `me` resolves to the caller — the officer's "what happened to my edits" view.
  submittedBy: z.union([z.literal('me'), z.coerce.number().int().positive()]).optional(),
  cadreId: z.coerce.number().int().positive().optional(),
  // The approver queue: only what THIS caller can act on next.
  awaitingMe: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(15),
});

export const changeIdParam = z.object({ id: z.coerce.number().int().positive() });
export const cadreIdParam = z.object({ cadreId: z.coerce.number().int().positive() });

export type SubmitChangeBody = z.infer<typeof submitChangeBody>;
export type RejectChangeBody = z.infer<typeof rejectChangeBody>;
export type ListChangesQuery = z.infer<typeof listChangesQuery>;

// What the service receives once the route resolves the `me` sentinel.
export type ResolvedListChangesQuery = Omit<ListChangesQuery, 'submittedBy'> & {
  submittedBy?: number;
};

// ─── Direct writes (ADR-026) ──────────────────────────────────────────────────
//
// Tags/aliases only — the fields the maintainer put outside the approval chain
// because they are filtering tools, not facts of record. Everything else must go
// through a change request; the route rejects approval-gated keys here rather
// than silently ignoring them.
// `.strict()` is load-bearing: Zod strips unknown keys by default, so without it a
// client PATCHing `phone` here would get a 204 and no phone change — a write that
// reports success and does nothing. That is the phantom-write bug this codebase has
// already shipped twice (the tag picker, the alias sheet). Approval-gated fields
// sent here must 400 and say so.
export const patchCadreBody = z
  .object({
    // ADR-033: constrained to the catalogue, not a free string. `alertLevel` is
    // derived from this value, so an unrecognised tag would silently land as
    // `normal` — a red-looking badge filed under "no alert". Reject it at the edge.
    alertTag: z.enum(ALERT_TAGS).nullable(),
    aliases: z.array(z.string().trim().min(1).max(100)).max(20),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'at least one field must be provided');

export type PatchCadreBody = z.infer<typeof patchCadreBody>;
