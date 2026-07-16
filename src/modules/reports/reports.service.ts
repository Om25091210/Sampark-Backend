import type { FastifyBaseLogger } from 'fastify';
import { Prisma, type PrismaClient } from '@prisma/client';
import { toWireReport, type WireReport } from '../../lib/serialize.js';
import { writeAuditLog } from '../../lib/audit.js';
import { writeOutboxEvent } from '../../lib/outbox.js';
import { notFound } from '../../lib/errors.js';
import type { StorageProvider } from '../../lib/storage.js';
import type {
  CreateReportBody,
  ListReportsQuery,
  ResolvedListAllReportsQuery,
} from './reports.schema.js';

export interface ReportsDeps {
  prisma: PrismaClient;
  log: FastifyBaseLogger;
  // Storage + TTL power the per-read re-signing of photo keys (ADR-016).
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

export interface CreateReportResult {
  report: WireReport;
  // false when an idempotent replay returned the pre-existing record (→ 200).
  created: boolean;
}

export interface ReportsService {
  listByCadre(cadreId: number, query: ListReportsQuery): Promise<Paginated<WireReport>>;
  list(query: ResolvedListAllReportsQuery): Promise<Paginated<WireReport>>;
  getById(cadreId: number, reportId: number): Promise<WireReport>;
  create(cadreId: number, body: CreateReportBody, reporterId: number): Promise<CreateReportResult>;
}

// Load the report together with its cadre so the wire entity can carry the
// nested `cadre` Pick the client renders.
const withCadre = { include: { cadre: true } } as const;

// ADR-024. The report-log date filter is a calendar-day filter in **India
// Standard Time**, not UTC.
//
// `reportedAt` is stored UTC. A report filed at 00:30 IST on the 16th is
// 19:00 UTC on the 15th, so filtering on the UTC day would file it under the
// previous date for the officer who wrote it — they would pick "16 जुलाई" and not
// find their own report. Data residency is India-only and every user is in
// Chhattisgarh, so a fixed +05:30 is correct; IST has no DST to track.
const IST_OFFSET_MS = 330 * 60 * 1000; // +05:30
const DAY_MS = 24 * 60 * 60 * 1000;

/** `2026-07-16` (IST) → the UTC half-open instant range [gte, lt) covering it. */
export function istDayRangeUtc(day: string): { gte: Date; lt: Date } {
  const gte = new Date(Date.parse(`${day}T00:00:00.000Z`) - IST_OFFSET_MS);
  return { gte, lt: new Date(gte.getTime() + DAY_MS) };
}

// Resolves the officer-declared report date. The client's date picker caps at
// today, so a future value means a skewed device clock — clamp it to now rather
// than 400, because the mobile drain drops a queued report after 3 failed
// retries and a rejection would lose the report outright. Absent → now().
function resolveReportedAt(selectedDate: string | undefined, log: FastifyBaseLogger): Date | undefined {
  if (selectedDate === undefined) return undefined;
  const picked = new Date(selectedDate);
  const now = new Date();
  if (picked.getTime() > now.getTime()) {
    log.warn({ selectedDate }, 'selected_date is in the future (device clock skew); clamping to now');
    return now;
  }
  return picked;
}

export function makeReportsService({ prisma, log, storage, mediaUrlTtlSeconds }: ReportsDeps): ReportsService {
  // Re-signs a stored S3 key into a fresh presigned GET URL (ADR-016). Passed to
  // the serializer so every read hands out non-expired photo URLs.
  const signUrl = (key: string): Promise<string> => storage.presignGet(key, mediaUrlTtlSeconds);

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
      // ADR-024: date-only. Filters on `reportedAt` (the date the officer says the
      // reporting happened), never `createdAt` (when the row landed) — an offline
      // report composed Monday may only drain Thursday, and the officer looking for
      // it will pick Monday.
      if (query.date !== undefined) {
        where.reportedAt = istDayRangeUtc(query.date);
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
        data: await Promise.all(rows.map((r) => toWireReport(r, signUrl))),
        total,
        page: query.page,
        pageSize: query.pageSize,
        hasMore: query.page * query.pageSize < total,
      };
    },

    async list(query) {
      // Aggregate feed across every cadre (ADR-021). No cadre assertion — this is
      // not scoped to one cadre; it's "the reports matching this filter".
      const where: Prisma.ReportWhereInput = { deletedAt: null };
      // The route has already resolved `me` to a concrete officer id.
      if (query.reportedBy !== undefined) where.reportedById = query.reportedBy;

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
          orderBy: [{ reportedAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
      ]);

      return {
        data: await Promise.all(rows.map((r) => toWireReport(r, signUrl))),
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
      return toWireReport(report, signUrl);
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
        if (existing !== null) return { report: await toWireReport(existing, signUrl), created: false };
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
        // Officer-declared event date. `undefined` falls through to the schema's
        // @default(now()) for clients that don't send one.
        reportedAt: resolveReportedAt(body.selected_date, log),
        photoUrl: body.photo_url ?? null,
        photoKeys: body.photo_keys ?? [],
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
        return { report: await toWireReport(report, signUrl), created: true };
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
          if (winner !== null) return { report: await toWireReport(winner, signUrl), created: false };
        }
        throw err;
      }
    },
  };
}
