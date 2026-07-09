import type PgBoss from 'pg-boss';
import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '@prisma/client';

// Transactional-outbox publisher. Domain writes commit their events to
// `outbox_events` inside the same transaction as the state change (see lib/outbox.ts);
// this worker drains the unpublished events, marks them shipped, and emits the event
// trail. A real downstream consumer (e.g. client push) plugs in at the log point later.
export const OUTBOX_QUEUE = 'outbox-drain';

export interface OutboxDrainDeps {
  prisma: PrismaClient;
  log: FastifyBaseLogger;
  batchSize?: number;
}

// Publishes one batch of unpublished outbox events. Returns how many were shipped.
// Pure enough to unit-test directly against the DB (no pg-boss needed).
export async function publishOutboxBatch(deps: OutboxDrainDeps): Promise<number> {
  const { prisma, log, batchSize = 100 } = deps;

  const events = await prisma.outboxEvent.findMany({
    where: { publishedAt: null },
    orderBy: { id: 'asc' },
    take: batchSize,
  });
  if (events.length === 0) return 0;

  for (const event of events) {
    log.info(
      {
        outboxId: event.id,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
      },
      'outbox event published',
    );
  }

  await prisma.outboxEvent.updateMany({
    where: { id: { in: events.map((e) => e.id) } },
    data: { publishedAt: new Date() },
  });

  return events.length;
}

export interface OutboxWorkerDeps {
  prisma: PrismaClient;
  boss: PgBoss;
  log: FastifyBaseLogger;
  /** Cron for the recurring drain; defaults to every minute. */
  cron?: string;
}

// Registers the pg-boss queue + recurring drain schedule (Postgres-backed cron, so a
// single run fires per interval even across restarts). Call once from the composition root.
export async function startOutboxWorker(deps: OutboxWorkerDeps): Promise<void> {
  const { prisma, boss, log, cron = '* * * * *' } = deps;

  await boss.createQueue(OUTBOX_QUEUE);
  await boss.work(OUTBOX_QUEUE, async () => {
    const published = await publishOutboxBatch({ prisma, log });
    if (published > 0) log.info({ published }, 'outbox drain complete');
  });
  await boss.schedule(OUTBOX_QUEUE, cron);

  log.info({ queue: OUTBOX_QUEUE, cron }, 'outbox worker started');
}
