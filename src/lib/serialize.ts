import type { Cadre, Report, User } from '@prisma/client';

// Wire shape for a user (camelCase entity, per the client contract). `role`
// serializes verbatim (lowercase enum). `completionPercent` is deferred to
// Phase 1.5 and intentionally omitted, like `avatarSource` on cadres.
export interface WireUser {
  id: number;
  name: string;
  phone: string;
  role: User['role'];
  designation?: string;
  thana?: string;
  avatarUrl?: string;
  badgeImageUrl?: string;
}

export function toWireUser(user: User): WireUser {
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    role: user.role,
    // Optional fields: omit (undefined) when absent so the JSON matches the
    // client's optional-field shape rather than sending nulls.
    designation: user.designation ?? undefined,
    thana: user.thana ?? undefined,
    avatarUrl: user.avatarUrl ?? undefined,
    badgeImageUrl: user.badgeImageUrl ?? undefined,
  };
}

// Wire shape for a cadre (camelCase entity). Dates serialize to ISO strings;
// internal columns (deletedAt) and the mobile-only `avatarSource` are never
// returned. Optional fields are omitted when null.
//
// `assignedOfficerId` IS returned (ADR-018): the clients need it to show "my
// assigned cadres" and to drive the admin assignment UI. It is not sensitive —
// every authenticated user can already list every cadre.
export interface WireCadre {
  id: number;
  // The official register serial number (ADR-025). Absent until the import
  // supplies one — never fall back to `id`, which is an unrelated surrogate key.
  serialNumber?: string;
  name: string;
  phone: string;
  thana: string;
  currentAddress: string;
  permanentAddress?: string;
  designation: string;
  category: Cadre['category'];
  filter?: NonNullable<Cadre['filter']>;
  alertLevel: Cadre['alertLevel'];
  avatarUrl?: string;
  alertDate?: string;
  incident?: string;
  verificationOffice?: string;
  supervisoryOffice?: string;
  alertTag?: string;
  aliases: string[];
  surrenderDate?: string;
  surrenderLocation?: string;
  // ADR-019. Only surrendered cadres carry one; absent otherwise.
  surrenderOrigin?: NonNullable<Cadre['surrenderOrigin']>;
  surrenderYear?: string;
  regiment?: string;
  familyGroupInfo?: string;
  subDivision?: string;
  // ADR-040. Home district — one of the 7 Bastar-region districts (dropdown on edit).
  district?: string;
  // ADR-036. Date of birth (ISO date), and `age` DERIVED from it on read — never a
  // stored int, which would be wrong the day after it was written. Both absent when
  // no birth date is on file. `age` is read-only: the client edits `dateOfBirth`.
  dateOfBirth?: string;
  age?: number;
  fatherName?: string;
  motherName?: string;
  spouseName?: string;
  // ADR-038. Demographic facts from the paper register, supplied by the one-time
  // historical import. Both absent when null (`gender` is male|female; `caste` is
  // free text). Non-sensitive — same visibility as every other cadre field.
  gender?: NonNullable<Cadre['gender']>;
  caste?: string;
  // ADR-029. The four hardcopy documents, INDIVIDUALLY (ADR-026 shipped them as one
  // flag; the client asked for them apart, and "the paperwork exists" is
  // unanswerable when three of four are on file). Always present — NOT NULL
  // booleans, never tri-state. Written only via the change-request workflow.
  hasAadhaar: boolean;
  hasBankAccount: boolean;
  hasAbProforma: boolean;
  hasAgreementLetter: boolean;
  assignedOfficerId?: number;
  // ADR-022. When the cadre's next reporting check-in is due: the most recent
  // report's date + 30 days. Derived, not stored. Absent when the cadre has never
  // reported (no baseline to count from).
  nextReportingDueAt?: string;
  // ADR-023. The most recent report's date itself — the baseline the above is
  // derived FROM. Exposed so the client can measure "time since last contact"
  // without reconstructing it as `nextReportingDueAt - CADENCE`, which would mean
  // a second copy of REPORTING_CADENCE_DAYS living in the mobile repo and
  // silently disagreeing with this one the day the cadence changes.
  // Absent when the cadre has never reported — same condition as above.
  lastReportedAt?: string;
  // ADR-027. Which fields currently have an in-flight change request. ALWAYS
  // present (empty array = nothing pending) on both the list and the detail — an
  // optional array would make "no pending changes" and "not computed here"
  // indistinguishable, and the UI would guess wrong in exactly one of them.
  pendingFields: string[];
  // ADR-027. Who last changed this record's contents and when — the answer to
  // "has someone touched this recently?" before an officer proposes their own
  // edit. Absent on a cadre nobody has edited since the write path existed.
  lastEditedAt?: string;
  lastEditedBy?: { id: number; name: string };
  createdAt: string;
  updatedAt: string;
}

