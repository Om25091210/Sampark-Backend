import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { publishOutboxBatch } from './outbox.worker.js';
import { MockPushProvider, PushEndpointDisabledError, type PushMessage, type PushProvider } from '../lib/push.js';
import {
  MockSheetsSyncProvider,
  SheetsSyncNotConfiguredError,
  type SheetsSyncAction,
  type SheetsSyncProvider,
  type SheetsSyncResult,
} from '../lib/sheets-sync.js';

const prisma = new PrismaClient();
const AGG = 'test-outbox-drain';

// Silent logger stub — publishOutboxBatch only calls `.info`/`.warn`.
const log = { info: () => undefined, warn: () => undefined } as unknown as FastifyBaseLogger;
const pushProvider = new MockPushProvider();
const sheetsSync = new MockSheetsSyncProvider();

async function seedEvent(): Promise<number> {
  const e = await prisma.outboxEvent.create({
    data: { aggregateType: AGG, aggregateId: 'x', eventType: 'test.happened', payload: { ok: true } },
  });
  return e.id;
}

async function cleanup(): Promise<void> {
  await prisma.outboxEvent.deleteMany({ where: { aggregateType: AGG } });
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('outbox publisher', () => {
  it('marks unpublished events as published and reports the count', async () => {
    const id1 = await seedEvent();
    const id2 = await seedEvent();

    const published = await publishOutboxBatch({ prisma, pushProvider, sheetsSync, log });
    expect(published).toBeGreaterThanOrEqual(2);

    const rows = await prisma.outboxEvent.findMany({ where: { id: { in: [id1, id2] } } });
    expect(rows.every((r) => r.publishedAt !== null)).toBe(true);
  });

  it('does not re-publish an already-published event (publishedAt stays fixed)', async () => {
    const id = await seedEvent();
    await publishOutboxBatch({ prisma, pushProvider, sheetsSync, log }); // drains it
    const first = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
    expect(first.publishedAt).not.toBeNull();

    // A second drain must not touch an already-published event. (Global count isn't
    // asserted — other suites run in parallel against the same DB.)
    await publishOutboxBatch({ prisma, pushProvider, sheetsSync, log });
    const second = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
    expect(second.publishedAt?.getTime()).toBe(first.publishedAt?.getTime());
  });
});

// A push provider whose publish() behavior is controlled per-test — MockPushProvider
// itself never fails, so these tests need a double that can. `publishImpl` decides
// PER ENDPOINT ARN and defaults to a silent success for anything it doesn't
// recognise: the outbox table is shared across every test suite running in
// parallel (same caveat outbox.worker.test.ts's original tests already carry — see
// "Global count isn't asserted" above), so a batch drain can legitimately sweep up
// another suite's unrelated notification.created events too. Scoping the special
// (throwing) behavior to only OUR arn(s) keeps this test from corrupting another
// suite's DeviceToken rows.
class ControllablePushProvider implements PushProvider {
  readonly name = 'controllable';
  publishImpl: (endpointArn: string, msg: PushMessage) => Promise<void> = async () => undefined;
  async createEndpoint(token: string) {
    return { endpointArn: `arn:mock:${token}` };
  }
  async publish(endpointArn: string, msg: PushMessage) {
    return this.publishImpl(endpointArn, msg);
  }
  async deleteEndpoint() {
    return undefined;
  }
}

describe('notification.created dispatch (ADR-048)', () => {
  const PHONE = '+919000000066';
  let userId = 0;

  beforeAll(async () => {
    const user = await prisma.user.upsert({
      where: { phone: PHONE },
      update: { deletedAt: null, role: 'officer', name: 'Dispatch Officer', thana: 'बीजापुर' },
      create: { phone: PHONE, name: 'Dispatch Officer', role: 'officer', thana: 'बीजापुर' },
    });
    userId = user.id;
  });

  afterEach(async () => {
    await prisma.outboxEvent.deleteMany({ where: { aggregateType: 'notification', aggregateId: { not: '' } } });
    await prisma.notification.deleteMany({ where: { userId } });
    await prisma.deviceToken.deleteMany({ where: { userId } });
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { userId } });
    await prisma.deviceToken.deleteMany({ where: { userId } });
  });

  async function seedNotificationEvent(): Promise<{ notificationId: number; outboxEventId: number }> {
    const notification = await prisma.notification.create({
      data: { userId, type: 'broadcast', title: 't', body: 'b' },
    });
    const event = await prisma.outboxEvent.create({
      data: {
        aggregateType: 'notification',
        aggregateId: String(notification.id),
        eventType: 'notification.created',
        payload: { notificationId: notification.id, userId, title: 't', body: 'b' },
      },
    });
    return { notificationId: notification.id, outboxEventId: event.id };
  }

  it('a notification.created event with no registered device is published immediately (nothing to deliver)', async () => {
    const { outboxEventId } = await seedNotificationEvent();
    const provider = new ControllablePushProvider();
    await publishOutboxBatch({ prisma, pushProvider: provider, sheetsSync, log });

    const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: outboxEventId } });
    expect(event.publishedAt).not.toBeNull();
  });

  it('publishes via the push provider and marks the event published when a device is registered', async () => {
    const { outboxEventId } = await seedNotificationEvent();
    const arn = 'arn:mock:tok-1';
    await prisma.deviceToken.create({ data: { userId, token: 'tok-1', endpointArn: arn } });

    const calls: string[] = [];
    const provider = new ControllablePushProvider();
    provider.publishImpl = async (endpointArn) => {
      if (endpointArn === arn) calls.push(endpointArn);
    };

    await publishOutboxBatch({ prisma, pushProvider: provider, sheetsSync, log });
    expect(calls).toEqual([arn]);

    const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: outboxEventId } });
    expect(event.publishedAt).not.toBeNull();
  });

  it('an EndpointDisabledException prunes the stale DeviceToken but still marks the event published', async () => {
    const { outboxEventId } = await seedNotificationEvent();
    const arn = 'arn:mock:tok-2';
    const device = await prisma.deviceToken.create({ data: { userId, token: 'tok-2', endpointArn: arn } });

    const provider = new ControllablePushProvider();
    provider.publishImpl = async (endpointArn) => {
      if (endpointArn === arn) throw new PushEndpointDisabledError(endpointArn);
    };

    await publishOutboxBatch({ prisma, pushProvider: provider, sheetsSync, log });

    const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: outboxEventId } });
    expect(event.publishedAt).not.toBeNull(); // a dead device is not a reason to retry the event
    const row = await prisma.deviceToken.findUniqueOrThrow({ where: { id: device.id } });
    expect(row.deletedAt).not.toBeNull();
  });

  it('a generic publish error leaves the event unpublished, and a later successful drain retries it', async () => {
    const { outboxEventId } = await seedNotificationEvent();
    const arn = 'arn:mock:tok-3';
    await prisma.deviceToken.create({ data: { userId, token: 'tok-3', endpointArn: arn } });

    const failing = new ControllablePushProvider();
    failing.publishImpl = async (endpointArn) => {
      if (endpointArn === arn) throw new Error('transient SNS error');
    };
    await publishOutboxBatch({ prisma, pushProvider: failing, sheetsSync, log });
    const stillUnpublished = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: outboxEventId } });
    expect(stillUnpublished.publishedAt).toBeNull();

    const succeeding = new ControllablePushProvider();
    await publishOutboxBatch({ prisma, pushProvider: succeeding, sheetsSync, log });
    const nowPublished = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: outboxEventId } });
    expect(nowPublished.publishedAt).not.toBeNull();
  });
});

