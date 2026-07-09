import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export interface OutboxEntry {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Prisma.InputJsonValue;
}

// Writes a domain event to the transactional outbox within the caller's
// transaction. A pg-boss worker (later step) publishes unshipped events.
export async function writeOutboxEvent(tx: Tx, entry: OutboxEntry): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      aggregateType: entry.aggregateType,
      aggregateId: entry.aggregateId,
      eventType: entry.eventType,
      payload: entry.payload,
    },
  });
}
