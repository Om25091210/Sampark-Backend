import type { FastifyBaseLogger } from 'fastify';
import { Prisma, type PrismaClient } from '@prisma/client';
import { writeAuditLog } from '../../lib/audit.js';
import { conflict } from '../../lib/errors.js';
import type { StorageProvider } from '../../lib/storage.js';
import type { SheetsSyncProvider, SheetsSyncResult } from '../../lib/sheets-sync.js';
import { resolveMirrorTab, type MirrorTab } from './cadre-export.tabs.js';
import type { SheetPreviewQuery } from './cadre-export.schema.js';

// The text rows go in big, fast chunks: a chunk is ~200 short strings and the Apps Script
// side writes them with one bulk setValues(). Photos are NOT in these chunks -- see
// PHOTO_BATCH_SIZE. (When photos rode along, one chunk meant 200 downloads held in memory,
// one enormous request body, and 200 Sheet.insertImage() calls inside a single 6-minute
// Apps Script execution: the run stalled after the first chunk.)
const DEFAULT_CHUNK_SIZE = 200;

// Photos are sent in their own small calls. Sheet.insertImage() is slow (seconds each), so
// a call must stay well inside Apps Script's 6-minute cap; 10 also bounds server memory
// (10 photos in flight, never 200) and keeps the script's lock window short.
const PHOTO_BATCH_SIZE = 10;

// Give up on the photo phase after this many photo calls IN A ROW that made no progress,
// instead of hammering a broken sheet for the other ~700 batches. The rows are already in
// the sheet by then; the next sync retries the photos.
const PHOTO_CONSECUTIVE_FAILURE_LIMIT = 3;

// A run counts as alive while it keeps writing a heartbeat (progress updates). One that has
// been silent this long is presumed crashed (the export is in-process, not durable), so it
// no longer blocks a fresh run.
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

interface PhotoJob {
  cadreId: number;
  tab: MirrorTab;
  avatarKey: string;
}

