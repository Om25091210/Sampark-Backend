import type PgBoss from 'pg-boss';
import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { dispatchNotificationEvent, type NotificationDispatchPayload } from '../lib/notification-dispatch.js';
import type { PushProvider } from '../lib/push.js';

// Transactional-outbox publisher. Domain writes commit their events to
// `outbox_events` inside the same transaction as the state change (see lib/outbox.ts);
// this worker drains the unpublished events, marks them shipped, and emits the event
// trail. ADR-048: `notification.created` events are the one real downstream consumer
// this file's own comment used to say would "plug in later" — every other event type
// keeps the original log-then-publish behavior unchanged.
export const OUTBOX_QUEUE = 'outbox-drain';

export interface OutboxDrainDeps {
  prisma: PrismaClient;
  pushProvider: PushProvider;
  log: FastifyBaseLogger;
  batchSize?: number;
}

// Publishes one batch of unpublished outbox events. Returns how many were shipped.
// Pure enough to unit-test directly against the DB (no pg-boss needed). This is the
// DURABLE catch-up path for notification.created events — the primary delivery
// attempt is the best-effort immediate dispatch fired right after each trigger's own
// transaction commits (see lib/notification-dispatch.ts's fireImmediateDispatch);
// this drain only re-attempts what that missed (a process restart, a transient error).
export async function publishOutboxBatch(deps: OutboxDrainDeps): Promise<number> {
  const { prisma, pushProvider, log, batchSize = 100 } = deps;

  const events = await prisma.outboxEvent.findMany({
    where: { publishedAt: null },
    orderBy: { id: 'asc' },
    take: batchSize,
  });
  if (events.length === 0) return 0;

  const idsToMarkPublished: number[] = [];

  for (const event of events) {
    if (event.eventType === 'notification.created') {
      const payload = event.payload as unknown as NotificationDispatchPayload;
      const handled = await dispatchNotificationEvent({ prisma, pushProvider, log }, payload);
      if (handled) {
        idsToMarkPublished.push(event.id);
      } else {
        log.warn({ outboxId: event.id }, 'notification dispatch not fully handled, retrying next drain');
      }
      continue;
    }

    log.info(
      {
        outboxId: event.id,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
      },
      'outbox event published',
    );
    idsToMarkPublished.push(event.id);
  }

  if (idsToMarkPublished.length > 0) {
    await prisma.outboxEvent.updateMany({
      where: { id: { in: idsToMarkPublished } },
      data: { publishedAt: new Date() },
    });
  }

  return idsToMarkPublished.length;
}

export interface OutboxWorkerDeps {
  prisma: PrismaClient;
  pushProvider: PushProvider;
  boss: PgBoss;
  log: FastifyBaseLogger;
  /** Cron for the recurring drain; defaults to every minute. */
  cron?: string;
}

// Registers the pg-boss queue + recurring drain schedule (Postgres-backed cron, so a
// single run fires per interval even across restarts). Call once from the composition root.
export async function startOutboxWorker(deps: OutboxWorkerDeps): Promise<void> {
  const { prisma, pushProvider, boss, log, cron = '* * * * *' } = deps;

  await boss.createQueue(OUTBOX_QUEUE);
  await boss.work(OUTBOX_QUEUE, async () => {
    const published = await publishOutboxBatch({ prisma, pushProvider, log });
    if (published > 0) log.info({ published }, 'outbox drain complete');
  });
  await boss.schedule(OUTBOX_QUEUE, cron);

  log.info({ queue: OUTBOX_QUEUE, cron }, 'outbox worker started');
}
