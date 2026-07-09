import PgBoss from 'pg-boss';

// pg-boss is the Postgres-backed job queue (replaces Celery, per ADR-011). It
// manages its own `pgboss` schema in the same database. This factory is reused
// by the seed (to initialise the schema) and by the queue plugin in later steps.
export function createQueue(connectionString: string): PgBoss {
  return new PgBoss({ connectionString });
}
