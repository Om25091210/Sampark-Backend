import type { FastifyBaseLogger } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { toWireCadre, type WireCadre } from '../../lib/serialize.js';
import { writeAuditLog } from '../../lib/audit.js';
import { writeOutboxEvent } from '../../lib/outbox.js';
import { badRequest, notFound } from '../../lib/errors.js';
import type { StorageProvider } from '../../lib/storage.js';
import type { ResolvedListCadresQuery } from './cadres.schema.js';

export interface CadresDeps {
  prisma: PrismaClient;
  log: FastifyBaseLogger;
  // ADR-029. Re-signs `avatarKey` on read, exactly as reports do for photo keys.
  storage: StorageProvider;
  mediaUrlTtlSeconds: number;
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

export interface CadresService {
  list(query: ResolvedListCadresQuery): Promise<Paginated<WireCadre>>;
  facets(): Promise<CadreFacets>;
  getById(id: number): Promise<WireCadre>;
  transfer(cadreId: number, toOfficerId: number, actorId: number): Promise<void>;
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

export function makeCadresService({ prisma, storage, mediaUrlTtlSeconds }: CadresDeps): CadresService {
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
    async list(query) {
      // Soft-delete filter applies to every read.
      const where: Prisma.CadreWhereInput = { deletedAt: null };

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
    async facets() {
      const [thanas, designations] = await prisma.$transaction([
        prisma.cadre.findMany({
          where: { deletedAt: null },
          distinct: ['thana'],
          select: { thana: true },
          orderBy: { thana: 'asc' },
        }),
        prisma.cadre.findMany({
          where: { deletedAt: null },
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

    async getById(id) {
      const cadre = await prisma.cadre.findFirst({
        where: { id, deletedAt: null },
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

    async transfer(cadreId, toOfficerId, actorId) {
      const cadre = await prisma.cadre.findFirst({ where: { id: cadreId, deletedAt: null } });
      if (cadre === null) throw notFound('Cadre not found');

      const target = await prisma.user.findFirst({ where: { id: toOfficerId, deletedAt: null } });
      if (target === null) throw badRequest('to_officer_id does not reference an active user', 'INVALID_OFFICER');

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
  };
}
