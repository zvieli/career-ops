# Scheduler shadow kernel

The scheduler is opt-in and has no import-time or CLI-start side effects. Importing `src/agent/runtime/scheduler.mjs` installs no timer. `node operator.mjs scheduler enable` writes a private, bounded configuration; it does **not** install cron/systemd/launchd, spawn a daemon, or start background work. `disable` only changes configuration.

## Current v0.9 boundary

The scheduler is a local coordination kernel, not an autonomous job-search pipeline. `run-once` acquires one local lease, writes a run receipt, and invokes only the operator's no-op shadow callback (`SHADOW_KERNEL_ONLY`). It does not discover or fetch jobs, call providers, start LangGraph, mutate application/review/notification stores, fill forms, submit applications, or contact employers. The generic injected callback API is for trusted in-process integration and is not a sandbox; no production callback is wired.

Run mode is `SHADOW_SCHEDULED`; manual operator commands remain separate. Only explicitly classified read-only or local durable operations may be allowed by `shadow-policy.mjs`; external operations are blocked and return a decision receipt. The policy module is not a substitute for a human decision receipt.

## Configuration and commands

Configuration is `data/scheduler-config.json`; absent config means disabled. The only supported enabled mode is `shadow`. Cadence is bounded from 60 minutes to 7 days, runtime to 30 minutes, and jobs to 100. Unknown keys/modes and invalid values fail closed. The operator writes configuration atomically with private permissions.

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

`enable` means configuration enabled only. A human may later invoke `run-once`; it does not create an OS schedule.

## Leases, receipts, and recovery

A lease is stored under `data/scheduler/` with a hashed scheduler ID and private permissions. A process-scoped lock serializes acquisition and updates. One active lease is allowed per scheduler ID. Heartbeats cannot move backward or revive an expired lease. A stale lease is reclaimed only after expiry and only when its recorded local process is demonstrably gone; unknown owners fail closed. Wall-clock rollback therefore delays takeover rather than stealing a lease. Future/corrupt timestamps are not trusted. Coordination is limited to processes sharing a local filesystem; it is not distributed exactly-once coordination. A crash while holding a `.reap` recovery guard can leave recovery blocked; inspect the recorded lock owner, verify no writer is active, then remove only the stale lock/recovery-guard pair manually. Never remove a lock based on age alone.

Run receipts are append-only JSONL in `data/runs/agent-runs.jsonl`. Records are bounded, validated, private, and lifecycle transitions are checked. Corrupt or incomplete records fail closed. No destructive cleanup is performed; operators should monitor file growth and archive only with an independently reviewed procedure. Current receipts do not include provider or application-stage metrics because those workers are not wired to the shadow kernel.

If the process crashes after lease acquisition, the next run does not replay arbitrary in-memory work. It records/reclaims only after lease expiry and process-death checks; archived expired leases are reconciled against nonterminal receipts on later invocations. Readiness distinguishes archived stale leases from active-but-expired leases pending recovery. Application stores and LangGraph checkpoints remain authoritative and are not changed by the current scheduler callback. A failed/corrupt run receipt requires operator investigation; do not edit canonical application data to repair scheduler metadata.

## Retry and capacity policy

`operational-budgets.mjs` provides deterministic bounded policies for trusted future integrations: finite per-run limits, bounded retry/backoff (including `Retry-After`), per-run provider suppression after consecutive failures, bounded concurrency, and explicit queue admission outcomes. These helpers are not yet wired into scanner/provider/queue-runner behavior; existing provider policies remain in force. No anti-bot or authentication bypass is provided.

## Safety and v1.0 gates

Submission capability: **NO**. Live fill support: **NO**. Employer contact: **NO**. Production readiness: **NO**. The scheduler imports no graph, browser controller, fill, submission, messaging, or calendar execution module. Human decisions—including application preparation/fill, submission confirmation, facts, and interview acceptance—remain explicit human actions.

`maxRuntimeMs` bounds the lease duration; it does not forcibly terminate an injected callback. The current CLI callback is a no-op, but generic callback injection is trusted in-process code, not a sandbox. Provider/runtime budgets, retries, cancellation, and signal handling are not wired into execution.

Before any future scheduler integration executes discovery/evaluation, require a separately reviewed change that narrows callback capabilities, shares application-level locks with operator decisions, binds review/notification idempotency, integrates provider/runtime budgets, supplies truthful stage metrics, adds cancellation and signal handling, and proves external mutation is structurally unreachable. Review crash/replay and multi-process behavior on the target filesystem before enabling an OS timer. v1.0 acceptance must separately review each external capability; this document is not production authorization.
