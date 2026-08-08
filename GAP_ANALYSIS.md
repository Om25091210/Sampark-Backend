# GAP_ANALYSIS — SAMPARK Web / B-Smart Development Plan, Phase 0

Read-only discovery audit per `SAMPARK_Web_BSmart_Development_Plan.md`, Phase 0. Findings only —
this does not restate the plan. Repos audited: `Sampark Backend` (this repo), `Sampark Web
Application` (`Sampark-Web` on GitHub), `BC-THESIS-SAMPARK.md`.

## Open Questions Q3–Q5 — answered

**Q3 — Does a full Users REST API exist, or only bulk import + soft-delete?**
Only a **narrow provisioning surface** exists, not a CRUD API:
- `POST /users/import` — bulk upsert-by-`name`, max 200 rows (`src/modules/users/users.routes.ts:19-44`)
- `POST /users/:userId/password` — set/reset password only (`users.routes.ts:46-70`)
- `DELETE /users/:userId` — soft deactivate (`users.routes.ts:72-96`)

Missing entirely: `GET /users` (list), `GET /users/:id`, `POST /users` (single create),
`PATCH /users/:id` (edit role/thana/subDivision/designation). Phase 2 is building this from
scratch, not extending partial coverage.

**Q4 — Web repo name/location.**
Confirmed: GitHub remote is `Om25091210/Sampark-Web`, `package.json` name is `sampark-web`. Local
folder is `Sampark Web Application` (spaces, cosmetic only) — same repo, own `.git`. The plan's
references to "Sampark-Web" are accurate as-is; no correction needed.

**Q5 — Does a Google Cloud project / service account already exist for Sheets access?**
**Cannot be answered from the codebase — no trace of one exists anywhere in either repo.** A
repo-wide case-insensitive search for `googleapis`, `sheets`, `GOOGLE_`, `service account`,
`google-auth` in the backend returned zero relevant hits (one unrelated FCM/push comment in
`infra/sns.tf`). This is an external-provisioning question, not a code question — **needs to be
answered by Om directly before Phase 3 can start**, since Phase 3's prerequisite check will
otherwise stall on "provision a GCP project + service account" with no key ready to load into
Secrets Manager.

---

## 1. Current Users API surface (backend)

| Method | Path | File:line | Gate | Notes |
|---|---|---|---|---|
| POST | `/users/import` | `users.routes.ts:19-44` | `super_admin` | Batch upsert-by-name, skips not overwrites duplicates |
| POST | `/users/:userId/password` | `users.routes.ts:46-70` | `super_admin` | Password-only mutation |
| DELETE | `/users/:userId` | `users.routes.ts:72-96` | `super_admin` | Soft delete (`deletedAt`), self-deactivation blocked |

**Soft-delete endpoint detail** (`users.service.ts:175-207`, `deactivate`):
- Revokes all active refresh tokens in the same DB transaction as the soft delete.
- Does **not** blacklist already-issued access tokens — instead, `src/plugins/auth.ts:44-69`
  re-resolves the user row (`deletedAt: null` check) on **every** authenticated request. A
  deactivated account gets `401 ACCOUNT_INACTIVE` on its very next request, regardless of JWT
  expiry. This is a deliberate design choice (documented in an `auth.ts` comment), **not the open
  gap ADR-044 discusses** — treat this as resolved, and if a later phase's checkpoint language
  ("confirm which one applies") gets to Phase 7, the answer is: per-request re-authorization, not
  token blacklisting, and it already closes the gap.

