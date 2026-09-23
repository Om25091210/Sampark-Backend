import { z } from 'zod';

// ─── AB Proforma (ADR-064) ─────────────────────────────────────────────────────
//
// Field slugs and dropdown option text below are transcribed directly from the
// source document (`Proforma AB.docx`, read this session via Python's stdlib
// zipfile/xml.etree — no paraphrase). Request bodies are snake_case, entity
// responses camelCase — the existing client contract, not a new convention.

// ADR-064 §4. Every list below ends "इत्यादि" (etc.) in the source document
// except EconomicStatus (a genuinely closed 3-value list, made a real Prisma
// enum instead — see schema.prisma). These stay plain strings on the DB side;
// this is the UI's suggested-options list, not a validation whitelist — an
// officer entering a value not on the list must not be rejected.
export const PROFORMA_DROPDOWN_OPTIONS = {
  build: ['दुबला', 'मोटा', 'सामान्य', 'झुका हुआ', 'कुबड़ा'],
  complexion: ['गोरा', 'भूरा', 'काला', 'सफेद', 'पीला'],
  hair: [
    'काले', 'भूरे', 'ग्रे', 'गंजा', 'लंबे', 'घुंघराले',
    'पीछे कंघी किए हुए', 'आंशिक रूप से कंघी किए हुए', 'मिले-जुले बाल',
  ],
  eyebrows: ['घनी', 'पतली', 'धनुषाकार', 'सीधी मिली हुई'],
  eyes: ['बड़ी', 'छोटी', 'भेंगापन', 'एक आंख', 'अन्य'],
  irisColor: ['काला', 'भूरा', 'बादामी जैसा', 'अन्य'],
  nose: ['बड़ी', 'छोटी', 'हुक जैसी', 'उभरी हुई मोटी', 'पतली', 'चपटी'],
  teeth: ['टेढ़े-मेढ़े', 'बदरंग', 'टूटे हुए', 'दोहरे', 'बाहर निकले हुए'],
  lips: ['मोटे', 'पतले', 'चौड़े'],
  fingers: ['लंबी', 'छोटी', 'मीडियम'],
  chin: ['नुकीली', 'चौकोर'],
  ears: ['बड़े', 'छोटे', 'सामान्य'],
  face: ['लंबा', 'गोल', 'अंडाकार झुर्रियों वाला', 'चौकोर', 'अन्य'],
  beard: ['ट्रिम', 'लंबी', 'छोटी', 'फ्रेंच कट'],
  moustache: ['लंबी', 'ऊपर की ओर मुड़ी हुई', 'कटी हुई', 'नीचे की ओर झुकी हुई', 'बिना मूंछो के'],
} as const;

const t = (max: number) => z.string().trim().max(max).nullable();
const shortText = t(500);
const longText = t(4000);

// ─── Repeatable tables (items 19-23, 27) ───────────────────────────────────────

const nameAddressRemark = z.object({
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().max(500).default(''),
  remark: z.string().trim().max(500).default(''),
});

const nameAndPosition = z.object({
  name: z.string().trim().min(1).max(200),
  position: z.string().trim().max(300).default(''),
});

const identifyingOfficer = z.object({
  nameAndRank: z.string().trim().min(1).max(300),
  currentAddressWithDate: z.string().trim().max(500).default(''),
});

const relativeRow = z.object({
  name: z.string().trim().max(200).default(''),
  address: z.string().trim().max(500).default(''),
  remark: z.string().trim().max(500).default(''),
});

// Item 22 — fixed rows (मां/मां का भाई/पिता का भाई/पिता की बहन), plus a repeatable
// "अन्य रिश्तेदार" list. A fixed-shape object, not a generic array: the source
// table's first four rows are named roles, not free entries.
const relativesSchema = z.object({
  mother: relativeRow.optional(),
  mothersBrother: relativeRow.optional(),
  fathersBrother: relativeRow.optional(),
  fathersSister: relativeRow.optional(),
  others: z.array(relativeRow).max(20).default([]),
});

// ─── Section B — माओवादी संगठन संबंधी विवरण ────────────────────────────────────
//
// ADR-064 §2: one JSON blob, internally Zod-typed. Slugs follow the source
// document's own item order (its numbering resets/duplicates in a couple of
// places — e.g. two items both labelled "17." — carried faithfully, not
// renumbered).

const positionHeldRow = z.object({
  period: z.string().trim().max(200).default(''),
  position: z.string().trim().max(300).default(''),
  dalam: z.string().trim().max(200).default(''),
});