// ADR-022. Fixed monthly reporting cadence. No per-category rules for now — the
// simplest thing that works; revisit if it proves wrong.
export const REPORTING_CADENCE_DAYS = 30;

// ADR-036. Whole years from a birth date to today, in UTC. Age is derived on every
// read so it can never go stale — a stored int is wrong the day after a birthday and
// has no way to know. Returns undefined for no birth date, and for a birth date in
// the future (a bad import value should not surface as a negative age).
export function deriveAge(dateOfBirth: Date | null, now: Date = new Date()): number | undefined {
  if (dateOfBirth === null) return undefined;
  let age = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dateOfBirth.getUTCMonth();
  // Not had this year's birthday yet → subtract one.
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dateOfBirth.getUTCDate())) {
    age -= 1;
  }
  return age < 0 ? undefined : age;
}

/** ADR-027. What the caller must supply so `pendingFields` / `lastEditedBy` are real. */
export interface CadreEditContext {
  /** Fields with an in-flight change request. Pass `[]`, never omit — see WireCadre. */
  pendingFields: string[];
  /** The last editor, if the cadre carries `lastEditedById`. */
  lastEditedBy?: { id: number; name: string } | null;
  /**
   * ADR-029. A freshly-signed GET URL for `avatarKey`. Supplied by the caller for
   * the same reason `pendingFields` is: signing is async and per-page, and having
   * the serializer reach for it would turn every cadre list into an N+1 of S3
   * calls. Absent → falls back to the legacy `avatarUrl` column.
   */
  avatarUrl?: string;
}

