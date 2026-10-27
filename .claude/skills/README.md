# SDLC skill pipeline

Six skills that run in order. Each one reads the previous one's output from `docs/` and writes its own,
so any step can be re-run or resumed in a fresh session.

```
1 requirements ──► 2 architecture (PDF) ──► [client sign-off] ──► 3 build ──► deploy
                                                                      │
                                              4 security ◄────────────┤ (after every staging/prod deploy)
                                              5 qa (load/stress) ◄────┘
6 feature  — for any later change: research → design → explore → implement
```

| Skill | Invoke | Reads | Writes |
|---|---|---|---|
| sdlc-1-requirements | `/sdlc-1-requirements` | your text / images / files | `docs/requirements/REQUIREMENTS.md` |
| sdlc-2-architecture | `/sdlc-2-architecture` | requirements | `docs/architecture/ARCHITECTURE.md` + `.pdf` |
| sdlc-3-build | `/sdlc-3-build` | approved architecture | web / mobile / api / infra code, CI/CD |
| sdlc-4-security | `/sdlc-4-security <env>` | architecture + deployed env | `docs/security/<date>-<env>.md` |
| sdlc-5-qa | `/sdlc-5-qa <env>` | requirements + deployed env | `docs/qa/<date>-<env>.md` |
| sdlc-6-feature | `/sdlc-6-feature <idea>` | everything above + code | `docs/features/<slug>.md` + code |

Hard gates: step 3 will not start without `docs/architecture/APPROVAL.md`; step 5 will not run load
against production without explicit confirmation.
