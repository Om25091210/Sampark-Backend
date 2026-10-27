---
name: sdlc-2-architecture
description: Step 2 of the SDLC pipeline. Interviews the user on traffic, monthly active users, cost target and constraints, then produces an architecture and design document as a PDF (AWS infrastructure, backend, Next.js/React Native frontends, database choice, GitHub Actions CI/CD, cost estimate). Use after requirements are captured, or when asked for architecture, design docs, or a cloud cost plan.
---

# Architecture & Design (PDF output)

Input: `docs/requirements/REQUIREMENTS.md` (if missing, run `/sdlc-1-requirements` first or ask the
user for a brief). Output: `docs/architecture/ARCHITECTURE.md` and `ARCHITECTURE.pdf`.

## Step A — Sizing interview (do not skip)
Use AskUserQuestion. Ask only what the requirements do not already answer:
- Expected peak concurrent users, requests/sec, and growth over 12 months
- Monthly active users (MAU) and total registered users
- Monthly infrastructure budget (hard cap vs target) and currency
- Availability target (e.g. 99.5 / 99.9) and acceptable downtime window
- Data volume: records, media/file uploads per month, retention period
- Data residency / compliance (region, audit, PII)
- Read/write ratio, real-time or offline needs, background jobs
- Environments wanted (dev / staging / prod) and who operates it (team size, on-call)
Record every answer and assumption in the document's "Sizing inputs" section.

## Step B — Design
Defaults, overridden by requirements or existing repo conventions (read `CLAUDE.md` first):
- **Cloud:** AWS. Pick the smallest sufficient shape: e.g. ECS Fargate or a single EC2 / Lightsail
  for low traffic, RDS PostgreSQL, S3 + CloudFront, SES/SNS, Secrets Manager, CloudWatch.
  Avoid k8s/managed sprawl for a 2-person team. IaC with Terraform.
- **Backend:** state language/framework, API style, auth, background jobs, module layout.
- **Web:** Next.js (React). **Mobile:** React Native (Expo unless native modules force bare).
- **Database:** choose by access patterns, not habit; justify vs. one alternative. Default
  PostgreSQL; use DynamoDB/Redis/OpenSearch only for a stated need.
- **CI/CD:** GitHub Actions (lint, test, build, scan, deploy to staging, manual-approved prod).
  Use OIDC to AWS, no long-lived keys.
- Cross-cutting: security boundaries (VPC, subnets, SGs, IAM least privilege), observability,
  backups/DR, environments, secrets, cost controls (budgets/alarms).

## Step C — Document contents
1. Summary & decisions table (each decision: choice, alternative rejected, reason)
2. Sizing inputs and assumptions
3. System context + component diagram (Mermaid in the .md; render to image for the PDF)
4. Infrastructure (AWS) with network diagram
5. Backend, frontend (web/mobile), data model outline and DB rationale
6. CI/CD pipeline and environment promotion
7. Security & compliance posture (feeds step 4's checklist)
8. **Monthly cost estimate** by service for dev/staging/prod vs. budget, with the pricing
   assumptions stated and a note that it must be re-checked in the AWS calculator
9. Risks, open questions, delivery phases and rough effort for 2 people
10. **Client sign-off page** (blank: name, date, signature) and the approval checklist

## Step D — Produce PDF
Write the Markdown first, render diagrams, then build the PDF (use the `pdf` skill / a Python or
Node PDF library available in the environment; if the doc needs non-Latin scripts, bundle a font
that supports them). Verify the PDF by converting a page or two to images and looking at them.
Mark the document **DRAFT — pending client approval** on the cover.

## Rules
- Present the PDF path and tell the user that step 3 stays locked until the client approves.
- Do not create `APPROVAL.md` yourself; that is the user's act (see sdlc-3-build).
- Prices change; label every figure an estimate with its date.
