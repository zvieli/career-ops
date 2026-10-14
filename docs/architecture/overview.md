# Product architecture

## Status

LangGraph adoption is **staged**. Production readiness is **NO**. `autonomous-pipeline.mjs` remains the legacy production rollback/reference implementation.

**Migrated to the manually invoked LangGraph path:** hydration, evaluation, candidate fit, CV tailoring, PDF validation, and the graph-only `PRE_SUBMIT_REVIEW` / ATS preparation-review interrupts.

**Not yet migrated:** production/live ATS form extraction, live Telegram delivery, live recruiter-mailbox integration, and scheduler cutover. The queue runner is not wired to systemd, a timer, or an unattended schedule.

## Runtime layers

```text
Career Ops CLI / legacy scripts
        │
        ├── stable root contracts (path resolver, tracker, liveness, providers)
        │
        └── src/agent/runtime/queue-runner.mjs
                  │
                  ├── src/agent/graph/          LangGraph orchestration/checkpoints
                  ├── src/agent/domain/         application state, candidate fit, evaluation
                  └── src/agent/infrastructure/ persistence, PI gateway, docs, browser, communications
```

Root files and existing `lib/`/`scripts/` entrypoints remain compatibility surfaces. The implementation is canonical only under `src/agent/`; the old module paths are thin re-exports or command delegators.

## Authority boundaries

- The application state machine owns lifecycle state and permitted transitions.
- The application ledger records events/artifact references; it does not replace canonical state.
- LangGraph checkpoints own resumable orchestration progress only. They cannot override a conflicting canonical identity, state, or ledger event.
- The pending queue is durable work intake, not application state.
- The model gateway accepts exact logical model IDs from the allowlist and delegates every model call through PI.
- Human review remains mandatory. The graph follows `SHORTLISTED → CV_GENERATED → CV_VALIDATED`, then pauses at graph-only `PRE_SUBMIT_REVIEW`. Only explicit `PREPARE_APPLICATION` authorization advances through `ATS_DETECT → FORM_SCHEMA_EXTRACT → FIELD_MAP → APPLICATION_PREPARED → ATS_PREPARATION_REVIEW`; the canonical lifecycle advances to existing `READY_TO_FILL` only for a recognized provider. Both review interrupts are graph orchestration, not canonical states. ATS preparation is read-only: it never fills, uploads, submits, contacts employers, or handles CAPTCHAs. Greenhouse and Lever have controlled HTML fixtures and deterministic fixture parsers, but there are currently no production live-form adapters; recognized live hosts therefore produce a review blocker rather than claimed support. CV changes remain reorder-only, source-fact-gated, and immutable; PDF quality requires exactly one page and more than 1,000 extracted characters.

See [state ownership](state-ownership.md), [model gateway](model-gateway.md), and [security boundaries](security-boundaries.md).

## Product readiness gates

The graph remains non-production until parity, crash/recovery, state/ledger consistency, candidate-fact, security, observability, and explicit human-approval gates are independently demonstrated. No timer is enabled as part of this migration. Operational status and safe test commands are in [the runbook](../operations/langgraph-runbook.md).