// `lastReportedAt` is the cadre's most recent (non-deleted) report date, or null
// if it has never reported. The caller computes it (a `take: 1` include); passing
// it in keeps the 30-day formula in one place.
//
// `edit` (ADR-027) is likewise the caller's job: pending changes are a batched
// lookup over the whole page, not a per-row query, so the serializer takes the
// answer rather than fetching it and turning a list into an N+1.
export function toWireCadre(
  c: Cadre & { lastEditedBy?: { id: number; name: string } | null },
  lastReportedAt?: Date | null,
  edit?: CadreEditContext,
): WireCadre {
  const nextReportingDueAt =
    lastReportedAt != null
      ? new Date(lastReportedAt.getTime() + REPORTING_CADENCE_DAYS * 24 * 60 * 60 * 1000).toISOString()
      : undefined;

  return {
    id: c.id,
    serialNumber: c.serialNumber ?? undefined,
    name: c.name,
    phone: c.phone,
    thana: c.thana,
    currentAddress: c.currentAddress,
    permanentAddress: c.permanentAddress ?? undefined,
    designation: c.designation,
    category: c.category,
    filter: c.filter ?? undefined,
    alertLevel: c.alertLevel,
    // ADR-029. Prefer a freshly-signed URL from the durable `avatarKey`; fall back
    // to the legacy `avatarUrl` column for rows that predate it. Never emit the
    // key itself — the client renders a URL, and a stored URL is what ADR-016
    // taught us not to trust.
    avatarUrl: edit?.avatarUrl ?? c.avatarUrl ?? undefined,
    alertDate: c.alertDate?.toISOString(),
    incident: c.incident ?? undefined,
    verificationOffice: c.verificationOffice ?? undefined,
    supervisoryOffice: c.supervisoryOffice ?? undefined,
    alertTag: c.alertTag ?? undefined,
    aliases: c.aliases,
    surrenderDate: c.surrenderDate?.toISOString(),
    surrenderLocation: c.surrenderLocation ?? undefined,
    surrenderOrigin: c.surrenderOrigin ?? undefined,
    surrenderYear: c.surrenderYear ?? undefined,
    regiment: c.regiment ?? undefined,
    familyGroupInfo: c.familyGroupInfo ?? undefined,
    subDivision: c.subDivision ?? undefined,
    district: c.district ?? undefined,
    // ADR-036. `@db.Date` stores midnight UTC; slice to the date part so the wire
    // carries `1990-05-16`, not a spurious `T00:00:00.000Z` the client must trim.
    dateOfBirth: c.dateOfBirth?.toISOString().slice(0, 10),
    age: deriveAge(c.dateOfBirth),
    fatherName: c.fatherName ?? undefined,
    motherName: c.motherName ?? undefined,
    spouseName: c.spouseName ?? undefined,
    gender: c.gender ?? undefined,
    caste: c.caste ?? undefined,
    hasAadhaar: c.hasAadhaar,
    hasBankAccount: c.hasBankAccount,
    hasAbProforma: c.hasAbProforma,
    hasAgreementLetter: c.hasAgreementLetter,
    assignedOfficerId: c.assignedOfficerId ?? undefined,
    nextReportingDueAt,
    lastReportedAt: lastReportedAt?.toISOString(),
    pendingFields: edit?.pendingFields ?? [],
    lastEditedAt: c.lastEditedAt?.toISOString(),
    lastEditedBy: edit?.lastEditedBy ?? c.lastEditedBy ?? undefined,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

// Wire shape for a report (camelCase entity). The flat GPS columns collapse into
// the client's nested `gpsCoords`; `reportedBy` is the reporter's id (number, not
// a user object); the optional nested `cadre` is a Pick the client renders in
// ReportCard. Internal columns (reportedById, deletedAt, idempotencyKey) are never
// returned. Optional fields are omitted when null.
export interface WireReport {
  id: number;
  cadreId: number;
  cadre?: Pick<WireCadre, 'id' | 'name' | 'phone' | 'avatarUrl'>;
  reportingPlace: Report['reportingPlace'];
  specificLocation: string;
  personStatus: Report['personStatus'];
  currentPhone: string;
  currentActivity: string;
  /** Legacy single-photo URL, passed through for old rows. Prefer `photoUrls`. */
  photoUrl?: string;
  /** Fresh presigned GET URLs, re-signed from the stored S3 keys on every read (ADR-016). */
  photoUrls?: string[];
  gpsCoords?: { latitude: number; longitude: number; address: string };
  isHomeAddress?: boolean;
  reportedAt: string;
  reportedBy: number;
  syncedAt?: string;
}

// A report row optionally carrying its included `cadre` relation.
type ReportWithCadre = Report & { cadre?: Cadre | null };

// Turns a durable S3 key into a readable URL. Injected (not imported) so the
// serializer stays free of storage/config coupling; callers pass the storage
// provider's presigner. Absent in contexts that don't need photo URLs.
export type SignUrl = (key: string) => Promise<string>;

export async function toWireReport(r: ReportWithCadre, signUrl?: SignUrl): Promise<WireReport> {
  const wire: WireReport = {
    id: r.id,
    cadreId: r.cadreId,
    reportingPlace: r.reportingPlace,
    specificLocation: r.specificLocation,
    personStatus: r.personStatus,
    currentPhone: r.currentPhone,
    currentActivity: r.currentActivity,
    photoUrl: r.photoUrl ?? undefined,
    isHomeAddress: r.isHomeAddress ?? undefined,
    reportedAt: r.reportedAt.toISOString(),
    reportedBy: r.reportedById,
    syncedAt: r.syncedAt?.toISOString(),
  };

  // ADR-016: re-sign the stored keys into fresh, time-limited GET URLs per read.
  // The key is the durable identity; the presigned URL is never persisted.
  if (r.photoKeys.length > 0 && signUrl !== undefined) {
    wire.photoUrls = await Promise.all(r.photoKeys.map((key) => signUrl(key)));
  }

  // Nest GPS only when coordinates exist; `address` falls back to '' so the shape
  // matches the client's GpsCoords (address is a required string there).
  if (r.gpsLatitude !== null && r.gpsLongitude !== null) {
    wire.gpsCoords = {
      latitude: r.gpsLatitude,
      longitude: r.gpsLongitude,
      address: r.gpsAddress ?? '',
    };
  }

  // Include the nested cadre Pick only when the relation was loaded.
  if (r.cadre) {
    wire.cadre = {
      id: r.cadre.id,
      name: r.cadre.name,
      phone: r.cadre.phone,
      avatarUrl: r.cadre.avatarUrl ?? undefined,
    };
  }

  return wire;
}
