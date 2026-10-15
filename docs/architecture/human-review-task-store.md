# Durable human control plane (v0.8)

`HumanReviewTaskStore` persists review tasks and immutable decision receipts in append-only JSONL at `data/human-review/events.jsonl` with private file/directory permissions. LangGraph candidate-fit, pre-submit, ATS-preparation and final-review interrupts persist a task before yielding. Task identity is deterministic over application, workflow checkpoint and canonicalized evidence hash. Identical evidence reuses the task; changed evidence supersedes an open task. Decisions validate application, allowlist, canonical state/version and evidence hash under a local lock. Comments are bounded inert text; sensitive evidence keys are rejected.

The operator CLI is read-only unless a specific action is named:

```sh
node operator.mjs reviews list
node operator.mjs reviews show <review-task-id>
node operator.mjs reviews decide <review-task-id> <allowed-decision>
node operator.mjs applications list|show|timeline <application-id>
node operator.mjs notifications list|deliver|retry|cancel <notification-id>|reconcile
node operator.mjs facts list|provide <request-id>
node operator.mjs applications confirm-submission <application-id>
```

Graph decisions first persist a receipt, then inspect and resume only the matching application-scoped thread and interrupt carrying the same task/evidence binding. A per-application local lock serializes operator decisions. A checkpoint marker prevents replaying the decision command after a lost response. If a downstream graph node remains pending, the operator continues from the checkpoint without resending the decision; if the checkpoint is paused at a later interrupt, that task remains for its own decision. If a process dies before checkpoint persistence, recovery relies on the graph's existing node-level idempotency/receipt checks; this is **not a distributed exactly-once guarantee**. Uncertain or mismatched states fail closed for reconciliation.

Review creation writes a local notification intent to `data/notifications/human-review-outbox.jsonl`. Delivery, retry, cancellation and reconciliation are explicit local CLI operations; no scheduler is started. The legacy event-router outbox is also shown by `notifications list`. No remote notification sender is enabled by this CLI.

`inbound-events.mjs` accepts normalized provider events through an injected adapter. It stores source-ID hashes and bounded metadata, never message bodies; only unique exact application matches are attached. Unmatched/ambiguous events remain in the private inbound event log. A matched interview invite creates a high-priority human review task. User facts are captured only through an explicit human value, scoped to one application, with `HUMAN_EXPLICIT` provenance in a private local JSONL store; the operator masks fact input on a TTY. Values are not copied to the CV or profile automatically. Integrations consuming a fact must still verify its provenance and application scope.

Manual submission confirmation is a separate human assertion that appends `APPLICATION_SUBMITTED_CONFIRMED` to the application ledger. The CLI asks the user to type `SUBMITTED`; it does not open a browser, contact an employer, or submit anything. `FORM_FILLED` remains distinct from submission confirmation.

This control plane does not submit applications, contact/reply to recruiters, accept or schedule interviews, enable live-fill, or activate a scheduler. Unmatched inbound events and values requiring profile-wide reuse need explicit human reconciliation; the system does not infer a global profile update.
