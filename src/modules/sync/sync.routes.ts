import type { FastifyInstance } from 'fastify';
import type { Role } from '@prisma/client';
import { makeSyncService, type SyncPushItemResult, type SyncPushResult } from './sync.service.js';
import {
  parsePushBody,
  syncPullQuery,
  syncPushBody,
  type PushKind,
  type RejectedPushItem,
} from './sync.schema.js';
import { makeReportsService } from '../reports/reports.service.js';
import { makeCadreChangesService } from '../cadre-changes/cadre-changes.service.js';
import { makeCadreProformaAService } from '../cadre-proforma-a/cadre-proforma-a.service.js';
import { makeCadreProformaBService } from '../cadre-proforma-b/cadre-proforma-b.service.js';
import { forbidden } from '../../lib/errors.js';
import { bearerAuth, jsonResponse, zodToJson } from '../../lib/openapi.js';

// `AuthPrincipal.role` is a plain string off the JWT — same narrowing every other
// route with a role-typed parameter does (reports.routes.ts, cadre-changes.routes.ts).
const ROLES: readonly string[] = ['super_admin', 'admin', 'officer', 'viewer'];

/**
 * Puts items that failed validation back into the response at the position they held in the
 * request, as an ordinary per-item `error`. `processed` holds the results for the items that
 * DID validate, in request order, so the two lists interleave exactly. The phone matches
 * results by `clientKey`, so order is a courtesy — but the route documents it, so keep it.
 */
function mergeResults(
  processed: SyncPushItemResult[],
  rejected: RejectedPushItem[],
): SyncPushItemResult[] {
  if (rejected.length === 0) return processed;
  const byIndex = new Map(rejected.map((r) => [r.index, r]));
  const total = processed.length + rejected.length;
  const out: SyncPushItemResult[] = [];
  let next = 0;
  for (let i = 0; i < total; i += 1) {
    const bad = byIndex.get(i);
    if (bad !== undefined) {
      out.push({ clientKey: bad.clientKey, status: 'error', error: bad.error });
    } else {
      out.push(processed[next]!);
      next += 1;
    }
  }
  return out;
}

const PUSH_KINDS: readonly PushKind[] = [
  'reports', 'cadreChangeRequests', 'proformaAChangeRequests', 'proformaBChangeRequests',
];

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
  const proformaA = makeCadreProformaAService({
    prisma: app.prisma,
    log: app.log,
    storage: app.storage,
    mediaUrlTtlSeconds: app.config.mediaUrlTtlSeconds,
  });
  const proformaB = makeCadreProformaBService({
    prisma: app.prisma,
    log: app.log,
    storage: app.storage,
    mediaUrlTtlSeconds: app.config.mediaUrlTtlSeconds,
  });
  const service = makeSyncService({
    prisma: app.prisma,
    log: app.log,
    storage: app.storage,
    mediaUrlTtlSeconds: app.config.mediaUrlTtlSeconds,
    reports,
    cadreChanges,
    proformaA,
    proformaB,
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
            proformaAChangeRequests: [{ clientKey: '2a1e5c3f-...', status: 'created', serverId: 12 }],
            proformaBChangeRequests: [{ clientKey: '7d4f8b2a-...', status: 'created', serverId: 34 }],
          }),
        },
      },
    },
    async (request) => {
      // Item by item, not the whole body at once: one invalid item must not 400 the batch.
      const { body, rejected } = parsePushBody(request.body);
      const role = request.authUser!.role;
      if (!ROLES.includes(role)) throw forbidden('Unrecognised role on token');
      const result = await service.push(body, {
        id: request.authUser!.sub, role: role as Role, scope: request.scope!,
      });
      const merged = { ...result } as SyncPushResult;
      for (const kind of PUSH_KINDS) merged[kind] = mergeResults(result[kind], rejected[kind]);
      for (const kind of PUSH_KINDS) {
        if (rejected[kind].length > 0) {
          app.log.warn(
            { kind, rejected: rejected[kind].map((r) => ({ clientKey: r.clientKey, error: r.error })) },
            'sync push: items failed validation and were reported back individually',
          );
        }
      }
      return merged;
    },
  );
}
