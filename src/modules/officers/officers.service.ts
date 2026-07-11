import type { FastifyBaseLogger } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { toWireUser, type WireUser } from '../../lib/serialize.js';
import type { ListOfficersQuery } from './officers.schema.js';

export interface OfficersDeps {
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

// An officer as the admin assignment picker needs them: the user entity plus how
// many cadres they already carry, so an admin can see load before adding more.
export type WireOfficer = WireUser & { assignedCadreCount: number };

export interface OfficersService {
  list(query: ListOfficersQuery): Promise<Paginated<WireOfficer>>;
}

export function makeOfficersService({ prisma }: OfficersDeps): OfficersService {
  return {
    async list(query) {
      // Only officers are assignable. Admins and viewers are deliberately excluded:
      // an admin is not a field reporter, and assigning a cadre to one would create
      // a record nobody is accountable for.
      const where: Prisma.UserWhereInput = { role: 'officer', deletedAt: null };

      if (query.search !== undefined && query.search !== '') {
        const raw = query.search;
        where.OR = [
          { name: { contains: raw, mode: 'insensitive' } },
          { phone: { contains: raw, mode: 'insensitive' } },
          { thana: { contains: raw, mode: 'insensitive' } },
          { designation: { contains: raw, mode: 'insensitive' } },
        ];
      }

      const [total, rows] = await prisma.$transaction([
        prisma.user.count({ where }),
        prisma.user.findMany({
          where,
          orderBy: { name: 'asc' },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          // Count only live assignments — a soft-deleted cadre is not a workload.
          include: { _count: { select: { assignedCadres: { where: { deletedAt: null } } } } },
        }),
      ]);

      return {
        data: rows.map((r) => ({ ...toWireUser(r), assignedCadreCount: r._count.assignedCadres })),
        total,
        page: query.page,
        pageSize: query.pageSize,
        hasMore: query.page * query.pageSize < total,
      };
    },
  };
}