// A sheets-sync provider whose call() behavior is controlled per-test — same shape
// as ControllablePushProvider above, same reason: MockSheetsSyncProvider never fails.
class ControllableSheetsSyncProvider implements SheetsSyncProvider {
  readonly name = 'controllable';
  callImpl: (action: SheetsSyncAction, payload: unknown) => Promise<SheetsSyncResult> = async () => ({ ok: true });
  async call(action: SheetsSyncAction, payload: unknown): Promise<SheetsSyncResult> {
    return this.callImpl(action, payload);
  }
}

describe('user.* sheet sync dispatch (ADR-057)', () => {
  async function seedUserSyncEvent(eventType: string, name: string): Promise<number> {
    const event = await prisma.outboxEvent.create({
      data: {
        aggregateType: 'user',
        aggregateId: '999999',
        eventType,
        payload: {
          id: 999999,
          name,
          email: `${name.toLowerCase()}@sampark.internal`,
          role: 'officer',
          thana: 'बीजापुर',
          subDivision: null,
          designation: null,
          status: 'active',
          timestamp: new Date().toISOString(),
        },
      },
    });
    return event.id;
  }

  afterEach(async () => {
    await prisma.outboxEvent.deleteMany({ where: { aggregateType: 'user', aggregateId: '999999' } });
    await prisma.syncLog.deleteMany({ where: { targetKey: { startsWith: 'OUTBOXTEST_' } } });
  });

  it('a successful sync marks the event published and logs a SyncLog success row', async () => {
    const id = await seedUserSyncEvent('user.created', 'OUTBOXTEST_OK');
    const provider = new ControllableSheetsSyncProvider();
    await publishOutboxBatch({ prisma, pushProvider, sheetsSync: provider, log });

    const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
    expect(event.publishedAt).not.toBeNull();
    const logRow = await prisma.syncLog.findFirst({ where: { targetKey: 'OUTBOXTEST_OK' } });
    expect(logRow?.status).toBe('success');
  });

  it('a body-level rejection (ok: false) leaves the event unpublished and logs an error row', async () => {
    const id = await seedUserSyncEvent('user.updated', 'OUTBOXTEST_REJECT');
    const provider = new ControllableSheetsSyncProvider();
    provider.callImpl = async () => ({ ok: false, error: 'unauthorized' });
    await publishOutboxBatch({ prisma, pushProvider, sheetsSync: provider, log });

    const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
    expect(event.publishedAt).toBeNull();
    const logRow = await prisma.syncLog.findFirst({ where: { targetKey: 'OUTBOXTEST_REJECT' } });
    expect(logRow?.status).toBe('error');
    expect(logRow?.error).toBe('unauthorized');
  });

  it('a thrown error (e.g. sync not configured) leaves the event unpublished, and a later successful drain retries it', async () => {
    const id = await seedUserSyncEvent('user.deactivated', 'OUTBOXTEST_RETRY');
    const failing = new ControllableSheetsSyncProvider();
    failing.callImpl = async () => {
      throw new SheetsSyncNotConfiguredError();
    };
    await publishOutboxBatch({ prisma, pushProvider, sheetsSync: failing, log });
    const stillUnpublished = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
    expect(stillUnpublished.publishedAt).toBeNull();

    const succeeding = new ControllableSheetsSyncProvider();
    await publishOutboxBatch({ prisma, pushProvider, sheetsSync: succeeding, log });
    const nowPublished = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
    expect(nowPublished.publishedAt).not.toBeNull();
  });
});
