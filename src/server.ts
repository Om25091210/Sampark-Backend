import { buildApp } from './app.js';
import { loadEnv, toAppConfig } from './config/env.js';
import { loggerOptions } from './plugins/logging.js';
import { createQueue } from './db/queue.js';
import { startOutboxWorker } from './workers/outbox.worker.js';
import { startNotificationEscalationWorker } from './workers/notification-escalation.worker.js';

// Composition root: parse env (fail fast), build the app, then listen.
async function main(): Promise<void> {
  const env = loadEnv();
  const config = toAppConfig(env);
  const app = await buildApp({
    config,
    logger: loggerOptions(env.NODE_ENV),
  });

  // ADR-048/057. buildApp already decorated app.pushProvider / app.sheetsSync (their
  // own defaults, config-driven). Reuse those SAME instances for the background
  // workers below, rather than constructing second, independent ones.
  const pushProvider = app.pushProvider;
  const sheetsSync = app.sheetsSync;

  // Background job runner (pg-boss). Started alongside the API on the single server;
  // failure to start a worker degrades to no async processing for that worker but
  // must not take the API down (it still serves reads/writes; each worker's queue
  // drains on the next successful boot).
  const boss = createQueue(env.DATABASE_URL);
  boss.on('error', (err) => app.log.error({ err }, 'pg-boss error'));
  try {
    await boss.start();
    await startOutboxWorker({ prisma: app.prisma, pushProvider, sheetsSync, boss, log: app.log });
    await startNotificationEscalationWorker({ prisma: app.prisma, pushProvider, boss, log: app.log });
  } catch (err) {
    app.log.error({ err }, 'failed to start background workers (API continues)');
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await boss.stop().catch((err) => app.log.error({ err }, 'pg-boss stop failed'));
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
  } catch (err) {
    app.log.error({ err }, 'failed to start server');
    process.exit(1);
  }
}

void main();
