import type { Notification, NotificationType, Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export interface NotificationEntry {
  userId: number;
  type: NotificationType;
  title: string;
  body: string;
  cadreId?: number;
  cadreChangeId?: number;
  data?: Prisma.InputJsonValue;
}

// Writes one Notification row within the caller's transaction — the in-app inbox's
// source of truth. Mirrors lib/outbox.ts's shape. Callers that also want real push
// (ADR-048) additionally write a `notification.created` OutboxEvent in the same
// transaction (see notification-dispatch.ts) — this function only ever writes the
// inbox row.
export async function writeNotification(tx: Tx, entry: NotificationEntry): Promise<Notification> {
  return tx.notification.create({
    data: {
      userId: entry.userId,
      type: entry.type,
      title: entry.title,
      body: entry.body,
      cadreId: entry.cadreId,
      cadreChangeId: entry.cadreChangeId,
      data: entry.data,
    },
  });
}
