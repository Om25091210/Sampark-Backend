# SAMPARK Backend — Phase-1 Design (approved)

Approved design for the Phase-1 backend surface. Binding rules live in `CLAUDE.md`; this file
records the agreed shape and the decisions taken during `/design all`. Clients are canonical
(mobile `src/services/*` + `src/types/index.ts`); the backend matches their wire contract.

## Build status (through reports-media — 2026-07-08)

**Committed on `main`:**

| Step | Feature | Commit |
|---|---|---|
| 1 | scaffold — app/server split, Zod env, Pino + req-id, central error handler, prisma plugin, health, Vitest | `50a61d4` |
| 2 | schema — 7 models + 6 enums, migration `20260704183616_init`, idempotent seed, pg-boss init | `6328371` |
| 3 | auth — officer SMS-OTP (send/verify/refresh/me/logout), JWT + RBAC plugins | `adedccf` |
| 4 | cadres — list/detail/transfer; audit hash-chain + transactional outbox writers | `ea6d914` |
| 5 | reports-core — list/detail/create (idempotent → `201` new / `200` replay; audit + outbox in one tx) | `047e469` |

Backend-doc commits for context: `fd34695` (CLAUDE.md contract), `411a019` + `8672ae1` (thesis ADR-012/013 + tech-registry sweep).

**Just completed — pending commit:**

| Step | Feature | Status |
|---|---|---|
| 6 | reports-media — `POST …/reports/upload` (multipart → storage → `{ url }`, officer+), `GET …/reports/export` (pdfmake Hindi PDF → storage → `{ download_url }`, admin+), pg-boss outbox-publisher worker | 49 tests green, not yet committed |

**Tests: 49 passing** — 1 schema · 4 health · 9 auth · 12 cadres · 11 reports · 10 reports-media · 2 outbox-worker. (all DB-backed suites need Postgres up.)

**Remaining:** none — Phase-1 mobile surface complete. (Deferred web/admin cycles unchanged; see Scope.)

**Known deviations (intentional, Phase 1):**
1. Alias `@`-search uses exact array-element match (`aliases has term`), not the mobile's *substring*
   alias match (substring-in-array needs raw SQL). Normal search is `contains`, case-insensitive.
2. `pageSize > 50` → `400 VALIDATION_ERROR` (Zod max), not silently clamped.
3. Cadres tests delete their own audit/outbox rows in `afterEach` for isolation — leaves hash-chain
   gaps in the **dev DB only**, never in production.

**Environment notes:**
- MCP servers surfaced this session — `aws-mcp` (connecting) and `claude.ai Google Drive` (needs
  authorization in claude.ai connector settings). **Not needed for backend work — ignore.**
- `.env` (gitignored) must define `DATABASE_URL` + `JWT_SECRET` (≥32 chars); see `.env.example`.

## How to resume (fresh session)

1. Start **Docker Desktop**.
2. `cd "Sampark Backend" && docker compose up -d` — Postgres 16; data persists in the `sampark_pgdata`
   volume; `restart: unless-stopped` keeps it up across reboots.
3. Confirm `.env` exists with `DATABASE_URL` + `JWT_SECRET`.
4. `npm test` → expect **37 passing** (verifies the DB + full stack).
5. Run **`/build reports-media`**.

## Scope

Phase 1 = the **mobile-required** surface only, plus `/healthz` + `/readyz`. Out of scope
(own explore→design→build cycle later): the admin email+password+TOTP auth track *build*, and all
web-implied endpoints (officers list, dashboard stats, activity feed, leaderboard, analytics).

## Decisions (locked)

1. **Enum casing** — lowercase Prisma enum values, serialized verbatim on the wire (no mapping layer).
2. **`idempotency_key`** — nullable-unique on `reports`, Zod-optional for now; effectively required
   once the mobile sync change ships (ADR-013). Dedupe → `201` create / `200` existing.
3. **Transfer RBAC** — `admin`+.
4. **Export RBAC** — `admin`+.
5. **Officer provisioning** — officers are pre-created by an admin; `otp/send` for an unknown/inactive
   phone → `403 PHONE_NOT_REGISTERED` (closed roster; clarity over enumeration protection).
