import type { FastifyInstance } from 'fastify';
import { makeCadreExportService } from './cadre-export.service.js';
import { sheetPreviewQuery } from './cadre-export.schema.js';
import { bearerAuth, jsonResponse, zodToJson } from '../../lib/openapi.js';

// ADR-058 (amended by ADR-067). One-way, manually-triggered Postgres -> per-category
// mirror tabs, plus a read-only preview of the mirror's current contents. Both
// super_admin only (ADR-056).
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
        summary: 'Manually trigger a full Postgres -> per-category mirror-tab export (super_admin, ADR-058)',
        description:
          'Runs in the background, chunked -- responds 202 as soon as the run starts, it does ' +
          'not wait for the whole roster to finish. Each cadre lands in the tab for its category ' +
          '(Cadre-Surrendered / OtherDistrict / OtherState / Thana / Jail / Unclassified) and is ' +
          'upserted by cadreId, so it is always safe to trigger again. 409 EXPORT_RUNNING if a run ' +
          'is already in flight. Progress and outcome are the latest cadre.export row in ' +
          'GET /config/sync-log.',
        security: bearerAuth,
        response: {
          202: jsonResponse('Export started', { status: 'started', runId: 42 }),
          409: jsonResponse('An export is already running', {
            error: { code: 'EXPORT_RUNNING', message: 'A cadre sheet export is already running' },
          }),
        },
      },
    },
    async (request, reply) => {
      const actorId = request.authUser!.sub;
      // begin() claims the single export slot (409s if one is in flight) BEFORE we
      // answer; the long part is then deliberately not awaited -- see
      // CadreExportService.execute's doc comment for why fire-and-forget is the
      // accepted trade-off here.
      const handle = await service.begin(actorId);
      void service.execute(handle).catch((err) => {
        app.log.error({ err }, 'cadre export run crashed');
      });
      return reply.code(202).send({ status: 'started', runId: handle.runId });
    },
  );

  app.get(
    '/cadres/sheet-preview',
    {
      preHandler: [app.authenticate, app.requireRole('super_admin')],
      schema: {
        tags: ['Cadre Export'],
        summary: "Read the mirror sheet's per-tab counts and a capped page of one tab (super_admin, ADR-058 §3)",
        description:
          'A live read via the Apps Script deployment on every call -- never cached, never stored in ' +
          'Postgres. Returns `tabs` (row count per category tab) and, when `tab` is given, up to ' +
          '`limit` (default 50, max 200) rows of that tab.',
        security: bearerAuth,
        querystring: zodToJson(sheetPreviewQuery),
        response: {
          200: jsonResponse('Current mirror sheet contents', {
            ok: true,
            tabs: [{ tab: 'Cadre-Thana', rowCount: 120 }],
            tab: 'Cadre-Thana',
            rows: [],
          }),
        },
      },
    },
    async (request) => service.preview(sheetPreviewQuery.parse(request.query)),
  );
}
