/**
 * Prints a Postgres connection URL composed from its parts. Used by
 * docker-entrypoint.sh (ADR-034) and by anyone running a one-off command inside the
 * container.
 *
 * Why this exists
 * ---------------
 * `sampark_app` IS the RDS master user, and `manage_master_user_password = true`
 * puts its password on a 7-day rotation in a secret RDS owns. DATABASE_URL used to
 * be a HAND-ASSEMBLED copy of that password in `sampark/staging`. A copy of a
 * rotating value is wrong the moment it rotates: staging died at 11:40 IST on
 * 2026-07-17, exactly 7 days after the copy was written (Backend#17).
 *
 * ECS now injects DB_PASSWORD straight from the RDS-managed secret, and this
 * composes the URL at container start. There is no copy left to go stale.
 *
 * Why a script and not config/env.ts
 * ----------------------------------
 * The entrypoint runs `prisma migrate deploy` BEFORE the app starts, as a separate
 * process. The Prisma CLI reads DATABASE_URL from the environment and knows nothing
 * about our Zod schema, so composing inside env.ts would leave migrations broken.
 * Exporting it from the entrypoint feeds both, and leaves env.ts and all twelve
 * `new PrismaClient()` sites untouched.
 *
 * Usage:
 *   DATABASE_URL="$(node dist/scripts/print-database-url.js)" npx prisma migrate deploy
 */

import { pathToFileURL } from 'node:url';

function required(name: string, value: string | undefined): string {
  if (value === undefined || value === '') {
    // Fail loudly. A half-composed URL would surface as an authentication error
    // pointing at the database, which is exactly the wrong place to look.
    throw new Error(`${name} is required to compose DATABASE_URL (see ADR-034)`);
  }
  return value;
}

export function composeDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const user = required('DB_USER', env.DB_USER);
  const password = required('DB_PASSWORD', env.DB_PASSWORD);
  const host = required('DB_HOST', env.DB_HOST);
  const name = required('DB_NAME', env.DB_NAME);
  const port = env.DB_PORT ?? '5432';
  const sslmode = env.DB_SSLMODE ?? 'require';

  // Percent-encode the credentials. RDS excludes '/', '"', '@' and space from a
  // generated password, but NOT ':' — and an unescaped ':' splits the userinfo in
  // the wrong place, producing a wrong-password error rather than a parse error.
  // Encoding is free; debugging that at 05:30 on a rotation day is not.
  const u = encodeURIComponent(user);
  const p = encodeURIComponent(password);

  return `postgresql://${u}:${p}@${host}:${port}/${name}?sslmode=${sslmode}`;
}

// Only prints when this module IS the entry point, so importing it stays side-effect free.
//
// The previous guard tested `import.meta.url.endsWith('print-database-url.js')`, which is
// a tautology: `import.meta.url` is always THIS module's own URL, so it ended with that
// name whether the module was executed or merely imported. The effective condition was
// `process.argv[1] !== undefined` — i.e. "always" — so every importer printed the
// composed URL, RDS master password and all, to stdout. `src/db/seed.ts` imports it, so
// every seed run leaked the credential into whatever was capturing that output (an
// `ecs execute-command` session, and any exec logging configured behind it).
//
// The correct test compares this module's URL against the resolved ENTRY module.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(composeDatabaseUrl());
}