6. **SMS gateway** — provider-agnostic `src/lib/sms.ts`; `SMS_PROVIDER=mock|msg91`. `mock` implemented
   (logs the OTP in `NODE_ENV=development` only); `msg91` (real India-resident gateway) not implemented in Phase 1.
7. **Media storage** — provider-agnostic `src/lib/storage.ts` (`STORAGE_PROVIDER=mock|s3`), mirroring the
   `sms.ts` pattern. `mock` keeps objects in-process + returns deterministic fake URLs (dev/test, no AWS);
   `s3` uploads to a **private** S3 bucket (ap-south-1, data residency) and hands out **presigned-GET** URLs
   for both `{ url }` (photo) and `{ download_url }` (export). The mobile client uploads the photo **bytes as
   multipart** (`field=file`) to the backend — it does not presign-PUT — so the backend receives + stores the
   file server-side, then returns a readable URL. Presign TTL = `MEDIA_URL_TTL_SECONDS` (default/max 7 days,
   the SigV4 ceiling). **Known Phase-1 limitation:** a stored `photo_url` is a presigned GET that expires after
   the TTL; durable photo serving (re-presign on read, or CloudFront) is a follow-up, not built here.
7b. **Export = synchronous.** The mobile `downloadReports` contract expects `{ download_url }` **in the GET
   response**, so the export generates the Hindi PDF inline (pdfmake + bundled Noto Sans Devanagari, normal+bold
   only) and returns the URL synchronously. The **pg-boss worker built this step is the transactional-outbox
   publisher** (the genuinely-needed background job: a Postgres-cron `outbox-drain` that marks unpublished
   `outbox_events` shipped and emits the event trail). No phantom "async export" job is enqueued — a queued
   export nothing consumes would break the client contract and be engineering theatre.
8. **`completionPercent`** — **deferred entirely** (see Phase 1.5 Metrics below). Omitted from the
   `AuthUser` serializer for now, exactly like `avatarSource` on `Cadre`.
9. **Token TTLs** — access 15 min, refresh 30 days, rotate-on-refresh.
10. **Pagination** — `pageSize` default **15**, max **50** (EDGE/2G resilience).

## Build sequence (one `/build` per step)

1. ✅ `scaffold` — app/server split, Zod env, Pino logging + request-id, central error handler, Prisma
   plugin, health module, Vitest harness.
2. ✅ `schema` — full Prisma schema, first migration, seed, pg-boss init.
3. ✅ `auth` — JWT + RBAC plugins, tokens (access + rotating refresh), officer SMS-OTP routes.
4. ✅ `cadres` — list (filter+paginate), detail, transfer; introduces audit + outbox writers.
5. ✅ `reports-core` — list, detail, create (idempotent, audit + outbox in one tx).
6. ✅ `reports-media` — photo upload (multipart → storage → `{url}`), export (pdfmake Hindi PDF → storage →
   `{download_url}`, admin+), pg-boss outbox-publisher worker.

## Phase 1.5 Metrics (deferred — do not implement in Phase 1)

