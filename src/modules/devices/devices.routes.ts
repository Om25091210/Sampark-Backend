import type { FastifyInstance } from 'fastify';
import { makeDevicesService } from './devices.service.js';
import { registerDeviceBody, unregisterDeviceBody } from './devices.schema.js';
import { bearerAuth, emptyResponse, zodToJson } from '../../lib/openapi.js';

// ADR-048. Registers/unregisters a raw FCM device token against the caller's account,
// so real push (src/lib/push.ts, src/lib/notification-dispatch.ts) knows where to
// deliver a Notification.
export async function devicesRoutes(app: FastifyInstance): Promise<void> {
  const service = makeDevicesService({
    prisma: app.prisma,
    log: app.log,
    pushProvider: app.pushProvider,
  });

  app.post(
    '/devices/register',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Devices'],
        summary: 'Register (or refresh) this device for push delivery',
        security: bearerAuth,
        body: zodToJson(registerDeviceBody),
        response: { 204: emptyResponse('Registered') },
      },
    },
    async (request, reply) => {
      const { token } = registerDeviceBody.parse(request.body);
      await service.register(request.authUser!.sub, token);
      return reply.code(204).send();
    },
  );

  app.post(
    '/devices/unregister',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Devices'],
        summary: 'Unregister this device (called on logout)',
        security: bearerAuth,
        body: zodToJson(unregisterDeviceBody),
        response: { 204: emptyResponse('Unregistered') },
      },
    },
    async (request, reply) => {
      const { token } = unregisterDeviceBody.parse(request.body);
      await service.unregister(request.authUser!.sub, token);
      return reply.code(204).send();
    },
  );
}
