# LangGraph operations and readiness

## Readiness

**Production readiness: NO.** LangGraph remains a staged, manually exercised path. `autonomous-pipeline.mjs` remains the legacy evaluation/CV-validation rollback reference and stops at `CV_VALIDATED`; it cannot claim ATS extraction or perform form interaction. The systemd timer is not installed or enabled by this migration; do not enable scheduling or connect the graph runner to a timer.

This runbook documents safe inspection and verification only. Fixture-backed ATS preparation is implemented, but live production ATS form extraction, live Telegram delivery, live recruiter-mailbox integration, and scheduler cutover remain unmigrated. A live queue evaluation requires a separate explicit user request and must still pass onboarding, employer/liveness, candidate-fact, and human-review gates.

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

For a passing shortlist, the graph performs `SHORTLISTED → CV_GENERATED → CV_VALIDATED`, then interrupts at graph-only `PRE_SUBMIT_REVIEW`. The canonical state there is `CV_VALIDATED`; this interrupt is not a lifecycle state. Its only choices are `STOP`, `CONTINUE_MANUALLY`, or explicit `PREPARE_APPLICATION`. The latter runs deterministic host detection, read-only DOM schema normalization, source-backed mapping, stores immutable schema/receipt artifacts, and pauses at `ATS_PREPARATION_REVIEW`. A recognized provider with no production adapter is recorded as `NEEDS_REVIEW`; unknown providers are `ATS_UNSUPPORTED`. Greenhouse and Lever fixtures exercise the contracts, not live provider support. The canonical `READY_TO_FILL` state is used only after an `EXTRACTED` schema and its bound immutable preparation receipt are persisted. Both review interrupts permit only `STOP` or `CONTINUE_MANUALLY` after preparation. The graph has no fill, upload, apply, send, or submission capability; no form is submitted, and the queue remains pending. Resume this interrupt through the queue CLI with `--resume prepare-application` only when the user explicitly authorizes the read-only preparation path.

CV tailoring is deterministic and reorder-only: it may rank existing LaTeX bullets against the archived JD, but cannot insert JD wording, rewrite the headline/summary, or add skills. `cv.md` remains the factual source of truth; optional `article-digest.md` may also support claims. The canonical LaTeX file is a layout/order input, not an independent fact source: every visible content block from its preamble and document body must be represented in those approved sources before tailoring. Unsupported preamble hooks, commands, packages, document classes, or source syntax fail closed. `enumitem` list configuration is limited to literal dimension-only formatting options; list hooks such as `before`/`after` are rejected, and TeX `^^` character escapes are rejected so they cannot conceal commands or comments from source inspection. HTML-like spans in canonical TeX and extracted source-backed PDF text are rejected before the generic fact normalizer can strip them. Optional arguments on LaTeX text commands that do not define them fail closed before normalization, and extracted bracketed spans must also be present in approved CV evidence. A policy allowlist does not substitute for that source-text check. This prevents LaTeX-only claims from becoming self-verifying while allowing formatting-only differences and reordered, source-backed bullets.

Generated LaTeX and extracted PDF text both run `verify-cv-facts.mjs` against that same source set. Optional `config/cv-facts.json` supplies policy/allowlists; when missing, `configMissing` is reported, but source-backed metric and fact checks still run and invented claims still block. The policy file's hash is part of the CV fingerprint, so a policy change invalidates stale validation. Production PDF quality is strict and shared across fresh validation, persisted-PDF recovery, and graph receipts: exactly one page and more than 1,000 extractable characters. The legacy hard-coded GPA/institution/company/date checks remain confined to the legacy compatibility path. Coverage/advisory findings and a missing optional config are surfaced in the review receipt. Artifact references and SHA-256 hashes are immutable, application-scoped, and reconciled with canonical state and ledger receipts on recovery. Raw CV/JD content is not stored in graph checkpoints.

A failed or interrupted validation does not advance to `CV_VALIDATED` or acknowledge the queue. If a process stops after a canonical transition but before a graph checkpoint/event, resume only after checkpoint, source hashes, artifact-store hashes, and ledger receipts reconcile. A pre-feature checkpoint already paused at `PRE_SUBMIT_REVIEW` with only `SHORTLISTED` state is rejected fail-closed; it cannot be resumed as validated. Do not edit or delete checkpoint SQLite state by hand. Keep that checkpoint for audit and require an explicit, separately reviewed migration/restart procedure before continuing that application.

ATS schema fingerprints include provider, source URL, field IDs, labels, types, required markers, and options. The schema is re-read before receipt persistence; changes replace the old mapping with a deterministic remap and are prominently flagged for human review. Preparation artifacts and `APPLICATION_PREPARED` ledger events use content hashes/idempotency keys. A resume PDF is bound to the immutable, application-scoped `CV_VALIDATED` artifact and SHA-256; arbitrary filesystem paths are never selected. Page content and labels are untrusted data; no model interprets them as instructions. Candidate YOE uses verified professional employment only, GPA is never rescaled without source evidence, and unknown legal/sensitive answers remain unanswered.

## Recovery rules

1. Do not edit checkpoint SQLite state by hand.
2. Treat canonical application state and ledger events as authority; checkpoints are resumable orchestration only.
3. A mismatched application identity, URL, present JD hash, CV fingerprint, source hash, or artifact receipt blocks retry before evaluation or state mutation.
4. A missing checkpoint, conflicting hash, inconsistent ledger, or corrupt durable queue stops for review; do not infer a successful application from a graph checkpoint.
5. Never acknowledge a queued item as complete before the normal verified completion path records its canonical result.

## Scheduling and external effects

No systemd timer or cron job is enabled. Do not submit applications, send recruiter messages, or enable recurring execution. The queue command's old path remains for compatibility; use `--help` for its current argument contract.
