import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from './config/env.js';
import type { StorageProvider } from './lib/storage.js';
import { createStorageProvider } from './lib/storage.js';
import { loggerOptions } from './plugins/logging.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import prismaPlugin from './plugins/prisma.js';
import authPlugin from './plugins/auth.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { cadresRoutes } from './modules/cadres/cadres.routes.js';
import { cadreChangesRoutes } from './modules/cadre-changes/cadre-changes.routes.js';
import { officersRoutes } from './modules/officers/officers.routes.js';
import { reportsRoutes } from './modules/reports/reports.routes.js';
import { reportsMediaRoutes } from './modules/reports-media/reports-media.routes.js';
import { statsRoutes } from './modules/stats/stats.routes.js';
import { usersRoutes } from './modules/users/users.routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    storage: StorageProvider;
  }
}

export interface BuildAppOptions {
  /** Validated app config (server derives from env; tests pass a fixture). */
  config: AppConfig;
  /** Injected Prisma client (tests supply a real or fake one). */
  prisma?: PrismaClient;
  /** Injected storage provider (tests capture uploads); defaults from config. */
  storage?: StorageProvider;
  /** Logger config; tests pass `false` to silence output. */
  logger?: FastifyServerOptions['logger'];
}

/**
 * Builds + configures the Fastify instance WITHOUT listening, so tests can drive
 * it via `app.inject()`. `server.ts` owns env parsing + `listen()`.
 */
export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? loggerOptions(opts.config.nodeEnv),
    genReqId: () => randomUUID(),
  });

  app.decorate('config', opts.config);
  app.decorate('storage', opts.storage ?? createStorageProvider(opts.config, app.log));

  // Doc-only schemas: routes attach Zod-derived JSON Schema purely so @fastify/swagger
  // can display request shapes. Validation stays with each route's Zod `.parse()`, so
  // Fastify must NOT validate against these — a no-op compiler keeps behaviour unchanged.
  app.setValidatorCompiler(() => () => true);

  await app.register(errorHandlerPlugin);
  await app.register(prismaPlugin, { client: opts.prisma });
  await app.register(authPlugin);

  // Multipart (report photo upload). One file per request, capped at UPLOAD_MAX_BYTES.
  await app.register(multipart, {
    limits: { files: 1, fileSize: opts.config.uploadMaxBytes },
  });

  // API docs — development ONLY, never exposed in production. Dynamic import keeps the
  // swagger packages out of the production load path. Registered before the routes so
  // it can collect each route's schema; UI mounts at /docs.
  if (opts.config.nodeEnv === 'development') {
    const { default: swagger } = await import('@fastify/swagger');
    const { default: swaggerUi } = await import('@fastify/swagger-ui');
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'SAMPARK Backend API',
          version: '0.1.0',
          description:
            'Phase-1 mobile surface — officer SMS-OTP auth, cadres, reports, report media. ' +
            'Roles on the wire are lowercase (super_admin | admin | officer | viewer).',
        },
        tags: [
          { name: 'Health', description: 'Liveness / readiness probes (public)' },
          { name: 'Auth', description: 'Officer SMS-OTP authentication' },
          { name: 'Cadres', description: 'Cadre records' },
          { name: 'Reports', description: 'Field reports filed against a cadre' },
          { name: 'Reports Media', description: 'Report photo upload + PDF export' },
          { name: 'Stats', description: 'Dashboard summary counts' },
        ],
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          },
        },
      },
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
    app.log.info('API docs registered at /docs (development only)');
  }

  // Health probes: root-mounted, unauthenticated (for load balancers).
  await app.register(healthRoutes);

  // Versioned API. Feature modules mount here.
  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(cadresRoutes);
      await api.register(cadreChangesRoutes); // ADR-026
      await api.register(officersRoutes);
      await api.register(reportsRoutes);
      await api.register(reportsMediaRoutes);
      await api.register(statsRoutes);
      await api.register(usersRoutes); // Phase B: account provisioning (super_admin)
    },
    { prefix: '/api/v1' },
  );

  await app.ready();
  return app;
}
