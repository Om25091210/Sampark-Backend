---
name: sdlc-5-qa
description: Step 5 of the SDLC pipeline. Hammers the deployed services and apps with functional, end-to-end, load, stress, soak and resilience tests and reports bottlenecks against the stated performance targets. Use after a staging deployment, before release, or when asked for load testing, stress testing or QA.
---

# QA - hammer testing

Argument: environment (default `staging`). Output: `docs/qa/<YYYY-MM-DD>-<env>.md` plus test
code committed under `tests/` (or the project's test dir).

## Safety first
- Run heavy load **only against staging or a dedicated test env**. Against production, ask for
  explicit confirmation and limit to smoke + light load. Confirm the target URL is the project's own.
- Use synthetic test data and test accounts; never real PII. Clean up what tests create.
- Tell the user the expected cost/impact (AWS autoscaling, SMS/email sends) and stub or sandbox
  paid third-party calls.

## Test layers
1. **Contract/functional:** every endpoint from the requirements: happy path, validation errors,
   auth/role failures, idempotency (replay same request), pagination edges.
2. **End-to-end:** key user journeys via Playwright (web) and Maestro/Detox (mobile) if present.
3. **Load:** k6 (or Artillery) scripts modeled on the architecture's sizing inputs: baseline,
   expected peak, then 2-3x peak. Track p50/p95/p99 latency, error rate, throughput against the
   NFR targets in requirements.
4. **Stress & spike:** ramp until degradation; sudden 10x spike; find the breaking point and
   whether it recovers gracefully.
5. **Soak:** extended moderate load to expose leaks and connection exhaustion.
6. **Resilience:** kill/restart a container, drop the DB connection, slow dependency; verify
   health checks, retries, and no data loss. DB-level: connection-pool limits, slow queries
   (EXPLAIN on the hot ones), missing indexes.
7. **Abuse:** large payloads, malformed input, concurrent duplicate submits (race conditions).

## Report
Scenario table (load profile, p95/p99, error %, pass/fail vs. target), bottlenecks with evidence
(CPU/DB/connections from CloudWatch), top fixes ranked by impact, and the max sustainable load.
Verdict **PASS / FAIL** against stated targets. Commit the scripts so the run is repeatable and
can run from GitHub Actions.
