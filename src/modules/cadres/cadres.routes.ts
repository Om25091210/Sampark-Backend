import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { makeCadresService } from './cadres.service.js';
import {
  avatarBackfillBody,
  cadreIdParam,
  categoryBackfillBody,
  importCadresBody,
  listCadresQuery,
  thanaTransferBody,
  transferBody,
  transferParams,
  AVATAR_BACKFILL_BODY_LIMIT_BYTES,
  MAX_AVATAR_BACKFILL_BATCH,
  MAX_IMPORT_BATCH,
} from './cadres.schema.js';
import { forbidden, unauthorized } from '../../lib/errors.js';
import {
  bearerAuth,
  emptyResponse,
  examplePage,
  jsonResponse,
  zodToJson,
  EXAMPLE_AVATAR_BACKFILL_RESULT,
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
    // The bulk backfill holds each image to the same per-file ceiling the multipart
    // upload route enforces, so one photo cannot arrive by a laxer path than another.
    maxAvatarBytes: app.config.uploadMaxBytes,
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

  // Design-Docs#8. The photo half of the ADR-038 register backfill. Registered before
  // `/cadres/:id` alongside the other static segments (see the note on /cadres/facets).
  //
  // Auth is a plain super_admin JWT — NOT `authenticateImport`. The machine key exists
  // because an unattended script cannot complete a TOTP login to CREATE rows; this
  // route WRITES OVER rows that already exist, which is the same accountability line
  // /users/import draws when it refuses the key too.
  app.post(
    '/cadres/avatar-backfill',
    {
      preHandler: [app.authenticate, app.requireRole('super_admin')],
      // Fastify's default body limit is 1 MiB — about seven register photos. Without
      // this override a full batch is rejected before any handler sees it.
      bodyLimit: AVATAR_BACKFILL_BODY_LIMIT_BYTES,
      schema: {
        tags: ['Cadres'],
        summary: 'Bulk avatar backfill by serialNumber (super_admin)',
        description:
          'Design-Docs#8. Sets cadre photos in bulk from the historical register, matching ' +
          'EXISTING cadres by `serialNumber` (ADR-025). Body is an OBJECT with an `avatars` ' +
          `array (max ${MAX_AVATAR_BACKFILL_BATCH} rows, ` +
          `${AVATAR_BACKFILL_BODY_LIMIT_BYTES / (1024 * 1024)} MiB total). Each row is ` +
          '`{ serialNumber, base64Image }`; a `data:` URI prefix is accepted and stripped. ' +
          'The image type is SNIFFED from the decoded bytes (JPEG or PNG only) — no content ' +
          'type is taken from the caller. Bypasses the ADR-026/029 change-request ladder and ' +
          'writes `avatarKey` directly, exactly as ADR-038 bypasses it for the row import. ' +
          'A cadre that ALREADY has an `avatarKey` is skipped, never overwritten, so a re-run ' +
          'is idempotent. Returns a per-row result array in input order — one bad row is ' +
          'reported, it does not fail the batch.',
        security: bearerAuth,
        body: zodToJson(avatarBackfillBody),
        response: {
          200: jsonResponse('Per-row backfill results', EXAMPLE_AVATAR_BACKFILL_RESULT),
        },
      },
    },
    async (request) => {
      const { avatars } = avatarBackfillBody.parse(request.body);
      return service.backfillAvatars(avatars, request.authUser!.sub);
    },
  );

  // ADR-046. The grade half of the register backfill. super_admin only, like
  // /cadres/avatar-backfill — this WRITES OVER existing rows, so the machine key is
  // refused and the actor is in the audit. Registered before `/cadres/:id` alongside the
  // other static segments.
  app.post(
    '/cadres/category-backfill',
    {
      preHandler: [app.authenticate, app.requireRole('super_admin')],
      schema: {
        tags: ['Cadres'],
        summary: 'Bulk priorityCategory backfill by serialNumber (super_admin)',
        description:
          'ADR-046. Sets the priority grade (कैटेगरी) in bulk from the historical register, ' +
          'matching EXISTING cadres by `serialNumber` (ADR-025). Body is an OBJECT with a ' +
          `\`categories\` array (max ${MAX_IMPORT_BATCH} rows). Each row is ` +
          '`{ serialNumber, priorityCategory }` where priorityCategory is `A|B|C|jail|death` ' +
          '(A/B/C uppercase — a deliberate wire deviation, see ADR-046). Bypasses the ADR-026 ' +
          'change-request ladder and writes directly, exactly as ADR-038/045 do for the row ' +
          'and photo loads. A cadre that ALREADY has a grade is skipped, never overwritten, so ' +
          'a re-run is idempotent. Returns a per-row result array in input order.',
        security: bearerAuth,
        body: zodToJson(categoryBackfillBody),
        response: {
          200: jsonResponse('Per-row category backfill results', {
            results: [
              { serialNumber: 'BJP/2025/0001', status: 'updated', cadreId: 1, priorityCategory: 'A' },
              { serialNumber: 'BJP/2025/0002', status: 'skipped_has_category', cadreId: 2, priorityCategory: 'B' },
              { serialNumber: 'BJP/2025/9999', status: 'not_found' },
            ],
          }),
        },
      },
    },
    async (request) => {
      const { categories } = categoryBackfillBody.parse(request.body);
      return service.backfillCategory(categories, request.authUser!.sub);
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

  // ADR-046. Move a cadre to another station (admin+). Honours ADR-044 on both ends: the
  // cadre must be in the caller's scope, and the destination thana must be admitted by it
  // (400 THANA_OUT_OF_SCOPE otherwise). Clears the assignment; leaves sub-division as-is.
  app.post(
    '/cadres/:cadreId/thana-transfer',
    {
      preHandler: [app.authenticate, app.requireRole('admin', 'super_admin')],
      schema: {
        tags: ['Cadres'],
        summary: 'Move a cadre to another station (admin+)',
        description:
          'ADR-046. Reassigns the cadre to a different thana — a real move, not a copy. ' +
          'Enforces ADR-044 jurisdiction on BOTH ends (source in scope, destination admitted). ' +
          'Clears `assignedOfficerId` (the old station\'s officer loses scope) and leaves ' +
          '`subDivision` un-re-derived (ADR-043).',
        security: bearerAuth,
        params: zodToJson(transferParams),
        body: zodToJson(thanaTransferBody),
        response: { 204: emptyResponse('Transferred') },
      },
    },
    async (request, reply) => {
      const { cadreId } = transferParams.parse(request.params);
      const { thana } = thanaTransferBody.parse(request.body);
      await service.transferThana(cadreId, thana, request.authUser!.sub, request.scope!);
      return reply.code(204).send();
    },
  );
}
