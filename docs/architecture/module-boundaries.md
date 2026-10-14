# Module boundaries

## `src/agent/`

| Area | Responsibility |
|---|---|
| `domain/applications/` | Stable application identity and canonical lifecycle state machine |
| `domain/candidate/` | Candidate-fit gates, explicit GPA-scale interpretation, deterministic CV tailoring inputs |
| `domain/jobs/` | Job evaluation and evidence validation; calls an injected model runner |
| `graph/` | LangGraph nodes, interrupts, checkpoint persistence and checkpoint/domain reconciliation |
| `infrastructure/persistence/` | Application event/artifact ledger and durable pending queue |
| `infrastructure/model-gateway/` | Exact zero-cost inventory, PI-backed model gateway, availability and reasoning cache |
| `infrastructure/communications/` | Notification routing and recruiter mailbox ingestion adapters |
| `infrastructure/browser/` | Safe form-fill planning/simulation; no submit action |
| `infrastructure/documents/` | LaTeX patching and rendered-PDF validation |
| `infrastructure/observability/` | Redacted run receipts and summaries |
| `runtime/` | Queue command composition and dependency wiring |

## Root compatibility contracts

Existing root commands and shared Career Ops modules remain at their stable paths. New agent code may depend on root contracts such as `path-resolver.mjs`, `pipeline-lock.mjs`, liveness APIs, tracker utilities, and provider modules. Keep those imports explicit; do not duplicate their behavior under `src/agent/`.

The listed legacy autonomy `lib/` paths are compatibility re-exports and must not acquire new business logic. Other upstream `lib/` modules retain their existing contracts. `scripts/autonomous-langgraph-queue.mjs` delegates to the canonical runtime module and preserves the old command path. The legacy `autonomous-pipeline.mjs` remains a full rollback/reference orchestrator until parity gates authorize a separate transition.
