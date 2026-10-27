---
name: sdlc-6-feature
description: Handles a single new feature or requirement end to end - research, design, explore the existing codebase, estimate effort, then implement and test it. Use when the user describes a new feature, change request, or requirement on an existing project.
---

# Feature workflow: research → design → explore → implement

Argument: the feature request. Output: `docs/features/<slug>.md` and the code changes.

## 1. Understand
Restate the request in testable acceptance criteria. Read `CLAUDE.md`, the requirements and
architecture docs, and ask only the questions that change the design (AskUserQuestion).

## 2. Explore the codebase
Find the modules, routes, models, screens, and tests the feature touches; note the conventions to
follow (naming, validation, error handling, wire formats) and anything reusable. For wide
searches, use the Explore agent. Identify cross-project impact (api + web + mobile + infra) and
contract changes that must ship together.

## 3. Research
Check best practices and library options relevant to the feature (WebSearch/docs when needed).
Compare at most 2-3 approaches; pick one with a recommendation, not a survey.

## 4. Design & estimate
In `docs/features/<slug>.md` write: acceptance criteria, chosen approach and rejected
alternatives, data/API/UI changes, migration and rollout plan (flags, backfill, compatibility with
old mobile app versions), security and performance considerations, test plan, risks, and an
**effort estimate** (per project, in person-days, with confidence).
Present the estimate and plan. **Ask for go-ahead** before implementing if the effort is over
~1 day, touches auth/data migrations/infra, or changes a public contract.

## 5. Implement
Work on the designated branch, in small commits, following the repo's conventions. Update
schemas, migrations, clients, and docs together. Add tests (auth failure, validation failure,
happy path at minimum) and run the project's lint, typecheck and test commands; report failures
honestly.

## 6. Close out
Summarize changes and remaining work; recommend `/sdlc-4-security` and `/sdlc-5-qa` after it
deploys, and note any architecture doc amendments needed. Do not open a PR unless asked.
