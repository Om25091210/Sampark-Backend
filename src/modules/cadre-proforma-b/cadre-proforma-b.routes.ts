import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Role } from '@prisma/client';
import { makeCadreProformaBService, type Actor } from './cadre-proforma-b.service.js';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { isAllowedImageType } from '../../lib/images.js';
import {
  bulkApproveProformaBBody,
  cadreIdParam,
  changeIdParam,
  listProformaBChangesQuery,
  listProformaBQuery,
  proformaBIdParam,
  rejectProformaBChangeBody,
  submitProformaBCreateBody,
  submitProformaBEditBody,
} from './cadre-proforma-b.schema.js';
import { bearerAuth, jsonResponse, zodToJson } from '../../lib/openapi.js';

const EXAMPLE_REQUEST = {
  id: 1,
  cadreId: 1,
  proformaType: 'b',
  changeType: 'create',
  submittedBy: { id: 3, name: 'राजेश कुमार सिंह', role: 'officer' },
  submittedAt: '2026-09-23T10:00:00.000Z',
  status: 'pending',
  needsAdmin: true,
  needsSuperAdmin: true,
  awaitingRole: 'admin',
};

// B Proforma (ADR-064 addendum). Recurring, ~2-monthly filings, created/edited
// through the same ProformaChangeRequest ladder as AB Proforma (proformaType='b').
export async function cadreProformaBRoutes(app: FastifyInstance): Promise<void> {
  const service = makeCadreProformaBService({
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
    '/cadres/:cadreId/proforma-b',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Proforma'],
        summary: 'List a cadre’s B Proforma filing history (newest first)',
        security: bearerAuth,
        params: zodToJson(cadreIdParam),
        querystring: zodToJson(listProformaBQuery),
        response: {
          200: jsonResponse('Paginated filing history', { data: [], total: 0, page: 1, pageSize: 15, hasMore: false }),
        },
      },
    },
    async (request) => {
      const { cadreId } = cadreIdParam.parse(request.params);
      const { page, pageSize } = listProformaBQuery.parse(request.query);
      return service.list(cadreId, page, pageSize, actorOf(request));
    },
  );

  app.get(
    '/cadres/:cadreId/proforma-b/new-draft',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Proforma'],
        summary: 'Prefill helper for a new B Proforma filing — no write',
        description:
          'Snapshots identity/surrender fields from the cadre and carries forward the financial/' +
          'family/legal/health fields from the most recent prior filing (blank on the first ever ' +
          'filing). Time-bound fields (handler, current activity, this period’s problems, …) come ' +
          'back blank. Nothing is persisted — submit the edited result via POST .../proforma-b.',
        security: bearerAuth,
        params: zodToJson(cadreIdParam),
        response: { 200: jsonResponse('A prefilled (unsaved) B Proforma', {}) },
      },
    },
    async (request) => {
      const { cadreId } = cadreIdParam.parse(request.params);
      return service.newDraft(cadreId, actorOf(request));
    },
  );

  app.get(
    '/cadres/:cadreId/proforma-b/:bId',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Proforma'],
        summary: 'Fetch one B Proforma filing',
        security: bearerAuth,
        params: zodToJson(proformaBIdParam),
        response: { 200: jsonResponse('The filing', {}) },
      },
    },
    async (request) => {
      const { cadreId, bId } = proformaBIdParam.parse(request.params);
      const record = await service.getOne(cadreId, bId, actorOf(request));
      if (record === null) throw notFound('B Proforma filing not found');
      return record;
    },
  );

  app.post(
    '/cadres/:cadreId/proforma-b',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Proforma'],
        summary: 'Propose a new period’s B Proforma filing (officer/admin → approval, super_admin applies at once)',
        security: bearerAuth,
        params: zodToJson(cadreIdParam),
        body: zodToJson(submitProformaBCreateBody),
        response: { 201: jsonResponse('The create request', EXAMPLE_REQUEST) },
      },
    },
    async (request, reply) => {
      const { cadreId } = cadreIdParam.parse(request.params);
      const body = submitProformaBCreateBody.parse(request.body);
      const created = await service.submitCreate(cadreId, body, actorOf(request));
      return reply.code(201).send(created);
    },
  );

  app.patch(
    '/cadres/:cadreId/proforma-b/:bId',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Proforma'],
        summary: 'Propose an edit to an already-filed B Proforma',
        security: bearerAuth,
        params: zodToJson(proformaBIdParam),
        body: zodToJson(submitProformaBEditBody),
        response: { 201: jsonResponse('The change request', { ...EXAMPLE_REQUEST, changeType: 'edit' }) },
      },
    },
    async (request, reply) => {
      const { cadreId, bId } = proformaBIdParam.parse(request.params);
      const body = submitProformaBEditBody.parse(request.body);
      const created = await service.submitEdit(cadreId, bId, body, actorOf(request));
      return reply.code(201).send(created);
    },
  );

  app.post(
    '/cadres/:cadreId/proforma-b/upload',
    {
      preHandler: [app.authenticate, app.requireRole('officer', 'admin', 'super_admin')],
      schema: {
        tags: ['Proforma'],
        summary: 'Upload the current-period photo (officer+, camera capture) — returns a key to propose',
        description:
          'multipart/form-data with a single `file` field (image/jpeg or image/png, ≤ 10 MB). ' +
          'The key does NOT become part of a filing by itself — propose it as `currentPhotoKey` via ' +
          'POST/PATCH .../proforma-b and it applies on approval.',
        consumes: ['multipart/form-data'],
        security: bearerAuth,
        params: zodToJson(cadreIdParam),
        response: {
          200: jsonResponse('Stored — durable key + presigned preview URL', {
            key: 'cadres/cadre-12/proforma-b-photo-9f1c….jpg',
            url: 'https://sampark-media.s3.ap-south-1.amazonaws.com/cadres/cadre-12/proforma-b-photo-9f1c….jpg?X-Amz-…',
          }),
        },
      },
    },
    async (request) => {
      const { cadreId } = cadreIdParam.parse(request.params);
      const mp = await request.file();
      if (mp === undefined) throw badRequest('multipart file field "file" is required', 'FILE_REQUIRED');
      if (!isAllowedImageType(mp.mimetype)) {
        throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only image/jpeg and image/png are accepted');
      }
      const buffer = await mp.toBuffer();
      return service.uploadPhoto(cadreId, { buffer, contentType: mp.mimetype }, actorOf(request));
    },
  );

  app.get(
    '/proforma-b-changes',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Proforma'],
        summary: 'List B Proforma change requests (approver queue, or an officer’s own record)',
        security: bearerAuth,
        querystring: zodToJson(listProformaBChangesQuery),
        response: {
          200: jsonResponse('Paginated change requests', {
            data: [EXAMPLE_REQUEST], total: 1, page: 1, pageSize: 15, hasMore: false,
          }),
        },
      },
    },
    async (request) => {
      const { submittedBy, ...rest } = listProformaBChangesQuery.parse(request.query);
      const resolved = submittedBy === 'me' ? request.authUser!.sub : submittedBy;
      return service.listChanges({ ...rest, submittedBy: resolved }, actorOf(request));
    },
  );

  app.post(
    '/proforma-b-changes/:id/approve',
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
    '/proforma-b-changes/approve-bulk',
    {
      preHandler: [app.authenticate, app.requireRole('admin', 'super_admin')],
      schema: {
        tags: ['Proforma'],
        summary: 'Approve many B Proforma change requests at once (admin+)',
        security: bearerAuth,
        body: zodToJson(bulkApproveProformaBBody),
        response: {
          200: jsonResponse('Per-id outcomes and tallies', {
            results: [{ id: 1, status: 'applied' }], applied: 1, approved: 0, stale: 0, failed: 0,
          }),
        },
      },
    },
    async (request) => {
      const { ids } = bulkApproveProformaBBody.parse(request.body);
      return service.approveBulk(ids, actorOf(request));
    },
  );

  app.post(
    '/proforma-b-changes/:id/reject',
    {
      preHandler: [app.authenticate, app.requireRole('admin', 'super_admin')],
      schema: {
        tags: ['Proforma'],
        summary: 'Reject a change request (admin+). Terminal; reason required.',
        security: bearerAuth,
        params: zodToJson(changeIdParam),
        body: zodToJson(rejectProformaBChangeBody),
        response: { 200: jsonResponse('The rejected request', { ...EXAMPLE_REQUEST, status: 'rejected' }) },
      },
    },
    async (request) => {
      const { id } = changeIdParam.parse(request.params);
      const { reason } = rejectProformaBChangeBody.parse(request.body);
      return service.reject(id, reason, actorOf(request));
    },
  );

  app.post(
    '/proforma-b-changes/:id/cancel',
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
