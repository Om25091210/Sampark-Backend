import { randomUUID } from 'node:crypto';
import { cadreScopeWhere, type CadreScope } from '../../lib/scope.js';
import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { StorageProvider } from '../../lib/storage.js';
import { generateProfilePdf, generateReportsPdf } from '../../lib/pdf.js';
import { sniffImageType } from '../../lib/images.js';
import { deriveAge } from '../../lib/serialize.js';
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
  // ADR-044. Scoped: the export is a PDF of a cadre's whole reporting history, and the
  // uploads write evidence against a cadre record - both are cadre access by another name.
  uploadPhoto(cadreId: number, file: UploadInput, scope: CadreScope): Promise<{ key: string; url: string }>;
  /** ADR-029. The cadre's portrait, as opposed to a report's evidence photo. */
  uploadAvatar(cadreId: number, file: UploadInput, scope: CadreScope): Promise<{ key: string; url: string }>;
  exportReports(cadreId: number, scope: CadreScope): Promise<{ download_url: string }>;
  /** Master-profile PDF (photos + particulars + criminal cases). Same scope rules as exportReports. */
  exportProfile(cadreId: number, scope: CadreScope): Promise<{ download_url: string }>;
}

// A PDF is built fully in memory, so photo embedding is bounded: an image over
// MAX_PHOTO_BYTES is skipped, and once MAX_TOTAL_PHOTO_BYTES is spent the rest are too.
// Skips are counted and reported in the document, never silent.
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
const MAX_TOTAL_PHOTO_BYTES = 60 * 1024 * 1024;
const PHOTO_FETCH_CONCURRENCY = 6;

