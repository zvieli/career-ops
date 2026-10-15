# Durable human review tasks (v0.8 groundwork)

`HumanReviewTaskStore` stores graph-checkpoint reviews as append-only JSONL events in `data/human-review/events.jsonl` (private directory/file permissions). The LangGraph pre-submit, ATS-preparation, and final-human-review interrupt nodes persist a task before yielding the interrupt. Task identity is deterministic over application, workflow checkpoint, and canonicalized evidence hash. Replaying identical evidence returns the existing task; materially changed evidence supersedes an open task.

Decision receipts are immutable append-only records. The store validates application binding, task status, type-specific allowlist, expected canonical state, and exact evidence hash under the same local file lock. Exact decision replay returns the original receipt; conflicting decisions fail closed. Comments are stored as bounded plain text and never interpreted. Sensitive-key evidence is rejected. Inbox summaries expose only application identity, company/role, review reason, allowed decisions, field count and a short evidence-hash prefix.

Creating a task also persists a local `PENDING` notification item to `data/notifications/human-review-outbox.jsonl` before any delivery. This is a local outbox record only; it does not send email, push, or network notifications. No retry scheduler is enabled.

## Current boundary

This is the durable task/receipt foundation, not yet a complete operator control plane. It does not expose a CLI/HTTP decision endpoint or reconcile orphaned graph interrupts. Existing LangGraph `Command(resume)` remains the only graph-resume interface. When that exact interrupt resumes, the graph node validates the structured decision and records an evidence-bound receipt before taking its next edge; a receipt alone is not a graph resume command. A future operator interface must use the existing graph API and verify the deterministic thread/application binding.

The store does not submit applications, contact employers, reply to recruiters, schedule interviews, enable live-fill, or activate a scheduler. `FORM_FILLED` is not evidence of submission. Explicit manual-submission confirmation remains a separate ledger event and must be initiated by a human.
