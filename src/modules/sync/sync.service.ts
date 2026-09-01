import type { FastifyBaseLogger } from 'fastify';
import { Prisma, type PrismaClient, type Role } from '@prisma/client';
import { cadreScopeWhere, scopeAdmitsThana, type CadreScope } from '../../lib/scope.js';
import { toWireCadre, toWireReport, toWireUser, type WireCadre, type WireReport, type WireUser } from '../../lib/serialize.js';
import { LATEST_REPORT, avatarUrlsFor, pendingFieldsFor } from '../cadres/cadres.service.js';
import type { StorageProvider } from '../../lib/storage.js';
import { AppError } from '../../lib/errors.js';
import type { ReportsService } from '../reports/reports.service.js';
import type { Actor, CadreChangesService } from '../cadre-changes/cadre-changes.service.js';
import type { SyncPullQuery, SyncPushBody } from './sync.schema.js';

export interface SyncDeps {
  prisma: PrismaClient;
  log: FastifyBaseLogger;
  storage: StorageProvider;
  mediaUrlTtlSeconds: number;
  // Only `create` / `submit` are needed — the sync push path files reports and
  // proposes cadre edits exactly the way the online routes do, never a second
  // write mechanism with its own rules.
  reports: Pick<ReportsService, 'create'>;
  cadreChanges: Pick<CadreChangesService, 'submit'>;
}

// Hard cap per entity, per pull. At the current roster size (~1,790 cadres) a single
// response comfortably covers a full snapshot; if either table ever outgrows this,
// `truncated` below tells the CLIENT (never advance its cursor past a truncated
// response — retry instead) and the log line tells the operator, rather than either
// silently dropping rows or crashing on the mobile side. Real resumable keyset
// pagination is a documented follow-up, not built pre-emptively for a scale this
// app is nowhere near yet (solo-maintainer simplicity).
const SYNC_PAGE_CAP = 2000;

export interface SyncEntityBlock<T> {
  upserted: T[];
  deleted: number[];
  truncated: boolean;
}

export interface SyncPullResult {
  // Echoed back as the NEXT `lastPulledAt` — a server-issued cursor, deliberately
  // never the device's own clock (a phone offline for weeks may have a badly
  // skewed one; see the module doc comment in sync.routes.ts).
  serverTime: number;
  cadres: SyncEntityBlock<WireCadre>;
  reports: SyncEntityBlock<WireReport>;
  // Empty for officer/viewer callers — see the role gate in pull() below. Present
  // (not omitted) either way so the client's merge logic has one shape to handle.
  officers: SyncEntityBlock<WireUser & { assignedCadreCount: number }>;
}

export interface SyncPushItemResult {
  /** The item's own idempotency key — how the client matches a result back to its
   *  local outbox row. Always present; there is no positional fallback. */
  clientKey: string;
  status: 'created' | 'exists' | 'error';
  serverId?: number;
  /** User-safe message only (AppError's own message, or a generic fallback for an
   *  unexpected failure) — never a stack trace or internal detail. */
  error?: string;
}

export interface SyncPushResult {
  reports: SyncPushItemResult[];
  cadreChangeRequests: SyncPushItemResult[];
}

export interface SyncService {
  pull(query: SyncPullQuery, scope: CadreScope, actorRole: Role): Promise<SyncPullResult>;
  push(body: SyncPushBody, actor: Actor): Promise<SyncPushResult>;
}

/**
 * ADR-044 scope-narrowing. A cadre that moved OUT of this caller's thanas since the
 * cursor must be dropped from their device even though the row itself is alive — a
 * thana transfer, unlike a soft-delete, never touches `Cadre.deletedAt`, so the
 * ordinary tombstone query below cannot see it.
 *
 * Reuses the existing audit trail (`cadre.thana_transfer`, written by
 * `cadresService.transferThana`) as the change-detector rather than adding a new
 * history table: the event is already recorded with the displaced `thana` in
 * `before`, which is exactly what "used to be in scope" needs.
 *
 * A cadre bounced back into scope by a LATER transfer is filtered back out here —
 * it stays a normal update (already in the `upserted` set), not a tombstone.
 */
async function scopeNarrowedCadreIds(prisma: PrismaClient, scope: CadreScope, since: Date): Promise<number[]> {
  if (scope.kind === 'all') return []; // HQ scope never narrows.

  const transfers = await prisma.auditLog.findMany({
    where: { action: 'cadre.thana_transfer', createdAt: { gt: since } },
    select: { entityId: true, before: true },
  });
  const candidateIds = transfers
    .filter((r) => {
      const before = r.before as { thana?: string } | null;
      return before?.thana !== undefined && scopeAdmitsThana(scope, before.thana);
    })
    .map((r) => Number(r.entityId));
  if (candidateIds.length === 0) return [];

  const current = await prisma.cadre.findMany({
    where: { id: { in: candidateIds }, deletedAt: null },
    select: { id: true, thana: true },
  });
  return current.filter((c) => !scopeAdmitsThana(scope, c.thana)).map((c) => c.id);
}

