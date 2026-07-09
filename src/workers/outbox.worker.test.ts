import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { publishOutboxBatch } from './outbox.worker.js';

const prisma = new PrismaClient();
const AGG = 'test-outbox-drain';

// Silent logger stub — publishOutboxBatch only calls `.info`.
const log = { info: () => undefined } as unknown as FastifyBaseLogger;

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

    const published = await publishOutboxBatch({ prisma, log });
    expect(published).toBeGreaterThanOrEqual(2);

    const rows = await prisma.outboxEvent.findMany({ where: { id: { in: [id1, id2] } } });
    expect(rows.every((r) => r.publishedAt !== null)).toBe(true);
  });

  it('does not re-publish an already-published event (publishedAt stays fixed)', async () => {
    const id = await seedEvent();
    await publishOutboxBatch({ prisma, log }); // drains it
    const first = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
    expect(first.publishedAt).not.toBeNull();

    // A second drain must not touch an already-published event. (Global count isn't
    // asserted — other suites run in parallel against the same DB.)
    await publishOutboxBatch({ prisma, log });
    const second = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
    expect(second.publishedAt?.getTime()).toBe(first.publishedAt?.getTime());
  });
});