- **`AuthUser.completionPercent`** — no formula defined yet. It requires a reporting-compliance rule
  (e.g., % of an officer's assigned cadres reported within the current period) that is a product
  decision, not an engineering one. Until that rule is specified, the field is omitted from the
  `AuthUser` response serializer. `totalReports` (a simple count) may be added earlier if needed.
- Any web dashboard metrics (leaderboard, CSP performance, activity feed) belong to the web cycle,
  not Phase 1.5.

## Frontend Integration (mobile — Phase 1)

Checklist for wiring the mobile app to this backend. Verified against mobile `src/services/*`
(`api.ts`, `auth.service.ts`, `cadre.service.ts`, `report.service.ts`). Live API docs (dev only):
**`GET /docs`** (Swagger UI) — every route with its request/response shape, auth requirement, and an
example; use the **Authorize** button to paste a token and hit protected routes.

### Global prerequisites (apply to every endpoint)

| # | Prereq | Detail |
|---|---|---|
| ⚠️ 1 | **`EXPO_PUBLIC_API_URL`** | Set `EXPO_PUBLIC_API_URL=http://192.168.29.225:3000/api/v1` in the mobile `.env`. `api.ts` otherwise falls back to `https://api.sampark.bitcrackers.in/api/v1` (not deployed). Use the **LAN IP**, not `localhost` — a device/emulator can't reach the host's localhost. Backend binds `0.0.0.0`. |
| ⚠️ 2 | **Android cleartext HTTP** | `http://` (non-TLS) works in Expo Go/dev; a release build needs `usesCleartextTraffic`. Fine for dev integration. |
| ℹ️ 3 | **Dev login** | `SMS_PROVIDER=mock` prints the OTP in the **backend terminal** (dev only). Log in with a **seeded** officer phone (e.g. `+919770000001`); an unprovisioned phone → `403 PHONE_NOT_REGISTERED`. |

### The 13 Phase-1 endpoints

| Endpoint | Mobile service call | Status | Notes |
|---|---|---|---|
| `POST /auth/otp/send` | `AuthService.sendOtp(phone)` | ✅ | `{ message, expires_in }` matches `SendOtpResponse`. |
| `POST /auth/otp/verify` | `AuthService.verifyOtp(phone, otp)` | ✅ | snake tokens + `token_type:'bearer'` + camelCase `user` — matches `VerifyOtpResponse`. |
| `POST /auth/refresh` | interceptor in `api.ts` | ✅ | Sends `{ refresh_token }`, returns `{ access_token, refresh_token }` (rotate-on-refresh). Single-flight 401 retry works as-is. |
| `GET /auth/me` | `AuthService.getMe()` | ✅ | camelCase `AuthUser`; `completionPercent` omitted (Phase 1.5) — must be optional in the mobile type. |
| `POST /auth/logout` | `AuthService.logout()` | ✅ | Returns `204`; revokes all refresh tokens. |
| `GET /cadres` | `CadreService.list(params)` | ✅ | camelCase query params + `PaginatedResponse<Cadre>`. `category=all`/`filter=All` = no filter. |
| `GET /cadres/:id` | `CadreService.getById(id)` | ✅ | camelCase `Cadre`; `avatarSource` never returned (mobile-local only). |
| `POST /cadres/:id/transfer` | `CadreService.transferProfile(id, toOfficerId)` | ✅ | Body `{ to_officer_id }`, returns `204`. **Admin+** — officer call → `403` (gate the UI action). |
| `GET /cadres/:id/reports` | `ReportService.listByCadre(id, params)` | ✅ | Newest-first `PaginatedResponse<Report>`; GPS nested as `gpsCoords`. |
| `GET /cadres/:id/reports/:rid` | `ReportService.getById(id, rid)` | ✅ | camelCase `Report` with nested `cadre` Pick. |
| `POST /cadres/:id/reports` | `ReportService.create(payload)` | 🔧 | **Works today**, but `CreateReportPayload` has **no `idempotency_key`**. Backend dedupes on it (201 new / 200 replay). Offline-safe replay needs the mobile **sync build (ADR-013)** to generate a UUID v4 per report and send it; without it, an offline retry can duplicate. |
| `POST /cadres/:id/reports/upload` | `ReportService.uploadPhoto(id, uri)` | ✅ | multipart `file` → `{ url }`. Client flow (upload → set `photo_url` → create) already correct. **Prod:** set `STORAGE_PROVIDER=s3` + `S3_BUCKET` + AWS creds; `mock` returns fake URLs. |
| `GET /cadres/:id/reports/export` | `ReportService.downloadReports(id)` | ✅ | Hindi PDF → `{ download_url }`. **Admin+** — officer call → `403` (gate the UI). |

### Summary

- **11 of 13 are ✅ ready to call** the moment `EXPO_PUBLIC_API_URL` points at the backend.
- **1 needs a mobile change (🔧):** `idempotency_key` on report create — part of the planned mobile
  **sync** feature (ADR-013), not a blocker for a first happy-path wiring.
- **2 RBAC gates to honor in the mobile UI:** `transfer` + `export` are **admin+** (backend enforces
  `403`; mobile should only surface these to admins).
- **1 prod-config reminder:** flip `STORAGE_PROVIDER=s3` for real photo/PDF persistence.

---

## Phase 2 Migration Checklist (staging → production)

The staging environment (`infra/`, `environment = "staging"`) diverges from production on a
handful of durability, observability, and cost settings. Those divergences are recorded in
**ADR-015 (draft, pending paste into thesis)**; this section is the operational checklist for closing them. Flipping
`var.environment` to `"production"` changes `local.name_prefix`, so a production apply creates a
parallel set of resources rather than mutating staging in place.

### 1. Required before the flip

- [ ] **Upgrade the AWS account off the Free Plan.** `backup_retention_period = 7` is rejected with
      `FreeTierRestrictionError` on the free plan — this blocked the first staging apply.
- [ ] **Delegate `api.bitcrackers.in` DNS to Route 53** — create the hosted zone (~₹43/mo) and point
      the registrar's nameservers at it.
- [ ] **Issue an ACM public certificate** for `api.bitcrackers.in` **in `ap-south-1`** (free), and
      validate it via DNS. Region matters: an ALB can only use a certificate from its own region.
- [ ] **Implement the MSG91 provider** (or the chosen India-resident gateway) behind the existing
      `SmsProvider` interface in `src/lib/sms.ts`. Must cover `send` plus delivery-status webhook
      handling, with tests. Today only `mock` exists.
- [ ] **Obtain DLT registrations** from the SMS gateway — sender ID and OTP template, mandated by
      Indian telecom regulation. **Takes 3–7 business days; start early.** Without them the gateway
      accepts the API call and silently fails to deliver.
- [ ] **Rotate the `om-admin` access key** and delete the account root access keys.

### 2. Infrastructure changes, by file

**`alb.tf`**
- [ ] Add a `:443` HTTPS listener with the ACM certificate; redirect `:80` → `:443`.
- [ ] Route 53 alias record `api.bitcrackers.in` → ALB.
- [ ] Delta cost is < ₹150/mo: the cert is free and ALB bills per LB-hour regardless of listener count.
- [ ] **Enable access logs** to a dedicated S3 bucket. Needs a bucket policy granting the regional
      ELB service principal `s3:PutObject` — log delivery silently no-ops without it.
- [ ] **Attach WAF v2** with the AWS managed rule groups: Core (`AWSManagedRulesCommonRuleSet`),
      Known Bad Inputs (`AWSManagedRulesKnownBadInputsRuleSet`), SQL Injection
      (`AWSManagedRulesSQLiRuleSet`), and IP Reputation (`AWSManagedRulesAmazonIpReputationList`).
- [ ] `enable_deletion_protection`: `false` → `true`.

**`ecs.tf`**
- [ ] Add a `deployment_alarms` block referencing CloudWatch alarms on ALB 5xx rate and running task
      count, once those alarms exist (set up during the Phase 2 monitoring rollout). This catches a
      deployment whose tasks start healthy and then degrade — a different failure mode from the
      `deployment_circuit_breaker`, which only catches tasks that never stabilise.

**`rds.tf`**
- [ ] `backup_retention_period`: `1` → `7` (minimum).
- [ ] `multi_az`: `false` → `true`.
- [ ] `performance_insights_enabled`: `false` → `true` (free at 7-day retention).
- [ ] `monitoring_interval`: `0` → `60` (Enhanced Monitoring).
- [ ] `skip_final_snapshot`: `true` → `false`.
- [ ] Keep `deletion_protection = true` and keep `engine_version` pinned.

**`secrets.tf`**
- [ ] `recovery_window_in_days`: `0` → `30`.
- [ ] Populate `DATABASE_URL` / `JWT_SECRET` by hand after the first apply; never through Terraform.

**`github_oidc.tf`**
- [ ] Tighten the OIDC trust `sub` from `repo:<owner>/<repo>:ref:refs/heads/*` to
      `repo:<owner>/<repo>:ref:refs/heads/main`.

**New — `vpc_endpoints.tf`**
- [ ] Gateway endpoint for S3 (free).
- [ ] Interface endpoints for ECR (api + dkr), Secrets Manager, CloudWatch Logs (~₹500/mo total).
- [ ] Keeps Fargate → AWS API traffic off the public internet. Required because tasks run in public
      subnets with a public IP (no NAT Gateway — see ADR-015, draft, pending paste into thesis).

**`s3.tf` / application**
- [ ] Reduce `MEDIA_URL_TTL_SECONDS` from `604800` (7 days, the SigV4 maximum) to 1–6 hours, once
      the mobile client re-fetches presigned URLs on read instead of persisting them (ADR-014).

### 3. Deploy pipeline

- [ ] **Switch `SMS_PROVIDER` from `mock` to the real provider name** in the `sampark/production`
      secret. The SDK integration and DLT registrations must already be done — see *Required before
      the flip*. Until they are, **no officer can log in**, which is why this environment is tagged
      `Environment=staging` (DESIGN.md decision 6).
- [ ] Confirm `STORAGE_PROVIDER=s3` in the production task definition.
- [ ] Re-verify the rolling deploy end-to-end: `ecs wait services-stable` must pass with the
      circuit breaker armed.

### 4. Documentation

- [ ] Paste **ADR-015 (draft)** into `BC-THESIS-SAMPARK.md`, then drop the "draft" qualifier from every
      reference in this file.
- [ ] Update **ADR-015** with an `Outcome:` section recording what the production flip actually cost
      and broke.
- [ ] Refresh the technology registry in `BC-THESIS-SAMPARK.md`.
- [ ] Record an ADR for the **NAT-less network topology** (Fargate in public subnets) — currently
      justified only in the `infra/network.tf` comments and this checklist.
- [ ] Record an ADR for the **99.9% uptime deviation**: single-AZ RDS plus a single Fargate task does
      not meet the target in the root `CLAUDE.md`, and staging does not claim to.

### 5. Cross-references

- **ADR-011** — backend stack (Node/Fastify/Prisma; Redis deferred).
- **ADR-014** — fully-private media bucket, presigned-URL access.
- **ADR-015 (draft, pending paste into thesis)** — staging vs production configuration divergences
  and standing rules.

---

## Mobile Integration (handoff — staging backend is live)

### Live backend

| | |
|---|---|
| **Base URL** | `http://sampark-staging-alb-2106262233.ap-south-1.elb.amazonaws.com` |
| **API prefix** | `/api/v1` on all business routes |
| **Health** | `/healthz`, `/readyz` — **unversioned**. `/api/v1/healthz` correctly returns `404` |
| **Environment** | `Environment=staging` (AWS tag) / `NODE_ENV=production` (Node runtime) |
| **Region** | ap-south-1, AWS account `231378335677`, CLI profile `sampark-admin` |
| **Logs** | CloudWatch group `/ecs/sampark-backend`, 30-day retention |

`EXPO_PUBLIC_API_URL=http://sampark-staging-alb-2106262233.ap-south-1.elb.amazonaws.com/api/v1`

Note `http://`, not `https://`. TLS is a Phase 2 item (needs Route 53 + an ACM cert in ap-south-1). An
Android **release** build will need `usesCleartextTraffic`; Expo Go / dev builds work as-is.

Backend surface is unchanged from the Phase-1 build: **13 endpoints, 49 tests green**, mixed wire casing
(snake_case request bodies + auth responses, camelCase entity responses) exactly as the clients expect.

### ⚠️ Authenticated flows are NOT testable in staging today

Two independent blockers. Both must be cleared before an OTP login can succeed. **Neither is a bug** —
each is a consequence of a deliberate decision recorded in ADR-015.

**Blocker 1 — the staging database has schema but no rows.**
`docker-entrypoint.sh` runs `prisma migrate deploy`, never `prisma db seed` (a deploy must not write
fixture data). So *every* phone number returns `403 PHONE_NOT_REGISTERED`, including the seeded ones —
the closed-roster check in `auth.service.ts` finds no user.

**Blocker 2 — the OTP is never printed anywhere.**
`MockSmsProvider` surfaces the code **only when `nodeEnv === 'development'`** (`src/lib/sms.ts:23`). The
task runs `NODE_ENV=production`, because `env.ts` accepts only `development | test | production` and the
deployed runtime must not be in dev mode. So `aws logs tail` shows the request and no code.

The OTP cannot be read out of the database either: `otp_challenges.code_hash` stores an HMAC of the code
keyed by `JWT_SECRET` (`auth.service.ts:73`), not the code itself.

### Clearing the blockers

**Seeding (Blocker 1).** The compiled seed ships in the image at `dist/db/seed.js`. Do **not** use
`npm run seed` — it invokes `tsx`, a devDependency absent from the runner. Requires the AWS
`session-manager-plugin` installed locally; `enable_execute_command` and the `ssmmessages` grant on the
task role are already in place.

```
TASK=$(aws ecs list-tasks --cluster sampark-staging-cluster --desired-status RUNNING \
  --profile sampark-admin --region ap-south-1 --query 'taskArns[0]' --output text)

aws ecs execute-command --cluster sampark-staging-cluster --task "$TASK" \
  --container sampark-backend --interactive --command "node dist/db/seed.js" \
  --profile sampark-admin --region ap-south-1
```

The seed is idempotent (upsert on `phone`), so it is safe to re-run.

**Reading an OTP (Blocker 2).** No clean option exists yet. In rough order of preference:

1. **Implement the MSG91 provider** and send real SMS. This is the intended path and is already on the
   Phase 2 Migration Checklist — note DLT registration takes 3–7 business days.
2. **Add a dev-only OTP retrieval affordance** guarded on something other than `NODE_ENV` (e.g. a
   `MOCK_OTP_ECHO=true` env var that only the mock provider honours). A small, reviewable backend change.
3. **Temporarily set `NODE_ENV=development`** in the task definition. Works, but also enables the Swagger
   UI at `/docs` on a publicly reachable HTTP endpoint and switches Pino to pretty-printing. Not
   recommended without TLS.

Until one is done, staging proves **deployment**, not **authenticated flows** — precisely the caveat
recorded in ADR-015.

### Seeded users (present after running the seed above)

| Phone | Role | Name |
|---|---|---|
| `+919999999999` | `super_admin` | सुपर एडमिन |
| `+919888888888` | `admin` | एडमिन |
| `+919770000001` | `officer` | राजेश कुमार सिंह |
| `+919770000002` | `officer` | प्रिया वर्मा |

Roles serialize lowercase on the wire, verbatim. Four cadres are also seeded, assigned to
`+919770000001`.

### What IS testable right now, with no unblocking

These exercise the network path, RBAC, and the error contract end to end:

```
curl http://<alb>/healthz                  # 200 {"status":"ok"}
curl http://<alb>/readyz                   # 200 {"status":"ready"}  <- proves RDS + Prisma over TLS
curl http://<alb>/api/v1/cadres            # 401 UNAUTHORIZED
curl -X POST http://<alb>/api/v1/auth/otp/send \
  -H 'content-type: application/json' -d '{"phone":"+919770000001"}'   # 403 PHONE_NOT_REGISTERED
```

`/readyz` is the load-bearing check. `/healthz` is pure liveness and returns `200` even when Prisma is
completely broken — that is how a wrong-libssl query engine slipped through a green deploy during the
initial Docker build. Always confirm `/readyz` after a deploy.

### Test flow once both blockers are cleared

1. Set `EXPO_PUBLIC_API_URL` (above) in the mobile `.env`.
2. Send an OTP from the app to a seeded number, e.g. `+919770000001`.
3. Obtain the code by whichever route from *Clearing the blockers* was taken.
4. Verify the OTP in the app → expect snake_case tokens + a camelCase `user`.
5. Confirm the access + refresh tokens land in SecureStore and the 401 interceptor refreshes.
6. Exercise protected endpoints: `GET /cadres`, `GET /cadres/:id/reports`.
   `transfer` and `export` are **admin+** and will `403` for `+919770000001`.

Known client gap: `CreateReportPayload` still carries no `idempotency_key`. The backend dedupes on it
(`201` new / `200` replay); without it an offline retry can duplicate a report. That mobile change is part
of the planned sync build (ADR-013), not a blocker for first wiring.