// AppError carries a client-safe message by construction (every call site writes
// one meant to be read by the user — see lib/errors.ts); anything else is an
// unexpected failure and must not leak past a generic Hindi message.
function describeError(err: unknown, log: FastifyBaseLogger, context: Record<string, unknown>): string {
  if (err instanceof AppError) return err.message;
  log.error({ err, ...context }, 'sync push item failed unexpectedly');
  return 'आंतरिक त्रुटि — बाद में पुनः प्रयास करें';
}

export function makeSyncService({ prisma, log, storage, mediaUrlTtlSeconds, reports, cadreChanges }: SyncDeps): SyncService {
  return {
    async pull(query, scope, actorRole) {
      // Captured once, BEFORE any read runs, and handed back as the next cursor. A
      // row written between this line and the queries below just gets picked up on
      // the NEXT pull (its updatedAt will be >= this timestamp) — the alternative,
      // capturing it after the reads, risks missing a row written mid-pull entirely.
      const serverTime = Date.now();
      const since = query.lastPulledAt !== undefined ? new Date(query.lastPulledAt) : undefined;

      // ─── Cadres ───────────────────────────────────────────────────────────────
      const cadreWhere: Prisma.CadreWhereInput = { deletedAt: null, ...cadreScopeWhere(scope) };
      if (since !== undefined) cadreWhere.updatedAt = { gt: since };

      const [cadreRows, cadreDeletedRows] = await Promise.all([
        prisma.cadre.findMany({
          where: cadreWhere,
          include: LATEST_REPORT,
          orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
          take: SYNC_PAGE_CAP + 1,
        }),
        since !== undefined
          ? prisma.cadre.findMany({
              where: { deletedAt: { gt: since }, ...cadreScopeWhere(scope) },
              select: { id: true },
              take: SYNC_PAGE_CAP + 1,
            })
          : Promise.resolve([]),
      ]);

      const cadreTruncated = cadreRows.length > SYNC_PAGE_CAP;
      const cadrePage = cadreTruncated ? cadreRows.slice(0, SYNC_PAGE_CAP) : cadreRows;

      const [pending, avatars] = await Promise.all([
        pendingFieldsFor(prisma, cadrePage.map((r) => r.id)),
        avatarUrlsFor(storage, mediaUrlTtlSeconds, cadrePage),
      ]);

      const wireCadres = cadrePage.map((r) =>
        toWireCadre(r, r.reports[0]?.reportedAt ?? null, {
          pendingFields: pending.get(r.id) ?? [],
          ...avatars.get(r.id),
        }),
      );

      const narrowed = since !== undefined ? await scopeNarrowedCadreIds(prisma, scope, since) : [];
      const cadreDeletedTruncated = cadreDeletedRows.length > SYNC_PAGE_CAP;
      const cadreDeletedIds = [...cadreDeletedRows.slice(0, SYNC_PAGE_CAP).map((r) => r.id), ...narrowed];

      // ─── Reports ──────────────────────────────────────────────────────────────
      // Scoped through the cadre relation — a report is as sensitive as the cadre
      // it is about (matches reports.service.ts's aggregate `list`).
      const reportWhere: Prisma.ReportWhereInput = { deletedAt: null };
      if (scope.kind !== 'all') reportWhere.cadre = { thana: { in: [...scope.thanas] } };
      if (since !== undefined) reportWhere.updatedAt = { gt: since };

      const [reportRows, reportDeletedRows] = await Promise.all([
        prisma.report.findMany({
          where: reportWhere,
          orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
          take: SYNC_PAGE_CAP + 1,
        }),
        since !== undefined
          ? prisma.report.findMany({
              where: {
                deletedAt: { gt: since },
                ...(scope.kind !== 'all' ? { cadre: { thana: { in: [...scope.thanas] } } } : {}),
              },
              select: { id: true },
              take: SYNC_PAGE_CAP + 1,
            })
          : Promise.resolve([]),
      ]);

      const reportTruncated = reportRows.length > SYNC_PAGE_CAP;
      const reportPage = reportTruncated ? reportRows.slice(0, SYNC_PAGE_CAP) : reportRows;
      // No signUrl passed (deliberately): the sync mirror carries structured report
      // fields only. Photo binaries are lazy-fetched by the detail screen, which
      // already re-signs keys on every read (ADR-016) — bulk-signing thousands of
      // presigned URLs into a payload that then sits unread on a phone for weeks
      // is wasted work AND a URL that will be long expired by the time it matters.
      const wireReports = await Promise.all(reportPage.map((r) => toWireReport(r)));

      // ─── Officers (admin+ only — matches GET /officers, ADR-018) ────────────────
      let wireOfficers: (WireUser & { assignedCadreCount: number })[] = [];
      let officerDeletedIds: number[] = [];
      let officerTruncated = false;

      if (actorRole === 'admin' || actorRole === 'super_admin') {
        const officerWhere: Prisma.UserWhereInput = { role: 'officer', deletedAt: null };
        if (scope.kind !== 'all') officerWhere.thana = { in: [...scope.thanas] };
        if (since !== undefined) officerWhere.updatedAt = { gt: since };

        const officerRows = await prisma.user.findMany({
          where: officerWhere,
          orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
          take: SYNC_PAGE_CAP + 1,
          include: { _count: { select: { assignedCadres: { where: { deletedAt: null } } } } },
        });
        officerTruncated = officerRows.length > SYNC_PAGE_CAP;
        wireOfficers = officerRows
          .slice(0, SYNC_PAGE_CAP)
          .map((r) => ({ ...toWireUser(r), assignedCadreCount: r._count.assignedCadres }));

        if (since !== undefined) {
          const deletedOfficers = await prisma.user.findMany({
            where: {
              role: 'officer',
              deletedAt: { gt: since },
              ...(scope.kind !== 'all' ? { thana: { in: [...scope.thanas] } } : {}),
            },
            select: { id: true },
            take: SYNC_PAGE_CAP + 1,
          });
          officerDeletedIds = deletedOfficers.slice(0, SYNC_PAGE_CAP).map((r) => r.id);
        }
      }

      if (cadreTruncated || cadreDeletedTruncated || reportTruncated || officerTruncated) {
        log.warn(
          { lastPulledAt: query.lastPulledAt ?? null, scope },
          'sync pull hit the per-entity page cap (SYNC_PAGE_CAP) — client must retry with the SAME cursor, not advance it',
        );
      }

      return {
        serverTime,
        cadres: { upserted: wireCadres, deleted: cadreDeletedIds, truncated: cadreTruncated || cadreDeletedTruncated },
        reports: {
          upserted: wireReports,
          deleted: reportDeletedRows.slice(0, SYNC_PAGE_CAP).map((r) => r.id),
          truncated: reportTruncated,
        },
        officers: { upserted: wireOfficers, deleted: officerDeletedIds, truncated: officerTruncated },
      };
    },

    async push(body, actor) {
      // Sequential, not Promise.all: two queued edits from the SAME device can
      // target the same cadre (e.g. a report's ADR-052 phone sync and a manual
      // change-request touching another field), and running them concurrently
      // would let them race each other's own drift checks for no real gain — the
      // whole point of an offline outbox is that it was going to sit unsynced for
      // a while anyway; a few hundred ms of serial processing costs nothing.
      const reportResults: SyncPushItemResult[] = [];
      for (const item of body.reports) {
        try {
          const { report, created } = await reports.create(item.cadre_id, item, actor.id, actor.scope, actor.role);
          reportResults.push({
            clientKey: item.idempotency_key,
            status: created ? 'created' : 'exists',
            serverId: report.id,
          });
        } catch (err) {
          reportResults.push({
            clientKey: item.idempotency_key,
            status: 'error',
            error: describeError(err, log, { entity: 'report', cadreId: item.cadre_id }),
          });
        }
      }

      const changeResults: SyncPushItemResult[] = [];
      for (const item of body.cadreChangeRequests) {
        try {
          // ADR-013's pattern, extended to this entity (schema comment on
          // CadreChangeRequest.idempotencyKey): submit() dedupes on the key itself,
          // so a replayed push is safe without a second check here.
          const req = await cadreChanges.submit(
            item.cadre_id,
            { changes: item.changes, note: item.note, idempotency_key: item.idempotency_key },
            actor,
          );
          changeResults.push({ clientKey: item.idempotency_key, status: 'created', serverId: req.id });
        } catch (err) {
          changeResults.push({
            clientKey: item.idempotency_key,
            status: 'error',
            error: describeError(err, log, { entity: 'cadreChangeRequest', cadreId: item.cadre_id }),
          });
        }
      }

      return { reports: reportResults, cadreChangeRequests: changeResults };
    },
  };
}
