import type { FastifyBaseLogger } from 'fastify';
import { cadreScopeWhere, scopeAdmitsThana, type CadreScope } from '../../lib/scope.js';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { toWireCadre, REPORTING_CADENCE_DAYS, type WireCadre } from '../../lib/serialize.js';
import { writeAuditLog } from '../../lib/audit.js';
import { writeOutboxEvent } from '../../lib/outbox.js';
import { badRequest, notFound } from '../../lib/errors.js';
import type { StorageProvider } from '../../lib/storage.js';
import { randomUUID } from 'node:crypto';
import { decodeBase64Image, sniffImageType, EXT_BY_TYPE } from '../../lib/images.js';
import {
  avatarBackfillRow,
  importCadreRow,
  type AvatarBackfillRow,
  type ImportCadreRow,
  type ResolvedListCadresQuery,
} from './cadres.schema.js';

export interface CadresDeps {
  prisma: PrismaClient;
  log: FastifyBaseLogger;
  // ADR-029. Re-signs `avatarKey` on read, exactly as reports do for photo keys.
  storage: StorageProvider;
  mediaUrlTtlSeconds: number;
  /** Per-image ceiling for the bulk avatar backfill; the single-upload route's cap. */
  maxAvatarBytes: number;
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** ADR-033. The filter sheet's options, taken from the rows that actually exist. */
export interface CadreFacets {
  thanas: string[];
  designations: string[];
}

// ADR-038. Per-row outcome of the bulk historical import. Keyed by serialNumber so the
// calling Apps Script can write the result straight back into the sheet row.
// `serialNumber` is nullable because a row that fails validation may not carry a usable
// one — the sheet still needs SOMETHING to key on, so we echo whatever was provided.
export interface ImportRowResult {
  serialNumber: string | null;
  status: 'created' | 'skipped_duplicate' | 'error';
  cadreId?: number;
  error?: string;
}

export interface ImportResult {
  results: ImportRowResult[];
}

// Design-Docs#8. Per-row outcome of the bulk avatar backfill, same contract as
// ImportRowResult so the Apps Script writes it back into the sheet the same way.
//
// `not_found` is its own status rather than an `error`: a serial the register has but
// the database does not is an expected, actionable gap in a backfill (the text import
// skipped that row), not a malfunction. Collapsing it into `error` would bury it among
// genuine failures in the sheet.
export interface AvatarBackfillRowResult {
  serialNumber: string | null;
  status: 'updated' | 'skipped_has_avatar' | 'not_found' | 'error';
  cadreId?: number;
  /** The stored S3 key, on `updated` — so the sheet records what was written. */
  avatarKey?: string;
  error?: string;
}

export interface AvatarBackfillResult {
  results: AvatarBackfillRowResult[];
}

export interface CadresService {
  // ADR-044. `scope` is the caller's row-level authorisation, resolved per request in the
  // auth plugin. It is a REQUIRED parameter, not an optional one: an optional scope is a
  // scope somebody forgets to pass, and the failure mode of forgetting is a silent,
  // total loss of access control. TypeScript refuses the call instead.
  list(query: ResolvedListCadresQuery, scope: CadreScope): Promise<Paginated<WireCadre>>;
  facets(scope: CadreScope): Promise<CadreFacets>;
  getById(id: number, scope: CadreScope): Promise<WireCadre>;
  transfer(cadreId: number, toOfficerId: number, actorId: number, scope: CadreScope): Promise<void>;
  // ADR-038. Bulk historical import. `actorId` is the super_admin's id for an
  // interactive call, or null when authenticated by the SDR-007 machine key.
  importCadres(rows: unknown[], actorId: number | null): Promise<ImportResult>;
  // Design-Docs#8. Bulk avatar backfill onto EXISTING rows, matched by serialNumber.
  // No `scope` parameter, for the same reason importCadres has none: the route is
  // super_admin-only, and a super_admin's scope is unrestricted by definition
  // (ADR-044). `actorId` is NOT nullable here — there is no machine-key path.
  backfillAvatars(rows: unknown[], actorId: number): Promise<AvatarBackfillResult>;
}

// Echoes whatever serialNumber a raw (possibly invalid) row carried, so a row that
// fails validation is still reportable by serial to the sheet.
function rawSerial(raw: unknown): string | null {
  if (raw !== null && typeof raw === 'object' && 'serialNumber' in raw) {
    const s = (raw as Record<string, unknown>).serialNumber;
    if (typeof s === 'string' && s.trim() !== '') return s.trim();
    if (typeof s === 'number') return String(s);
  }
  return null;
}

// Compact, per-row validation message: "field: reason; field: reason".
function formatIssues(error: Prisma.PrismaClientKnownRequestError | { issues: { path: (string | number)[]; message: string }[] }): string {
  return 'issues' in error
    ? error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    : error.message;
}

// ADR-038. An import row → the Cadre create payload. A straight field map; undefined
// values are simply not set (Prisma leaves them null/default).
function toCreateData(row: ImportCadreRow): Prisma.CadreCreateInput {
  return {
    serialNumber: row.serialNumber,
    name: row.name,
    phone: row.phone,
    thana: row.thana,
    currentAddress: row.currentAddress,
    designation: row.designation,
    category: row.category,
    alertLevel: row.alertLevel,
    filter: row.filter,
    permanentAddress: row.permanentAddress,
    surrenderDate: row.surrenderDate,
    surrenderLocation: row.surrenderLocation,
    surrenderOrigin: row.surrenderOrigin,
    surrenderYear: row.surrenderYear,
    regiment: row.regiment,
    subDivision: row.subDivision,
    district: row.district,
    fatherName: row.fatherName,
    motherName: row.motherName,
    spouseName: row.spouseName,
    incident: row.incident,
    gender: row.gender,
    caste: row.caste,
    dateOfBirth: row.dateOfBirth,
    aliases: row.aliases,
  };
}

// The unique constraint on cadres is serial_number (id aside). A P2002 on a create
// therefore means the serial already exists — the concurrent-batch race the pre-check
// map cannot see.
function isDuplicateSerial(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

// ADR-041. Reporting-recency tier → a where clause over report windows. Same 30/60/90
// boundaries the dashboard counts use (multiples of the cadence), so a tile's count
// equals the size of the list its drill-down opens.
const RECENCY_DAY_MS = 86_400_000;
function recencyWhere(
  tier: 'current' | 'overdue1m' | 'overdue2m' | 'overdue3m',
): Prisma.CadreWhereInput {
  const now = Date.now();
  const d = (mult: number) => new Date(now - REPORTING_CADENCE_DAYS * mult * RECENCY_DAY_MS);
  const some = (gte: Date): Prisma.CadreWhereInput => ({ reports: { some: { deletedAt: null, reportedAt: { gte } } } });
  const none = (gte: Date): Prisma.CadreWhereInput => ({ reports: { none: { deletedAt: null, reportedAt: { gte } } } });
  switch (tier) {
    case 'current':
      return some(d(1)); // सामान्य — reported within 30d
    case 'overdue1m':
      return { AND: [some(d(2)), none(d(1))] }; // सतर्क — [60d, 30d)
    case 'overdue2m':
      return { AND: [some(d(3)), none(d(2))] }; // जोखिम — [90d, 60d)
    case 'overdue3m':
      return none(d(3)); // उच्च जोखिम — nothing within 90d (incl. never)
  }
}

// The cadre's most recent non-deleted report date only (ADR-022) — nothing else
// of the report is needed for nextReportingDueAt.
const LATEST_REPORT = {
  reports: {
    where: { deletedAt: null },
    orderBy: [{ reportedAt: 'desc' }, { id: 'desc' }],
    take: 1,
    select: { reportedAt: true },
  },
  // ADR-027. The last editor's name, for "अंतिम बदलाव — <officer>".
  lastEditedBy: { select: { id: true, name: true } },
} as const satisfies Prisma.CadreInclude;

export function makeCadresService({
  prisma,
  log,
  storage,
  mediaUrlTtlSeconds,
  maxAvatarBytes,
}: CadresDeps): CadresService {
  /**
   * ADR-029. Signs each row's `avatarKey` into a fresh GET URL. Only rows that
   * actually carry a key cost an S3 call, so a page of cadres with no photos costs
   * nothing.
   */
  async function avatarUrlsFor(
    rows: { id: number; avatarKey: string | null }[],
  ): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    const withKey = rows.filter((r) => r.avatarKey !== null);
    await Promise.all(
      withKey.map(async (r) => {
        out.set(r.id, await storage.presignGet(r.avatarKey!, mediaUrlTtlSeconds));
      }),
    );
    return out;
  }

  /**
   * ADR-027. Which fields have an in-flight change request, for every cadre on the
   * page — ONE query for the whole page, not one per row. A list endpoint that
   * fans out per row is how a 15-row page becomes 16 round trips.
   *
   * Returns a map that is complete for `ids`: a cadre with nothing pending gets an
   * empty array, never a missing entry, so callers cannot confuse "none" with
   * "not looked up".
   */
  async function pendingFieldsFor(ids: number[]): Promise<Map<number, string[]>> {
    const out = new Map<number, string[]>(ids.map((id) => [id, []]));
    if (ids.length === 0) return out;

    const rows = await prisma.cadreChangeRequest.findMany({
      where: { cadreId: { in: ids }, status: 'pending' },
      select: { cadreId: true, changes: true },
    });

    for (const r of rows) {
      const fields = Object.keys(r.changes as Record<string, unknown>);
      const existing = out.get(r.cadreId);
      // A cadre can hold several pending requests (on different fields — ADR-027
      // refuses a second request on the SAME field), so union rather than replace.
      if (existing !== undefined) for (const f of fields) if (!existing.includes(f)) existing.push(f);
    }
    return out;
  }

  return {
    async list(query, scope) {
      // Soft-delete filter applies to every read; ADR-044 scope applies on top of it.
      const where: Prisma.CadreWhereInput = { deletedAt: null, ...cadreScopeWhere(scope) };

      // ADR-033: multi-valued facets. `all` is the client's "no filter" sentinel, so
      // its presence anywhere in the selection widens to everything rather than
      // narrowing to a category literally named "all".
      const cats = query.category?.filter((c) => c !== 'all');
      if (cats !== undefined && cats.length > 0 && !query.category!.includes('all')) {
        where.category = { in: cats as ('surrendered' | 'jail' | 'thana')[] };
      }
      if (query.filter !== undefined && query.filter !== 'All') where.filter = query.filter;
      // ADR-018: the route has already resolved `me` to a concrete officer id.
      if (query.assignedTo !== undefined) where.assignedOfficerId = query.assignedTo;
      // ADR-019: the two surrendered dashboard tiles differ only by this.
      if (query.surrenderOrigin !== undefined) where.surrenderOrigin = query.surrenderOrigin;
      // ADR-020/033: the "सक्रिय अलर्ट" tile drills into critical cadres; the sheet can
      // select several levels at once.
      if (query.alertLevel !== undefined) where.alertLevel = { in: query.alertLevel };

      // ADR-033: thana/designation match as substrings, so several chips OR together
      // within a facet while the facets themselves AND. Kept in `AND` rather than the
      // top-level `OR`, which text search already owns — writing to `where.OR` here
      // would make a search term and a thana chip widen each other instead of both
      // applying.
      const and: Prisma.CadreWhereInput[] = [];
      if (query.thana !== undefined) {
        and.push({ OR: query.thana.map((t) => ({ thana: { contains: t, mode: 'insensitive' as const } })) });
      }
      if (query.designation !== undefined) {
        and.push({
          OR: query.designation.map((d) => ({ designation: { contains: d, mode: 'insensitive' as const } })),
        });
      }
      // ADR-041: reporting-recency tier — same windows as /stats/dashboard's tiles.
      if (query.recency !== undefined) and.push(recencyWhere(query.recency));
      if (and.length > 0) where.AND = and;

      if (query.search !== undefined && query.search !== '') {
        const raw = query.search.trim();
        if (raw.startsWith('@')) {
          // Alias search (mobile "@" convention): matches an alias element.
          const term = raw.slice(1).trim();
          if (term !== '') where.aliases = { has: term };
        } else {
          where.OR = [
            { name: { contains: raw, mode: 'insensitive' } },
            { thana: { contains: raw, mode: 'insensitive' } },
            { designation: { contains: raw, mode: 'insensitive' } },
            // BE#15. The register serial (ADR-025) is what an officer reads off the
            // paper record — searching "BJP/2025/0001" or just "0001" must find it.
            { serialNumber: { contains: raw, mode: 'insensitive' } },
          ];
        }
      }

      const [total, rows] = await prisma.$transaction([
        prisma.cadre.count({ where }),
        prisma.cadre.findMany({
          where,
          // ADR-022: the latest non-deleted report's date, for nextReportingDueAt.
          // `take: 1` over the desc order is one lateral join, not an N+1.
          include: LATEST_REPORT,
          orderBy: { id: 'asc' },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
      ]);

      const [pending, avatars] = await Promise.all([
        pendingFieldsFor(rows.map((r) => r.id)),
        avatarUrlsFor(rows),
      ]);

      return {
        data: rows.map((r) =>
          toWireCadre(r, r.reports[0]?.reportedAt ?? null, {
            pendingFields: pending.get(r.id) ?? [],
            avatarUrl: avatars.get(r.id),
          }),
        ),
        total,
        page: query.page,
        pageSize: query.pageSize,
        hasMore: query.page * query.pageSize < total,
      };
    },

    /**
     * ADR-033. The filter sheet used to offer a hardcoded list of four thanas and
     * five Latin rank acronyms. Against the real roster the rank chips matched
     * NOTHING (every designation is Devanagari) and two of the four thana chips
     * matched nothing either — a filter that always returns zero rows.
     *
     * These come from the data instead. Distinct + non-null over the live rows, so
     * the sheet cannot offer an option that finds nobody, and Design-Docs#7's ~1,790
     * imported cadres populate it without a code change.
     */
    async facets(scope) {
      // Scoped too. An unscoped facet list would leak the shape of the wider register —
      // a thana officer could read off every station and designation in the district from
      // a filter dropdown they cannot actually filter into.
      const visible = { deletedAt: null, ...cadreScopeWhere(scope) };
      const [thanas, designations] = await prisma.$transaction([
        prisma.cadre.findMany({
          where: visible,
          distinct: ['thana'],
          select: { thana: true },
          orderBy: { thana: 'asc' },
        }),
        prisma.cadre.findMany({
          where: visible,
          distinct: ['designation'],
          select: { designation: true },
          orderBy: { designation: 'asc' },
        }),
      ]);
      // Both columns are non-nullable, but a blank string is still not an option
      // worth offering.
      return {
        thanas: thanas.map((r) => r.thana).filter((t) => t !== ''),
        designations: designations.map((r) => r.designation).filter((d) => d !== ''),
      };
    },

    async getById(id, scope) {
      // Scope is in the WHERE, so an out-of-scope cadre is indistinguishable from one that
      // does not exist. Deliberate: a 403 here would confirm that a given cadre id is real,
      // letting anyone enumerate the register's size and id space by probing.
      const cadre = await prisma.cadre.findFirst({
        where: { id, deletedAt: null, ...cadreScopeWhere(scope) },
        include: LATEST_REPORT,
      });
      if (cadre === null) throw notFound('Cadre not found');
      const [pending, avatars] = await Promise.all([
        pendingFieldsFor([cadre.id]),
        avatarUrlsFor([cadre]),
      ]);
      return toWireCadre(cadre, cadre.reports[0]?.reportedAt ?? null, {
        pendingFields: pending.get(cadre.id) ?? [],
        avatarUrl: avatars.get(cadre.id),
      });
    },

    async transfer(cadreId, toOfficerId, actorId, scope) {
      const cadre = await prisma.cadre.findFirst({
        where: { id: cadreId, deletedAt: null, ...cadreScopeWhere(scope) },
      });
      if (cadre === null) throw notFound('Cadre not found');

      const target = await prisma.user.findFirst({ where: { id: toOfficerId, deletedAt: null } });
      if (target === null) throw badRequest('to_officer_id does not reference an active user', 'INVALID_OFFICER');

      // BOTH ends of a transfer must be in scope. Without this an SDOP could hand a cadre
      // they legitimately hold to an officer in another sub-division — pushing a record
      // OUT of their own jurisdiction and permanently out of their own reach, which is a
      // scope escape even though every individual object was one they could see.
      if (target.role === 'officer' && target.thana !== null && !scopeAdmitsThana(scope, target.thana)) {
        throw badRequest(
          'to_officer_id is outside your jurisdiction',
          'OFFICER_OUT_OF_SCOPE',
        );
      }

      const fromOfficerId = cadre.assignedOfficerId;

      // Mutation + audit + outbox commit atomically.
      await prisma.$transaction(async (tx) => {
        await tx.cadre.update({ where: { id: cadreId }, data: { assignedOfficerId: toOfficerId } });
        await writeAuditLog(tx, {
          actorId,
          action: 'cadre.transfer',
          entityType: 'cadre',
          entityId: String(cadreId),
          before: { assignedOfficerId: fromOfficerId },
          after: { assignedOfficerId: toOfficerId },
        });
        await writeOutboxEvent(tx, {
          aggregateType: 'cadre',
          aggregateId: String(cadreId),
          eventType: 'cadre.transferred',
          payload: { cadreId, fromOfficerId, toOfficerId, actorId },
        });
      });
    },

    async importCadres(rows, actorId) {
      // Phase 1: validate every row up front (safeParse — one bad row must not fail the
      // batch). Results is a dense array aligned to the input order, so the caller's
      // sheet can map row-for-row.
      const results: ImportRowResult[] = new Array(rows.length);
      const valid: { index: number; row: ImportCadreRow }[] = [];
      rows.forEach((raw, index) => {
        const parsed = importCadreRow.safeParse(raw);
        if (!parsed.success) {
          results[index] = {
            serialNumber: rawSerial(raw),
            status: 'error',
            error: formatIssues(parsed.error),
          };
        } else {
          valid.push({ index, row: parsed.data });
        }
      });

      // Phase 2: one query for every serial already on file (across ALL rows, including
      // soft-deleted — the unique constraint spans them), so the duplicate check is a
      // map lookup per row rather than a query per row.
      const serials = valid.map((v) => v.row.serialNumber);
      const existing =
        serials.length > 0
          ? await prisma.cadre.findMany({
              where: { serialNumber: { in: serials } },
              select: { id: true, serialNumber: true },
            })
          : [];
      const idBySerial = new Map<string, number>();
      for (const e of existing) if (e.serialNumber !== null) idBySerial.set(e.serialNumber, e.id);

      // Phase 3: create the new rows, each in its OWN transaction (create + audit),
      // so a failure on one row neither rolls back the rows before it nor aborts the
      // rows after. This is the "partial success, report per row" contract — it is
      // why the batch is not one all-or-nothing transaction. Bypasses the ADR-026
      // change-request ladder entirely: these are new rows, not edits to existing ones.
      for (const { index, row } of valid) {
        const dupId = idBySerial.get(row.serialNumber);
        if (dupId !== undefined) {
          results[index] = { serialNumber: row.serialNumber, status: 'skipped_duplicate', cadreId: dupId };
          continue;
        }
        try {
          const created = await prisma.$transaction(async (tx) => {
            const c = await tx.cadre.create({ data: toCreateData(row) });
            await writeAuditLog(tx, {
              actorId,
              action: 'cadre.import',
              entityType: 'cadre',
              entityId: String(c.id),
              // No `before` — the row did not exist. `after` is a compact identity,
              // not the whole record (the row itself is the source of truth).
              after: { serialNumber: row.serialNumber, name: row.name, category: row.category },
            });
            return c;
          });
          // Guard the case of the SAME serial appearing twice within one batch: the
          // second occurrence now sees the first as a duplicate.
          idBySerial.set(row.serialNumber, created.id);
          results[index] = { serialNumber: row.serialNumber, status: 'created', cadreId: created.id };
        } catch (err) {
          if (isDuplicateSerial(err)) {
            // Lost a race with a concurrent batch — the row exists, so this is a skip,
            // not an error (idempotent by serialNumber, same as ADR-013's key).
            results[index] = { serialNumber: row.serialNumber, status: 'skipped_duplicate' };
          } else {
            log.error({ err, serialNumber: row.serialNumber }, 'cadre import row failed');
            results[index] = {
              serialNumber: row.serialNumber,
              status: 'error',
              error: 'internal error creating cadre',
            };
          }
        }
      }

      return { results };
    },

    async backfillAvatars(rows, actorId) {
      // Phase 1: validate every row up front (safeParse), same as importCadres — one
      // unusable row becomes that row's result, never a failed batch.
      const results: AvatarBackfillRowResult[] = new Array(rows.length);
      const valid: { index: number; row: AvatarBackfillRow }[] = [];
      rows.forEach((raw, index) => {
        const parsed = avatarBackfillRow.safeParse(raw);
        if (!parsed.success) {
          results[index] = {
            serialNumber: rawSerial(raw),
            status: 'error',
            error: formatIssues(parsed.error),
          };
        } else {
          valid.push({ index, row: parsed.data });
        }
      });

      // Phase 2: one query resolving every serial to its cadre, so the match is a map
      // lookup per row rather than a query per row. `deletedAt: null` — a soft-deleted
      // cadre is not a backfill target, and reports as `not_found` rather than being
      // silently revived with a photo.
      const serials = valid.map((v) => v.row.serialNumber);
      const existing =
        serials.length > 0
          ? await prisma.cadre.findMany({
              where: { serialNumber: { in: serials }, deletedAt: null },
              select: { id: true, serialNumber: true, avatarKey: true },
            })
          : [];
      const bySerial = new Map<string, { id: number; avatarKey: string | null }>();
      for (const e of existing) {
        if (e.serialNumber !== null) bySerial.set(e.serialNumber, { id: e.id, avatarKey: e.avatarKey });
      }

      // Phase 3: one row at a time — decode, verify, upload, then write. Sequential on
      // purpose: each row holds a decoded image in memory, and a parallel batch of 20
      // would multiply the peak on a single-server budget for no useful gain (the
      // 6-minute Apps Script cap is spent on the round trip, not on our concurrency).
      for (const { index, row } of valid) {
        const match = bySerial.get(row.serialNumber);
        if (match === undefined) {
          results[index] = { serialNumber: row.serialNumber, status: 'not_found' };
          continue;
        }
        // Already has a photo → skip, never overwrite. Same discipline as the two
        // import endpoints (an existing serial/name is skipped, not rewritten), so a
        // re-run of the script is idempotent and cannot clobber a photo an officer has
        // since replaced through the ADR-026 ladder. NOTE: this checks `avatarKey`
        // only — a row carrying just the LEGACY `avatarUrl` is still backfilled, which
        // is the intended upgrade path.
        if (match.avatarKey !== null) {
          results[index] = {
            serialNumber: row.serialNumber,
            status: 'skipped_has_avatar',
            cadreId: match.id,
            avatarKey: match.avatarKey,
          };
          continue;
        }

        const buffer = decodeBase64Image(row.base64Image);
        if (buffer === null) {
          results[index] = {
            serialNumber: row.serialNumber,
            status: 'error',
            cadreId: match.id,
            error: 'base64Image is not decodable base64',
          };
          continue;
        }
        if (buffer.byteLength > maxAvatarBytes) {
          results[index] = {
            serialNumber: row.serialNumber,
            status: 'error',
            cadreId: match.id,
            error: `image is ${buffer.byteLength} bytes, over the ${maxAvatarBytes}-byte limit`,
          };
          continue;
        }
        // The bytes are the only claim about type that cannot be wrong — the sheet
        // extraction's idea of a content type is a guess. This doubles as the real
        // base64 validation: garbage decodes to bytes that sniff as nothing.
        const contentType = sniffImageType(buffer);
        if (contentType === null) {
          results[index] = {
            serialNumber: row.serialNumber,
            status: 'error',
            cadreId: match.id,
            error: 'image is neither JPEG nor PNG',
          };
          continue;
        }

        try {
          // Same key convention as POST /cadres/:cadreId/avatar/upload, so the read
          // path re-signs a backfilled photo exactly as it does an officer-uploaded one.
          const key = `cadres/cadre-${match.id}/avatar-${randomUUID()}.${EXT_BY_TYPE[contentType] ?? 'bin'}`;
          // S3 first, then the row. The put is outside the transaction because it
          // cannot be rolled back by one; a failed write below leaves an unreferenced
          // object, which is the same harmless outcome the upload route already
          // produces every time a proposed photo is never approved.
          await storage.put(key, buffer, contentType);

          await prisma.$transaction(async (tx) => {
            await tx.cadre.update({ where: { id: match.id }, data: { avatarKey: key } });
            // Bypassing the ADR-026/029 approval ladder means the audit row is the
            // ONLY record of who changed this photo — hence a non-null actor is
            // required by the signature, and `before` carries the displaced value.
            await writeAuditLog(tx, {
              actorId,
              action: 'cadre.avatar_backfill',
              entityType: 'cadre',
              entityId: String(match.id),
              before: { avatarKey: null },
              after: { serialNumber: row.serialNumber, avatarKey: key },
            });
          });

          // Guard the same serial appearing twice in one batch: the second occurrence
          // now sees a photo on file and skips, rather than uploading over the first.
          bySerial.set(row.serialNumber, { id: match.id, avatarKey: key });
          results[index] = {
            serialNumber: row.serialNumber,
            status: 'updated',
            cadreId: match.id,
            avatarKey: key,
          };
        } catch (err) {
          log.error({ err, serialNumber: row.serialNumber }, 'cadre avatar backfill row failed');
          results[index] = {
            serialNumber: row.serialNumber,
            status: 'error',
            cadreId: match.id,
            error: 'internal error storing avatar',
          };
        }
      }

      return { results };
    },
  };
}