const meetingAttendedRow = z.object({
  participants: z.string().trim().max(1000).default(''),
  topic: z.string().trim().max(1000).default(''),
  place: z.string().trim().max(500).default(''),
  proposal: z.string().trim().max(1000).default(''),
});

export const sectionBSchema = z
  .object({
    reasonForJoining: longText,
    recruitingUnit: shortText,
    initialWorkBeforeJoining: longText,
    initialDalamProfile: longText,
    promotions: longText,
    positionsHeld: z.array(positionHeldRow).max(50).default([]),
    reasonForSurrenderOrArrest: longText,
    positionInOrganizationalStructure: longText,
    seniorCadreDetails: longText,
    weaponsCarriedByLevel: longText,
    otherUndergroundCadres: longText,
    lgsAndSubDalamDetails: longText,
    urbanNetworkAssociates: longText,
    frontOrganizationsAndCadres: longText,
    knownAssociatesByVillage: longText,
    surrenderedContactsChhattisgarh: z.array(nameAddressRemark).max(50).default([]),
    surrenderedContactsOtherStates: z.array(nameAddressRemark).max(50).default([]),
    courierContactsByDalam: longText,
    meetingsAttended: z.array(meetingAttendedRow).max(50).default([]),
    dumpsByLocation: longText,
    hideoutsByVillage: longText,
    wirelessStatus: longText,
    remoteControlDevices: longText,
    landmineLocations: longText,
    weaponsSupplyByItem: longText,
    commsEquipmentSupplyByItem: longText,
    fundingSources: longText,
    trainingCamps: longText,
    conferencesAndMeetings: longText,
    keyInternalDiscussions: longText,
    policyMatters: longText,
    designatedPeaceZones: longText,
    informationGatheringNetwork: longText,
    policeInformers: longText,
    tiesToOtherLeftOrganizations: longText,
    weaponSupplyingAgencies: longText,
    dalamMeetingLocations: longText,
    routesAndFerryPoints: longText,
    surrenderDateNote: shortText,
  })
  .partial();
export type SectionB = z.infer<typeof sectionBSchema>;

// ─── Section C — अन्य महत्त्वपूर्ण बातें ──────────────────────────────────────────

const newlyRecruitedRow = z.object({
  name: z.string().trim().min(1).max(200),
  remark: z.string().trim().max(500).default(''),
});

export const sectionCSchema = z
  .object({
    policeRelatedDiscussionsInOrg: longText,
    targetsPolice: shortText,
    targetsCivilians: shortText,
    raidsAndEscapeRoutes: longText,
    crimesInvolved: longText,
    retaliatoryActions: longText,
    encountersEscaped: longText,
    ambushesConducted: longText,
    seniorCadresInOrg: longText,
    vehiclesUsed: longText,
    medicalKitsUsed: shortText,
    hospitalsUsed: shortText,
    contactsWithPoliticalLeaders: longText,
    foodStoragePractices: longText,
    friendshipsAmongSeniorCadres: longText,
    internalRivalries: longText,
    weaponsUsedAndDumpLocations: longText,
    martyrsDayPreparation: longText,
    memorialBuildingMethods: longText,
    contactsOtherStatesAbroad: longText,
    availableAudioVideo: shortText,
    knownInvestments: longText,
    urbanMovementPatterns: longText,
    identificationPhotosNote: shortText,
    partyMoraleAssessment: longText,
    movementStatusGenerally: longText,
    policeInformersCrossCheck: longText,
    pastIncidentsInArea: longText,
    newlyRecruitedPersons: z.array(newlyRecruitedRow).max(50).default([]),
  })
  .partial();
export type SectionC = z.infer<typeof sectionCSchema>;

// ─── Section D — कमजोरियाँ ──────────────────────────────────────────────────────

export const sectionDSchema = z
  .object({
    illicitRelationships: longText,
    discontentAndDisputes: longText,
    familyRelations: longText,
    demotions: shortText,
    negativeRemarks: longText,
    briefPartyLifeHistory: longText,
    extortion: longText,
    contactsOutsideParty: longText,
  })
  .partial();
export type SectionD = z.infer<typeof sectionDSchema>;

// ─── Section A + whole-record shape ─────────────────────────────────────────────