export function makeReportsMediaService(deps: ReportsMediaDeps): ReportsMediaService {
  const { prisma, storage, log, mediaUrlTtlSeconds } = deps;

  // Fetches each key's bytes (bounded parallelism) and returns them in key order:
  // `null` for a photo that could not go in the PDF â€” missing object, not a JPEG/PNG
  // (pdfmake embeds no other format), over the per-image cap, or past the total budget.
  async function loadPhotos(keys: string[]): Promise<(Buffer | null)[]> {
    const out: (Buffer | null)[] = new Array<Buffer | null>(keys.length).fill(null);
    let spent = 0;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < keys.length) {
        const i = next++;
        try {
          const obj = await storage.getObject(keys[i]!);
          if (obj === null || obj.body.length > MAX_PHOTO_BYTES || sniffImageType(obj.body) === null) continue;
          if (spent + obj.body.length > MAX_TOTAL_PHOTO_BYTES) continue;
          spent += obj.body.length;
          out[i] = obj.body;
        } catch (err) {
          // One unreadable photo must not sink the whole export.
          log.warn({ err, key: keys[i] }, 'pdf export: photo fetch failed');
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PHOTO_FETCH_CONCURRENCY, keys.length) }, worker));
    return out;
  }

  // Confirms the cadre exists and is not soft-deleted; throws 404 otherwise.
  async function assertCadre(
    cadreId: number,
    scope: CadreScope,
  ): Promise<{ name: string; phone: string; thana: string }> {
    const cadre = await prisma.cadre.findFirst({
      where: { id: cadreId, deletedAt: null, ...cadreScopeWhere(scope) },
      select: { name: true, phone: true, thana: true },
    });
    if (cadre === null) throw notFound('Cadre not found');
    return cadre;
  }

  return {
    async uploadPhoto(cadreId, file, scope) {
      await assertCadre(cadreId, scope);

      const ext = EXT_BY_TYPE[file.contentType] ?? 'bin';
      const key = `reports/cadre-${cadreId}/${randomUUID()}.${ext}`;
      await storage.put(key, file.buffer, file.contentType);
      const url = await storage.presignGet(key, mediaUrlTtlSeconds);
      // ADR-016: `key` is the durable identity the client stores on the report
      // (`photo_keys`); `url` is a presigned preview, valid only for the TTL window.
      return { key, url };
    },

    // ADR-029. The cadre's own photo. Same storage discipline as report photos â€”
    // the durable `key` is what gets persisted (proposed through the change-request
    // workflow), the `url` is a presigned preview for the picker only. A separate
    // key prefix from `reports/` so a cadre portrait and a report's evidence photo
    // never share a namespace.
    async uploadAvatar(cadreId, file, scope) {
      await assertCadre(cadreId, scope);

      const ext = EXT_BY_TYPE[file.contentType] ?? 'bin';
      const key = `cadres/cadre-${cadreId}/avatar-${randomUUID()}.${ext}`;
      await storage.put(key, file.buffer, file.contentType);
      const url = await storage.presignGet(key, mediaUrlTtlSeconds);
      return { key, url };
    },

    async exportReports(cadreId, scope) {
      const cadre = await assertCadre(cadreId, scope);

      // Soft-delete filter applies; chronological order reads best in a document.
      const reports = await prisma.report.findMany({
        where: { cadreId, deletedAt: null },
        orderBy: [{ reportedAt: 'asc' }, { id: 'asc' }],
        include: { reportedBy: { select: { name: true } } },
      });

      // One flat fetch across every report, then handed back out per report by offset.
      const allKeys = reports.flatMap((r) => r.photoKeys);
      const loaded = await loadPhotos(allKeys);
      const photosOmitted = loaded.filter((b) => b === null).length;
      let offset = 0;
      const photosByReport = reports.map((r) => {
        const slice = loaded.slice(offset, offset + r.photoKeys.length);
        offset += r.photoKeys.length;
        return slice.filter((b): b is Buffer => b !== null);
      });

      const pdf = await generateReportsPdf({
        cadreName: cadre.name,
        cadrePhone: cadre.phone,
        cadreThana: cadre.thana,
        generatedAt: new Date(),
        photosOmitted,
        reports: reports.map((r, i) => ({
          photos: photosByReport[i]!,
          reportedAt: r.reportedAt,
          reportingPlace: r.reportingPlace,
          specificLocation: r.specificLocation ?? undefined,
          personStatus: r.personStatus,
          currentPhone: r.currentPhone ?? undefined,
          currentActivity: r.currentActivity ?? undefined,
          surrenderNetworkDetails: r.surrenderNetworkDetails ?? undefined,
          otherInformation: r.otherInformation ?? undefined,
          reporterName: r.reportedBy.name,
        })),
      });

      const key = `exports/cadre-${cadreId}/reports-${Date.now()}-${randomUUID()}.pdf`;
      await storage.put(key, pdf, 'application/pdf');
      const download_url = await storage.presignGet(key, mediaUrlTtlSeconds);
      // snake_case response per the client contract (report.service.ts expects { download_url }).
      return { download_url };
    },

    async exportProfile(cadreId, scope) {
      await assertCadre(cadreId, scope);
      const c = await prisma.cadre.findFirst({
        where: { id: cadreId, deletedAt: null, ...cadreScopeWhere(scope) },
        include: {
          cases: { where: { deletedAt: null }, orderBy: { id: 'asc' } },
          reports: { where: { deletedAt: null }, orderBy: { reportedAt: 'desc' }, take: 1, select: { reportedAt: true } },
        },
      });
      if (c === null) throw notFound('Cadre not found');

      const slotKeys = [c.avatarKey, c.avatarKey2, c.avatarKey3].filter((k): k is string => k !== null);
      const loaded = await loadPhotos(slotKeys);

      const pdf = await generateProfilePdf({
        generatedAt: new Date(),
        photos: loaded.filter((b): b is Buffer => b !== null),
        photosOmitted: loaded.filter((b) => b === null).length,
        cadre: {
          serialNumber: c.serialNumber ?? undefined,
          name: c.name,
          phone: c.phone,
          aliases: c.aliases,
          gender: c.gender ?? undefined,
          dateOfBirth: c.dateOfBirth ?? undefined,
          age: deriveAge(c.dateOfBirth),
          fatherName: c.fatherName ?? undefined,
          motherName: c.motherName ?? undefined,
          spouseName: c.spouseName ?? undefined,
          caste: c.caste ?? undefined,
          thana: c.thana,
          subDivision: c.subDivision ?? undefined,
          district: c.district ?? undefined,
          currentAddress: c.currentAddress,
          permanentAddress: c.permanentAddress ?? undefined,
          residingVillage: c.residingVillage ?? undefined,
          designation: c.designation,
          post: c.post ?? undefined,
          regiment: c.regiment ?? undefined,
          familyGroupInfo: c.familyGroupInfo ?? undefined,
          category: c.category,
          priorityCategory: c.priorityCategory ?? undefined,
          permanentStatus: c.permanentStatus ?? undefined,
          custodyStatus: c.custodyStatus ?? undefined,
          deceasedDate: c.deceasedDate ?? undefined,
          surrenderDate: c.surrenderDate ?? undefined,
          surrenderLocation: c.surrenderLocation ?? undefined,
          surrenderYear: c.surrenderYear ?? undefined,
          hasAadhaar: c.hasAadhaar,
          hasBankAccount: c.hasBankAccount,
          hasAbProforma: c.hasAbProforma,
          hasAgreementLetter: c.hasAgreementLetter,
          lastReportedAt: c.reports[0]?.reportedAt,
        },
        cases: c.cases.map((k) => ({
          crimeNumber: k.crimeNumber ?? undefined,
          sections: k.sections ?? undefined,
          crimeThana: k.crimeThana ?? undefined,
          crimeDescription: k.crimeDescription ?? undefined,
          arrestDate: k.arrestDate ?? undefined,
          bailGranted: k.bailGranted,
          bailDate: k.bailDate ?? undefined,
          inJail: k.inJail,
          jailName: k.jailName ?? undefined,
          underInvestigation: k.underInvestigation,
          underTrial: k.underTrial,
          challanNumber: k.challanNumber ?? undefined,
          courtName: k.courtName ?? undefined,
          caseStatus: k.caseStatus ?? undefined,
          publicHarmOccurred: k.publicHarmOccurred,
          uapaApplied: k.uapaApplied,
        })),
      });

      const key = `exports/cadre-${cadreId}/profile-${Date.now()}-${randomUUID()}.pdf`;
      await storage.put(key, pdf, 'application/pdf');
      return { download_url: await storage.presignGet(key, mediaUrlTtlSeconds) };
    },
  };
}
