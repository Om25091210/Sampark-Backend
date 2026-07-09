import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export interface AuditEntry {
  actorId: number | null;
  action: string;
  entityType: string;
  entityId: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
}

// Stable, key-sorted JSON so the chain hash is reproducible regardless of key order.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

// Appends a hash-chained audit record within the caller's transaction.
// A transaction-scoped advisory lock serialises writers so `prevHash` is consistent.
export async function writeAuditLog(tx: Tx, entry: AuditEntry): Promise<void> {
  // $executeRaw (not $queryRaw) — the lock function returns `void`, which
  // $queryRaw cannot deserialize; $executeRaw ignores the result set.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(4771)`;

  const last = await tx.auditLog.findFirst({ orderBy: { id: 'desc' }, select: { hash: true } });
  const prevHash = last?.hash ?? 'GENESIS';

  const body = {
    actorId: entry.actorId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before ?? null,
    after: entry.after ?? null,
  };
  const hash = createHash('sha256').update(`${prevHash}:${stableStringify(body)}`).digest('hex');

  await tx.auditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: entry.before,
      after: entry.after,
      prevHash,
      hash,
    },
  });
}
