import type { OutboxEvent, Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export interface OutboxEntry {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Prisma.InputJsonValue;
}

// Writes a domain event to the transactional outbox within the caller's
// transaction. A pg-boss worker (later step) publishes unshipped events. Returns the
// created row so a caller that needs to reference this specific event afterwards
// (ADR-048's notification.created — see lib/notification-dispatch.ts) can mark THIS
// row published on an immediate-dispatch success, not just rely on the periodic drain.
export async function writeOutboxEvent(tx: Tx, entry: OutboxEntry): Promise<OutboxEvent> {
  return tx.outboxEvent.create({
    data: {
      aggregateType: entry.aggregateType,
      aggregateId: entry.aggregateId,
      eventType: entry.eventType,
      payload: entry.payload,
    },
  });
}
