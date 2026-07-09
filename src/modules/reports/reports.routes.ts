import type { FastifyInstance } from 'fastify';
import { makeReportsService } from './reports.service.js';
import { badRequest } from '../../lib/errors.js';
import {
  createReportBody,
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
  const service = makeReportsService({ prisma: app.prisma, log: app.log });

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
      return service.listByCadre(cadreId, query);
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
      return service.getById(cadreId, reportId);
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

      const { report, created } = await service.create(cadreId, body, request.authUser!.sub);
      // 201 for a fresh create; 200 for an idempotent replay (ADR-013).
      return reply.code(created ? 201 : 200).send(report);
    },
  );
}
