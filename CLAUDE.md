# SAMPARK Backend — Conventions (to be built)

The API server for SAMPARK. **Nothing is scaffolded yet** — these are binding non-negotiables for
the build. Read the root `../CLAUDE.md` first; the backend serves the existing web + mobile clients
and must match what they already expect. All rules below are defaults, not suggestions.

## Stack (fixed)

- **Node.js (22.x) + TypeScript, `strict: true`.** No `any` in committed code; no `ts-ignore`
  without a justifying comment.
- **Fastify** as the HTTP framework. **Prisma** as the ORM (PostgreSQL 16). **Zod** for all runtime
  validation. **Pino** for logging. **JWT** for auth.
- Stateless process — no in-memory session/state that blocks horizontal scaling. Shared state lives
  in PostgreSQL, never in the Node process. **Introduce Redis only when a concrete need appears**
  (caching, rate-limit counters, an event bus) — do not add it to the stack pre-emptively; the
  solo-maintainer simplicity rule applies.

> Supersedes the Python/FastAPI stack in `BC-THESIS-SAMPARK.md`. The domain rules there (RBAC,
> soft-delete, audit chain, transactional outbox, offline sync) still apply — only the runtime/ORM
> changed. Note: Fastify (Node) ≠ FastAPI (Python).

## Library choices (pinned — TS replacements for the thesis's Python tools)

- **Tests: Vitest** — run per-route integration tests via Fastify's `.inject()` against a test DB.
- **Background jobs: pg-boss** — Postgres-backed queue (replaces Celery). Keeps Redis deferred per
  ADR-011; the queue table lives in PostgreSQL alongside the transactional outbox.
- **TOTP 2FA: otplib** — TOTP generation/verification + provisioning URIs for admin/super-admin 2FA
  (replaces `pyotp`).
- **PDF reports: pdfmake** — pure-Node PDF generation with a **bundled Devanagari font** so Hindi
  reports render correctly without a headless browser (replaces WeasyPrint). Chosen for the
  single-server budget.

Do not swap these without an ADR — they are the recorded equivalents to the superseded Python tools.

## Non-negotiables

1. **Zod on every input boundary.** Validate body, params, querystring, and headers with Zod
   schemas per route; reject invalid input at the edge. Infer types from schemas (`z.infer`) —
   don't hand-write duplicate types.
2. **Zod-validated environment at boot.** Parse `process.env` through a Zod schema at startup;
   crash immediately on missing/invalid config. Never read `process.env` deep in the code.
3. **All routes under `/api/v1/`.** Version the prefix; never break v1 shapes silently.
4. **Health checks:** `/healthz` (liveness — process is up) and `/readyz` (readiness — DB/deps
   reachable). No auth on these.
5. **JWT + RBAC middleware.** Every non-public route passes an auth hook then a role/permission
   check. Roles (lowercase on the wire): `super_admin`, `admin`, `officer`, `viewer`. Authorization
   is enforced here, on the API — never trust the client. Auth is **two-track** (see § Auth, ADR-012):
   officers sign in by **SMS OTP**, admins/super-admins by **email+password then TOTP** (otplib).
   Bulk ops (mass approve/export) = Admin+. Soft-delete of users = Super-Admin only.
6. **Centralized error handler.** One Fastify error handler maps errors → consistent JSON
   (`{ error: { code, message } }`) + correct status. No ad-hoc try/catch returning raw errors;
   never leak stack traces or internals to clients.
7. **Structured Pino logging.** JSON logs with a request id on every log line; **redact secrets**
   (tokens, passwords, PII). No `console.log`.
8. **Per-route integration tests (Vitest).** Every route ships a Vitest integration test hitting the
   real Fastify instance via `app.inject()` against a test DB. Cover auth failure, validation failure,
   and the happy path at minimum.
9. **NO facial recognition.** Do not create facial-recognition endpoints, models, or stubs.
   Biometrics in scope are fingerprint-only (client device unlock; Phase-2 attendance devices).
