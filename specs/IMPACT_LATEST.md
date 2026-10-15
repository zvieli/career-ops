## Target
`decideAndResumeHumanReview()`, `HumanReviewTaskStore.create()/markStale()/getDecisionReceipt()`, the LangGraph interrupt payloads, and `operator.mjs` review commands.

## Dependents (4)
- `src/agent/graph/autonomous-langgraph.mjs`: materializes tasks before four graph interrupt types; node-level decision and crash-recovery checks.
- `src/agent/runtime/human-review-resume-bridge.mjs`: only production caller from operator; owns exact task/receipt/canonical/checkpoint binding.
- `operator.mjs`: local graph decisions and checkpoint lifecycle; add explicit reconcile command.
- `src/agent/read-models/operator-read-models.mjs`: exposes active review status affected by stale/reconstructed tasks.

## Affected Stories
- No `specs/release-plan.yaml` or epic capsule directory exists in this checkout; user-specified v0.8 closure matrix is the acceptance contract.

## Test Coverage
- `tests/agent/runtime/human-review-resume-bridge.test.mjs`: ordinary decision path, stale evidence, concurrency, receipt replay.
- `tests/agent/graph/autonomous-langgraph.test.mjs`: actual graph interrupt/checkpoint lifecycle and candidate-fit resume.
- `tests/human-review-task-store.test.mjs`: deterministic task identity, generations, receipt, stale-status behavior, notification-intent repair.
- `tests/operator-cli.test.mjs`: subprocess CLI workflows.
- Added `tests/agent/runtime/human-review-reconciliation.test.mjs` for orphan restoration/replay, stale and changed tasks, receipt resume/idempotency, ambiguity, unknown types, canonical/thread/application mismatch, strict descriptor validation, legacy evidence/generation, checkpoint identity drift, and notification repair.

## Risk: High
This changes a shared durable workflow boundary involving graph checkpoints, immutable task/receipt storage, canonical state, and side-effect-safe resume semantics.

## Closure
Implemented the scoped reconciliation path and `node operator.mjs reviews reconcile [application-id]`. The implementation restores only typed or hash-verified legacy evidence, retains receipt/history safeguards, and fails closed on ambiguity or binding drift. Final validation and independent read-only review are recorded in the task handoff.
