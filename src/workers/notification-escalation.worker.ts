import type PgBoss from 'pg-boss';
import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { recencyTierWhere, type RecencyTier } from '../lib/recency.js';
import { writeNotification } from '../lib/notifications.js';
import { writeOutboxEvent } from '../lib/outbox.js';
import { escalationCopy, type EscalationTierLabel } from '../lib/notification-copy.js';
import { fireImmediateDispatch, type NotificationDispatchDeps } from '../lib/notification-dispatch.js';
import type { PushProvider } from '../lib/push.js';

// ADR-046/047 + ADR-048. Scans every live, assigned cadre for a recency-tier
// ESCALATION (सतर्क→जोखिम→उच्च जोखिम) and notifies the assigned officer once per tier
// ENTRY, not every scan while stuck at the same tier — `Cadre.lastEscalationTier` is
// the dedupe marker. Mirrors outbox.worker.ts's pure-scan-function +
// registration-function shape.
export const ESCALATION_QUEUE = 'notification-escalation-scan';

const TIER_LABELS: Record<'overdue1m' | 'overdue2m' | 'overdue3m', EscalationTierLabel> = {
  overdue1m: 'सतर्क',
  overdue2m: 'जोखिम',
  overdue3m: 'उच्च जोखिम',
};

export interface EscalationScanDeps {
  prisma: PrismaClient;
  pushProvider: PushProvider;
  log: FastifyBaseLogger;
}

// Pure enough to unit-test directly against the DB (no pg-boss needed). Returns how
// many escalation notifications were written.
export async function scanEscalations(deps: EscalationScanDeps): Promise<number> {
  const { prisma, pushProvider, log } = deps;
  const dispatchDeps: NotificationDispatchDeps = { prisma, pushProvider, log };

  // Back to `current` (a new report landed) → reset the marker, so a future
  // re-escalation notifies again from a clean slate.
  await prisma.cadre.updateMany({
    where: { deletedAt: null, lastEscalationTier: { not: null }, ...recencyTierWhere('current') },
    data: { lastEscalationTier: null },
  });

  let notified = 0;

  for (const [tier, label] of Object.entries(TIER_LABELS) as [RecencyTier, EscalationTierLabel][]) {
    // A cadre with no assigned officer has nobody to notify — left untouched rather
    // than marked, so notifying happens immediately once someone is assigned.
    //
    // `lastEscalationTier: { not: tier }` alone would silently exclude every
    // never-escalated cadre: SQL's `<>` against a NULL column is neither true nor
    // false, so a plain `column <> 'x'` comparison drops NULL rows from the result
    // instead of matching them. The explicit `OR [null, not tier]` below is the
    // null-safe form of "not already recorded at this tier." Nested inside its own
    // AND entry (not spread as a second top-level OR) so it doesn't collide with
    // recencyTierWhere's own top-level OR.
    const cadres = await prisma.cadre.findMany({
      where: {
        deletedAt: null,
        assignedOfficerId: { not: null },
        AND: [
          { OR: [{ lastEscalationTier: null }, { lastEscalationTier: { not: tier } }] },
          recencyTierWhere(tier),
        ],
      },
      select: { id: true, name: true, assignedOfficerId: true },
    });

    for (const cadre of cadres) {
      const copy = escalationCopy(cadre.name, label);
      const written = await prisma.$transaction(async (tx) => {
        const notification = await writeNotification(tx, {
          userId: cadre.assignedOfficerId!,
          type: 'report_overdue',
          title: copy.title,
          body: copy.body,
          cadreId: cadre.id,
        });
        const event = await writeOutboxEvent(tx, {
          aggregateType: 'notification',
          aggregateId: String(notification.id),
          eventType: 'notification.created',
          payload: {
            notificationId: notification.id,
            userId: cadre.assignedOfficerId!,
            title: copy.title,
            body: copy.body,
          },
        });
        await tx.cadre.update({ where: { id: cadre.id }, data: { lastEscalationTier: tier } });
        return { notificationId: notification.id, outboxEventId: event.id };
      });

      fireImmediateDispatch(dispatchDeps, written.outboxEventId, {
        notificationId: written.notificationId,
        userId: cadre.assignedOfficerId!,
        title: copy.title,
        body: copy.body,
      });
      notified += 1;
    }
  }

  if (notified > 0) log.info({ notified }, 'escalation scan complete');
  return notified;
}

export interface EscalationWorkerDeps extends EscalationScanDeps {
  boss: PgBoss;
  /** Cron for the recurring scan; defaults to once daily at 06:00. */
  cron?: string;
}

// Registers the pg-boss queue + recurring scan schedule. Call once from the
// composition root, alongside startOutboxWorker.
export async function startNotificationEscalationWorker(deps: EscalationWorkerDeps): Promise<void> {
  const { prisma, pushProvider, log, boss, cron = '0 6 * * *' } = deps;

  await boss.createQueue(ESCALATION_QUEUE);
  await boss.work(ESCALATION_QUEUE, async () => {
    await scanEscalations({ prisma, pushProvider, log });
  });
  await boss.schedule(ESCALATION_QUEUE, cron);

  log.info({ queue: ESCALATION_QUEUE, cron }, 'notification escalation worker started');
}
