import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { writeAuditLog } from '../../lib/audit.js';
import type { UpdateConfigBody } from './config.schema.js';

export interface ConfigDeps {
  prisma: PrismaClient;
  log: FastifyBaseLogger;
}

export interface WireConfig {
  sheetsSyncUrl: string | null;
  updatedAt: string;
  updatedById: number | null;
}

interface ConfigRow {
  sheetsSyncUrl: string | null;
  updatedAt: Date;
  updatedById: number | null;
}

// Unset (no row created yet) reads as an all-null config -- not an error. The row
// is created lazily by the first PATCH, never by a migration seed.
function toWireConfig(row: ConfigRow | null): WireConfig {
  if (row === null) return { sheetsSyncUrl: null, updatedAt: new Date(0).toISOString(), updatedById: null };
  return { sheetsSyncUrl: row.sheetsSyncUrl, updatedAt: row.updatedAt.toISOString(), updatedById: row.updatedById };
}

export interface WireSyncLogEntry {
  id: number;
  eventType: string;
  targetKey: string | null;
  status: string;
  error: string | null;
  createdAt: string;
}

export interface ConfigService {
  get(): Promise<WireConfig>;
  update(body: UpdateConfigBody, actorId: number): Promise<WireConfig>;
  listSyncLog(limit: number): Promise<WireSyncLogEntry[]>;
}

// Singleton row at id=1 -- see ConfigEntry's schema comment. Every read/write
// targets that fixed id; there is never a second row.
export function makeConfigService({ prisma }: ConfigDeps): ConfigService {
  return {
    async get() {
      const row = await prisma.configEntry.findUnique({ where: { id: 1 } });
      return toWireConfig(row);
    },

    async update(body, actorId) {
      const row = await prisma.$transaction(async (tx) => {
        const before = await tx.configEntry.findUnique({ where: { id: 1 } });
        const updated = await tx.configEntry.upsert({
          where: { id: 1 },
          create: { id: 1, sheetsSyncUrl: body.sheetsSyncUrl, updatedById: actorId },
          update: { sheetsSyncUrl: body.sheetsSyncUrl, updatedById: actorId },
        });
        await writeAuditLog(tx, {
          actorId,
          action: 'config.updated',
          entityType: 'config',
          entityId: '1',
          before: before === null ? undefined : { sheetsSyncUrl: before.sheetsSyncUrl },
          after: { sheetsSyncUrl: updated.sheetsSyncUrl },
        });
        return updated;
      });
      return toWireConfig(row);
    },

    async listSyncLog(limit) {
      const rows = await prisma.syncLog.findMany({
        // Rows from the same batch write (e.g. createMany) can share a millisecond
        // timestamp -- id desc breaks the tie deterministically, newest-inserted first.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        select: { id: true, eventType: true, targetKey: true, status: true, error: true, createdAt: true },
      });
      return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
    },
  };
}
