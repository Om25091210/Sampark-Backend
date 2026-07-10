# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 -- builder. Full dependency tree; produces dist/ and the generated
# Prisma client.
#
# node:22-slim (Debian), not -alpine. Prisma's query engine links against glibc;
# musl needs a separate engine binary and Prisma does not recommend Alpine. The
# image-size difference is irrelevant for a long-running Fargate service.
# ---------------------------------------------------------------------------
FROM node:22-slim AS builder

# OpenSSL must be present BEFORE `prisma generate` runs. Prisma detects the libssl
# version to pick an engine binary; on a slim image with no libssl it silently falls
# back to debian-openssl-1.1.x. The runner has OpenSSL 3.0, so the client would ship
# an engine for the wrong libssl and every query would fail at runtime -- while
# /healthz still returned 200 and the deploy looked green.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Manifests first: this layer stays cached until a dependency actually changes, so
# a source-only commit skips the install entirely.
COPY package.json package-lock.json ./
RUN npm ci

# The schema must land before `prisma generate`, and generate must run before tsc:
# the TypeScript build imports types from the generated client.
COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src

# `npm run build` = tsc + copy:assets. The asset copy carries the bundled Noto Sans
# Devanagari fonts into dist/assets; without them the Hindi PDF export renders blank.
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 -- runner. Production dependencies only: no vitest, no tsx, no @types/*.
# ---------------------------------------------------------------------------
FROM node:22-slim AS runner

ENV NODE_ENV=production

# Prisma's query engine dlopen()s libssl at runtime. node:22-slim does not ship it,
# and the failure is an opaque "Unable to require libquery_engine" on the first
# query -- after the health check has already passed. Root is required for apt.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Own the workdir up front and drop privileges before anything writes to it. A
# `chown -R` after the fact would rewrite every file into a fresh layer, roughly
# doubling the image.
RUN mkdir -p /app && chown node:node /app
WORKDIR /app
USER node

COPY --chown=node:node package.json package-lock.json ./

# `prisma` (the CLI) is a devDependency here, but it is also an *optional peer
# dependency* of @prisma/client, so npm installs it even under --omit=dev. Verified:
# a clean `npm ci --omit=dev` yields node_modules/.bin/prisma. That is what makes
# `prisma migrate deploy` work in the entrypoint without promoting a build tool to a
# production dependency. If a future Prisma release drops that peer, the entrypoint
# fails loudly on the first deploy rather than silently skipping migrations.
RUN npm ci --omit=dev && npm cache clean --force

# The generated client is the one thing npm cannot reproduce here: `prisma generate`
# needs the schema, which is only copied in below, after the install.
COPY --from=builder --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma

COPY --from=builder --chown=node:node /app/dist ./dist

# Amazon RDS certificate authority bundle.
#
# `pg` (via pg-boss) now treats sslmode=require as verify-full, and RDS presents a
# certificate chained to the Amazon RDS CA, which is NOT in Node's default trust
# store. Without this the driver fails with "self-signed certificate in certificate
# chain" -- and because server.ts deliberately survives a pg-boss startup failure,
# the API reports healthy while the transactional-outbox publisher never runs.
# Prisma is unaffected (its own TLS stack), which is what makes the failure silent.
#
# NODE_EXTRA_CA_CERTS *appends* to Node's trust store, so public TLS still works.
# The connection is now genuinely authenticated, not merely encrypted.
ADD --chown=node:node --chmod=0644 \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    /app/certs/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem

# migrate deploy reads the schema and the committed migration history at runtime.
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node --chmod=0755 docker-entrypoint.sh ./

# Documentation only; ECS awsvpc publishes the port via the task definition.
EXPOSE 3000

# No HEALTHCHECK: the ALB target group probes /healthz externally. A second,
# in-container check would duplicate it and add an independent way to fail.
ENTRYPOINT ["./docker-entrypoint.sh"]
