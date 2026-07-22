import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Role } from '@prisma/client';
import { makeCadreChangesService, type Actor } from './cadre-changes.service.js';
import { forbidden } from '../../lib/errors.js';
import {
  cadreIdParam,
  changeIdParam,
  listChangesQuery,
  patchCadreBody,
  rejectChangeBody,
  submitChangeBody,
} from './cadre-changes.schema.js';
import { bearerAuth, emptyResponse, jsonResponse, zodToJson } from '../../lib/openapi.js';

const EXAMPLE_CHANGE = {
  id: 1,
  cadreId: 1,
  cadre: { id: 1, name: 'बबलू माडवी', serialNumber: 'BJP/2025/0001' },
  changes: { phone: { old: '+919770784646', new: '+919770784600' } },
  submittedBy: { id: 3, name: 'राजेश कुमार सिंह', role: 'officer' },
  submittedAt: '2026-07-16T10:00:00.000Z',
  note: 'नंबर बदल गया है',
  status: 'pending',
  needsAdmin: true,
  needsSuperAdmin: true,
  awaitingRole: 'admin',
};

// Cadre change requests (ADR-026). An officer/admin proposes an edit to a CADRE
// record; every role above the submitter signs off before it is applied.
//
// Scope is the cadre, NOT the user account — officers do not edit their own
// profile through this.
export async function cadreChangesRoutes(app: FastifyInstance): Promise<void> {
  const service = makeCadreChangesService({
    prisma: app.prisma,
    log: app.log,
    storage: app.storage,
    mediaUrlTtlSeconds: app.config.mediaUrlTtlSeconds,
  });

  // `AuthPrincipal.role` is a plain `string` (it comes off the JWT), but every
  // policy decision here switches on the Role union. Narrow it once, at this
  // boundary, and reject anything unrecognised rather than casting blindly: a
  // token carrying an unknown role must not reach the approval ladder and land in
  // a `default` branch that quietly picks a behaviour for it.
  const ROLES: readonly string[] = ['super_admin', 'admin', 'officer', 'viewer'];

  const actorOf = (request: FastifyRequest): Actor => {
    const principal = request.authUser!;
    if (!ROLES.includes(principal.role)) throw forbidden('Unrecognised role on token');
    return { id: principal.sub, role: principal.role as Role, scope: request.scope! };
  };

  app.post(
    '/cadres/:cadreId/changes',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Cadre changes'],
        summary: 'Propose an edit to a cadre (officer/admin → approval; super_admin applies at once)',
        description:
          'Approval ladder: officer → admin → super_admin (2 approvals); admin → super_admin (1); ' +
          'super_admin applies immediately (the request is still recorded, with status `applied`). ' +
          'Viewers are rejected. Tags/aliases do NOT come through here — see PATCH /cadres/:id.',
        security: bearerAuth,
        params: zodToJson(cadreIdParam),
        body: zodToJson(submitChangeBody),
        response: { 201: jsonResponse('The change request', EXAMPLE_CHANGE) },
      },
    },
    async (request, reply) => {
      const { cadreId } = cadreIdParam.parse(request.params);
      const body = submitChangeBody.parse(request.body);
      const created = await service.submit(cadreId, body, actorOf(request));
      return reply.code(201).send(created);
    },
  );

  app.get(
    '/changes',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Cadre changes'],
        summary: 'List change requests (approver queue, or an officer’s own record)',
        description:
          '`awaitingMe=true` returns only what the caller can sign next — the approver queue. ' +
          '`submittedBy=me` returns the caller’s own proposals and what became of them: with no ' +
          'notification system, this is the only way a submitter learns the outcome. ' +
          'Filters, not access boundaries — any authenticated user may read the list.',
        security: bearerAuth,
        querystring: zodToJson(listChangesQuery),
        response: { 200: jsonResponse('Paginated change requests', { data: [EXAMPLE_CHANGE], total: 1, page: 1, pageSize: 15, hasMore: false }) },
      },
    },
    async (request) => {
      const { submittedBy, ...rest } = listChangesQuery.parse(request.query);
      const resolved = submittedBy === 'me' ? request.authUser!.sub : submittedBy;
      return service.list({ ...rest, submittedBy: resolved }, actorOf(request));
    },
  );

  app.post(
    '/changes/:id/approve',
    {
      preHandler: [app.authenticate, app.requireRole('admin', 'super_admin')],
      schema: {
        tags: ['Cadre changes'],
        summary: 'Approve the rung this request is waiting on (admin+)',
        description:
          'Approve-or-reject only — an approver cannot amend the proposed value, so the thing approved ' +
          'is always the thing proposed. When the last required approval lands, the change is applied ' +
          'in the same transaction. If the underlying value moved since submission the request goes ' +
          '`stale` and is NOT applied.',
        security: bearerAuth,
        params: zodToJson(changeIdParam),
        response: { 200: jsonResponse('The updated request', { ...EXAMPLE_CHANGE, status: 'applied' }) },
      },
    },
    async (request) => {
      const { id } = changeIdParam.parse(request.params);
      return service.approve(id, actorOf(request));
    },
  );

  app.post(
    '/changes/:id/reject',
    {
      preHandler: [app.authenticate, app.requireRole('admin', 'super_admin')],
      schema: {
        tags: ['Cadre changes'],
        summary: 'Reject a change request (admin+). Terminal; reason required.',
        security: bearerAuth,
        params: zodToJson(changeIdParam),
        body: zodToJson(rejectChangeBody),
        response: { 200: jsonResponse('The rejected request', { ...EXAMPLE_CHANGE, status: 'rejected' }) },
      },
    },
    async (request) => {
      const { id } = changeIdParam.parse(request.params);
      const { reason } = rejectChangeBody.parse(request.body);
      return service.reject(id, reason, actorOf(request));
    },
  );

  app.post(
    '/changes/:id/cancel',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Cadre changes'],
        summary: 'Withdraw your own pending change request',
        security: bearerAuth,
        params: zodToJson(changeIdParam),
        response: { 200: jsonResponse('The cancelled request', { ...EXAMPLE_CHANGE, status: 'cancelled' }) },
      },
    },
    async (request) => {
      const { id } = changeIdParam.parse(request.params);
      return service.cancel(id, actorOf(request));
    },
  );

  app.patch(
    '/cadres/:cadreId',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Cadres'],
        summary: 'Direct write of operational metadata (tags/aliases) — no approval',
        description:
          'ONLY `alertTag` and `aliases`. These are filtering/sorting tools rather than facts of ' +
          'record, so they are deliberately outside the approval chain — routing a tag through two ' +
          'approvals would stop tagging being usable, which is the point of having it. Every other ' +
          'cadre field must go through POST /cadres/:cadreId/changes; unknown keys are rejected here ' +
          'rather than silently dropped.',
        security: bearerAuth,
        params: zodToJson(cadreIdParam),
        body: zodToJson(patchCadreBody),
        response: { 204: emptyResponse('Updated') },
      },
    },
    async (request, reply) => {
      const { cadreId } = cadreIdParam.parse(request.params);
      // `.strict()` so an approval-gated field sent here 400s loudly. Silently
      // ignoring it would let a client believe it had saved a phone change that
      // never happened — the phantom-write bug this project keeps re-learning.
      const body = patchCadreBody.parse(request.body);
      await service.patchDirect(cadreId, body, actorOf(request));
      return reply.code(204).send();
    },
  );
}
