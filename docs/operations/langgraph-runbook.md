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

## Recovery rules

1. Do not edit checkpoint SQLite state by hand.
2. Treat canonical application state and ledger events as authority; checkpoints are resumable orchestration only.
3. A mismatched application identity, URL, or present JD hash blocks retry before evaluation or state mutation.
4. A missing checkpoint, conflicting hash, inconsistent ledger, or corrupt durable queue stops for review; do not infer a successful application from a graph checkpoint.
5. Never acknowledge a queued item as complete before the normal verified completion path records its canonical result.

## Scheduling and external effects

No systemd timer or cron job is enabled. Do not submit applications, send recruiter messages, or enable recurring execution. The queue command's old path remains for compatibility; use `--help` for its current argument contract.
