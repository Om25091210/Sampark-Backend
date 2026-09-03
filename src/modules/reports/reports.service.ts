import type { FastifyBaseLogger } from 'fastify';
import { cadreScopeWhere, type CadreScope } from '../../lib/scope.js';
import { Prisma, type PrismaClient, type Role } from '@prisma/client';
import { toWireReport, type WireReport } from '../../lib/serialize.js';
import { writeAuditLog } from '../../lib/audit.js';
import { writeOutboxEvent } from '../../lib/outbox.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import type { StorageProvider } from '../../lib/storage.js';
// ADR-052. Report-time phone sync reuses the SAME approval-ladder write path the
// manual cadre-edit form calls — phone stays an APPROVAL field (ADR-026); this is
// a new way to PROPOSE a change, never a new way to bypass approval.
import type { Actor, CadreChangesService } from '../cadre-changes/cadre-changes.service.js';
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
  // ADR-052. `submit` proposes a phone/photo/death change exactly the way the
  // manual edit form does, never applies one directly. This task adds
  // `cancelBySourceReport` — the withdraw half of death sync, called from
  // `remove()` when a person_status='dead' report is deleted.
  cadreChanges: Pick<CadreChangesService, 'submit' | 'cancelBySourceReport'>;
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
  // ADR-044. Reports inherit their cadre's scope — a report is as sensitive as the cadre
  // it is about, so there is no separate report-level rule. `scope` is required on every
  // read AND on create: writing a report about an out-of-scope cadre is also an escape.
  listByCadre(cadreId: number, query: ListReportsQuery, scope: CadreScope): Promise<Paginated<WireReport>>;
  list(query: ResolvedListAllReportsQuery, scope: CadreScope): Promise<Paginated<WireReport>>;
  getById(cadreId: number, reportId: number, scope: CadreScope): Promise<WireReport>;
  create(
    cadreId: number,
    body: CreateReportBody,
    reporterId: number,
    scope: CadreScope,
    reporterRole: Role,
  ): Promise<CreateReportResult>;
  // This task, item 3. Soft-delete (ADR-006 — deletedAt, never a hard DELETE): who
  // may call this is enforced here, not just by the route's role gate — see the
  // access-control note above `remove`'s implementation.
  remove(cadreId: number, reportId: number, actorId: number, actorRole: Role, scope: CadreScope): Promise<void>;
}

// This task, item 3. An officer may delete only their OWN report, and only within
// this self-correction window — long enough to fix a same-shift mistake, short
// enough that it cannot become a way to quietly erase a stale or inconvenient
// filing. Admin/super_admin have no window: they are the people this system's
// approval ladder already treats as authorised to make permanent decisions about
// a record (ADR-026), and a deletion is a smaller act than the field edits they
// can already apply directly.
const OFFICER_DELETE_WINDOW_MS = 24 * 60 * 60 * 1000;

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

