import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Role } from '@prisma/client';
import { makeCadreProformaAService, type Actor } from './cadre-proforma-a.service.js';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { isAllowedImageType } from '../../lib/images.js';
import {
  bulkApproveProformaBody,
  cadreIdParam,
  changeIdParam,
  listProformaChangesQuery,
  rejectProformaChangeBody,
  submitProformaACreateBody,
  submitProformaAEditBody,
  uploadSlotQuery,
} from './cadre-proforma-a.schema.js';
import { bearerAuth, jsonResponse, zodToJson } from '../../lib/openapi.js';

const EXAMPLE_REQUEST = {
  id: 1,
  cadreId: 1,
  proformaType: 'ab',
  changeType: 'create',
  submittedBy: { id: 3, name: 'राजेश कुमार सिंह', role: 'officer' },
  submittedAt: '2026-09-23T10:00:00.000Z',
  status: 'pending',
  needsAdmin: true,
  needsSuperAdmin: true,
  awaitingRole: 'admin',
};

// AB Proforma (ADR-064). One-time-per-cadre record, created/edited only through
// the ProformaChangeRequest ladder — the same "every role above you must
// approve" chain as cadre changes (cadre-changes.policy.ts, reused unchanged).
export async function cadreProformaARoutes(app: FastifyInstance): Promise<void> {
  const service = makeCadreProformaAService({
    prisma: app.prisma,
    log: app.log,
    storage: app.storage,
    mediaUrlTtlSeconds: app.config.mediaUrlTtlSeconds,
  });

  const ROLES: readonly string[] = ['super_admin', 'admin', 'officer', 'viewer'];
  const actorOf = (request: FastifyRequest): Actor => {
    const principal = request.authUser!;
    if (!ROLES.includes(principal.role)) throw forbidden('Unrecognised role on token');
    return { id: principal.sub, role: principal.role as Role, scope: request.scope! };
  };

  app.get(
    '/cadres/:cadreId/proforma-a',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Proforma'],
        summary: 'Fetch a cadre’s AB Proforma',
        description: '404 if none has been created yet for this cadre — the UI shows a "create" action.',
        security: bearerAuth,
        params: zodToJson(cadreIdParam),
        response: { 200: jsonResponse('The AB Proforma record', {}) },
      },
    },
    async (request) => {
      const { cadreId } = cadreIdParam.parse(request.params);
      const record = await service.get(cadreId, actorOf(request));
      if (record === null) throw notFound('No AB Proforma exists yet for this cadre');
      return record;
    },
  );

  app.post(
    '/cadres/:cadreId/proforma-a',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Proforma'],
        summary: 'Propose a cadre’s AB Proforma (one-time; officer/admin → approval, super_admin applies at once)',
        description: '409 if an AB Proforma already exists for this cadre — PATCH to propose an edit instead.',
        security: bearerAuth,
        params: zodToJson(cadreIdParam),
        body: zodToJson(submitProformaACreateBody),
        response: { 201: jsonResponse('The create request', EXAMPLE_REQUEST) },
      },
    },
    async (request, reply) => {
      const { cadreId } = cadreIdParam.parse(request.params);
      const body = submitProformaACreateBody.parse(request.body);
      const created = await service.submitCreate(cadreId, body, actorOf(request));
      return reply.code(201).send(created);
    },
  );

  app.patch(
    '/cadres/:cadreId/proforma-a',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Proforma'],
        summary: 'Propose an edit to a cadre’s AB Proforma',
        security: bearerAuth,
        params: zodToJson(cadreIdParam),
        body: zodToJson(submitProformaAEditBody),
        response: { 201: jsonResponse('The change request', { ...EXAMPLE_REQUEST, changeType: 'edit' }) },
      },
    },
    async (request, reply) => {
      const { cadreId } = cadreIdParam.parse(request.params);
      const body = submitProformaAEditBody.parse(request.body);
      const created = await service.submitEdit(cadreId, body, actorOf(request));
      return reply.code(201).send(created);
    },
  );

  app.post(
    '/cadres/:cadreId/proforma-a/upload',
    {
      preHandler: [app.authenticate, app.requireRole('officer', 'admin', 'super_admin')],
      schema: {
        tags: ['Proforma'],
        summary: 'Upload a fingerprint or handwriting-sample image (officer+) — returns a key to propose',
        description:
          'multipart/form-data with a single `file` field (image/jpeg or image/png, ≤ 10 MB). ' +
          '`?slot=fingerprint|handwriting` picks which field the returned key is meant for. ' +
          'The key does NOT become part of the record by itself — propose it as `fingerprintKey` or ' +
          '`handwritingSampleKey` via POST/PATCH .../proforma-a and it applies on approval.',
        consumes: ['multipart/form-data'],
        security: bearerAuth,
        params: zodToJson(cadreIdParam),
        querystring: zodToJson(uploadSlotQuery),
        response: {
          200: jsonResponse('Stored — durable key + presigned preview URL', {
            key: 'cadres/cadre-12/proforma-a-fingerprint-9f1c….jpg',
            url: 'https://sampark-media.s3.ap-south-1.amazonaws.com/cadres/cadre-12/proforma-a-fingerprint-9f1c….jpg?X-Amz-…',
          }),
        },
      },
    },
    async (request) => {
      const { cadreId } = cadreIdParam.parse(request.params);
      const { slot } = uploadSlotQuery.parse(request.query);
      const mp = await request.file();
      if (mp === undefined) throw badRequest('multipart file field "file" is required', 'FILE_REQUIRED');
      if (!isAllowedImageType(mp.mimetype)) {
        throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only image/jpeg and image/png are accepted');
      }
      const buffer = await mp.toBuffer();
      return service.uploadImage(cadreId, slot, { buffer, contentType: mp.mimetype }, actorOf(request));
    },
  );

  app.get(
    '/proforma-a-changes',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Proforma'],
        summary: 'List AB Proforma change requests (approver queue, or an officer’s own record)',
        security: bearerAuth,
        querystring: zodToJson(listProformaChangesQuery),
        response: {
          200: jsonResponse('Paginated change requests', {
            data: [EXAMPLE_REQUEST],
            total: 1,
            page: 1,
            pageSize: 15,
            hasMore: false,
          }),
        },
      },
    },
    async (request) => {
      const { submittedBy, ...rest } = listProformaChangesQuery.parse(request.query);
      const resolved = submittedBy === 'me' ? request.authUser!.sub : submittedBy;
      return service.list({ ...rest, submittedBy: resolved }, actorOf(request));
    },
  );

  app.post(
    '/proforma-a-changes/:id/approve',
    {
      preHandler: [app.authenticate, app.requireRole('admin', 'super_admin')],
      schema: {
        tags: ['Proforma'],
        summary: 'Approve the rung this request is waiting on (admin+)',
        security: bearerAuth,
        params: zodToJson(changeIdParam),
        response: { 200: jsonResponse('The updated request', { ...EXAMPLE_REQUEST, status: 'applied' }) },
      },
    },
    async (request) => {
      const { id } = changeIdParam.parse(request.params);
      return service.approve(id, actorOf(request));
    },
  );

  app.post(
    '/proforma-a-changes/approve-bulk',
    {
      preHandler: [app.authenticate, app.requireRole('admin', 'super_admin')],
      schema: {
        tags: ['Proforma'],
        summary: 'Approve many AB Proforma change requests at once (admin+)',
        security: bearerAuth,
        body: zodToJson(bulkApproveProformaBody),
        response: {
          200: jsonResponse('Per-id outcomes and tallies', {
            results: [{ id: 1, status: 'applied' }],
            applied: 1,
            approved: 0,
            stale: 0,
            failed: 0,
          }),
        },
      },
    },
    async (request) => {
      const { ids } = bulkApproveProformaBody.parse(request.body);
      return service.approveBulk(ids, actorOf(request));
    },
  );

  app.post(
    '/proforma-a-changes/:id/reject',
    {
      preHandler: [app.authenticate, app.requireRole('admin', 'super_admin')],
      schema: {
        tags: ['Proforma'],
        summary: 'Reject a change request (admin+). Terminal; reason required.',
        security: bearerAuth,
        params: zodToJson(changeIdParam),
        body: zodToJson(rejectProformaChangeBody),
        response: { 200: jsonResponse('The rejected request', { ...EXAMPLE_REQUEST, status: 'rejected' }) },
      },
    },
    async (request) => {
      const { id } = changeIdParam.parse(request.params);
      const { reason } = rejectProformaChangeBody.parse(request.body);
      return service.reject(id, reason, actorOf(request));
    },
  );

  app.post(
    '/proforma-a-changes/:id/cancel',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Proforma'],
        summary: 'Withdraw your own pending change request',
        security: bearerAuth,
        params: zodToJson(changeIdParam),
        response: { 200: jsonResponse('The cancelled request', { ...EXAMPLE_REQUEST, status: 'cancelled' }) },
      },
    },
    async (request) => {
      const { id } = changeIdParam.parse(request.params);
      return service.cancel(id, actorOf(request));
    },
  );
}
