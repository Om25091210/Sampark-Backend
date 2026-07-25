import type { FastifyInstance } from 'fastify';
import type { Role } from '@prisma/client';
import { makeReportsService } from './reports.service.js';
import { makeCadreChangesService } from '../cadre-changes/cadre-changes.service.js';
import { badRequest, forbidden } from '../../lib/errors.js';
import {
  createReportBody,
  listAllReportsQuery,
  listReportsQuery,
  reportCadreParam,
  reportDetailParams,
} from './reports.schema.js';
import {
  bearerAuth,
  examplePage,
  jsonResponse,
  zodToJson,
  EXAMPLE_REPORT,
} from '../../lib/openapi.js';

// Reports filed against a cadre. All routes require authentication; creating a
// report is officer+ (viewers are read-only).
export async function reportsRoutes(app: FastifyInstance): Promise<void> {
  // ADR-052. Report creation proposes a report-time phone mismatch through the
  // SAME change-request path the manual cadre-edit form uses — a second
  // instance sharing the same underlying deps, not a separate write mechanism.
  const cadreChanges = makeCadreChangesService({
    prisma: app.prisma,
    log: app.log,
    storage: app.storage,
    mediaUrlTtlSeconds: app.config.mediaUrlTtlSeconds,
    pushProvider: app.pushProvider,
  });

  const service = makeReportsService({
    prisma: app.prisma,
    log: app.log,
    storage: app.storage,
    mediaUrlTtlSeconds: app.config.mediaUrlTtlSeconds,
    cadreChanges,
  });

  // `AuthPrincipal.role` is a plain string off the JWT; the create-report route
  // is already gated to officer/admin/super_admin by requireRole below, so the
  // cast here is safe — mirrors the same narrowing cadre-changes.routes.ts does.
  const ROLES: readonly string[] = ['super_admin', 'admin', 'officer', 'viewer'];

  // Aggregate feed across every cadre (ADR-021) — the officer's own reporting
  // record via `reportedBy=me`. Not a privilege boundary: the per-cadre feed below
  // is already open to any authenticated user, so this only narrows a reachable set.
  app.get(
    '/reports',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Reports'],
        summary: 'List reports across cadres (newest first, paginated)',
        description:
          '`reportedBy=me` scopes to the calling user (the "my reporting record" screen); ' +
          '`reportedBy=<officerId>` scopes to that officer; omitted lists all. Each row carries ' +
          'its nested `cadre` so the client can show which cadre the report was about.',
        security: bearerAuth,
        querystring: zodToJson(listAllReportsQuery),
        response: { 200: jsonResponse('Paginated reports', examplePage(EXAMPLE_REPORT)) },
      },
    },
    async (request) => {
      const { reportedBy, ...rest } = listAllReportsQuery.parse(request.query);
      const resolved = reportedBy === 'me' ? request.authUser!.sub : reportedBy;
      return service.list({ ...rest, reportedBy: resolved }, request.scope!);
    },
  );

  app.get(
    '/cadres/:cadreId/reports',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Reports'],
        summary: 'List a cadre’s reports (newest first, paginated)',
        security: bearerAuth,
        params: zodToJson(reportCadreParam),
        querystring: zodToJson(listReportsQuery),
        response: { 200: jsonResponse('Paginated reports', examplePage(EXAMPLE_REPORT)) },
      },
    },
    async (request) => {
      const { cadreId } = reportCadreParam.parse(request.params);
      const query = listReportsQuery.parse(request.query);
      return service.listByCadre(cadreId, query, request.scope!);
    },
  );

  app.get(
    '/cadres/:cadreId/reports/:reportId',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Reports'],
        summary: 'Get a single report',
        security: bearerAuth,
        params: zodToJson(reportDetailParams),
        response: { 200: jsonResponse('The report', EXAMPLE_REPORT) },
      },
    },
    async (request) => {
      const { cadreId, reportId } = reportDetailParams.parse(request.params);
      return service.getById(cadreId, reportId, request.scope!);
    },
  );

  app.post(
    '/cadres/:cadreId/reports',
    {
      preHandler: [app.authenticate, app.requireRole('officer', 'admin', 'super_admin')],
      schema: {
        tags: ['Reports'],
        summary: 'File a report (officer+, idempotent)',
        description:
          'Body is snake_case. A client-supplied `idempotency_key` (UUID v4) dedupes: ' +
          'first call → 201 new, replay with the same key → 200 existing (ADR-013).',
        security: bearerAuth,
        params: zodToJson(reportCadreParam),
        body: zodToJson(createReportBody),
        response: {
          201: jsonResponse('Report created', EXAMPLE_REPORT),
          200: jsonResponse('Idempotent replay — existing report', EXAMPLE_REPORT),
        },
      },
    },
    async (request, reply) => {
      const { cadreId } = reportCadreParam.parse(request.params);
      const body = createReportBody.parse(request.body);

      // Path is authoritative; reject a body that names a different cadre.
      if (body.cadre_id !== undefined && body.cadre_id !== cadreId) {
        throw badRequest('cadre_id in body does not match the URL', 'CADRE_ID_MISMATCH');
      }

      const role = request.authUser!.role;
      if (!ROLES.includes(role)) throw forbidden('Unrecognised role on token');

      const { report, created } = await service.create(
        cadreId,
        body,
        request.authUser!.sub,
        request.scope!,
        role as Role,
      );
      // 201 for a fresh create; 200 for an idempotent replay (ADR-013).
      return reply.code(created ? 201 : 200).send(report);
    },
  );
}
