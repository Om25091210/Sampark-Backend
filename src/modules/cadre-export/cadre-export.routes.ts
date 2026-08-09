import type { FastifyInstance } from 'fastify';
import { makeCadreExportService } from './cadre-export.service.js';
import { bearerAuth, jsonResponse } from '../../lib/openapi.js';

// ADR-058. One-way, manually-triggered Postgres -> mirror-sheet export, plus a
// read-only preview of the mirror's current contents. Both super_admin only (ADR-056).
export async function cadreExportRoutes(app: FastifyInstance): Promise<void> {
  const service = makeCadreExportService({
    prisma: app.prisma,
    storage: app.storage,
    sheetsSync: app.sheetsSync,
    log: app.log,
  });

  app.post(
    '/cadres/export-to-sheet',
    {
      preHandler: [app.authenticate, app.requireRole('super_admin')],
      schema: {
        tags: ['Cadre Export'],
        summary: 'Manually trigger a full Postgres -> mirror-sheet export (super_admin, ADR-058)',
        description:
          'Runs in the background, chunked -- responds 202 as soon as the run starts, it does ' +
          'not wait for the whole roster to finish. Upserts by serialNumber on the Apps Script ' +
          'side, so it is always safe to trigger again. Check the sync_log table, or GET ' +
          '/cadres/sheet-preview once it has had time to run, for the outcome.',
        security: bearerAuth,
        response: { 202: jsonResponse('Export started', { status: 'started' }) },
      },
    },
    async (request, reply) => {
      const actorId = request.authUser!.sub;
      // Deliberately not awaited -- see CadreExportService.runExport's own doc
      // comment for why a fire-and-forget run is the accepted trade-off here.
      void service.runExport(actorId).catch((err) => {
        app.log.error({ err }, 'cadre export run crashed');
      });
      return reply.code(202).send({ status: 'started' });
    },
  );

  app.get(
    '/cadres/sheet-preview',
    {
      preHandler: [app.authenticate, app.requireRole('super_admin')],
      schema: {
        tags: ['Cadre Export'],
        summary: "Read the mirror sheet's current contents (super_admin, ADR-058 §3)",
        description: 'A live read via the Apps Script deployment on every call -- never cached, never stored in Postgres.',
        security: bearerAuth,
        response: { 200: jsonResponse('Current mirror sheet contents', { ok: true, rows: [] }) },
      },
    },
    async () => service.preview(),
  );
}
