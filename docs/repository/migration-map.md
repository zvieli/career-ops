# Fork migration map

## Canonical implementation moves

| Previous compatibility path | Canonical path | Compatibility retained |
|---|---|---|
| `lib/application-identity.mjs` | `src/agent/domain/applications/application-identity.mjs` | Named exports re-exported |
| `lib/application-state-machine.mjs` | `src/agent/domain/applications/application-state-machine.mjs` | Named exports re-exported |
| `lib/candidate-fit-gate.mjs`, `lib/gpa-scale.mjs`, `lib/cv-tailoring-engine.mjs` | `src/agent/domain/candidate/` | Named exports re-exported |
| `lib/job-evaluator.mjs` | `src/agent/domain/jobs/job-evaluator.mjs` | Named exports re-exported |
| `lib/autonomous-langgraph.mjs` | `src/agent/graph/autonomous-langgraph.mjs` | Named exports re-exported |
| `lib/application-ledger.mjs`, `lib/autonomous-pending-queue.mjs` | `src/agent/infrastructure/persistence/` | Named exports re-exported |
| `lib/llm/provider-runner.mjs`, `lib/zero-cost-router.mjs`, `lib/provider-availability.mjs`, `lib/reasoning-cache.mjs` | `src/agent/infrastructure/model-gateway/` | Named exports re-exported; old runner name aliases PI gateway |
| `lib/notification-router.mjs`, recruiter adapters | `src/agent/infrastructure/communications/` | Named exports re-exported |
| `lib/autofill-engine.mjs`, `lib/latex-patcher.mjs`, `lib/pdf-validator.mjs` | `src/agent/infrastructure/{browser,documents}/` | Named exports re-exported |
| `lib/run-reporter.mjs` | `src/agent/infrastructure/observability/run-reporter.mjs` | Named exports re-exported |
| `scripts/autonomous-langgraph-queue.mjs` | `src/agent/runtime/queue-runner.mjs` | Old command delegates and preserves `--help` |

`autonomous-pipeline.mjs`, updater roots, tracker commands, and the upstream system/user data layout remain in place. The legacy orchestrator remains a production rollback/reference, not a wrapper around LangGraph.

## Test organization

Agent tests are grouped in `tests/agent/{domain,graph,infrastructure,integration,security,recovery}`. Recovery worker fixtures are in `tests/agent/fixtures/`. Existing root-level regression suites remain when they specifically validate legacy/upstream-compatible behavior. `tests/agent/integration/compatibility.test.mjs` compares old-path and canonical export surfaces and exercises the queue CLI help path.

## Documentation authority

Current architecture and policy live in `docs/architecture/`; actionable operations live in `docs/operations/`; decision records live in `docs/decisions/`; repository ownership lives in `docs/repository/`; privacy-safe verification summaries live in `docs/evidence/`. Prior local autonomy dossiers and candidate-specific research remain ignored and untouched; see `docs/archive/README.md`.
