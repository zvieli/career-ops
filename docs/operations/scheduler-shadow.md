# Scheduled shadow pipeline

The scheduler is opt-in and one-shot. Importing `src/agent/runtime/scheduler.mjs` starts no timer. `node operator.mjs scheduler enable` writes private configuration only; it does **not** install cron/systemd/launchd or start a daemon. Invoke `run-once` manually or from an externally managed scheduler.

## v0.9 execution boundary

`run-once` uses a project-owned executor; production callers cannot supply an execution callback. The bounded pipeline:

1. Reads `portals.yml` and uses only the Greenhouse and Lever public ATS providers. Provider HTTP is GET-only, redirects are refused by default, the provider DNS/IP guard remains active, and response bodies are capped. Unsupported providers and configured filter policies the scheduled path cannot enforce fail closed.
2. Applies the standard title/location and blacklist checks, then exact within-run posting dedup. The canonical application-identity registry provides exact cross-run identity reuse; broader scan-history/company-role recheck heuristics are not run. Repeated exact postings reuse canonical review tasks. It caps admitted jobs/providers, concurrency, retries, request time, response bytes, and total runtime. Eligible postings above the run's job cap are counted as `capacity_skipped_rediscoverable`; they are not written to a durable deferred queue and may only be seen again if a later provider scan rediscovers them. Provider sources and liveness calls skipped by request/failure budgets have separate counters.
3. Hydrates from provider-supplied listing text and checks liveness only through the supported ATS API. No browser, model, unrestricted fallback, or LangGraph execution is reachable. Expired postings are skipped; incomplete text or uncertain liveness is kept for human review, never treated as confirmed active.
4. Uses the canonical application identity/state/event stores and creates idempotent local `CANDIDATE_FIT_REVIEW` tasks plus local notification intents. The scheduled evaluator is intentionally conservative: without validated extraction it returns `NEEDS_REVIEW`; it does not manufacture a fit score or shortlist. The `LOCAL_REVIEW_RECONCILIATION` stage repairs/reuses only the current run's local review tasks and notification intents. It does not inspect or resume LangGraph interrupts. The v0.8 orphan-interrupt reconciliation remains an explicit operator workflow (`node operator.mjs reviews reconcile`), never part of scheduled execution.
5. Records durable receipts when a stored human decision requests a blocked action. Scheduled execution never creates or chooses human decisions, resumes a graph, delivers notifications, or invokes an action.

`maxRuntimeMs` is enforced with cooperative cancellation and provider signals; it is not hard process termination. Lease ownership loss fails closed. An uncooperative in-process operation cannot be forcibly killed, so only the trusted project-owned executor is used in production.

## Configuration and commands

Configuration lives in `data/scheduler-config.json`; absent config means disabled. The only mode is `shadow`. Cadence is validated from 60 minutes to 7 days (it does not itself schedule work), runtime is at most 30 minutes, and jobs are capped at 100. Unknown keys/modes and invalid values fail closed.

```sh
node operator.mjs scheduler status
node operator.mjs scheduler run-once
node operator.mjs scheduler enable
node operator.mjs scheduler disable
node operator.mjs runs list
node operator.mjs runs show <run-id>
node operator.mjs system health
node operator.mjs system readiness
```

## Leases, run receipts, and metrics

Leases are stored under `data/scheduler/`; run receipts are append-only in `data/runs/agent-runs.jsonl`. Acquisition/update locks serialize local processes. Takeover requires expiry and demonstrable death of the recorded local owner; unknown owners fail closed. Wall-clock rollback delays takeover rather than stealing a lease. This is local-filesystem coordination, not distributed exactly-once execution.

Each executed stage records measured counters and timings. `provider_attempts` counts actual outbound provider HTTP requests (the guarded request hook); `provider_operations` counts bounded provider-operation attempts, including retries; `provider_failures` counts failed bounded operation attempts. Readiness computes `provider_failure_rate` as `provider_failures / provider_operations` and reports HTTP request and operation counts separately. Capacity skips are explicitly rediscoverable, not durably queued. Missing metrics are reported as unavailable, not fabricated zeros. The run lifecycle may be `COMPLETED` while its separate `outcome` is `DEGRADED`; warning-bearing or partial runs are not counted as successful by readiness.

On a crash, no arbitrary in-memory work is replayed. Later invocations reconcile expired run receipts after lease checks. Corrupt stores fail closed and require operator investigation; do not hand-edit canonical application data to repair scheduler metadata.

## Safety boundary and readiness

`REAL_APPLICATIONS_SUBMITTED: 0`. Submission capability: **NO**. Live fill support: **NO** (the legacy web fill/drive endpoints are disabled and fixture fill is isolated). Employer/recruiter contact: **NO**. Calendar acceptance: **NO**. Automatic graph resumption: **NO**. Autonomous production readiness: **NO**. These are structural boundaries, not scheduler configuration options. Human decisions remain explicit and cannot cause the shadow run to fill, submit, contact, accept, or resume work. The repository-wide capability statement is [the capability matrix](../architecture/capability-matrix.md).

Only add provider capabilities, filters, evaluation, or external actions through a separately reviewed change with structural reachability tests, failure/replay tests, and an independent review. This document is not production authorization.
