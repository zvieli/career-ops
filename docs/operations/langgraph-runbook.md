# LangGraph operations and readiness

## Readiness

**Production readiness: NO.** LangGraph remains a staged, manually exercised path. `autonomous-pipeline.mjs` remains the legacy production rollback/reference. The systemd timer is not installed or enabled by this migration; do not enable scheduling or connect the graph runner to a timer.

This runbook documents safe inspection and verification only. A live queue evaluation requires a separate explicit user request and must still pass onboarding, employer/liveness, candidate-fact, and human-review gates.

## Safe checks

```bash
node scripts/autonomous-langgraph-queue.mjs --help
node test-all.mjs --only agent/
node test-all.mjs --only autonomous-
node validate-system-paths-coverage.mjs
npm run lint
```

The focused `--only` selectors run matching suites only; they do not replace the full gate. Before declaring a release candidate, run `node test-all.mjs` and the updater/upgrade checks listed in CI.

## Staged CV/PDF review flow

For a passing shortlist, the existing graph now performs `SHORTLISTED → CV_GENERATED → CV_VALIDATED`, then interrupts at graph-only `PRE_SUBMIT_REVIEW`. The canonical state at that interrupt is `CV_VALIDATED`; `PRE_SUBMIT_REVIEW` is not a lifecycle state. The graph has no submit capability. The queue item remains pending. Resume with `STOP` or `CONTINUE_MANUALLY` only.

CV tailoring is deterministic and reorder-only: it may rank existing LaTeX bullets against the archived JD, but cannot insert JD wording, rewrite the headline/summary, or add skills. Both generated LaTeX and extracted PDF text pass the source-backed `verify-cv-facts.mjs` gate against the data-root CV sources. The PDF path uses generic compile, page-count, extractability, and source-fact checks; the legacy hard-coded GPA/institution/company/date checks are not applied to this graph path. Unsupported claims block validation; coverage/advisory findings and a missing optional `config/cv-facts.json` are surfaced as compact warnings in the review receipt. Artifact references and SHA-256 hashes are immutable, application-scoped, and reconciled with canonical state and ledger receipts on recovery. Raw CV/JD content is not stored in graph checkpoints.

A failed or interrupted validation does not advance to `CV_VALIDATED` or acknowledge the queue. If a process stops after a canonical transition but before a graph checkpoint/event, resume only after checkpoint, source hashes, artifact-store hashes, and ledger receipts reconcile. A pre-feature checkpoint already paused at `PRE_SUBMIT_REVIEW` with only `SHORTLISTED` state is rejected fail-closed; it cannot be resumed as validated. Do not edit or delete checkpoint SQLite state by hand. Keep that checkpoint for audit and require an explicit, separately reviewed migration/restart procedure before continuing that application.

## Recovery rules

1. Do not edit checkpoint SQLite state by hand.
2. Treat canonical application state and ledger events as authority; checkpoints are resumable orchestration only.
3. A mismatched application identity, URL, present JD hash, CV fingerprint, source hash, or artifact receipt blocks retry before evaluation or state mutation.
4. A missing checkpoint, conflicting hash, inconsistent ledger, or corrupt durable queue stops for review; do not infer a successful application from a graph checkpoint.
5. Never acknowledge a queued item as complete before the normal verified completion path records its canonical result.

## Scheduling and external effects

No systemd timer or cron job is enabled. Do not submit applications, send recruiter messages, or enable recurring execution. The queue command's old path remains for compatibility; use `--help` for its current argument contract.
