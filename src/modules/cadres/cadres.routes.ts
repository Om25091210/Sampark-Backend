import type { FastifyInstance } from 'fastify';
import { makeCadresService } from './cadres.service.js';
import { cadreIdParam, listCadresQuery, transferBody, transferParams } from './cadres.schema.js';
import {
  bearerAuth,
  emptyResponse,
  examplePage,
  jsonResponse,
  zodToJson,
  EXAMPLE_CADRE,
} from '../../lib/openapi.js';

// Cadre records. All routes require authentication; transfer is admin+.
export async function cadresRoutes(app: FastifyInstance): Promise<void> {
  const service = makeCadresService({ prisma: app.prisma, log: app.log });

  app.get(
    '/cadres',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Cadres'],
        summary: 'List cadres (filter + paginate)',
        description: 'Query params are camelCase. `category=all` / `filter=All` mean "no filter".',
        security: bearerAuth,
        querystring: zodToJson(listCadresQuery),
        response: { 200: jsonResponse('Paginated cadres', examplePage(EXAMPLE_CADRE)) },
      },
    },
    async (request) => {
      const query = listCadresQuery.parse(request.query);
      return service.list(query);
    },
  );

  app.get(
    '/cadres/:id',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Cadres'],
        summary: 'Get a cadre by id',
        security: bearerAuth,
        params: zodToJson(cadreIdParam),
        response: { 200: jsonResponse('The cadre', EXAMPLE_CADRE) },
      },
    },
    async (request) => {
      const { id } = cadreIdParam.parse(request.params);
      return service.getById(id);
    },
  );

  app.post(
    '/cadres/:cadreId/transfer',
    {
      preHandler: [app.authenticate, app.requireRole('admin', 'super_admin')],
      schema: {
        tags: ['Cadres'],
        summary: 'Reassign a cadre to another officer (admin+)',
        security: bearerAuth,
        params: zodToJson(transferParams),
        body: zodToJson(transferBody),
        response: { 204: emptyResponse('Transferred') },
      },
    },
    async (request, reply) => {
      const { cadreId } = transferParams.parse(request.params);
      const { to_officer_id } = transferBody.parse(request.body);
      await service.transfer(cadreId, to_officer_id, request.authUser!.sub);
      return reply.code(204).send();
    },
  );
}
