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

export function makeCadresService({ prisma }: CadresDeps): CadresService {
  return {
    async list(query) {
      // Soft-delete filter applies to every read.
      const where: Prisma.CadreWhereInput = { deletedAt: null };
      if (query.category !== undefined && query.category !== 'all') where.category = query.category;
      if (query.filter !== undefined && query.filter !== 'All') where.filter = query.filter;
      // ADR-018: the route has already resolved `me` to a concrete officer id.
      if (query.assignedTo !== undefined) where.assignedOfficerId = query.assignedTo;

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
          orderBy: { id: 'asc' },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
      ]);

      return {
        data: rows.map(toWireCadre),
        total,
        page: query.page,
        pageSize: query.pageSize,
        hasMore: query.page * query.pageSize < total,
      };
    },

    async getById(id) {
      const cadre = await prisma.cadre.findFirst({ where: { id, deletedAt: null } });
      if (cadre === null) throw notFound('Cadre not found');
      return toWireCadre(cadre);
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