export const proformaAFieldsSchema = z.object({
  party: shortText,
  fatherOccupation: shortText,
  spouseOccupation: shortText,
  subCaste: shortText,
  religion: shortText,
  placeOfBirth: shortText,

  aadhaarNumber: t(20),
  identifierMobile: t(20),
  identifierEmail: t(200),
  socialMediaHandle: t(200),
  rationCardNumber: t(50),
  voterIdNumber: t(50),
  drivingLicenseNumber: t(50),
  bankAccountNumber: t(50),
  postOfficeAccountNumber: t(50),

  educationalQualification: shortText,
  occupation: shortText,
  // Item 12 — the one genuinely closed dropdown (गरीब/औसत/ठीक-ठाक); real Prisma enum.
  economicStatus: z.enum(['poor', 'average', 'fair']).nullable(),
  // Item 13 — returned by POST /cadres/:cadreId/proforma-a/upload?slot=fingerprint.
  fingerprintKey: t(1024),

  height: shortText,
  build: shortText,
  complexion: shortText,
  distinguishingFeatures: longText,
  hair: shortText,
  eyebrows: shortText,
  eyes: shortText,
  irisColor: shortText,
  nose: shortText,
  teeth: shortText,
  lips: shortText,
  fingers: shortText,
  chin: shortText,
  ears: shortText,
  face: shortText,
  beard: shortText,
  moustache: shortText,
  marksOrTattoos: longText,
  deformity: longText,

  specialHabits: longText,
  vulnerabilities: longText,
  // Item 17 — returned by POST /cadres/:cadreId/proforma-a/upload?slot=handwriting.
  handwritingSampleKey: t(1024),
  friendsAndAssociates: longText,

  childhoodFriends: z.array(nameAddressRemark).max(50).nullable(),
  classmates: z.array(nameAddressRemark).max(50).nullable(),
  organizationAssociatesChronological: z.array(nameAndPosition).max(50).nullable(),
  relatives: relativesSchema.nullable(),
  identifyingPoliceOfficers: z.array(identifyingOfficer).max(50).nullable(),
  otherPointsOfInterest: z.array(z.string().trim().min(1).max(1000)).max(50).nullable(),

  priorArrestDetails: longText,
  convictions: longText,
  areaOfOperation: shortText,

  sectionB: sectionBSchema.nullable(),
  sectionC: sectionCSchema.nullable(),
  sectionD: sectionDSchema.nullable(),
});
export type ProformaAFields = z.infer<typeof proformaAFieldsSchema>;

// A create submits the FULL record (nullable-first, so every field may still be
// omitted/null — nothing here is mandatory at the API boundary; the paper
// process fills it incrementally). An edit proposes a partial diff, same as
// CadreChangeRequest.changes.
export const proformaAFieldsPartial = proformaAFieldsSchema.partial();
export type ProformaAFieldsPartial = z.infer<typeof proformaAFieldsPartial>;

export const submitProformaACreateBody = z.object({
  fields: proformaAFieldsSchema,
  note: z.string().trim().max(1000).optional(),
  idempotency_key: z.string().uuid().optional(),
});
export type SubmitProformaACreateBody = z.infer<typeof submitProformaACreateBody>;

export const submitProformaAEditBody = z.object({
  changes: proformaAFieldsPartial.refine(
    (c) => Object.keys(c).length > 0,
    'at least one field must be proposed',
  ),
  note: z.string().trim().max(1000).optional(),
  idempotency_key: z.string().uuid().optional(),
});
export type SubmitProformaAEditBody = z.infer<typeof submitProformaAEditBody>;

export const rejectProformaChangeBody = z.object({
  reason: z.string().trim().min(1).max(1000),
});
export type RejectProformaChangeBody = z.infer<typeof rejectProformaChangeBody>;

export const bulkApproveProformaBody = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
});
export type BulkApproveProformaBody = z.infer<typeof bulkApproveProformaBody>;

export const listProformaChangesQuery = z.object({
  status: z.enum(['pending', 'applied', 'rejected', 'cancelled', 'stale']).optional(),
  submittedBy: z.union([z.literal('me'), z.coerce.number().int().positive()]).optional(),
  cadreId: z.coerce.number().int().positive().optional(),
  awaitingMe: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(15),
});
export type ListProformaChangesQuery = z.infer<typeof listProformaChangesQuery>;
export type ResolvedListProformaChangesQuery = Omit<ListProformaChangesQuery, 'submittedBy'> & {
  submittedBy?: number;
};

export const cadreIdParam = z.object({ cadreId: z.coerce.number().int().positive() });
export const changeIdParam = z.object({ id: z.coerce.number().int().positive() });
export const uploadSlotQuery = z.object({ slot: z.enum(['fingerprint', 'handwriting']) });
