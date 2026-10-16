# Telegram Human Control Plane Runbook (v1.1)

## Overview

The Telegram Human Control Plane provides a thin, authenticated, human-in-the-loop interface for career-ops. It enables human operators to review application evaluation checkpoints, make binding decisions via inline buttons, and explicitly confirm manual submissions from their Telegram client.

**Core Governance Principle:**
Telegram is an **adapter only**, never the source of truth or lifecycle authority. Application state machine transitions, the append-only `ApplicationLedger`, immutable `ApplicationArtifactStore`, `HumanReviewTaskStore`, and `HumanDecisionReceipt` remain canonical.

---

## 1. Setup & Configuration

### Prerequisites
1. Telegram account.
2. Bot created via `@BotFather`.
3. Candidate's numeric Telegram User ID.

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Token provided by BotFather (format `123456789:ABCdef...`). |
| `TELEGRAM_ALLOWED_USER_ID` | Yes | Numeric user ID of the authorized human operator. Wildcards are strictly forbidden. |
| `TELEGRAM_ALLOWED_CHAT_ID` | Optional | Numeric chat ID if restricted to a specific DM/chat. |

Credentials can be supplied via process environment or the local secrets file at `~/.config/career-ops/secrets.env` (or path in `CAREER_OPS_SECRETS_FILE`).

Secrets are never logged, never committed to git, and never included in error strings or receipts.

### Obtaining User ID Safely
1. In Telegram, start `@userinfobot` or forward a message to `@userinfobot`.
2. It returns your exact numeric `Id` (e.g. `987654321`).
3. Set `TELEGRAM_ALLOWED_USER_ID="987654321"`.

---

## 2. Operator Commands

Commands can be invoked either via `node operator.mjs telegram <command>` or `node telegram.mjs <command>`:

### Status
Check bot configuration, authorized user binding, last update offset, and queue status without revealing secrets:
```bash
node operator.mjs telegram status
# or
node telegram.mjs status
```

### Connection Test
Send an explicit ping to the authorized user:
```bash
node operator.mjs telegram test
# or
node telegram.mjs test
```

### List Pending Reviews
List review tasks awaiting human response:
```bash
node operator.mjs telegram pending
# or
node telegram.mjs pending
```

### Resend / Update Review Notification
Re-send or edit an existing Telegram review notification for a review task:
```bash
node operator.mjs telegram resend <review-task-id>
```

### Ingest Updates (Long Polling)
Polling is strictly operator-controlled and does not run as a hidden background daemon.

**Process available updates once:**
```bash
node operator.mjs telegram poll --once
```

**Continuous long polling:**
```bash
node operator.mjs telegram poll
# or
node telegram.mjs poll
```
Press `Ctrl+C` to gracefully terminate polling.

---

## 3. Security Model

### Authentication & Authorization
- **Fail Closed:** If `TELEGRAM_BOT_TOKEN` or `TELEGRAM_ALLOWED_USER_ID` is missing, all Telegram ingress/egress is blocked.
- **No Wildcard Authorization:** Any configuration containing `*`, `0`, or `all` is immediately rejected.
- **Strict Sender Verification:** Every incoming update is checked against `TELEGRAM_ALLOWED_USER_ID`. Updates from any other user are rejected with an authorization error.

### Opaque Callback Tokens
- Telegram inline button payloads (`callback_data`) have a strict 64-byte limit.
- Inline buttons contain **zero candidate facts, zero state, and zero CV text**.
- Each button references a short opaque token (e.g. `cb_7a3f89b1c2d3...`) durably persisted in `data/telegram/callback-tokens.jsonl`.
- Tokens bind:
  - `review_task_id`
  - `application_id`
  - `decision`
  - `expected_evidence_hash`
  - `expected_canonical_state`
  - `expected_canonical_version`

### Tamper & Replay Protection
- **Forged Callbacks:** Unknown tokens are rejected.
- **Cross-Application Protection:** Callbacks bound to application A cannot mutate application B.
- **Stale Evidence / State Changes:** If canonical state or evidence has advanced, old callbacks are rejected.
- **Conflicting Decisions:** If a review task was already decided, subsequent conflicting decisions are rejected.
- **Duplicate Protection:** Replayed clicks return an idempotent confirmation without duplicating decision receipts or state transitions.

### Prompt Injection Fencing
- External job postings and incoming chat messages are treated strictly as untrusted data, never instructions.
- Chat text cannot execute shell commands, eval JavaScript, or mutate application lifecycle directly.

---

## 4. Human Decision Mapping

| Review Stage | Allowed Decisions | Next Step |
|---|---|---|
| `PRE_SUBMIT_REVIEW` | `PREPARE_APPLICATION`<br>`CONTINUE_MANUALLY`<br>`STOP` | If `PREPARE_APPLICATION`: inspect ATS schema read-only.<br>If `CONTINUE_MANUALLY` or `STOP`: pause automation. |
| `ATS_PREPARATION_REVIEW` | `FILL_APPLICATION`<br>`CONTINUE_MANUALLY`<br>`STOP` | If `FILL_APPLICATION`: execute safe fixture fill.<br>If `CONTINUE_MANUALLY`: human applies manually. |
| `FINAL_HUMAN_REVIEW` | `CONTINUE_MANUALLY`<br>`EDIT_REQUIRED`<br>`REFILL_REQUIRED`<br>`STOP` | `CONTINUE_MANUALLY` halts automation for external manual human submission. |

### Manual Submission Confirmation
Automation **never** clicks the final apply/submit button on employer sites. When manual submission is completed by the human:
1. In Telegram, the authorized human sends:
   ```
   /confirm_submission app-<24hex>
   ```
2. The Telegram control adapter verifies the application state, records a human assertion via `confirmManualSubmission()`, and emits `APPLICATION_SUBMITTED_CONFIRMED`.
3. The tracking timeline and read-models update to `APPLIED_CONFIRMED`.

---

## 5. Recovery & Reconciliation

- If the service restarts during a paused human review:
  1. The review task remains durably saved in `data/human-review/events.jsonl`.
  2. The checkpointer holds execution state at the interrupt boundary.
  3. Running `node operator.mjs reviews reconcile` or polling Telegram reconciles state.
  4. Redelivery checks `data/telegram/deliveries.jsonl` to ensure messages are edited rather than spammed.
  5. When the user clicks an inline button, `HumanDecisionReceipt` is persisted and the graph resumes cleanly.

---

## 6. Known Limitations & Non-Negotiable Boundaries

- **No Autonomous Submission:** Automation never submits an application.
- **No CAPTCHA / Login Bypass:** The bot never solves CAPTCHAs or bypasses authenticated walls.
- **No Recruiter Messaging:** No automated outbound messages to recruiters or employers.
- **Telegram is Not Storage of Record:** If Telegram history is cleared, all state and decision receipts remain intact on disk.
