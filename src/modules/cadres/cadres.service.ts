import type { FastifyBaseLogger } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { toWireCadre, type WireCadre } from '../../lib/serialize.js';
import { writeAuditLog } from '../../lib/audit.js';
import { writeOutboxEvent } from '../../lib/outbox.js';
import { badRequest, notFound } from '../../lib/errors.js';
import type { ResolvedListCadresQuery } from './cadres.schema.js';

export interface CadresDeps {
  prisma: PrismaClient;
  log: FastifyBaseLogger;
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface CadresService {
  list(query: ResolvedListCadresQuery): Promise<Paginated<WireCadre>>;
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

export function makeCadresService({ prisma }: CadresDeps): CadresService {
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
      if (query.category !== undefined && query.category !== 'all') where.category = query.category;
      if (query.filter !== undefined && query.filter !== 'All') where.filter = query.filter;
      // ADR-018: the route has already resolved `me` to a concrete officer id.
      if (query.assignedTo !== undefined) where.assignedOfficerId = query.assignedTo;
      // ADR-019: the two surrendered dashboard tiles differ only by this.
      if (query.surrenderOrigin !== undefined) where.surrenderOrigin = query.surrenderOrigin;
      // ADR-020: the "सक्रिय अलर्ट" tile drills into critical cadres.
      if (query.alertLevel !== undefined) where.alertLevel = query.alertLevel;

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

      const pending = await pendingFieldsFor(rows.map((r) => r.id));

      return {
        data: rows.map((r) =>
          toWireCadre(r, r.reports[0]?.reportedAt ?? null, {
            pendingFields: pending.get(r.id) ?? [],
          }),
        ),
        total,
        page: query.page,
        pageSize: query.pageSize,
        hasMore: query.page * query.pageSize < total,
      };
    },

    async getById(id) {
      const cadre = await prisma.cadre.findFirst({
        where: { id, deletedAt: null },
        include: LATEST_REPORT,
      });
      if (cadre === null) throw notFound('Cadre not found');
      const pending = await pendingFieldsFor([cadre.id]);
      return toWireCadre(cadre, cadre.reports[0]?.reportedAt ?? null, {
        pendingFields: pending.get(cadre.id) ?? [],
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
