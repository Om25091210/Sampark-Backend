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
