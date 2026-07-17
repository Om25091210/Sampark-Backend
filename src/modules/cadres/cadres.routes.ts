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
  const service = makeCadresService({
    prisma: app.prisma,
    log: app.log,
    // ADR-029: re-signs `avatarKey` on read, so a cadre photo never goes stale.
    storage: app.storage,
    mediaUrlTtlSeconds: app.config.mediaUrlTtlSeconds,
  });

  app.get(
    '/cadres',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Cadres'],
        summary: 'List cadres (filter + paginate)',
        description:
          'Query params are camelCase. `category=all` / `filter=All` mean "no filter". ' +
          '`assignedTo=me` scopes the list to the caller\'s assigned cadres; `assignedTo=<officerId>` to that officer\'s.',
        security: bearerAuth,
        querystring: zodToJson(listCadresQuery),
        response: { 200: jsonResponse('Paginated cadres', examplePage(EXAMPLE_CADRE)) },
      },
    },
    async (request) => {
      const { assignedTo, ...rest } = listCadresQuery.parse(request.query);
      // Resolve the `me` sentinel here, where the caller is known, so the service
      // stays a pure query over a concrete officer id.
      const resolved = assignedTo === 'me' ? request.authUser!.sub : assignedTo;
      return service.list({ ...rest, assignedTo: resolved });
    },
  );

  // Registered before `/cadres/:id`. find-my-way prefers a static segment over a
  // parametric one regardless of order, but relying on that silently would be a
  // trap for whoever adds the next route here.
  app.get(
    '/cadres/facets',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Cadres'],
        summary: 'Distinct thana / designation values for the filter sheet',
        description:
          'ADR-033. The options the master filter sheet offers, taken from the rows that exist. ' +
          'The sheet previously hardcoded them, and offered ranks that matched no cadre at all.',
        security: bearerAuth,
        response: {
          200: jsonResponse('Filter facets', {
            thanas: ['बीजापुर / गंगालूर', 'दंतेवाड़ा'],
            designations: ['दस्ते का सदस्य', 'सीनियर कैडर'],
          }),
        },
      },
    },
    async () => service.facets(),
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
