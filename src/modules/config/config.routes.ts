import type { FastifyInstance } from 'fastify';
import { makeConfigService } from './config.service.js';
import { updateConfigBody } from './config.schema.js';
import { bearerAuth, jsonResponse, zodToJson } from '../../lib/openapi.js';

const EXAMPLE_CONFIG = {
  sheetsSyncUrl: 'https://script.google.com/macros/s/AKfycbxExampleDeploymentId/exec',
  updatedAt: '2026-08-09T10:00:00.000Z',
  updatedById: 1,
};

// ADR-059. Configuration page backend: manages exactly ONE non-secret value, the
// Apps Script Web App deployment URL the sheets-sync client calls. The shared-
// secret credential that authenticates those calls is never reachable from here,
// or any other web endpoint -- see ADR-057 SS6 / ADR-059 for the full reasoning.
export async function configRoutes(app: FastifyInstance): Promise<void> {
  const service = makeConfigService({ prisma: app.prisma, log: app.log });

  app.get(
    '/config',
    {
      preHandler: [app.authenticate, app.requireRole('super_admin')],
      schema: {
        tags: ['Config'],
        summary: 'Get the sheets-sync connection setting (super_admin, ADR-059)',
        security: bearerAuth,
        response: { 200: jsonResponse('Current config', EXAMPLE_CONFIG) },
      },
    },
    async () => service.get(),
  );

  app.patch(
    '/config',
    {
      preHandler: [app.authenticate, app.requireRole('super_admin')],
      schema: {
        tags: ['Config'],
        summary: 'Set the Apps Script Web App deployment URL (super_admin, ADR-059)',
        description:
          'The ONLY thing this endpoint manages. Pass sheetsSyncUrl: null to clear it ' +
          'and pause sync without touching Secrets Manager. The shared-secret credential ' +
          'that authenticates sheets-sync calls is hand-provisioned into Secrets Manager ' +
          '-- it never reaches this endpoint, or any other web endpoint, in any form.',
        security: bearerAuth,
        body: zodToJson(updateConfigBody),
        response: { 200: jsonResponse('Updated config', EXAMPLE_CONFIG) },
      },
    },
    async (request) => {
      const body = updateConfigBody.parse(request.body);
      return service.update(body, request.authUser!.sub);
    },
  );
}
