import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Role } from '@prisma/client';
import { makeCadreCreateRequestsService, type Actor } from './cadre-create-requests.service.js';
import { AppError, badRequest, forbidden } from '../../lib/errors.js';
import {
  createRequestIdParam,
  listCreateRequestsQuery,
  rejectCreateRequestBody,
  submitCreateRequestBody,
} from './cadre-create-requests.schema.js';
import { isAllowedImageType } from '../../lib/images.js';
import { bearerAuth, jsonResponse, zodToJson } from '../../lib/openapi.js';

const EXAMPLE_CREATE_REQUEST = {
  id: 1,
  draft: {
    name: 'बबलू माडवी',
    phone: '+919770784646',
    thana: 'बीजापुर',
    currentAddress: 'मचीपाडा थाना गंगालूर जिला बीजापुर',
    designation: 'पश्चिम बस्तर डिवीजन DKBCM',
    category: 'surrendered',
  },
  submittedBy: { id: 3, name: 'राजेश कुमार सिंह', role: 'officer' },
  submittedAt: '2026-07-29T10:00:00.000Z',
  note: 'नया समर्पण',
  status: 'pending',
  needsAdmin: true,
  needsSuperAdmin: true,
  awaitingRole: 'admin',
};

// Cadre CREATION requests — the same two-level approval ladder as cadre-changes
// (ADR-026/027/028), applied to a whole new record instead of an edit to an
// existing one. Flat resource (no cadreId prefix): there is no cadre until the
// ladder resolves.
export async function cadreCreateRequestsRoutes(app: FastifyInstance): Promise<void> {
  const service = makeCadreCreateRequestsService({
    prisma: app.prisma,
    log: app.log,
    storage: app.storage,
    mediaUrlTtlSeconds: app.config.mediaUrlTtlSeconds,
    pushProvider: app.pushProvider,
  });

  const ROLES: readonly string[] = ['super_admin', 'admin', 'officer', 'viewer'];

  const actorOf = (request: FastifyRequest): Actor => {
    const principal = request.authUser!;
    if (!ROLES.includes(principal.role)) throw forbidden('Unrecognised role on token');
    return { id: principal.sub, role: principal.role as Role, scope: request.scope! };
  };

  app.post(
    '/cadre-create-requests',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Cadre create requests'],
        summary: 'Propose a new cadre (officer/admin → approval; super_admin applies at once)',
        description:
          'Approval ladder: officer → admin → super_admin (2 approvals); admin → super_admin (1); ' +
          'super_admin applies immediately (the request is still recorded, with status `applied`). ' +
          'Viewers are rejected. The response may carry a non-blocking `duplicateWarning` if a ' +
          'name+thana+(phone|DOB) match exists against an existing cadre or another pending request ' +
          '— it never blocks submission.',
        security: bearerAuth,
        body: zodToJson(submitCreateRequestBody),
        response: { 201: jsonResponse('The create request', EXAMPLE_CREATE_REQUEST) },
      },
    },
    async (request, reply) => {
      const body = submitCreateRequestBody.parse(request.body);
      const created = await service.submit(body, actorOf(request));
      return reply.code(201).send(created);
    },
  );

  app.get(
    '/cadre-create-requests',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Cadre create requests'],
        summary: 'List create requests (approver queue, or an officer’s own record)',
        description:
          '`awaitingMe=true` returns only what the caller can sign next — the approver queue. ' +
          '`submittedBy=me` returns the caller’s own proposals and what became of them. ' +
          'Filters, not access boundaries — any authenticated user may read the list.',
        security: bearerAuth,
        querystring: zodToJson(listCreateRequestsQuery),
        response: {
          200: jsonResponse('Paginated create requests', {
            data: [EXAMPLE_CREATE_REQUEST],
            total: 1,
            page: 1,
            pageSize: 15,
            hasMore: false,
          }),
        },
      },
    },
    async (request) => {
      const { submittedBy, ...rest } = listCreateRequestsQuery.parse(request.query);
      const resolved = submittedBy === 'me' ? request.authUser!.sub : submittedBy;
      return service.list({ ...rest, submittedBy: resolved }, actorOf(request));
    },
  );

  app.post(
    '/cadre-create-requests/:id/approve',
    {
      preHandler: [app.authenticate, app.requireRole('admin', 'super_admin')],
      schema: {
        tags: ['Cadre create requests'],
        summary: 'Approve the rung this request is waiting on (admin+)',
        description:
          'When the last required approval lands, the real cadre is created in the same ' +
          'transaction with a server-assigned serial number.',
        security: bearerAuth,
        params: zodToJson(createRequestIdParam),
        response: { 200: jsonResponse('The updated request', { ...EXAMPLE_CREATE_REQUEST, status: 'applied' }) },
      },
    },
    async (request) => {
      const { id } = createRequestIdParam.parse(request.params);
      return service.approve(id, actorOf(request));
    },
  );

  app.post(
    '/cadre-create-requests/:id/reject',
    {
      preHandler: [app.authenticate, app.requireRole('admin', 'super_admin')],
      schema: {
        tags: ['Cadre create requests'],
        summary: 'Reject a create request (admin+). Terminal; reason required.',
        security: bearerAuth,
        params: zodToJson(createRequestIdParam),
        body: zodToJson(rejectCreateRequestBody),
        response: { 200: jsonResponse('The rejected request', { ...EXAMPLE_CREATE_REQUEST, status: 'rejected' }) },
      },
    },
    async (request) => {
      const { id } = createRequestIdParam.parse(request.params);
      const { reason } = rejectCreateRequestBody.parse(request.body);
      return service.reject(id, reason, actorOf(request));
    },
  );

  app.post(
    '/cadre-create-requests/:id/cancel',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Cadre create requests'],
        summary: 'Withdraw your own pending create request',
        security: bearerAuth,
        params: zodToJson(createRequestIdParam),
        response: { 200: jsonResponse('The cancelled request', { ...EXAMPLE_CREATE_REQUEST, status: 'cancelled' }) },
      },
    },
    async (request) => {
      const { id } = createRequestIdParam.parse(request.params);
      return service.cancel(id, actorOf(request));
    },
  );

  app.post(
    '/cadre-create-requests/avatar/upload',
    {
      preHandler: [app.authenticate, app.requireRole('officer', 'admin', 'super_admin')],
      schema: {
        tags: ['Cadre create requests'],
        summary: 'Upload a photo for a not-yet-created cadre (officer+) — returns a key to propose',
        description:
          'multipart/form-data with a single `file` field (image/jpeg or image/png, ≤ 10 MB). ' +
          'Returns the durable `key` and a presigned `url` for preview. Unlike ' +
          'POST /cadres/:cadreId/avatar/upload there is no cadreId yet — the key becomes a real ' +
          'photo only once the create request carrying it as `avatarKey` is applied.',
        consumes: ['multipart/form-data'],
        security: bearerAuth,
        response: {
          200: jsonResponse('Stored — durable key + presigned preview URL', {
            key: 'cadres/draft/9f1c…/avatar-9f1c….jpg',
            url: 'https://sampark-media.s3.ap-south-1.amazonaws.com/cadres/draft/9f1c…/avatar-9f1c….jpg?X-Amz-…',
          }),
        },
      },
    },
    async (request) => {
      const mp = await request.file();
      if (mp === undefined) throw badRequest('multipart file field "file" is required', 'FILE_REQUIRED');
      if (!isAllowedImageType(mp.mimetype)) {
        throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only image/jpeg and image/png are accepted');
      }
      const buffer = await mp.toBuffer();
      return service.uploadDraftAvatar({ buffer, contentType: mp.mimetype }, actorOf(request));
    },
  );
}
