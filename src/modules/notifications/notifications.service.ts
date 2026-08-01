import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient, Notification, Role } from '@prisma/client';
import { SUB_DIVISION_THANAS, scopeAdmitsThana, type CadreScope } from '../../lib/scope.js';
import { nfc } from '../../lib/text.js';
import { writeNotification } from '../../lib/notifications.js';
import { writeOutboxEvent } from '../../lib/outbox.js';
import { writeAuditLog } from '../../lib/audit.js';
import { fireImmediateDispatch, type NotificationDispatchDeps } from '../../lib/notification-dispatch.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import type { BroadcastBody, ListNotificationsQuery } from './notifications.schema.js';

export interface NotificationsDeps extends NotificationDispatchDeps {
  prisma: PrismaClient;
  log: FastifyBaseLogger;
}

export interface Actor {
  id: number;
  role: Role;
  scope: CadreScope;
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface WireNotification {
  id: number;
  type: Notification['type'];
  title: string;
  body: string;
  cadreId?: number;
  cadreChangeId?: number;
  cadreCreateRequestId?: number;
  data?: Record<string, unknown>;
  readAt?: string;
  createdAt: string;
}

function toWire(n: Notification): WireNotification {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    cadreId: n.cadreId ?? undefined,
    cadreChangeId: n.cadreChangeId ?? undefined,
    cadreCreateRequestId: n.cadreCreateRequestId ?? undefined,
    data: (n.data as Record<string, unknown> | null) ?? undefined,
    readAt: n.readAt?.toISOString(),
    createdAt: n.createdAt.toISOString(),
  };
}

export interface NotificationsService {
  list(query: ListNotificationsQuery, userId: number): Promise<Paginated<WireNotification>>;
  unreadCount(userId: number): Promise<number>;
  markRead(id: number, userId: number): Promise<void>;
  markAllRead(userId: number): Promise<void>;
  broadcast(body: BroadcastBody, actor: Actor): Promise<{ recipientCount: number }>;
}

export function makeNotificationsService(deps: NotificationsDeps): NotificationsService {
  const { prisma, pushProvider, log } = deps;
  const dispatchDeps = { prisma, pushProvider, log };

  return {
    async list(query, userId) {
      const where = {
        userId,
        deletedAt: null,
        ...(query.unreadOnly === true ? { readAt: null } : {}),
      };

      const [total, rows] = await prisma.$transaction([
        prisma.notification.count({ where }),
        prisma.notification.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
      ]);

      return {
        data: rows.map(toWire),
        total,
        page: query.page,
        pageSize: query.pageSize,
        hasMore: query.page * query.pageSize < total,
      };
    },

    async unreadCount(userId) {
      return prisma.notification.count({ where: { userId, readAt: null, deletedAt: null } });
    },

    async markRead(id, userId) {
      // Fail-closed: a mismatched id/user updates 0 rows, which reads as 404 without
      // ever revealing whether the id belongs to someone else (same idiom as
      // cadre-changes' assertRequestInScope / cadres' getById).
      const { count } = await prisma.notification.updateMany({
        where: { id, userId, deletedAt: null },
        data: { readAt: new Date() },
      });
      if (count === 0) throw notFound('Notification not found');
    },

    async markAllRead(userId) {
      await prisma.notification.updateMany({
        where: { userId, readAt: null, deletedAt: null },
        data: { readAt: new Date() },
      });
    },

    async broadcast(body, actor) {
      if (actor.role !== 'admin' && actor.role !== 'super_admin') {
        throw forbidden('Only admin/super_admin may broadcast');
      }

      // Resolve the recipient thana list. `undefined` means "no thana filter" — every
      // active officer, which only super_admin may reach.
      let thanas: string[] | undefined;

      if (body.target === 'sub_division') {
        if (actor.role !== 'super_admin') {
          throw forbidden('Only super_admin can target a sub-division');
        }
        const list = SUB_DIVISION_THANAS[nfc(body.sub_division!)];
        if (list === undefined) {
          throw badRequest('sub_division is not one of the 9 sub-divisions', 'UNKNOWN_SUB_DIVISION');
        }
        thanas = [...list];
      } else if (body.target === 'thana') {
        if (actor.role === 'admin' && !scopeAdmitsThana(actor.scope, body.thana!)) {
          throw badRequest('thana is outside your jurisdiction', 'THANA_OUT_OF_SCOPE');
        }
        thanas = [body.thana!];
      } else {
        // target === 'all'. An admin's "all" is capped at their own scope — they
        // cannot reach beyond their sub-division just by asking for everyone.
        thanas = actor.role === 'admin' && actor.scope.kind !== 'all' ? [...actor.scope.thanas] : undefined;
      }

      const officerRecipients = await prisma.user.findMany({
        where: {
          role: 'officer',
          deletedAt: null,
          ...(thanas !== undefined ? { thana: { in: thanas } } : {}),
        },
        select: { id: true },
      });

      // The sender always gets a confirmation copy of their own broadcast — an
      // admin/super_admin broadcasting isn't `role: 'officer'`, so the query above
      // never includes them on its own.
      const recipientIds = [...officerRecipients.map((r) => r.id), actor.id];

      const created = await prisma.$transaction(async (tx) => {
        const rows: { notificationId: number; userId: number; outboxEventId: number }[] = [];
        for (const recipientId of recipientIds) {
          const n = await writeNotification(tx, {
            userId: recipientId,
            type: 'broadcast',
            title: body.title,
            body: body.body,
            data: { target: body.target },
          });
          const event = await writeOutboxEvent(tx, {
            aggregateType: 'notification',
            aggregateId: String(n.id),
            eventType: 'notification.created',
            payload: {
              notificationId: n.id,
              userId: recipientId,
              title: body.title,
              body: body.body,
              data: { target: body.target },
            },
          });
          rows.push({ notificationId: n.id, userId: recipientId, outboxEventId: event.id });
        }

        await writeAuditLog(tx, {
          actorId: actor.id,
          action: 'notification.broadcast',
          entityType: 'notification',
          entityId: 'broadcast',
          after: { title: body.title, target: body.target, recipientCount: recipientIds.length },
        });

        return rows;
      });

      // The outbox row is what makes each of these durable; this is only the
      // best-effort immediate half — see fireImmediateDispatch's own comment.
      for (const row of created) {
        fireImmediateDispatch(dispatchDeps, row.outboxEventId, {
          notificationId: row.notificationId,
          userId: row.userId,
          title: body.title,
          body: body.body,
          data: { target: body.target },
        });
      }

      return { recipientCount: recipientIds.length };
    },
  };
}
