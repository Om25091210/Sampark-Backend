import type { FastifyInstance } from 'fastify';
import type { Role } from '@prisma/client';
import { makeSyncService } from './sync.service.js';
import { syncPullQuery, syncPushBody } from './sync.schema.js';
import { makeReportsService } from '../reports/reports.service.js';
import { makeCadreChangesService } from '../cadre-changes/cadre-changes.service.js';
import { forbidden } from '../../lib/errors.js';
import { bearerAuth, jsonResponse, zodToJson } from '../../lib/openapi.js';

// `AuthPrincipal.role` is a plain string off the JWT — same narrowing every other
// route with a role-typed parameter does (reports.routes.ts, cadre-changes.routes.ts).
const ROLES: readonly string[] = ['super_admin', 'admin', 'officer', 'viewer'];

// The offline-first mobile mirror (extends ADR-002 to the current stack — see
// BC-THESIS-SAMPARK.md's sync ADR). `GET /sync/pull` is a delta feed of everything
// the caller's ADR-044 scope admits (cadres, their reports, and — admin+ only — the
// officer roster); `POST /sync/push` replays a device's offline outbox through the
// SAME write paths the online routes use (report creation, change-request
// submission) — never a second, parallel write mechanism with its own rules.
export async function syncRoutes(app: FastifyInstance): Promise<void> {
  const cadreChanges = makeCadreChangesService({
    prisma: app.prisma,
    log: app.log,
    storage: app.storage,
    mediaUrlTtlSeconds: app.config.mediaUrlTtlSeconds,
    pushProvider: app.pushProvider,
  });
  const reports = makeReportsService({
    prisma: app.prisma,
    log: app.log,
    storage: app.storage,
    mediaUrlTtlSeconds: app.config.mediaUrlTtlSeconds,
    cadreChanges,
  });
  const service = makeSyncService({
    prisma: app.prisma,
    log: app.log,
    storage: app.storage,
    mediaUrlTtlSeconds: app.config.mediaUrlTtlSeconds,
    reports,
    cadreChanges,
  });

  app.get(
    '/sync/pull',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Sync'],
        summary: "Delta-pull the caller's offline mirror (cadres, reports, officer roster)",
        description:
          '`lastPulledAt` is the `serverTime` this endpoint previously returned — never the ' +
          "device's own clock. Omit it for a full first-sync snapshot. Every entity block is " +
          '`{ upserted, deleted, truncated }`; if `truncated` is true the client must retry with ' +
          'the SAME `lastPulledAt` rather than advance its cursor. `officers` is empty for ' +
          'officer/viewer callers (ADR-018 — the roster is admin+ only).',
        security: bearerAuth,
        querystring: zodToJson(syncPullQuery),
        response: {
          200: jsonResponse('Delta since lastPulledAt (or a full snapshot if omitted)', {
            serverTime: 1735689600000,
            cadres: { upserted: [], deleted: [], truncated: false },
            reports: { upserted: [], deleted: [], truncated: false },
            officers: { upserted: [], deleted: [], truncated: false },
          }),
        },
      },
    },
    async (request) => {
      const query = syncPullQuery.parse(request.query);
      const role = request.authUser!.role;
      if (!ROLES.includes(role)) throw forbidden('Unrecognised role on token');
      return service.pull(query, request.scope!, role as Role);
    },
  );

  app.post(
    '/sync/push',
    {
      // officer+ (viewers are read-only, same gate as report creation and change
      // submission individually — this route is just those two, batched).
      preHandler: [app.authenticate, app.requireRole('officer', 'admin', 'super_admin')],
      schema: {
        tags: ['Sync'],
        summary: 'Replay a device offline outbox (idempotent per item)',
        description:
          'Every item carries its own `idempotency_key`; a replayed push is always safe to ' +
          'resend. Never all-or-nothing — one bad item in the batch does not fail the rest; each ' +
          'gets its own `{ clientKey, status, serverId?, error? }` in the response.',
        security: bearerAuth,
        body: zodToJson(syncPushBody),
        response: {
          200: jsonResponse('Per-item results, in the SAME order as the request', {
            reports: [{ clientKey: '9f1c2b7e-...', status: 'created', serverId: 501 }],
            cadreChangeRequests: [{ clientKey: '4b7e6a4d-...', status: 'created', serverId: 88 }],
          }),
        },
      },
    },
    async (request) => {
      const body = syncPushBody.parse(request.body);
      const role = request.authUser!.role;
      if (!ROLES.includes(role)) throw forbidden('Unrecognised role on token');
      return service.push(body, { id: request.authUser!.sub, role: role as Role, scope: request.scope! });
    },
  );
}
