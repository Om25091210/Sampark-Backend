import type { FastifyBaseLogger } from 'fastify';
import { Prisma, type PrismaClient } from '@prisma/client';
import { toWireReport, type WireReport } from '../../lib/serialize.js';
import { writeAuditLog } from '../../lib/audit.js';
import { writeOutboxEvent } from '../../lib/outbox.js';
import { notFound } from '../../lib/errors.js';
import type { CreateReportBody, ListReportsQuery } from './reports.schema.js';

export interface ReportsDeps {
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

export interface CreateReportResult {
  report: WireReport;
  // false when an idempotent replay returned the pre-existing record (→ 200).
  created: boolean;
}

export interface ReportsService {
  listByCadre(cadreId: number, query: ListReportsQuery): Promise<Paginated<WireReport>>;
  getById(cadreId: number, reportId: number): Promise<WireReport>;
  create(cadreId: number, body: CreateReportBody, reporterId: number): Promise<CreateReportResult>;
}

// Load the report together with its cadre so the wire entity can carry the
// nested `cadre` Pick the client renders.
const withCadre = { include: { cadre: true } } as const;

export function makeReportsService({ prisma }: ReportsDeps): ReportsService {
  // Confirms the cadre exists and is not soft-deleted; throws 404 otherwise.
  async function assertCadre(cadreId: number): Promise<void> {
    const cadre = await prisma.cadre.findFirst({ where: { id: cadreId, deletedAt: null } });
    if (cadre === null) throw notFound('Cadre not found');
  }

  return {
    async listByCadre(cadreId, query) {
      await assertCadre(cadreId);

      // Soft-delete filter applies to every read.
      const where: Prisma.ReportWhereInput = { cadreId, deletedAt: null };
      if (query.search !== undefined && query.search !== '') {
        const raw = query.search.trim();
        where.OR = [
          { specificLocation: { contains: raw, mode: 'insensitive' } },
          { currentActivity: { contains: raw, mode: 'insensitive' } },
          { currentPhone: { contains: raw, mode: 'insensitive' } },
        ];
      }

      const [total, rows] = await prisma.$transaction([
        prisma.report.count({ where }),
        prisma.report.findMany({
          where,
          ...withCadre,
          // Newest report first (matches the mobile reports feed).
          orderBy: [{ reportedAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
      ]);

      return {
        data: rows.map(toWireReport),
        total,
        page: query.page,
        pageSize: query.pageSize,
        hasMore: query.page * query.pageSize < total,
      };
    },

    async getById(cadreId, reportId) {
      const report = await prisma.report.findFirst({
        where: { id: reportId, cadreId, deletedAt: null },
        ...withCadre,
      });
      if (report === null) throw notFound('Report not found');
      return toWireReport(report);
    },

    async create(cadreId, body, reporterId) {
      // Idempotent replay: a report already exists for this key → return it (200),
      // never a duplicate. Checked before the cadre assertion so a replay stays
      // cheap and succeeds even if the cadre was later soft-deleted.
      if (body.idempotency_key !== undefined) {
        const existing = await prisma.report.findUnique({
          where: { idempotencyKey: body.idempotency_key },
          ...withCadre,
        });
        if (existing !== null) return { report: toWireReport(existing), created: false };
      }

      await assertCadre(cadreId);

      const data: Prisma.ReportCreateInput = {
        cadre: { connect: { id: cadreId } },
        reportedBy: { connect: { id: reporterId } },
        reportingPlace: body.reporting_place,
        specificLocation: body.specific_location,
        personStatus: body.person_status,
        currentPhone: body.current_phone,
        currentActivity: body.current_activity,
        photoUrl: body.photo_url ?? null,
        gpsLatitude: body.gps_coords?.latitude ?? null,
        gpsLongitude: body.gps_coords?.longitude ?? null,
        gpsAddress: body.gps_coords?.address ?? null,
        isHomeAddress: body.is_home_address ?? null,
        idempotencyKey: body.idempotency_key ?? null,
      };

      try {
        // Create + audit + outbox commit atomically.
        const report = await prisma.$transaction(async (tx) => {
          const created = await tx.report.create({ data, ...withCadre });
          await writeAuditLog(tx, {
            actorId: reporterId,
            action: 'report.create',
            entityType: 'report',
            entityId: String(created.id),
            after: { cadreId, reportedById: reporterId },
          });
          await writeOutboxEvent(tx, {
            aggregateType: 'report',
            aggregateId: String(created.id),
            eventType: 'report.created',
            payload: { reportId: created.id, cadreId, reportedById: reporterId },
          });
          return created;
        });
        return { report: toWireReport(report), created: true };
      } catch (err) {
        // Concurrent replay lost the race on the unique idempotency key: fetch and
        // return the winner's record (200) instead of surfacing the conflict.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002' &&
          body.idempotency_key !== undefined
        ) {
          const winner = await prisma.report.findUnique({
            where: { idempotencyKey: body.idempotency_key },
            ...withCadre,
          });
          if (winner !== null) return { report: toWireReport(winner), created: false };
        }
        throw err;
      }
    },
  };
}
