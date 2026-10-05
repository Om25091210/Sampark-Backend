import type { FastifyBaseLogger } from 'fastify';
import { Prisma, type PrismaClient } from '@prisma/client';
import { writeAuditLog } from '../../lib/audit.js';
import { conflict } from '../../lib/errors.js';
import type { StorageProvider } from '../../lib/storage.js';
import type { SheetsSyncProvider, SheetsSyncResult } from '../../lib/sheets-sync.js';
import { resolveMirrorTab, type MirrorTab } from './cadre-export.tabs.js';
import type { SheetPreviewQuery } from './cadre-export.schema.js';

// 25 meant ~294 HTTP round trips for a 7,349-row roster, each triggering a full
// existing-serials rescan on the Apps Script side (B-Smart.gs's handleCadreExport_) --
// the combination timed out 44 of those calls on the first full run. 200 cuts that
// to ~37 calls; combined with that function's now-batched bulk-append write, each
// call comfortably finishes well inside Apps Script's 6-minute execution cap even
// when every row in the chunk carries a photo.
const DEFAULT_CHUNK_SIZE = 200;

// A run that has been "running" longer than this is presumed crashed (the process
// restarted mid-run -- the export is in-process, not durable), so it no longer blocks
// a fresh run. Comfortably above a real full run (~37 chunks).
const RUN_STALE_AFTER_MS = 30 * 60 * 1000;

// The sync_log row used to carry one outcome per cadre (7k+ JSON entries for a full
// roster). It now carries counts plus a bounded sample of failures.
const ERROR_SAMPLE_LIMIT = 50;

export interface CadreExportDeps {
  prisma: PrismaClient;
  storage: StorageProvider;
  sheetsSync: SheetsSyncProvider;
  log: FastifyBaseLogger;
  /** Overridable for tests -- production leaves this at DEFAULT_CHUNK_SIZE. */
  chunkSize?: number;
}

export interface ExportRunHandle {
  runId: number;
  /** ISO timestamp stamped on every row of this run; drives the stale-row pass. */
  startedAt: string;
}

interface ExportErrorSample {
  cadreId: number | null;
  serialNumber: string | null;
  error: string;
}

export interface CadreExportService {
  /**
   * Claims the single export slot: throws a 409 if a run is already in flight, else
   * records a `running` sync_log row (+ the audit entry) atomically. Split from
   * execute() so the route can answer 409/202 before the background work starts.
   */
  begin(actorId: number): Promise<ExportRunHandle>;
  /**
   * Runs to completion in-process, chunked. ADR-058: this is a manual, super_admin-
   * triggered BATCH, never a per-mutation stream -- so there is no durability
   * requirement beyond "safe to click again", which upsert-by-cadreId on the Apps
   * Script side already gives for free. If the process restarts mid-run, the run
   * simply stops (its `running` row goes stale after RUN_STALE_AFTER_MS); a
   * super_admin re-clicking the button re-syncs everything.
   */
  execute(handle: ExportRunHandle): Promise<void>;
  /** begin() + execute() in one call -- used by tests and any caller that wants to await it. */
  runExport(actorId: number): Promise<void>;
  /** ADR-058 §3: a live, on-demand read of the mirror sheet -- tab counts + a capped page of one tab. */
  preview(query?: Partial<SheetPreviewQuery>): Promise<SheetsSyncResult>;
}

interface ExportableCadre {
  id: number;
  serialNumber: string | null;
  name: string;
  phone: string;
  thana: string;
  subDivision: string | null;
  district: string | null;
  currentAddress: string;
  permanentAddress: string | null;
  designation: string;
  category: string;
  priorityCategory: string | null;
  alertLevel: string;
  alertTag: string | null;
  filter: string | null;
  regiment: string | null;
  aliases: string[];
  surrenderDate: Date | null;
  surrenderYear: string | null;
  surrenderLocation: string | null;
  surrenderOrigin: string | null;
  otherOriginType: string | null;
  fatherName: string | null;
  motherName: string | null;
  spouseName: string | null;
  incident: string | null;
  gender: string | null;
  caste: string | null;
  dateOfBirth: Date | null;
  avatarKey: string | null;
  assignedOfficer: { name: string } | null;
}

// Date-only (YYYY-MM-DD): readable in a sheet cell, and exactly what the push side
// (B-Smart-Push.gs) validates and sends back, so a round-tripped row stays stable.
const toDateOnly = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));

