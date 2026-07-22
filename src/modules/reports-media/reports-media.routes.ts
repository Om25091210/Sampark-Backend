import type { FastifyInstance } from 'fastify';
import { makeReportsMediaService } from './reports-media.service.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { mediaCadreParam, isAllowedImageType } from './reports-media.schema.js';
import { bearerAuth, jsonResponse, zodToJson } from '../../lib/openapi.js';

// Report media: photo upload (officer+) and PDF export (admin+). Both hang off the
// same `/cadres/:cadreId/reports` space as core reports; no route collisions.
export async function reportsMediaRoutes(app: FastifyInstance): Promise<void> {
  const service = makeReportsMediaService({
    prisma: app.prisma,
    storage: app.storage,
    log: app.log,
    mediaUrlTtlSeconds: app.config.mediaUrlTtlSeconds,
  });

  // POST /cadres/:cadreId/reports/upload — multipart `file` → S3 → { url }. Officer+.
  app.post(
    '/cadres/:cadreId/reports/upload',
    {
      preHandler: [app.authenticate, app.requireRole('officer', 'admin', 'super_admin')],
      schema: {
        tags: ['Reports Media'],
        summary: 'Upload a report photo (officer+)',
        description:
          'multipart/form-data with a single `file` field (image/jpeg or image/png, ≤ 10 MB). ' +
          'Returns the durable `key` (store it in the report’s `photo_keys`) and a presigned ' +
          '`url` for immediate preview (expires after the media TTL).',
        consumes: ['multipart/form-data'],
        security: bearerAuth,
        params: zodToJson(mediaCadreParam),
        response: {
          200: jsonResponse('Stored — durable key + presigned preview URL', {
            key: 'reports/cadre-12/9f1c….jpg',
            url: 'https://sampark-media.s3.ap-south-1.amazonaws.com/reports/cadre-12/9f1c….jpg?X-Amz-…',
          }),
        },
      },
    },
    async (request) => {
      const { cadreId } = mediaCadreParam.parse(request.params);

      const mp = await request.file();
      if (mp === undefined) throw badRequest('multipart file field "file" is required', 'FILE_REQUIRED');
      if (!isAllowedImageType(mp.mimetype)) {
        throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only image/jpeg and image/png are accepted');
      }

      // Buffers the stream; @fastify/multipart enforces the byte cap and throws
      // (→ 413 via the central error handler) if the file exceeds UPLOAD_MAX_BYTES.
      const buffer = await mp.toBuffer();

      return service.uploadPhoto(cadreId, { buffer, contentType: mp.mimetype }, request.scope!);
    },
  );

  // ADR-029. POST /cadres/:cadreId/avatar/upload — multipart `file` → S3 → { key, url }.
  // Open to every non-viewer: uploading is not the same as changing the photo. The
  // key only becomes the cadre's portrait once a change request carrying it is
  // approved, so an officer uploading here has not altered the record.
  app.post(
    '/cadres/:cadreId/avatar/upload',
    {
      preHandler: [app.authenticate, app.requireRole('officer', 'admin', 'super_admin')],
      schema: {
        tags: ['Reports Media'],
        summary: 'Upload a cadre photo (officer+) — returns a key to propose',
        description:
          'multipart/form-data with a single `file` field (image/jpeg or image/png, ≤ 10 MB). ' +
          'Returns the durable `key` and a presigned `url` for preview. The key does NOT become the ' +
          'cadre’s photo by itself — propose it as `avatarKey` via POST /cadres/:cadreId/changes and it ' +
          'applies on approval (ADR-026/029).',
        consumes: ['multipart/form-data'],
        security: bearerAuth,
        params: zodToJson(mediaCadreParam),
        response: {
          200: jsonResponse('Stored — durable key + presigned preview URL', {
            key: 'cadres/cadre-12/avatar-9f1c….jpg',
            url: 'https://sampark-media.s3.ap-south-1.amazonaws.com/cadres/cadre-12/avatar-9f1c….jpg?X-Amz-…',
          }),
        },
      },
    },
    async (request) => {
      const { cadreId } = mediaCadreParam.parse(request.params);
      const mp = await request.file();
      if (mp === undefined) throw badRequest('multipart file field "file" is required', 'FILE_REQUIRED');
      if (!isAllowedImageType(mp.mimetype)) {
        throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only image/jpeg and image/png are accepted');
      }
      const buffer = await mp.toBuffer();
      return service.uploadAvatar(cadreId, { buffer, contentType: mp.mimetype }, request.scope!);
    },
  );

  // GET /cadres/:cadreId/reports/export — Hindi PDF → S3 → { download_url }. Admin+.
  app.get(
    '/cadres/:cadreId/reports/export',
    {
      preHandler: [app.authenticate, app.requireRole('admin', 'super_admin')],
      schema: {
        tags: ['Reports Media'],
        summary: 'Export a cadre’s reports as a Hindi PDF (admin+)',
        description: 'Generates a Devanagari PDF of the cadre’s reports and returns a download URL.',
        security: bearerAuth,
        params: zodToJson(mediaCadreParam),
        response: {
          200: jsonResponse('Generated — presigned download URL', {
            download_url:
              'https://sampark-media.s3.ap-south-1.amazonaws.com/exports/cadre-12/reports-….pdf?X-Amz-…',
          }),
        },
      },
    },
    async (request) => {
      const { cadreId } = mediaCadreParam.parse(request.params);
      return service.exportReports(cadreId, request.scope!);
    },
  );
}