export function makeReportsService({
  prisma,
  log,
  storage,
  mediaUrlTtlSeconds,
  cadreChanges,
}: ReportsDeps): ReportsService {
  // Re-signs a stored S3 key into a fresh presigned GET URL (ADR-016). Passed to
  // the serializer so every read hands out non-expired photo URLs.
  const signUrl = (key: string): Promise<string> => storage.presignGet(key, mediaUrlTtlSeconds);

  // Confirms the cadre exists, is not soft-deleted, AND is inside the caller's scope;
  // throws 404 otherwise. Out-of-scope reads 404 rather than 403 so cadre ids stay
  // unenumerable. This is the single chokepoint for every per-cadre report route.
  // Returns category/priorityCategory (ADR-049 reportability check) and phone
  // (ADR-052 report-time phone sync) too, so create() needs no second query.
  async function assertCadre(
    cadreId: number,
    scope: CadreScope,
  ): Promise<{
    category: string;
    priorityCategory: string | null;
    // This task (item 7).
    permanentStatus: string | null;
    phone: string;
  }> {
    const cadre = await prisma.cadre.findFirst({
      where: { id: cadreId, deletedAt: null, ...cadreScopeWhere(scope) },
      select: { category: true, priorityCategory: true, permanentStatus: true, phone: true },
    });
    if (cadre === null) throw notFound('Cadre not found');
    return cadre;
  }

  return {
    async listByCadre(cadreId, query, scope) {
      await assertCadre(cadreId, scope);

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

    async list(query, scope) {
      // Aggregate feed across every cadre (ADR-021). No cadre assertion — this is
      // not scoped to one cadre; it's "the reports matching this filter".
      // Scoped through the RELATION: a report is visible only if its cadre is. Note this
      // also bounds `reportedBy=me` — an officer who filed a report and then moved station
      // stops seeing it, because the cadre is no longer theirs. That is the correct
      // reading: the boundary is the cadre's jurisdiction, not who typed the report.
      const where: Prisma.ReportWhereInput = { deletedAt: null };
      if (scope.kind !== 'all') where.cadre = { thana: { in: [...scope.thanas] } };
      // The route has already resolved `me` to a concrete officer id.
      if (query.reportedBy !== undefined) where.reportedById = query.reportedBy;
      // Drill-down for the dashboard's "इस सप्ताह रिपोर्ट" tile.
      if (query.reportedAfter !== undefined) where.reportedAt = { gte: new Date(query.reportedAfter) };

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

    async getById(cadreId, reportId, scope) {
      await assertCadre(cadreId, scope);
      const report = await prisma.report.findFirst({
        where: { id: reportId, cadreId, deletedAt: null },
        ...withCadre,
      });
      if (report === null) throw notFound('Report not found');
      return toWireReport(report, signUrl);
    },

    async create(cadreId, body, reporterId, scope, reporterRole) {
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

      const cadre = await assertCadre(cadreId, scope);

      // ADR-049. A cadre in jail custody (Cadre.category) or graded jail/death on
      // the register (Cadre.priorityCategory) cannot be field-reported — there is
      // no reporting due for either (see ADR-046 §3). Checked here, not just in
      // the mobile UI, per the project's API-enforced-authorization rule.
      //
      // This task (item 7). Same rule extended to any permanentStatus mark
      // (फौत/शासकीय नौकरी/GS/अन्य जिले में निवासरत): "no attendance/reporting
      // required going forward" means filing a NEW report is exactly the act
      // being exempted, not just the overdue count.
      if (
        cadre.category === 'jail' ||
        cadre.priorityCategory === 'jail' ||
        cadre.priorityCategory === 'death' ||
        cadre.permanentStatus !== null
      ) {
        throw badRequest(
          'Reports cannot be filed for a jail-custody, deceased, or permanently-marked cadre',
          'CADRE_NOT_REPORTABLE',
        );
      }

      const data: Prisma.ReportCreateInput = {
        cadre: { connect: { id: cadreId } },
        reportedBy: { connect: { id: reporterId } },
        reportingPlace: body.reporting_place,
        specificLocation: body.specific_location,
        personStatus: body.person_status,
        currentPhone: body.current_phone,
        currentActivity: body.current_activity,
        surrenderNetworkDetails: body.surrender_network_details ?? null,
        otherInformation: body.other_information ?? null,
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

        // ADR-052. Report-time phone sync: propose it through the SAME
        // approval-ladder path the manual cadre-edit form uses (phone stays an
        // APPROVAL field, ADR-026) — this is a new way to PROPOSE a change, never
        // a new way to bypass approval. Best-effort only, and only for a fresh
        // create (never a replay): an unrelated in-flight phone change (409
        // CHANGE_PENDING) or any other failure here must never fail the report
        // itself — filing the report is this endpoint's job, not editing the cadre.
        // This task: current_phone is no longer always sent (a 'dead' report
        // omits it), so an absent value must not read as "propose phone: null" —
        // only a REAL, different phone number triggers the sync.
        if (body.current_phone !== undefined && body.current_phone !== cadre.phone) {
          try {
            await cadreChanges.submit(
              cadreId,
              { changes: { phone: body.current_phone } },
              { id: reporterId, role: reporterRole, scope },
            );
          } catch (err) {
            log.warn(
              { err, cadreId, reportId: report.id },
              'report-time phone sync to cadre record failed; report was still created',
            );
          }
        }

        // This task. Report-time PHOTO sync — same ADR-052 idiom (propose through
        // the approval ladder, best-effort, never fails the report), applied to
        // the three avatar slots. Deliberately THREE INDEPENDENT submit() calls,
        // not one multi-field submit: a pending lock on, say, avatarKey2 must not
        // block front/left syncing too — the same "one pending photo never blocks
        // the other two" rule edit.tsx's own three-slot uploader already follows.
        // Not every report carries all three (or any) — each is simply skipped
        // when absent.
        const photoSlots: { field: 'avatarKey' | 'avatarKey2' | 'avatarKey3'; key: string | undefined }[] = [
          { field: 'avatarKey', key: body.front_photo_key },
          { field: 'avatarKey2', key: body.right_photo_key },
          { field: 'avatarKey3', key: body.left_photo_key },
        ];
        for (const slot of photoSlots) {
          if (slot.key === undefined) continue;
          try {
            await cadreChanges.submit(
              cadreId,
              { changes: { [slot.field]: slot.key } },
              { id: reporterId, role: reporterRole, scope },
            );
          } catch (err) {
            log.warn(
              { err, cadreId, reportId: report.id, slot: slot.field },
              'report-time photo sync to cadre record failed; report was still created',
            );
          }
        }

        // This task. Report-time DEATH sync — same ADR-052 idiom again, but ONE
        // bundled submit() (not independent per-field like the photo slots above):
        // permanentStatus='deceased' and deceasedDate are a single fact, and the
        // ladder must approve or reject them together — approving the mark
        // without the date (or vice versa) is not a state anyone asked for.
        // The `!== 'deceased'` guard is technically redundant right now — ADR-049's
        // reportability check above already 400s CADRE_NOT_REPORTABLE for ANY
        // non-null permanentStatus, so this line can only be reached with
        // permanentStatus already null — but it's kept, matching ADR-052's own
        // `!==` idiom, as a harmless guard against that check ever loosening.
        if (body.person_status === 'dead' && cadre.permanentStatus !== 'deceased') {
          try {
            const result = await cadreChanges.submit(
              cadreId,
              { changes: { permanentStatus: 'deceased', deceasedDate: body.death_date! } },
              { id: reporterId, role: reporterRole, scope },
              { sourceReportId: report.id },
            );
            log.info(
              { cadreId, reportId: report.id, changeRequestId: result.id },
              'report-time death sync proposed permanentStatus+deceasedDate',
            );
          } catch (err) {
            log.warn(
              { err, cadreId, reportId: report.id },
              'report-time death sync to cadre record failed; report was still created',
            );
          }
        }

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

    async remove(cadreId, reportId, actorId, actorRole, scope) {
      await assertCadre(cadreId, scope);
      const report = await prisma.report.findFirst({
        where: { id: reportId, cadreId, deletedAt: null },
      });
      if (report === null) throw notFound('Report not found');

      // Access control (this task, item 3): admin+ may delete any report in their
      // scope (already enforced by assertCadre above); an officer may delete only
      // their OWN report, and only within OFFICER_DELETE_WINDOW_MS of filing it —
      // see the constant's comment for why. Viewers never reach here (route-gated).
      if (actorRole === 'officer') {
        if (report.reportedById !== actorId) {
          throw forbidden('You can only delete a report you filed yourself');
        }
        if (Date.now() - report.createdAt.getTime() > OFFICER_DELETE_WINDOW_MS) {
          throw forbidden('This report can no longer be deleted (past the 24-hour window)');
        }
      }

      await prisma.$transaction(async (tx) => {
        await tx.report.update({ where: { id: reportId }, data: { deletedAt: new Date() } });
        // Hash-chained audit trail (ADR-008) is how "who deleted what and when" is
        // recorded — this codebase's soft-delete columns are deletedAt-only, with
        // actor attribution living in the audit log rather than a deletedBy column
        // on every table (see e.g. Cadre, which has the same shape).
        await writeAuditLog(tx, {
          actorId,
          action: 'report.delete',
          entityType: 'report',
          entityId: String(reportId),
          before: { cadreId, reportedById: report.reportedById },
        });
        await writeOutboxEvent(tx, {
          aggregateType: 'report',
          aggregateId: String(reportId),
          eventType: 'report.deleted',
          payload: { reportId, cadreId },
        });
      });

      // This task. Deleting the ONE report that proposed a death mark withdraws
      // that still-pending proposal too — "the officer can also delete the
      // reporting, changing the status from death back to previous" (the
      // maintainer's own framing). Best-effort and outside the transaction
      // above: the report is already deleted regardless of whether this
      // succeeds. A no-op if the change was never pending (already decided, or
      // this report never proposed one) — see cancelBySourceReport's own doc
      // comment for why an already-APPLIED mark is deliberately left alone.
      if (report.personStatus === 'dead') {
        try {
          await cadreChanges.cancelBySourceReport(reportId, actorId);
        } catch (err) {
          log.warn(
            { err, cadreId, reportId },
            'withdrawing the death-sync change request for a deleted report failed',
          );
        }
      }
    },
  };
}
