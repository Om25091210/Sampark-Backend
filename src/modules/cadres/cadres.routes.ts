import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { makeCadresService } from './cadres.service.js';
import {
  cadreIdParam,
  importCadresBody,
  listCadresQuery,
  transferBody,
  transferParams,
} from './cadres.schema.js';
import { forbidden, unauthorized } from '../../lib/errors.js';
import {
  bearerAuth,
  emptyResponse,
  examplePage,
  jsonResponse,
  zodToJson,
  EXAMPLE_CADRE,
  EXAMPLE_IMPORT_RESULT,
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

  // SDR-007. Auth for the bulk historical import, LOCAL to this one route — never a
  // general capability. Two ways in, nothing else:
  //   1. The scoped machine credential in `X-Sampark-Import-Key` (the unattended Apps
  //      Script path). It authorizes THIS route only and yields no session — the
  //      caller becomes no user (`authUser` stays null; the write is audited with a
  //      null actor + action `cadre.import`).
  //   2. An interactive super_admin Bearer JWT (a human running it by hand).
  // Anything else — no credential, a wrong key, or a non-super_admin JWT — is refused.
  async function authenticateImport(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const provided = req.headers['x-sampark-import-key'];
    const expected = app.config.importApiKey;
    if (typeof provided === 'string' && expected !== undefined) {
      const a = Buffer.from(provided);
      const b = Buffer.from(expected);
      // Length-guard first: timingSafeEqual throws on a length mismatch. A
      // wrong-length or wrong-value key is a 401 — it does NOT fall through to the
      // JWT path (presenting a key is a claim to the machine path).
      const ok = a.length === b.length && timingSafeEqual(a, b);
      if (ok) {
        req.authUser = null;
        return;
      }
      throw unauthorized('Invalid import key', 'INVALID_IMPORT_KEY');
    }
    // No key header → require an interactive super_admin JWT.
    await app.authenticate(req, reply);
    if (req.authUser === null || req.authUser.role !== 'super_admin') {
      throw forbidden('Import requires super_admin');
    }
  }

  app.post(
    '/cadres/import',
    {
      preHandler: authenticateImport,
      schema: {
        tags: ['Cadres'],
        summary: 'Bulk historical import (super_admin or scoped machine key)',
        description:
          'ADR-038. One-time backfill of the paper surrender register from an unattended ' +
          'Apps Script. Auth (SDR-007): the scoped `X-Sampark-Import-Key` machine credential, ' +
          'OR an interactive super_admin Bearer JWT — nothing else. Accepts a batch of up to ' +
          '200 cadres; UPSERTS by `serialNumber` (an existing serial is skipped, never ' +
          'duplicated). Bypasses the ADR-026 change-request ladder. Returns a per-row result ' +
          'array — one bad row is reported as `error`, it does not fail the batch. Row fields ' +
          'are camelCase, mirroring the Cadre entity.',
        security: bearerAuth,
        body: zodToJson(importCadresBody),
        response: { 200: jsonResponse('Per-row import results', EXAMPLE_IMPORT_RESULT) },
      },
    },
    async (request) => {
      const { cadres } = importCadresBody.parse(request.body);
      // Machine-key path → null actor; interactive super_admin → their id.
      const actorId = request.authUser?.sub ?? null;
      return service.importCadres(cadres, actorId);
    },
  );

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
      return service.list({ ...rest, assignedTo: resolved }, request.scope!);
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
    async (request) => service.facets(request.scope!),
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
      return service.getById(id, request.scope!);
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
      await service.transfer(cadreId, to_officer_id, request.authUser!.sub, request.scope!);
      return reply.code(204).send();
    },
  );
}