export interface CadreExportService {
  /**
   * Claims the single export slot: throws a 409 if a run is already in flight, else
   * records a `running` sync_log row (+ the audit entry) atomically. Split from
   * execute() so the route can answer 409/202 before the background work starts.
   */
  begin(actorId: number): Promise<ExportRunHandle>;
  /**
   * Runs to completion in-process: text rows in chunks, then photos in small batches.
   * ADR-058: this is a manual, super_admin-triggered BATCH, never a per-mutation stream --
   * so there is no durability requirement beyond "safe to click again", which upsert-by-
   * cadreId (and the sheet's per-photo marker) on the Apps Script side already gives for
   * free. If the process restarts mid-run, the run simply stops (its `running` row goes
   * stale after RUN_STALE_AFTER_MS without a heartbeat); re-clicking the button re-syncs.
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

// ADR-058 §5. Text fields follow the Cadre wire entity's field names. The row carries
// `photoKey` (the S3 key) but never the bytes: the Apps Script side keeps a short marker of
// the key it last embedded in the row's photo cell and answers with `photoNeeded` for the
// rows whose marker differs, so an unchanged photo is never downloaded, sent or inserted
// again. Bytes travel later, in their own small calls (the photo phase of execute()), as
// base64 downloaded server-side -- never a presigned URL, which would rot past the mirror's
// browse window.
function buildRowPayload(cadre: ExportableCadre, tab: MirrorTab, runStartedAt: string): Record<string, unknown> {
  return {
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
    photoKey: cadre.avatarKey,
  };
}

const numberIds = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];

export function makeCadreExportService(deps: CadreExportDeps): CadreExportService {
  const { prisma, storage, sheetsSync, log, chunkSize = DEFAULT_CHUNK_SIZE } = deps;

  async function begin(actorId: number): Promise<ExportRunHandle> {
    const startedAt = new Date().toISOString();
    const runId = await prisma.$transaction(async (tx) => {
      // The advisory lock serialises concurrent begin() calls, so "check for a running
      // row, then insert one" is atomic -- without it two near-simultaneous clicks both
      // see "nothing running" and both start a run, racing on the sheet's append row.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('cadre.export'))`;

      // Liveness = the newest of the heartbeat the run writes into `detail` and the row's
      // own creation time. A long photo phase keeps heartbeating, so it is never mistaken
      // for a crash; a run that died stops heartbeating and expires after RUN_STALE_AFTER_MS.
      const candidates = await tx.syncLog.findMany({
        where: { eventType: 'cadre.export', status: 'running' },
        select: { createdAt: true, detail: true },
      });
      const cutoff = Date.now() - RUN_STALE_AFTER_MS;
      const alive = candidates.some((r) => {
        const hb =
          typeof r.detail === 'object' && r.detail !== null && !Array.isArray(r.detail)
            ? Date.parse(String((r.detail as Record<string, unknown>).heartbeatAt ?? ''))
            : NaN;
        return Math.max(r.createdAt.getTime(), Number.isNaN(hb) ? 0 : hb) >= cutoff;
      });
      if (alive) {
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
    const photoQueue: PhotoJob[] = [];
    let total = 0;
    let errorCount = 0;
    let photoErrors = 0;
    let photosTotal = 0;
    let photosDone = 0;
    // Rows the sheet kept as-is because a human edited them and has not pushed yet. Not an
    // error (nothing is lost -- the edit is preserved), but surfaced so a "successful" run
    // never hides that those rows were not refreshed from AWS.
    let skippedEdited = 0;
    let finishError: string | undefined;
    let photoPhaseError: string | undefined;

    const recordError = (sample: ExportErrorSample): void => {
      errorCount += 1;
      if (errors.length < ERROR_SAMPLE_LIMIT) errors.push(sample);
    };

    // Progress + heartbeat while running. Best effort: a failed progress write must never
    // fail the export. The page reads it to show where a long run is.
    const writeProgress = async (phase: 'rows' | 'photos'): Promise<void> => {
      try {
        await prisma.syncLog.update({
          where: { id: runId },
          data: {
            detail: {
              phase,
              rowsDone: total,
              photosTotal,
              photosDone,
              heartbeatAt: new Date().toISOString(),
            } as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (err) {
        log.warn({ err }, 'cadre export: progress write failed');
      }
    };

    try {
      // ── Phase 1: text rows ──
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

        const rows = cadres.map((c) => buildRowPayload(c, resolveMirrorTab(c), startedAt));

        try {
          const result = await sheetsSync.call('cadre.export', { rows });
          if (result.ok) {
            for (const r of rows) byTab[r.tab as string] = (byTab[r.tab as string] ?? 0) + 1;
            if (typeof result.skippedEdited === 'number') skippedEdited += result.skippedEdited;
            // The sheet names the rows whose photo cell does not already hold this photo's
            // marker; only those go through the photo phase.
            const needed = new Set(numberIds(result.photoNeeded));
            for (const c of cadres) {
              if (c.avatarKey !== null && needed.has(c.id)) {
                photoQueue.push({ cadreId: c.id, tab: resolveMirrorTab(c), avatarKey: c.avatarKey });
              }
            }
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

        await writeProgress('rows');
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

      // ── Phase 2: photos, in small batches. The mirror is already complete and usable. ──
      photosTotal = photoQueue.length;
      let consecutiveFailures = 0;
      if (photosTotal > 0) await writeProgress('photos');
      while (photoQueue.length > 0) {
        const batch = photoQueue.splice(0, PHOTO_BATCH_SIZE);

        // A missing object (key set but the S3/mock object is gone) or a failed download
        // costs only that photo, never the batch.
        const loaded = await Promise.all(
          batch.map(async (job) => {
            try {
              const obj = await storage.getObject(job.avatarKey);
              if (obj === null) {
                photoErrors += 1;
                return null;
              }
              return {
                cadreId: job.cadreId,
                tab: job.tab,
                photoKey: job.avatarKey,
                base64: obj.body.toString('base64'),
                contentType: obj.contentType,
              };
            } catch (err) {
              photoErrors += 1;
              log.warn({ err, cadreId: job.cadreId }, 'cadre export: avatar download failed, skipping that photo');
              return null;
            }
          }),
        );
        const photos = loaded.filter((p): p is NonNullable<typeof p> => p !== null);
        if (photos.length === 0) {
          photosDone += batch.length;
          continue;
        }

        let deferred: number[] = [];
        let progressed = false;
        try {
          const res = await sheetsSync.call('cadre.export.photos', { photos });
          if (res.ok) {
            const photoIds = new Set(photos.map((p) => p.cadreId));
            deferred = numberIds(res.deferred).filter((id) => photoIds.has(id));
            const perPhotoErrors = Array.isArray(res.errors) ? res.errors.length : 0;
            photoErrors += perPhotoErrors;
            progressed = photos.length - deferred.length > 0;
          } else {
            photoErrors += photos.length;
            log.warn({ error: res.error }, 'cadre export: photo batch rejected by sheet');
          }
        } catch (err) {
          photoErrors += photos.length;
          log.warn({ err }, 'cadre export: photo batch failed');
        }

        if (deferred.length > 0) {
          // The script ran out of time budget partway: re-queue what it did not reach.
          const retry = batch.filter((j) => deferred.includes(j.cadreId));
          photoQueue.unshift(...retry);
        }
        photosDone += batch.length - deferred.length;

        consecutiveFailures = progressed ? 0 : consecutiveFailures + 1;
        if (consecutiveFailures >= PHOTO_CONSECUTIVE_FAILURE_LIMIT) {
          photoPhaseError = `photo sync stopped after ${PHOTO_CONSECUTIVE_FAILURE_LIMIT} failed batches in a row (${photoQueue.length} photos not attempted); rows are in the sheet, run the sync again to retry the photos`;
          break;
        }
        await writeProgress('photos');
      }
    } catch (err) {
      // Anything unexpected (DB error mid-run): surface it as a failed run instead of
      // leaving the row `running` until it goes stale.
      finishError = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'cadre export run crashed');
    }

    const failed = errorCount > 0 || finishError !== undefined || photoPhaseError !== undefined;
    const detail = {
      total,
      errors: errorCount,
      photoErrors,
      photosTotal,
      photosDone,
      skippedEdited,
      byTab,
      errorSamples: errors,
      finishError: finishError ?? photoPhaseError ?? null,
    };
    await prisma.syncLog.update({
      where: { id: runId },
      data: {
        status: failed ? 'error' : 'success',
        error: failed
          ? (finishError ?? photoPhaseError ?? errors[0]?.error ?? 'export finished with errors').slice(0, 500)
          : null,
        detail: detail as unknown as Prisma.InputJsonValue,
      },
    });
    log.info(
      { rows: total, errors: errorCount, photos: photosDone, photoErrors, status: failed ? 'error' : 'success' },
      'cadre export run complete',
    );
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
