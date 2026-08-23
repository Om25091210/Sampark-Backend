import { z } from 'zod';
import { nfc } from '../../lib/text.js';

// ─── Cadre creation requests ───────────────────────────────────────────────────
//
// The draft is keyed by the same camelCase Cadre field names cadre-changes.schema.ts's
// `fieldValue` already uses — this repo's existing precedent for a proposal payload,
// not the older generic snake_case-body convention.
//
// Deliberately restricted to the fields `cadre/[id]/edit.tsx` actually exposes today
// (verified by grep, not just by the Cadre/APPROVAL_FIELDS schema): `filter`,
// `regiment`, `permanentStatus`, `alertTag`/`aliases` are absent from the edit screen
// and stay absent here — the server sets safe defaults for all of them at apply time
// (see cadre-create-requests.service.ts's applyWithin). `assignedOfficerId` is also
// excluded: assigning it needs GET /officers, which is admin+ only, so a field
// officer creating a record could never populate it anyway — assignment happens
// afterward via the existing transfer flow.

const requiredCore = {
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(1).max(20),
  thana: z.string().trim().min(1).max(200).transform(nfc),
  currentAddress: z.string().trim().min(1).max(500),
  designation: z.string().trim().min(1).max(300),
  category: z.enum(['surrendered', 'jail', 'thana']),
};

// Same per-field validators as cadre-changes.schema.ts's `fieldValue` (kept in sync
// by hand — there is no shared constant between the two modules, matching the
// self-contained-module convention every other feature here follows).
const optionalFacts = {
  permanentAddress: z.string().trim().max(500).nullish(),
  residingVillage: z.string().trim().max(200).nullish(),
  verificationOffice: z.string().trim().max(300).nullish(),
  supervisoryOffice: z.string().trim().max(300).nullish(),
  incident: z.string().trim().max(4000).nullish(),
  surrenderLocation: z.string().trim().max(500).nullish(),
  surrenderYear: z.string().trim().max(10).nullish(),
  surrenderDate: z.string().datetime({ offset: true }).nullish(),
  surrenderOrigin: z.enum(['district', 'other']).nullish(),
  // This task. Sub-category of surrenderOrigin='other' (दीगर जिला/राज्य tabs) —
  // required at that point by the object-level refinement below.
  otherOriginType: z.enum(['other_district', 'other_state']).nullish(),
  familyGroupInfo: z.string().trim().max(2000).nullish(),
  subDivision: z.string().trim().max(200).nullish(),
  district: z.string().trim().max(200).nullish(),
  gender: z.enum(['male', 'female']).nullish(),
  caste: z.string().trim().max(200).nullish(),
  dateOfBirth: z.string().datetime({ offset: true }).nullish(),
  fatherName: z.string().trim().max(200).nullish(),
  motherName: z.string().trim().max(200).nullish(),
  spouseName: z.string().trim().max(200).nullish(),
  priorityCategory: z.enum(['A', 'B', 'C', 'jail', 'death']).nullish(),
  hasAadhaar: z.boolean().default(false),
  hasBankAccount: z.boolean().default(false),
  hasAbProforma: z.boolean().default(false),
  hasAgreementLetter: z.boolean().default(false),
  // Keys returned by POST /cadre-create-requests/avatar/upload — never a client-
  // invented path, same guardrail as avatarKey on the change-request schema.
  avatarKey: z.string().trim().min(1).max(1024).nullish(),
  avatarKey2: z.string().trim().min(1).max(1024).nullish(),
  avatarKey3: z.string().trim().min(1).max(1024).nullish(),
};

// This task: `otherOriginType` is mandatory once surrenderOrigin='other' is chosen
// (the create-cadre form's second sub-dropdown), same "required at this point in the
// choice tree" posture as the four top-level category choices themselves.
export const createCadreDraftSchema = z
  .object({ ...requiredCore, ...optionalFacts })
  .strict()
  .refine((d) => d.surrenderOrigin !== 'other' || d.otherOriginType != null, {
    message: 'otherOriginType is required when surrenderOrigin is other',
    path: ['otherOriginType'],
  });
export type CreateCadreDraft = z.infer<typeof createCadreDraftSchema>;

export const submitCreateRequestBody = z.object({
  draft: createCadreDraftSchema,
  note: z.string().trim().max(1000).optional(),
});

export const rejectCreateRequestBody = z.object({
  reason: z.string().trim().min(1).max(1000),
});

export const listCreateRequestsQuery = z.object({
  status: z.enum(['pending', 'applied', 'rejected', 'cancelled']).optional(),
  // `me` resolves server-side to the caller — the officer's "what happened to my
  // submissions" view, same convention as listChangesQuery.
  submittedBy: z.union([z.literal('me'), z.coerce.number().int().positive()]).optional(),
  // The approver queue: only what THIS caller can act on next.
  awaitingMe: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(15),
});

export const createRequestIdParam = z.object({ id: z.coerce.number().int().positive() });

export type SubmitCreateRequestBody = z.infer<typeof submitCreateRequestBody>;
export type RejectCreateRequestBody = z.infer<typeof rejectCreateRequestBody>;
export type ListCreateRequestsQuery = z.infer<typeof listCreateRequestsQuery>;

// What the service receives once the route resolves the `me` sentinel.
export type ResolvedListCreateRequestsQuery = Omit<ListCreateRequestsQuery, 'submittedBy'> & {
  submittedBy?: number;
};