10. **`role` serializes to lowercase on the wire:** exactly `super_admin` | `admin` | `officer` |
   `viewer`. The mobile client switches on these lowercase literals (`isAdmin`/`isSuperAdmin` compare
   the raw string), so every JSON payload must use them verbatim. The Prisma enum MAY be uppercase
   internally (`SUPER_ADMIN | ADMIN | OFFICER | VIEWER`) for DB readability, but responses must map it
   down to the lowercase wire value and requests map it back. Clients are canonical — never emit an
   uppercase or otherwise transformed role on the wire.

## Structure (feature-based)

Organize by feature/domain, not by technical layer:

```
src/
  app.ts                 # build & configure the Fastify instance (no listen)
  server.ts              # env parse + listen (composition root)
  config/env.ts          # Zod env schema + parsed, typed config export
  plugins/               # cross-cutting Fastify plugins (auth, rbac, error-handler, logging)
  modules/
    <feature>/           # e.g. auth, cadres, reports, officers, sync
      <feature>.routes.ts
      <feature>.service.ts
      <feature>.schema.ts   # Zod schemas + inferred types
      <feature>.test.ts
  lib/                   # shared pure utilities
  db/                    # Prisma client, seed
prisma/schema.prisma
```

Keep `app.ts` (build) separate from `server.ts` (listen) so tests can inject requests without
binding a port.

## Contract direction

**The clients are canonical; the backend derives its contract from them, not the reverse.** The web
and mobile apps already define the field names, payload shapes, auth flow, and role literals they
send and expect (see `src/services/*` and `src/types/index.ts` in mobile, `lib/cadres.ts` in web).
Backend Zod schemas and Prisma models are written to **match those existing shapes** — do not invent
a shape and expect the clients to adapt. If a contract genuinely must change, update the client and
the backend **in the same PR** so the two never drift out of sync; a backend-only contract change is
a defect.

## Contract with the clients (match these — clients are canonical)

Verified against the mobile client (`Sampark Mobile Application/src/services/*`, `src/types/index.ts`,
`src/store/*`). The web app is still mock-only, so the mobile app is the canonical wire contract today.

### Wire casing (mixed — canonical, DO NOT normalize)

The clients use **different casing for different payload kinds**. This is deliberate and canonical —
do not "fix" it to a single convention:

- **snake_case** — all **request bodies** (writes) and all **auth/operation responses** (token pairs,
  OTP metadata, upload/export URLs). Examples: `refresh_token`, `cadre_id`, `to_officer_id`,
  `person_status`, `access_token`, `expires_in`, `download_url`.
- **camelCase** — all **entity response fields** (`Cadre`, `Report`, `AuthUser`), the
  `PaginatedResponse` envelope, and all **query parameters**. Examples: `currentAddress`, `alertLevel`,
  `reportingPlace`, `isHomeAddress`, `pageSize`, `hasMore`.
- A nested entity keeps its own casing: e.g. the snake_case OTP-verify response carries a camelCase
  `user` (`AuthUser`) object.

| Endpoint | Request body | Query params | Response body |
|---|---|---|---|
| `POST /auth/otp/send` | snake (`phone`) | — | snake (`message`, `expires_in`) |
| `POST /auth/otp/verify` | snake (`phone`, `otp`) | — | snake tokens + camelCase `user` |
| `POST /auth/login` | snake (`email`, `password`) | — | snake (2FA challenge, or tokens) |
| `POST /auth/2fa/verify` | snake (`challenge_token`, `otp`) | — | snake tokens + camelCase `user` |
| `POST /auth/refresh` | snake (`refresh_token`) | — | snake (`access_token`, `refresh_token?`) |
| `GET /auth/me` | — | — | camelCase `AuthUser` |
| `POST /auth/logout` | — | — | empty |
| `GET /cadres` | — | camelCase (`category`,`filter`,`search`,`page`,`pageSize`) | camelCase `PaginatedResponse<Cadre>` |
| `GET /cadres/:id` | — | — | camelCase `Cadre` |
| `POST /cadres/:id/transfer` | snake (`to_officer_id`) | — | empty |
| `GET /cadres/:id/reports` | — | camelCase (`page`,`pageSize`,`search`) | camelCase `PaginatedResponse<Report>` |
| `GET /cadres/:id/reports/:rid` | — | — | camelCase `Report` |
| `POST /cadres/:id/reports` | snake (`cadre_id`, …, `idempotency_key`) | — | camelCase `Report` |
| `POST /cadres/:id/reports/upload` | multipart (field `file`) | — | snake (`url`) |
| `GET /cadres/:id/reports/export` | — | — | snake (`download_url`) |

