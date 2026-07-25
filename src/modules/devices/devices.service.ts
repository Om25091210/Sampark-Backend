import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { PushProvider } from '../../lib/push.js';

export interface DevicesDeps {
  prisma: PrismaClient;
  pushProvider: PushProvider;
  log: FastifyBaseLogger;
}

export interface DevicesService {
  register(userId: number, token: string): Promise<void>;
  unregister(userId: number, token: string): Promise<void>;
}

export function makeDevicesService({ prisma, pushProvider }: DevicesDeps): DevicesService {
  return {
    async register(userId, token) {
      const { endpointArn } = await pushProvider.createEndpoint(token);
      // Upsert BY TOKEN, not (userId, token): a physical device's token maps to one
      // SNS endpoint regardless of which account registers it, so re-registering the
      // same token under a different user (a handset handed to a new officer)
      // REASSIGNS this row rather than colliding or orphaning a second one.
      await prisma.deviceToken.upsert({
        where: { token },
        create: { userId, token, endpointArn, lastSeenAt: new Date() },
        update: { userId, endpointArn, lastSeenAt: new Date(), deletedAt: null },
      });
    },

    async unregister(userId, token) {
      // Fail-closed: a token that doesn't belong to this user is a silent no-op,
      // same idiom as notifications' markRead — never reveal whose it is.
      const row = await prisma.deviceToken.findFirst({
        where: { userId, token, deletedAt: null },
      });
      if (row === null) return;

      await pushProvider.deleteEndpoint(row.endpointArn);
      await prisma.deviceToken.update({
        where: { id: row.id },
        data: { deletedAt: new Date() },
      });
    },
  };
}
