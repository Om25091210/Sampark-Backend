import { buildApp } from './app.js';
import { loadEnv, toAppConfig } from './config/env.js';
import { loggerOptions } from './plugins/logging.js';
import { createQueue } from './db/queue.js';
import { startOutboxWorker } from './workers/outbox.worker.js';

// Composition root: parse env (fail fast), build the app, then listen.
async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp({
    config: toAppConfig(env),
    logger: loggerOptions(env.NODE_ENV),
  });

  // Background job runner (pg-boss). Started alongside the API on the single server;
  // failure to start the worker degrades to no async processing but must not take the
  // API down (it still serves reads/writes; the outbox drains on the next boot).
  const boss = createQueue(env.DATABASE_URL);
  boss.on('error', (err) => app.log.error({ err }, 'pg-boss error'));
  try {
    await boss.start();
    await startOutboxWorker({ prisma: app.prisma, boss, log: app.log });
  } catch (err) {
    app.log.error({ err }, 'failed to start outbox worker (API continues)');
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
