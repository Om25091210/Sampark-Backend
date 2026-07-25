import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Role } from '@prisma/client';
import { makeNotificationsService, type Actor } from './notifications.service.js';
import { forbidden } from '../../lib/errors.js';
import { broadcastBody, listNotificationsQuery, notificationIdParam } from './notifications.schema.js';
import { bearerAuth, emptyResponse, jsonResponse, zodToJson, examplePage } from '../../lib/openapi.js';

const EXAMPLE_NOTIFICATION = {
  id: 1,
  type: 'cadre_change_outcome',
  title: 'बदलाव स्वीकृत',
  body: 'बबलू माडवी के लिए आपका प्रस्तावित बदलाव स्वीकृत हो गया है।',
  cadreId: 12,
  cadreChangeId: 4,
  createdAt: '2026-07-25T10:00:00.000Z',
};

// In-app notification inbox (v1, ADR-048). Also delivered as real push via AWS
// SNS + FCM V1 — see src/lib/notification-dispatch.ts and src/workers/outbox.worker.ts.
export async function notificationsRoutes(app: FastifyInstance): Promise<void> {
  const service = makeNotificationsService({
    prisma: app.prisma,
    log: app.log,
    pushProvider: app.pushProvider,
  });

  // Same narrow-and-reject idiom as cadre-changes.routes.ts: a token carrying an
  // unrecognised role must not reach the broadcast scoping logic.
  const ROLES: readonly string[] = ['super_admin', 'admin', 'officer', 'viewer'];

  const actorOf = (request: FastifyRequest): Actor => {
    const principal = request.authUser!;
    if (!ROLES.includes(principal.role)) throw forbidden('Unrecognised role on token');
    return { id: principal.sub, role: principal.role as Role, scope: request.scope! };
  };

  app.get(
    '/notifications',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Notifications'],
        summary: "List the caller's own notifications (in-app inbox)",
        security: bearerAuth,
        querystring: zodToJson(listNotificationsQuery),
        response: { 200: jsonResponse('Paginated notifications', examplePage(EXAMPLE_NOTIFICATION)) },
      },
    },
    async (request) => {
      const query = listNotificationsQuery.parse(request.query);
      return service.list(query, request.authUser!.sub);
    },
  );

  app.get(
    '/notifications/unread-count',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Notifications'],
        summary: "The caller's unread notification count (for the bell badge)",
        security: bearerAuth,
        response: { 200: jsonResponse('Unread count', { count: 3 }) },
      },
    },
    async (request) => {
      const count = await service.unreadCount(request.authUser!.sub);
      return { count };
    },
  );

  app.post(
    '/notifications/:id/read',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Notifications'],
        summary: 'Mark one notification read',
        security: bearerAuth,
        params: zodToJson(notificationIdParam),
        response: { 204: emptyResponse('Marked read') },
      },
    },
    async (request, reply) => {
      const { id } = notificationIdParam.parse(request.params);
      await service.markRead(id, request.authUser!.sub);
      return reply.code(204).send();
    },
  );

  app.post(
    '/notifications/read-all',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Notifications'],
        summary: "Mark all of the caller's notifications read",
        security: bearerAuth,
        response: { 204: emptyResponse('Marked all read') },
      },
    },
    async (request, reply) => {
      await service.markAllRead(request.authUser!.sub);
      return reply.code(204).send();
    },
  );

  app.post(
    '/notifications/broadcast',
    {
      preHandler: [app.authenticate, app.requireRole('admin', 'super_admin')],
      schema: {
        tags: ['Notifications'],
        summary: 'Send an announcement to all officers or a thana/sub-division-scoped subset (admin+)',
        description:
          '`target: "all"` for an admin is capped at their own scope (their sub-division), not every ' +
          'officer district-wide. `target: "sub_division"` is super_admin-only. `target: "thana"` must ' +
          'be within the caller\'s jurisdiction (ADR-044) or the request is rejected.',
        security: bearerAuth,
        body: zodToJson(broadcastBody),
        response: { 201: jsonResponse('Recipient count', { recipient_count: 42 }) },
      },
    },
    async (request, reply) => {
      const body = broadcastBody.parse(request.body);
      const { recipientCount } = await service.broadcast(body, actorOf(request));
      return reply.code(201).send({ recipient_count: recipientCount });
    },
  );
}
