#!/bin/sh
set -e

# ADR-034. DATABASE_URL is composed here, once, from the parts ECS injects --
# DB_PASSWORD coming straight from the secret RDS owns and rotates.
#
# It used to be a hand-assembled copy of that rotating password. A copy is wrong the
# moment it rotates: staging died at 11:40 IST on 2026-07-17, exactly 7 days after
# the copy was written, and every DB-backed route 500'd while /healthz still said
# 200 (Backend#17, Backend#18).
#
# Composed HERE rather than in env.ts because `prisma migrate deploy` below is a
# separate process: the Prisma CLI reads DATABASE_URL from the environment and knows
# nothing about our Zod schema. Exporting it feeds the migration AND the server.
#
# The guard keeps a literal DATABASE_URL winning when one is set -- local dev,
# docker-compose and CI all pass a plain URL and must keep working untouched.
if [ -z "${DATABASE_URL:-}" ]; then
  echo "entrypoint: composing DATABASE_URL from DB_* parts (ADR-034)"
  DATABASE_URL="$(node dist/scripts/print-database-url.js)"
  export DATABASE_URL
fi

# Migrations run on every task start, before the process accepts traffic. Prisma
# takes a Postgres advisory lock, so the two tasks briefly overlapping during a
# rolling deploy serialise here rather than racing: the second one waits, then
# no-ops. The ECS health_check_grace_period_seconds (120s) must stay longer than
# the slowest migration, or the ALB kills the task mid-schema-change.
echo "entrypoint: applying database migrations"
npx --no-install prisma migrate deploy

# `exec` replaces the shell with node, so node becomes PID 1 and receives SIGTERM
# directly. Without it the shell stays PID 1, swallows the signal, and every ECS
# deploy hard-kills the process after the 30s stop timeout -- cutting off the
# graceful shutdown in server.ts that drains pg-boss and closes Fastify.
echo "entrypoint: starting server"
exec node dist/server.js
