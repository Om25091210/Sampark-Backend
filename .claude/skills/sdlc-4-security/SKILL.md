---
name: sdlc-4-security
description: Step 4 of the SDLC pipeline. After each staging or production deployment, audits the code, infrastructure and live environment against the approved architecture's security boundaries and reports findings by severity. Use after deploys, before releases, or when asked for a security sanity check or architecture compliance check.
---

# Security sanity check

Argument: environment (`staging` | `production`), default `staging`. Output:
`docs/security/<YYYY-MM-DD>-<env>.md`.

## Scope and authorization
Only inspect systems that belong to this project. Live checks are **non-destructive and
read-only/low-impact** (no exploitation, no brute force, no DoS). Production checks are passive
(headers, TLS, config) unless the user explicitly authorizes more. Stop and ask if a target host
is not clearly the project's own.

## Checks
1. **Architecture conformance:** compare what is deployed/declared (Terraform, task defs, SG
   rules) with `docs/architecture/ARCHITECTURE.md`; list every drift.
2. **Network:** DB and internal services not public; security groups minimal (no `0.0.0.0/0`
   except 80/443 on the edge); private subnets; no open admin ports.
3. **IAM & secrets:** least-privilege roles, no wildcard actions/resources without reason, no
   long-lived keys, secrets only in Secrets Manager/SSM; scan repo and history for leaked
   secrets (`run_secret_scanning` if available, or a local scanner).
4. **Data:** encryption at rest (RDS, S3, EBS) and in transit (TLS 1.2+/1.3), S3 public access
   blocked, backups enabled and tested, residency region respected, logs free of PII/tokens.
5. **App layer:** auth on every non-public route, role checks server-side, input validation,
   rate limiting on auth/OTP, CORS allow-list, security headers (HSTS, CSP, X-Content-Type),
   safe error responses (no stack traces), file upload limits/type checks, debug/mock flags off
   in production (e.g. mock OTP echo).
6. **Supply chain:** dependency audit (`npm audit` / `pip-audit`), pinned base images, image
   scan, GitHub Actions pinned and least-privilege `permissions:`, OIDC for AWS.
7. **Observability:** audit logging on, alarms for auth failures/5xx, CloudTrail/GuardDuty
   status as per architecture.

## Report
Table of findings: ID, severity (Critical/High/Medium/Low/Info), evidence (file:line or command
output), impact, fix. Then a verdict: **PASS / PASS WITH FIXES / FAIL** (any Critical or High =
FAIL). Do not fix automatically; offer to open fixes. Never print secret values in the report.
