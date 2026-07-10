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
// internal columns (assignedOfficerId, deletedAt) and the mobile-only
// `avatarSource` are never returned. Optional fields are omitted when null.
export interface WireCadre {
  id: number;
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
  surrenderYear?: string;
  regiment?: string;
  familyGroupInfo?: string;
  subDivision?: string;
  createdAt: string;
  updatedAt: string;
}

export function toWireCadre(c: Cadre): WireCadre {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    thana: c.thana,
    currentAddress: c.currentAddress,
    permanentAddress: c.permanentAddress ?? undefined,
    designation: c.designation,
    category: c.category,
    filter: c.filter ?? undefined,
    alertLevel: c.alertLevel,
    avatarUrl: c.avatarUrl ?? undefined,
    alertDate: c.alertDate?.toISOString(),
    incident: c.incident ?? undefined,
    verificationOffice: c.verificationOffice ?? undefined,
    supervisoryOffice: c.supervisoryOffice ?? undefined,
    alertTag: c.alertTag ?? undefined,
    aliases: c.aliases,
    surrenderDate: c.surrenderDate?.toISOString(),
    surrenderLocation: c.surrenderLocation ?? undefined,
    surrenderYear: c.surrenderYear ?? undefined,
    regiment: c.regiment ?? undefined,
    familyGroupInfo: c.familyGroupInfo ?? undefined,
    subDivision: c.subDivision ?? undefined,
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
