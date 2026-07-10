#!/bin/sh
set -e

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
