---
name: sdlc-1-requirements
description: Step 1 of the SDLC pipeline. Gathers and consolidates project requirements from text, screenshots, wireframes, PDFs and docs into one structured requirements document, flags gaps, and prepares the input for the architecture step. Use when starting a new project or when the user shares project outlines, briefs, or client material.
---

# Requirements

Goal: turn scattered input into a single, reviewable `docs/requirements/REQUIREMENTS.md` that the
architecture step can consume without further guessing.

## Process

1. **Collect.** Read everything the user provides: pasted text, files, and images (open images with
   Read and describe what they show — screens, flows, ER sketches, whiteboards). Also read existing
   `CLAUDE.md`, README and `docs/` if the repo already has content. Ask for any attachment that is
   mentioned but missing.
2. **Extract**, tagging each item with its source (e.g. `[brief.pdf p3]`, `[img: login.png]`):
   - Vision, problem statement, target users and roles
   - Functional requirements, as numbered IDs (`FR-001`...) with priority (MUST/SHOULD/COULD)
   - Non-functional requirements (`NFR-001`...): performance, availability, security/compliance,
     data residency, accessibility, languages, offline needs, device/browser support
   - Integrations (payments, SMS, maps, SSO, third-party APIs)
   - Platforms: web, mobile (Android/iOS), admin panel
   - Constraints: budget, deadline, team (2 people), existing systems, mandated tech
   - Assumptions made, and out-of-scope items
3. **Find gaps.** List contradictions and missing information as `OQ-001`... open questions, each
   with why it matters and a proposed default. Ask the user the blocking ones with AskUserQuestion
   (max 4 per call, grouped by theme); record the rest as open.
4. **Write** `docs/requirements/REQUIREMENTS.md` using the structure above plus a glossary and a
   "Hand-off to architecture" section: expected scale hints, hardest requirements, and open
   questions that the architecture step must still ask (traffic, MAU, monthly budget).
5. Show a short summary and ask the user to confirm or correct. Do not invent requirements; mark
   inferred items `(inferred)`.

## Rules
- Preserve the user's wording for anything contractual; paraphrase only in summaries.
- Never silently drop an input. Anything unused goes under "Unclassified input".
- Next step: tell the user to run `/sdlc-2-architecture`.
