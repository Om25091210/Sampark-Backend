---
name: sdlc-3-build
description: Step 3 of the SDLC pipeline. After the user confirms the architecture PDF is approved by the client, scaffolds and builds the separate projects - Next.js web, React Native mobile, backend APIs, Terraform AWS infrastructure and GitHub Actions CI/CD. Use only when asked to start development from an approved architecture.
---

# Build (gated)

## Gate — always first
1. Read `docs/architecture/ARCHITECTURE.md`. If it is missing, stop and point to `/sdlc-2-architecture`.
2. Look for `docs/architecture/APPROVAL.md`. If absent, ask with AskUserQuestion:
   "Has the client approved the architecture PDF (version/date)?" Options: approved as-is /
   approved with changes (describe) / not yet.
   - Not yet → stop; do not write any project files.
   - Approved → create `docs/architecture/APPROVAL.md` recording approver, date, document
     version and any requested changes, as stated by the user. If changes were requested, update
     the architecture doc and PDF first, and get re-confirmation.
3. Proceed only when `APPROVAL.md` exists and matches the current architecture version.

## Plan
Break the work into milestones (infra baseline → api → web → mobile → CI/CD → hardening) with a
task list (TaskCreate). Show the plan and the repo layout (separate projects in a monorepo or
separate repos, as the architecture says) and get a go-ahead for the layout.

## Build rules
- Follow the architecture document exactly; any deviation is written back to the doc as an
  amendment and flagged to the user. If a repo already has `CLAUDE.md` conventions, they win.
- **Backend/API:** typed, input validation at every boundary, centralized error handling, auth +
  role checks, health endpoints, structured logging with secret redaction, migrations committed,
  tests per route (auth failure, validation failure, happy path).
- **Web (Next.js) / Mobile (React Native):** shared API client types generated from the API
  contract, no secrets in the client, loading/error/empty states, accessibility basics.
- **Infra:** Terraform modules per concern, remote state, least-privilege IAM, encryption at rest
  and in transit, budgets and alarms, no hardcoded secrets. Run `terraform fmt/validate`; never
  `apply` without the user's explicit instruction.
- **CI/CD (GitHub Actions):** lint + typecheck + test on PR; build and push image; deploy to
  staging on merge; production behind a manually approved environment; AWS via OIDC; add a
  post-deploy job that runs the `sdlc-4-security` and `sdlc-5-qa` checks against staging.
- Commit in small logical commits on the designated branch. Run each project's tests before
  declaring a milestone done, and report failures honestly.
- Write `README` per project: how to run, env vars (`.env.example`), deploy.

## Finish
Summarize what exists, what is stubbed, what needs credentials from the user, and suggest running
`/sdlc-4-security staging` and `/sdlc-5-qa staging` after the first deployment.