**`/stats/hierarchy` (ADR-055)**: exists, `stats.routes.ts:122-149`, gated `admin`/`super_admin`.
Core two-level rollup (officers-by-SDOP, admins-by-HQ) matches ADR-055's decision text faithfully.
**Drift found**: the shipped code has an undocumented third mode, `?by=thana` (`stats.service.ts:283-326`,
`stats.schema.ts:121-165`), self-labeled in code comments as "this task's extension of ADR-055" —
no ADR entry exists for it (ADR-055 is still the thesis's last entry). Not blocking for this plan,
but flagged since Phase 8 (thesis closeout) should either retroactively document it or the code
comments should stop claiming an undocumented extension is settled.

**Secrets Manager pattern to replicate in Phase 3** (`infra/secrets.tf`, `infra/ecs.tf`,
`src/config/env.ts`):
1. New secret key added by hand to the existing single JSON blob in
   `aws_secretsmanager_secret_version.app` (Terraform never writes the value — `lifecycle.ignore_changes`
   already covers this).
2. One more entry in the ECS task definition's `secrets` array:
   `{ name = "GOOGLE_SERVICE_ACCOUNT_JSON", valueFrom = "${aws_secretsmanager_secret.app.arn}:GOOGLE_SERVICE_ACCOUNT_JSON::" }`.
3. A Zod field in `src/config/env.ts` (optional, matching the `IMPORT_API_KEY` pattern — required
   secrets fail boot, optional ones degrade gracefully).
4. Deploy order: set the Secrets Manager value first, `terraform apply`, then a manual
   `force-new-deployment` (task-def revision changes are `ignore_changes`d for rollout safety).
5. App code never calls the Secrets Manager SDK directly — only reads `process.env`.

## 2. Web page / data-source table

| Page | File | Data source |
|---|---|---|
| `/` | `app/page.tsx` | None (static marketing copy) |
| `/login` | `app/login/page.tsx` | Hardcoded credential string-compare, `sessionStorage` flag, no API call |
| `/dashboard` | `app/(dashboard)/dashboard/page.tsx` | Mock (`STAT_CARDS` in `lib/constants.ts`) |
| `/records` | `app/(dashboard)/records/page.tsx` | Mock (`CADRES` in `lib/cadres.ts`, client-filtered) |
| `/records/analytics` | `app/(dashboard)/records/analytics/page.tsx` | Mock (in-file const arrays) |
| `/officers` | `app/(dashboard)/officers/page.tsx` | Mock (in-file `EXTENDED_OFFICERS` array) |
| `/tracker` | `app/(dashboard)/tracker/page.tsx` | Mock (in-file fake lat/lng array; hand-drawn SVG, not a real map) |
| `/notifications` | `app/(dashboard)/notifications/page.tsx` | Mock (in-file array) |
| `/profile` | `app/(dashboard)/profile/page.tsx` | Mock, hardcoded single officer, not a real per-account route (no `[id]` dynamic segment anywhere in the app) |

**Every page is mock or placeholder.** Zero `fetch`/`axios`/HTTP-client usage anywhere in the
repo. No dynamic routes exist at all.

**Auth model**: not ADR-042's email+password(+TOTP) flow — a single hardcoded credential pair
compared client-side in `app/login/page.tsx:26-29`. No `middleware.ts` exists anywhere in the
repo. Route gating is a Client Component (`app/(dashboard)/layout.tsx:12-24`) reading a
`sessionStorage` boolean in a `useEffect` — **UI-only, not server-enforced**, exactly the pattern
the plan's Ground Truth section prohibits going forward. The web repo's own `CLAUDE.md` already
self-labels this as faux auth not to be presented as real security.

**Data-fetching library**: none. `package.json` deps are only `lucide-react`, `next`, `react`,
`react-dom` — no React Query, SWR, or axios. Matches the plan's assumption (Section 3, Phase 0
step 2) — confirmed unchanged.

## 3. Sheets-integration status

**None.** Confirmed zero Google Sheets / googleapis / service-account code anywhere in the
backend repo (see Q5 above). This is the expected starting state per the plan.

## 4. What's missing for Phases 2–6

- **Phase 2 (Users CRUD)**: build all four missing endpoints from scratch — `GET /users`,
  `GET /users/:id`, `POST /users`, `PATCH /users/:id`. The existing `POST /users/:userId/password`
  and `DELETE /users/:userId` already match the plan's intended shape (password reset as its own
  endpoint, soft-delete only) and can be reused as-is; no rework needed there.
- **Phase 3 (Sheets sync)**: 100% greenfield — no `googleapis` dependency, no client wrapper, no
  outbox consumer for `user.*`/cadre sync events, no `sync_log` table. **Blocked on Q5** (GCP
  project/service-account provisioning) before any of this can start for real, though the
  Secrets Manager wiring pattern to receive the credential is already well-established and low-risk
  to replicate (see Section 1 above).
- **Phase 4 (Web stats wiring)**: every stats/dashboard surface needs wiring from zero — nothing
  currently calls the backend at all, not even partially. `/stats/dashboard`, `/stats/hierarchy`,
  `/stats/me`, `/cadres`, `/cadres/facets` are all unconsumed by web today.
- **Phase 5 (User Management UI)**: no page exists yet (`/officers` is a mock read-only table,
  not a CRUD UI) — needs to be built new, depends on Phase 2's endpoints existing first.
- **Phase 6 (Configuration page)**: no page exists. Also has no real auth/role system to gate it
  behind yet — **Phase 5/6 both depend on Phase 1's ADR #1 (web access model) landing first**,
  since there is currently no role concept on web at all, only a single boolean "authed" flag.
- **Cross-cutting**: real auth (email+password+TOTP matching ADR-042, server-enforced via
  `middleware.ts` or route handlers, not client-side `sessionStorage`) is a **prerequisite that
  the plan doesn't call out as its own line item** but blocks Phases 4–6 equally — every one of
  those phases assumes API calls carry a real JWT and real role, which nothing on web currently
  produces. Flagging this now since it's a gap the phased roadmap doesn't explicitly own; it likely
  needs to happen at the start of Phase 4 or as a Phase 3.5, and should be confirmed with Om rather
  than silently folded into whichever phase gets there first.
