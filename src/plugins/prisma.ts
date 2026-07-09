import fp from 'fastify-plugin';
import { PrismaClient } from '@prisma/client';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export interface PrismaPluginOptions {
  /** Injected client (tests supply a fake); defaults to a real PrismaClient. */
  client?: PrismaClient;
}

// Decorates the instance with `app.prisma` and closes the connection on shutdown.
// An initial connection failure is non-fatal: the app still boots and /readyz
// reports not_ready until the database becomes reachable.
export default fp<PrismaPluginOptions>(async function prismaPlugin(app, opts) {
  const injected = opts.client !== undefined;
  const prisma = opts.client ?? new PrismaClient();

  try {
    await prisma.$connect();
  } catch (err) {
    app.log.warn({ err }, 'prisma initial connect failed; /readyz will report not_ready');
  }

  app.decorate('prisma', prisma);

  // Only own the lifecycle of a client we created. An injected client (tests)
  // is owned by the caller, so closing the app must not disconnect it.
  if (!injected) {
    app.addHook('onClose', async () => {
      await prisma.$disconnect();
    });
  }
});
