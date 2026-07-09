import type { FastifyInstance } from 'fastify';
import { jsonResponse } from '../../lib/openapi.js';

// Liveness + readiness probes. Root-mounted, unauthenticated.
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Liveness: the process is up and serving.
  app.get(
    '/healthz',
    {
      schema: {
        tags: ['Health'],
        summary: 'Liveness probe',
        description: 'Returns 200 while the process is up. No auth.',
        response: { 200: jsonResponse('Process is up', { status: 'ok' }) },
      },
    },
    async () => ({ status: 'ok' }),
  );

  // Readiness: dependencies (the database) are reachable. Returns 503 otherwise
  // so orchestrators can hold traffic until the service is truly ready.
  app.get(
    '/readyz',
    {
      schema: {
        tags: ['Health'],
        summary: 'Readiness probe',
        description: 'Returns 200 when the database is reachable, 503 otherwise. No auth.',
        response: {
          200: jsonResponse('Dependencies reachable', { status: 'ready' }),
          503: jsonResponse('Dependencies unavailable', { status: 'not_ready' }),
        },
      },
    },
    async (_request, reply) => {
    try {
      await app.prisma.$queryRaw`SELECT 1`;
      return { status: 'ready' };
    } catch (err) {
      app.log.warn({ err }, 'readiness check failed');
      reply.status(503);
      return { status: 'not_ready' };
    }
  });
}