`Cadre.avatarSource` is a mobile-local mock field — **never** return it in an entity response.

### Auth — two tracks, one token system (see ADR-012)

Both tracks converge on the **same access+refresh token pair** and share the **same** `/auth/refresh`,
`/auth/me`, `/auth/logout`:

- **Officer / mobile — SMS OTP** (client-canonical, Phase 1): `POST /auth/otp/send { phone }` →
  `{ message, expires_in }`; `POST /auth/otp/verify { phone, otp }` → token pair + `user`. SMS delivery
  must use an India-resident gateway (data-residency rule).
- **Admin / web — email+password then TOTP** (specified now, built with the web cycle):
  `POST /auth/login { email, password }` → a 2FA challenge; `POST /auth/2fa/verify { challenge_token, otp }`
  → token pair + `user`. TOTP via **otplib** (ADR-011 / SDR-001). The exact login/challenge shapes are
  backend-proposed and confirmed when the web auth screens are wired.
- Tokens are Bearer in `Authorization`. The mobile interceptor calls `/auth/refresh` on 401 with a
  single-flight guard; refresh failure force-clears tokens (logout).

### Offline & idempotency (see ADR-013)

- **`CreateReportPayload` carries a client-generated `idempotency_key` (UUID v4).** The backend dedupes
  on it: a first request creates the report (`201`); a replay with the same key returns the existing
  record (`200`) — never a duplicate. Store it as a **unique-indexed column on the `reports` table**
  (no separate key store), retained for the report's lifetime with **no expiry window** — offline
  reports may sit in the outbox for weeks in no-signal areas and be replayed with the same key much
  later, so the key must never be aged out. It is unique per logical action and stable across retries.
- The mobile outbox replays `CREATE_REPORT` over plain REST (there is **no** batched push/pull sync
  endpoint), so create endpoints must be safe to call repeatedly. The mobile change to generate, enqueue,
  and send the `idempotency_key` lands as part of the **sync feature build** (ADR-013).
- `UPDATE_CADRE` exists in the client's queue type but is **not** synced yet — do not design a backend
  contract around it until the client implements it.
- Paginated list responses match the mobile `PaginatedResponse<T>` shape exactly.

## Phase 1 scope (mobile surface only)

Backend **Phase 1 builds only the mobile-required endpoints** — the officer/SMS-OTP auth track, cadres,
and reports listed above — plus `/healthz` and `/readyz`. **Out of scope for Phase 1**, deferred to its
own explore→design→build cycle when the web is wired for real: the **admin email+password+TOTP auth
track build**, and all **web-implied endpoints** (officers list, dashboard stats, activity feed,
leaderboard, analytics). Those are documented here for direction, not implemented in Phase 1.

## Data & domain rules (from thesis, still binding)

- PostgreSQL 16 via Prisma; Alembic-style discipline → use Prisma Migrate, migrations committed.
- **Soft-delete**, not hard-delete, for user/domain records. **Immutable audit trail** (hash-chained
  audit log) on every mutating action. **Transactional outbox** for events that must reach clients.
- Data residency **India only** (AWS Mumbai). No egress to services outside India.
- Single-server operable by one person; PgBouncer transaction pooling. Stay within the ≤₹10k/mo
  budget — no managed sprawl (no k8s/Kafka).
- Targets: reads < 200ms, writes < 300ms, 99.9% uptime, TLS 1.3, AES-256 at rest, audit ≥ 1yr.
