import { z } from 'zod';

// ─── B Proforma (ADR-064 addendum) ─────────────────────────────────────────────
//
// Field slugs follow `B Proforma ( To be filled every two months ).docx`, read
// this session via Python's stdlib zipfile/xml.etree. Request bodies are
// snake_case, entity responses camelCase — the existing client contract.

const t = (max: number) => z.string().trim().max(max).nullable();
const shortText = t(500);
const longText = t(2000);

const addressDetails = z.object({
  village: z.string().trim().max(200).default(''),
  thana: z.string().trim().max(200).default(''),
  district: z.string().trim().max(200).default(''),
  state: z.string().trim().max(200).default(''),
  phone: z.string().trim().max(20).default(''),
});
export type AddressDetails = z.infer<typeof addressDetails>;

export const proformaBFieldsSchema = z.object({
  // Items 1-3, 6, 6a — fetched from Cadre by the new-draft endpoint, editable here.
  fullNameWithAlias: z.string().trim().min(1).max(300),
  nativeAddress: addressDetails,
  currentAddressDetails: addressDetails,
  surrenderDate: z.string().datetime({ offset: true }).nullable(),
  surrenderPlaceAndBy: shortText,

  // Items 4/4a-c, 5/5a-b, 8/8a, 10, 11, 13 — carry-forward.
  ownHouseDetails: longText,
  agriculturalLandDetails: longText,
  vehicleDetails: longText,
  familyEducationDetails: longText,
  familyEmploymentDetails: longText,
  priorCriminalCases: longText,
  aadhaarVoterCardStatus: longText,
  bankDetails: longText,
  healthCondition: longText,

  // Items 6b/6c, 7/7a-c, 8b, 9/9a-b, 10b, 11b, 12/12a, 14-19 — blank every time.
  handlerDetails: shortText,
  liaisonOfficerDetails: shortText,
  currentWorkTypeAndPlace: shortText,
  employerDetails: shortText,
  wageDetails: shortText,
  newCriminalCases: longText,
  fullRewardReceivedDetails: longText,
  pendingRewardStatus: longText,
  applicationDateAndPlace: shortText,
  applicationStatus: shortText,
  rewardWithdrawn: shortText,
  rewardUsageDetails: longText,
  currentMaoistContact: shortText,
  contactWithWhom: shortText,
  newSkillsLearned: longText,
  needsAndRequirements: longText,
  maoistMovementInfo: longText,
  maoistContactAttempt: longText,
  otherSurrenderedArrestedInfo: longText,
  anyProblems: longText,

  // Item 20 — returned by POST /cadres/:cadreId/proforma-b/upload.
  currentPhotoKey: t(1024),
});
export type ProformaBFields = z.infer<typeof proformaBFieldsSchema>;

export const proformaBFieldsPartial = proformaBFieldsSchema.partial();
export type ProformaBFieldsPartial = z.infer<typeof proformaBFieldsPartial>;

export const submitProformaBCreateBody = z.object({
  fields: proformaBFieldsSchema,
  note: z.string().trim().max(1000).optional(),
  idempotency_key: z.string().uuid().optional(),
});
export type SubmitProformaBCreateBody = z.infer<typeof submitProformaBCreateBody>;

export const submitProformaBEditBody = z.object({
  changes: proformaBFieldsPartial.refine(
    (c) => Object.keys(c).length > 0,
    'at least one field must be proposed',
  ),
  note: z.string().trim().max(1000).optional(),
  idempotency_key: z.string().uuid().optional(),
});
export type SubmitProformaBEditBody = z.infer<typeof submitProformaBEditBody>;

export const rejectProformaBChangeBody = z.object({
  reason: z.string().trim().min(1).max(1000),
});
export type RejectProformaBChangeBody = z.infer<typeof rejectProformaBChangeBody>;

export const bulkApproveProformaBBody = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
});
export type BulkApproveProformaBBody = z.infer<typeof bulkApproveProformaBBody>;

export const listProformaBChangesQuery = z.object({
  status: z.enum(['pending', 'applied', 'rejected', 'cancelled', 'stale']).optional(),
  submittedBy: z.union([z.literal('me'), z.coerce.number().int().positive()]).optional(),
  cadreId: z.coerce.number().int().positive().optional(),
  awaitingMe: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(15),
});
export type ListProformaBChangesQuery = z.infer<typeof listProformaBChangesQuery>;
export type ResolvedListProformaBChangesQuery = Omit<ListProformaBChangesQuery, 'submittedBy'> & {
  submittedBy?: number;
};

export const listProformaBQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(15),
});
export type ListProformaBQuery = z.infer<typeof listProformaBQuery>;

export const cadreIdParam = z.object({ cadreId: z.coerce.number().int().positive() });
export const proformaBIdParam = z.object({ cadreId: z.coerce.number().int().positive(), bId: z.coerce.number().int().positive() });
export const changeIdParam = z.object({ id: z.coerce.number().int().positive() });