// ADR-058 §5. Text fields follow the Cadre wire entity's field names. Images travel
// as base64 bytes downloaded server-side (never a presigned URL, which would rot
// past the mirror's browse window) -- Apps Script decodes them with Utilities.newBlob()
// and embeds via Sheet.insertImage(), removing any image already anchored at that
// cell first so a repeat sync replaces the photo instead of stacking a second one
// on top (B-Smart.gs's handleCadreExport_). This only ever needs to REMOVE + RE-INSERT
// a floating image, never read one's bytes back out -- the operation this file's own
// photo-backfill code found unsupported is extracting bytes FROM an existing image,
// a different problem this export never runs into (it always has fresh bytes from S3).
async function buildRowPayload(
  cadre: ExportableCadre,
  tab: MirrorTab,
  runStartedAt: string,
  storage: StorageProvider,
  log: FastifyBaseLogger,
): Promise<Record<string, unknown>> {
  const row: Record<string, unknown> = {
    // `cadreId` -- not `serialNumber` -- is the upsert key: serialNumber is nullable
    // (a cadre created in the app has none), and every null-serial row collapsing
    // onto the same '' key silently overwrote the others.
    cadreId: cadre.id,
    tab,
    syncedAt: runStartedAt,
    serialNumber: cadre.serialNumber,
    name: cadre.name,
    phone: cadre.phone,
    thana: cadre.thana,
    subDivision: cadre.subDivision,
    district: cadre.district,
    currentAddress: cadre.currentAddress,
    permanentAddress: cadre.permanentAddress,
    designation: cadre.designation,
    priorityCategory: cadre.priorityCategory,
    alertLevel: cadre.alertLevel,
    alertTag: cadre.alertTag,
    filter: cadre.filter,
    regiment: cadre.regiment,
    surrenderDate: toDateOnly(cadre.surrenderDate),
    surrenderYear: cadre.surrenderYear,
    surrenderLocation: cadre.surrenderLocation,
    fatherName: cadre.fatherName,
    motherName: cadre.motherName,
    spouseName: cadre.spouseName,
    incident: cadre.incident,
    gender: cadre.gender,
    caste: cadre.caste,
    dateOfBirth: toDateOnly(cadre.dateOfBirth),
    aliases: cadre.aliases,
    assignedOfficerName: cadre.assignedOfficer?.name ?? null,
  };

  if (cadre.avatarKey !== null) {
    // A missing object (key set but the S3/mock object is gone) or a failed download
    // is a per-row skip of the image only -- never a reason to drop the row, and
    // never a reason to fail the other 199 rows in its chunk.
    try {
      const obj = await storage.getObject(cadre.avatarKey);
      if (obj !== null) {
        row.avatarBase64 = obj.body.toString('base64');
        row.avatarContentType = obj.contentType;
      }
    } catch (err) {
      log.warn({ err, cadreId: cadre.id }, 'cadre export: avatar download failed, exporting row without photo');
    }
  }

  return row;
}

