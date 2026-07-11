import type { FastifyInstance } from 'fastify';
import { makeOfficersService } from './officers.service.js';
import { listOfficersQuery } from './officers.schema.js';
import {
  bearerAuth,
  examplePage,
  jsonResponse,
  zodToJson,
  EXAMPLE_OFFICER,
} from '../../lib/openapi.js';

// The officer roster (ADR-018). Admin+ only: this exists to let an admin pick an
// officer to assign a cadre to. Officers have no reason to enumerate each other,
// and the list carries every officer's phone number.
export async function officersRoutes(app: FastifyInstance): Promise<void> {
  const service = makeOfficersService({ prisma: app.prisma, log: app.log });

  app.get(
    '/officers',
    {
      preHandler: [app.authenticate, app.requireRole('admin', 'super_admin')],
      schema: {
        tags: ['Officers'],
        summary: 'List officers, searchable (admin+)',
        description:
          'Only users with role=officer are returned — they are the only assignable role. ' +
          'Each carries `assignedCadreCount` so an admin can see current load before assigning.',
        security: bearerAuth,
        querystring: zodToJson(listOfficersQuery),
        response: { 200: jsonResponse('Paginated officers', examplePage(EXAMPLE_OFFICER)) },
      },
    },
    async (request) => {
      const query = listOfficersQuery.parse(request.query);
      return service.list(query);
    },
  );
}
