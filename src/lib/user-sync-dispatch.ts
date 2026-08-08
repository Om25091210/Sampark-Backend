import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { SheetsSyncProvider } from './sheets-sync.js';

export interface UserSyncDispatchDeps {
  prisma: PrismaClient;
  sheetsSync: SheetsSyncProvider;
  log: FastifyBaseLogger;
}

export interface UserSyncPayload {
  id: number;
  name: string;
  email: string | null;
  role: string;
  thana: string | null;
  subDivision: string | null;
  designation: string | null;
  status: 'active' | 'deactivated';
  timestamp: string;
}

export type UserSyncEventType = 'user.created' | 'user.updated' | 'user.deactivated';

// ADR-057. Delivers one user.created/user.updated/user.deactivated outbox event to
// the UsersReady sheet via the shared Apps Script Web App deployment (action:
// 'user.sync'). Called from the outbox drain cron ONLY -- unlike
// notification.created there is no best-effort immediate-dispatch path here: ADR-057
// §3 explicitly chose "commit first, the NEXT drain cycle picks it up" over a
// synchronous/fire-and-forget attempt.
//
// Every attempt (success or failure) writes a SyncLog row so HQ can see what synced
// when and what failed -- the same per-row-result discipline ADR-038/045 already
// established for the register imports.
export async function dispatchUserSyncEvent(
  deps: UserSyncDispatchDeps,
  eventType: UserSyncEventType,
  payload: UserSyncPayload,
): Promise<boolean> {
  const { prisma, sheetsSync, log } = deps;

  try {
    const result = await sheetsSync.call('user.sync', payload);
    if (!result.ok) {
      log.warn({ result, userId: payload.id, eventType }, 'user sheet sync rejected, will retry');
      await prisma.syncLog.create({
        data: { eventType, targetKey: payload.name, status: 'error', error: result.error ?? 'unknown error' },
      });
      return false;
    }
    await prisma.syncLog.create({ data: { eventType, targetKey: payload.name, status: 'success' } });
    return true;
  } catch (err) {
    // Covers SheetsSyncNotConfiguredError (URL never set yet) the same as any other
    // failure: log, leave the outbox event unpublished, retry next drain.
    const error = err instanceof Error ? err.message : String(err);
    log.warn({ err, userId: payload.id, eventType }, 'user sheet sync failed, will retry');
    await prisma.syncLog.create({ data: { eventType, targetKey: payload.name, status: 'error', error } });
    return false;
  }
}
