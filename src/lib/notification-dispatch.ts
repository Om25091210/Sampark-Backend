import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { PushEndpointDisabledError, type PushProvider } from './push.js';

export interface NotificationDispatchDeps {
  prisma: PrismaClient;
  pushProvider: PushProvider;
  log: FastifyBaseLogger;
}

export interface NotificationDispatchPayload {
  notificationId: number;
  userId: number;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

// ADR-048. Delivers one `notification.created` outbox event as real push to every
// active device the user has registered. Called two ways: (a) best-effort, fired
// (not awaited) right after a trigger's transaction commits, for near-real-time
// delivery; (b) from the outbox drain cron, as the durable catch-up path for
// anything (a) missed — a process restart, a transient SNS error. Both paths call
// this SAME function so there is one place that decides "is this event handled".
//
// Delivery is at-least-once, not exactly-once (ADR-048): if publishing to one of a
// user's two devices fails, the whole event stays unpublished and is retried against
// BOTH devices on the next drain — an occasional duplicate is an accepted trade-off
// over per-recipient ack tracking.
export async function dispatchNotificationEvent(
  deps: NotificationDispatchDeps,
  payload: NotificationDispatchPayload,
): Promise<boolean> {
  const { prisma, pushProvider, log } = deps;

  const tokens = await prisma.deviceToken.findMany({
    where: { userId: payload.userId, deletedAt: null },
  });
  // No registered device is not a failure — the notification still lives in the
  // in-app inbox. The event is fully handled with nothing left to deliver.
  if (tokens.length === 0) return true;

  for (const token of tokens) {
    try {
      await pushProvider.publish(token.endpointArn, {
        title: payload.title,
        body: payload.body,
        data: { notificationId: payload.notificationId, ...(payload.data ?? {}) },
      });
    } catch (err) {
      if (err instanceof PushEndpointDisabledError) {
        // The device is confirmed gone — stop retrying it, but this is not a
        // reason to leave the whole event unpublished.
        await prisma.deviceToken.update({
          where: { id: token.id },
          data: { deletedAt: new Date() },
        });
        continue;
      }
      log.warn({ err, userId: payload.userId, notificationId: payload.notificationId }, 'push dispatch failed, will retry');
      return false;
    }
  }
  return true;
}

// Fired (not awaited) by every trigger site right after its transaction commits —
// the best-effort immediate-delivery half of the design. Never call this from inside
// a `prisma.$transaction`: it makes a network call, and the outbox row it marks
// published must already be durably committed for the catch-up drain (outbox.worker.ts)
// to have a consistent fallback if this fails or the process restarts mid-flight.
export function fireImmediateDispatch(
  deps: NotificationDispatchDeps,
  outboxEventId: number,
  payload: NotificationDispatchPayload,
): void {
  void dispatchNotificationEvent(deps, payload)
    .then((handled) => {
      if (!handled) return undefined;
      return deps.prisma.outboxEvent.update({
        where: { id: outboxEventId },
        data: { publishedAt: new Date() },
      });
    })
    .catch((err) => {
      deps.log.warn({ err, outboxEventId }, 'immediate push dispatch failed; outbox cron will retry');
    });
}
