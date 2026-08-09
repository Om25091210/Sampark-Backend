import type { FastifyBaseLogger } from 'fastify';
import { Prisma, type PrismaClient } from '@prisma/client';
import { writeAuditLog } from '../../lib/audit.js';
import type { StorageProvider } from '../../lib/storage.js';
import type { SheetsSyncProvider, SheetsSyncResult } from '../../lib/sheets-sync.js';

const DEFAULT_CHUNK_SIZE = 25;

export interface CadreExportDeps {
  prisma: PrismaClient;
  storage: StorageProvider;
  sheetsSync: SheetsSyncProvider;
  log: FastifyBaseLogger;
  /** Overridable for tests -- production leaves this at DEFAULT_CHUNK_SIZE. */
  chunkSize?: number;
}

interface ExportRowOutcome {
  serialNumber: string | null;
  cadreId: number;
  status: 'synced' | 'error';
  error?: string;
}

export interface CadreExportService {
  /**
   * Fire-and-forget from the route: runs to completion in-process, chunked,
   * without blocking the HTTP response. ADR-058: this is a manual,
   * super_admin-triggered BATCH, never a per-mutation stream -- so there is no
   * durability requirement beyond "safe to click again", which upsert-by-
   * serialNumber on the Apps Script side already gives for free. If the
   * process restarts mid-run, the run simply stops; a super_admin re-clicking
   * the button re-syncs everything, including rows already synced.
   */
  runExport(actorId: number): Promise<void>;
  /** ADR-058 §3: a live, on-demand read of the mirror sheet's current contents. */
  preview(): Promise<SheetsSyncResult>;
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
  designation: string;
  category: string;
  priorityCategory: string | null;
  alertLevel: string;
  alertTag: string | null;
  aliases: string[];
  surrenderDate: Date | null;
  surrenderYear: string | null;
  avatarKey: string | null;
  assignedOfficer: { name: string } | null;
}

// ADR-058 §5. Text fields follow the Cadre wire entity's field names. Images travel
// as base64 bytes downloaded server-side (never a presigned URL, which would rot
// past the mirror's browse window) -- Apps Script decodes and embeds them with
// SpreadsheetApp.newCellImage(), an IN-CELL image that a repeat sync can cleanly
// overwrite (unlike Sheet.insertImage()'s floating OverGridImage, which this file's
// own photo-backfill code already found has no supported way to be replaced/read
// back once inserted -- newCellImage() sidesteps that problem entirely).
async function buildRowPayload(
  cadre: ExportableCadre,
  storage: StorageProvider,
): Promise<Record<string, unknown>> {
  const row: Record<string, unknown> = {
    serialNumber: cadre.serialNumber,
    name: cadre.name,
    phone: cadre.phone,
    thana: cadre.thana,
    subDivision: cadre.subDivision,
    district: cadre.district,
    currentAddress: cadre.currentAddress,
    designation: cadre.designation,
    category: cadre.category,
    priorityCategory: cadre.priorityCategory,
    alertLevel: cadre.alertLevel,
    alertTag: cadre.alertTag,
    aliases: cadre.aliases,
    surrenderDate: cadre.surrenderDate?.toISOString() ?? null,
    surrenderYear: cadre.surrenderYear,
    assignedOfficerName: cadre.assignedOfficer?.name ?? null,
  };

  if (cadre.avatarKey !== null) {
    const obj = await storage.getObject(cadre.avatarKey);
    // A missing object (key set but the S3/mock object is gone) is a per-row skip
    // of the image only -- never a reason to drop the whole row from the export.
    if (obj !== null) {
      row.avatarBase64 = obj.body.toString('base64');
      row.avatarContentType = obj.contentType;
    }
  }

  return row;
}

export function makeCadreExportService(deps: CadreExportDeps): CadreExportService {
  const { prisma, storage, sheetsSync, log, chunkSize = DEFAULT_CHUNK_SIZE } = deps;

  return {
    async runExport(actorId) {
      await prisma.$transaction((tx) =>
        writeAuditLog(tx, {
          actorId,
          action: 'cadre.export_triggered',
          entityType: 'cadre_export',
          entityId: 'all',
        }),
      );

      const outcomes: ExportRowOutcome[] = [];
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
            designation: true,
            category: true,
            priorityCategory: true,
            alertLevel: true,
            alertTag: true,
            aliases: true,
            surrenderDate: true,
            surrenderYear: true,
            avatarKey: true,
            assignedOfficer: { select: { name: true } },
          },
        });
        if (cadres.length === 0) break;
        cursor = cadres[cadres.length - 1]!.id;

        const rows = await Promise.all(cadres.map((c) => buildRowPayload(c, storage)));

        try {
          const result = await sheetsSync.call('cadre.export', { rows });
          for (const c of cadres) {
            outcomes.push(
              result.ok
                ? { serialNumber: c.serialNumber, cadreId: c.id, status: 'synced' }
                : { serialNumber: c.serialNumber, cadreId: c.id, status: 'error', error: result.error ?? 'unknown error' },
            );
          }
        } catch (err) {
          // A chunk failure (network blip, not-yet-configured URL) doesn't abort the
          // whole run -- one bad chunk must not silently drop the rest of the roster
          // from ever being attempted this run.
          const error = err instanceof Error ? err.message : String(err);
          for (const c of cadres) outcomes.push({ serialNumber: c.serialNumber, cadreId: c.id, status: 'error', error });
          log.warn({ err }, 'cadre export chunk failed');
        }

        if (cadres.length < chunkSize) break;
      }

      const overallStatus = outcomes.some((o) => o.status === 'error') ? 'error' : 'success';
      await prisma.syncLog.create({
        data: {
          eventType: 'cadre.export',
          targetKey: `run-${new Date().toISOString()}`,
          status: overallStatus,
          detail: outcomes as unknown as Prisma.InputJsonValue,
        },
      });
      log.info({ rows: outcomes.length, status: overallStatus }, 'cadre export run complete');
    },

    async preview() {
      return sheetsSync.call('cadre.preview', {});
    },
  };
}