export function makeCadreExportService(deps: CadreExportDeps): CadreExportService {
  const { prisma, storage, sheetsSync, log, chunkSize = DEFAULT_CHUNK_SIZE } = deps;

  async function begin(actorId: number): Promise<ExportRunHandle> {
    const startedAt = new Date().toISOString();
    const runId = await prisma.$transaction(async (tx) => {
      // The advisory lock serialises concurrent begin() calls, so "check for a running
      // row, then insert one" is atomic -- without it two near-simultaneous clicks both
      // see "nothing running" and both start a run, racing on the sheet's append row.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('cadre.export'))`;

      const running = await tx.syncLog.findFirst({
        where: {
          eventType: 'cadre.export',
          status: 'running',
          createdAt: { gte: new Date(Date.now() - RUN_STALE_AFTER_MS) },
        },
        select: { id: true },
      });
      if (running !== null) {
        throw conflict('A cadre sheet export is already running', 'EXPORT_RUNNING');
      }

      await writeAuditLog(tx, {
        actorId,
        action: 'cadre.export_triggered',
        entityType: 'cadre_export',
        entityId: 'all',
      });
      const row = await tx.syncLog.create({
        data: { eventType: 'cadre.export', targetKey: `run-${startedAt}`, status: 'running' },
        select: { id: true },
      });
      return row.id;
    });
    return { runId, startedAt };
  }

  async function execute(handle: ExportRunHandle): Promise<void> {
    const { runId, startedAt } = handle;
    const byTab: Record<string, number> = {};
    const errors: ExportErrorSample[] = [];
    let total = 0;
    let errorCount = 0;
    let photoErrors = 0;
    // Rows the sheet kept as-is because a human edited them and has not pushed yet. Not an
    // error (nothing is lost -- the edit is preserved), but surfaced so a "successful" run
    // never hides that those rows were not refreshed from AWS.
    let skippedEdited = 0;
    let finishError: string | undefined;

    const recordError = (sample: ExportErrorSample): void => {
      errorCount += 1;
      if (errors.length < ERROR_SAMPLE_LIMIT) errors.push(sample);
    };

    try {
      let cursor: number | undefined;
      for (;;) {
        const cadres: ExportableCadre[] = await prisma.cadre.findMany({
          // Keyset pagination via `id: { gt: cursor }`, not Prisma's cursor/skip
          // combo -- that mode's next-page query depends on the cursor row still
          // existing, so a concurrent delete of exactly that row silently empties
          // the next page and truncates the run.
          where: { deletedAt: null, ...(cursor !== undefined ? { id: { gt: cursor } } : {}) },
          orderBy: { id: 'asc' },
          take: chunkSize,
          select: {
            id: true,
            serialNumber: true,
            name: true,
            phone: true,
            thana: true,
            subDivision: true,
            district: true,
            currentAddress: true,
            permanentAddress: true,
            designation: true,
            category: true,
            priorityCategory: true,
            alertLevel: true,
            alertTag: true,
            filter: true,
            regiment: true,
            aliases: true,
            surrenderDate: true,
            surrenderYear: true,
            surrenderLocation: true,
            surrenderOrigin: true,
            otherOriginType: true,
            fatherName: true,
            motherName: true,
            spouseName: true,
            incident: true,
            gender: true,
            caste: true,
            dateOfBirth: true,
            avatarKey: true,
            assignedOfficer: { select: { name: true } },
          },
        });
        if (cadres.length === 0) break;
        cursor = cadres[cadres.length - 1]!.id;
        total += cadres.length;

        const rows = await Promise.all(
          cadres.map((c) => buildRowPayload(c, resolveMirrorTab(c), startedAt, storage, log)),
        );

        try {
          const result = await sheetsSync.call('cadre.export', { rows });
          if (result.ok) {
            for (const r of rows) byTab[r.tab as string] = (byTab[r.tab as string] ?? 0) + 1;
            if (typeof result.photoErrors === 'number') photoErrors += result.photoErrors;
            if (typeof result.skippedEdited === 'number') skippedEdited += result.skippedEdited;
            // The script reports rows it refused (e.g. a tab name outside its whitelist)
            // individually; those are errors even though the call itself succeeded.
            const rejected = Array.isArray(result.rejected) ? (result.rejected as Array<{ cadreId?: number; error?: string }>) : [];
            for (const rej of rejected) {
              const c = cadres.find((x) => x.id === rej.cadreId);
              recordError({ cadreId: rej.cadreId ?? null, serialNumber: c?.serialNumber ?? null, error: rej.error ?? 'rejected by sheet' });
            }
          } else {
            for (const c of cadres) recordError({ cadreId: c.id, serialNumber: c.serialNumber, error: result.error ?? 'unknown error' });
          }
        } catch (err) {
          // A chunk failure (network blip, not-yet-configured URL) doesn't abort the
          // whole run -- one bad chunk must not silently drop the rest of the roster
          // from ever being attempted this run.
          const error = err instanceof Error ? err.message : String(err);
          for (const c of cadres) recordError({ cadreId: c.id, serialNumber: c.serialNumber, error });
          log.warn({ err }, 'cadre export chunk failed');
        }

        if (cadres.length < chunkSize) break;
      }

      // Stale-row pass: a cadre deleted in AWS would otherwise stay in the sheet as a
      // live-looking row forever. Only safe after a CLEAN run -- after a partial one,
      // a row missing its stamp may simply be in a chunk that failed, not deleted.
      if (errorCount === 0) {
        try {
          const finish = await sheetsSync.call('cadre.export.finish', { runStartedAt: startedAt });
          if (!finish.ok) finishError = finish.error ?? 'finish step failed';
        } catch (err) {
          finishError = err instanceof Error ? err.message : String(err);
        }
      }
    } catch (err) {
      // Anything unexpected (DB error mid-run): surface it as a failed run instead of
      // leaving the row `running` until it goes stale.
      finishError = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'cadre export run crashed');
    }

    const failed = errorCount > 0 || finishError !== undefined;
    const detail = {
      total,
      errors: errorCount,
      photoErrors,
      skippedEdited,
      byTab,
      errorSamples: errors,
      finishError: finishError ?? null,
    };
    await prisma.syncLog.update({
      where: { id: runId },
      data: {
        status: failed ? 'error' : 'success',
        error: failed ? (finishError ?? errors[0]?.error ?? 'export finished with errors').slice(0, 500) : null,
        detail: detail as unknown as Prisma.InputJsonValue,
      },
    });
    log.info({ rows: total, errors: errorCount, status: failed ? 'error' : 'success' }, 'cadre export run complete');
  }

  return {
    begin,
    execute,
    async runExport(actorId) {
      await execute(await begin(actorId));
    },
    async preview(query = {}) {
      return sheetsSync.call('cadre.preview', { tab: query.tab ?? null, limit: query.limit ?? 50 });
    },
  };
}
