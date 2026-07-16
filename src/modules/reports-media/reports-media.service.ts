import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { StorageProvider } from '../../lib/storage.js';
import { generateReportsPdf } from '../../lib/pdf.js';
import { notFound } from '../../lib/errors.js';
import { EXT_BY_TYPE } from './reports-media.schema.js';

export interface ReportsMediaDeps {
  prisma: PrismaClient;
  storage: StorageProvider;
  log: FastifyBaseLogger;
  mediaUrlTtlSeconds: number;
}

export interface UploadInput {
  buffer: Buffer;
  contentType: string;
}

export interface ReportsMediaService {
  uploadPhoto(cadreId: number, file: UploadInput): Promise<{ key: string; url: string }>;
  /** ADR-029. The cadre's portrait, as opposed to a report's evidence photo. */
  uploadAvatar(cadreId: number, file: UploadInput): Promise<{ key: string; url: string }>;
  exportReports(cadreId: number): Promise<{ download_url: string }>;
}

export function makeReportsMediaService(deps: ReportsMediaDeps): ReportsMediaService {
  const { prisma, storage, mediaUrlTtlSeconds } = deps;

  // Confirms the cadre exists and is not soft-deleted; throws 404 otherwise.
  async function assertCadre(cadreId: number): Promise<{ name: string; phone: string; thana: string }> {
    const cadre = await prisma.cadre.findFirst({
      where: { id: cadreId, deletedAt: null },
      select: { name: true, phone: true, thana: true },
    });
    if (cadre === null) throw notFound('Cadre not found');
    return cadre;
  }

  return {
    async uploadPhoto(cadreId, file) {
      await assertCadre(cadreId);

      const ext = EXT_BY_TYPE[file.contentType] ?? 'bin';
      const key = `reports/cadre-${cadreId}/${randomUUID()}.${ext}`;
      await storage.put(key, file.buffer, file.contentType);
      const url = await storage.presignGet(key, mediaUrlTtlSeconds);
      // ADR-016: `key` is the durable identity the client stores on the report
      // (`photo_keys`); `url` is a presigned preview, valid only for the TTL window.
      return { key, url };
    },

    // ADR-029. The cadre's own photo. Same storage discipline as report photos —
    // the durable `key` is what gets persisted (proposed through the change-request
    // workflow), the `url` is a presigned preview for the picker only. A separate
    // key prefix from `reports/` so a cadre portrait and a report's evidence photo
    // never share a namespace.
    async uploadAvatar(cadreId, file) {
      await assertCadre(cadreId);

      const ext = EXT_BY_TYPE[file.contentType] ?? 'bin';
      const key = `cadres/cadre-${cadreId}/avatar-${randomUUID()}.${ext}`;
      await storage.put(key, file.buffer, file.contentType);
      const url = await storage.presignGet(key, mediaUrlTtlSeconds);
      return { key, url };
    },

    async exportReports(cadreId) {
      const cadre = await assertCadre(cadreId);

      // Soft-delete filter applies; chronological order reads best in a document.
      const reports = await prisma.report.findMany({
        where: { cadreId, deletedAt: null },
        orderBy: [{ reportedAt: 'asc' }, { id: 'asc' }],
        include: { reportedBy: { select: { name: true } } },
      });

      const pdf = await generateReportsPdf({
        cadreName: cadre.name,
        cadrePhone: cadre.phone,
        cadreThana: cadre.thana,
        generatedAt: new Date(),
        reports: reports.map((r) => ({
          reportedAt: r.reportedAt,
          reportingPlace: r.reportingPlace,
          specificLocation: r.specificLocation,
          personStatus: r.personStatus,
          currentPhone: r.currentPhone,
          currentActivity: r.currentActivity,
          reporterName: r.reportedBy.name,
        })),
      });

      const key = `exports/cadre-${cadreId}/reports-${Date.now()}-${randomUUID()}.pdf`;
      await storage.put(key, pdf, 'application/pdf');
      const download_url = await storage.presignGet(key, mediaUrlTtlSeconds);
      // snake_case response per the client contract (report.service.ts expects { download_url }).
      return { download_url };
    },
  };
}
