# v1 human-governed release checklist

Use this before an owner performs the final merge/tag. This checklist does not authorize merge, tag, submission, live form fill, or employer contact.

## Source and branch

- [ ] Start from the verified current `origin/main`; record the baseline SHA and confirm the v0.4–v0.9 release tags are ancestors.
- [ ] Feature branch only; clean working tree before validation and after commit.
- [ ] Review ownership boundaries and the complete diff; run `git diff --check`.
- [ ] Do not merge or tag from this checklist. Owner performs the final release merge/tag.

## Validation gates

- [ ] Focused E2E, replay/idempotency, shadow, recovery, concurrency, corruption, permissions, cross-application, artifact/decision-replay tests pass.
- [ ] Fresh-clone/install smoke and operator help/status commands pass without hidden developer state.
- [ ] `node test-all.mjs` passes.
- [ ] `npm run lint` passes.
- [ ] `node update-system.mjs check` passes; never run updater `apply` in this product fork.
- [ ] `node validate-system-paths-coverage.mjs` passes.
- [ ] `node ~/.pi/agent/bin/validate-routing.mjs` passes.
- [ ] Independent read-only final review covers exactly the pushed candidate range; P0=0 and P1=0.
- [ ] Security, operations, architecture, and release verdicts are PASS/OK. Any remaining P2 is explicitly non-blocking and documented.

## Human-governance gates

- [ ] Scheduler disabled by default; no import timer, daemon, or hidden recurring execution.
- [ ] Scheduled shadow reachability is limited to approved public provider reads and local durable state.
- [ ] No reachable production path submits an application, fills a live employer form, contacts an employer/recruiter, accepts an interview, mutates a calendar, or manufactures human decisions.
- [ ] Fixture-only controlled fill remains isolated from live providers and submission.
- [ ] Manual submission confirmation remains an explicit human assertion, not a browser/navigation/final-review side effect.
- [ ] Privacy, candidate-fact integrity, prompt-injection isolation, and cross-application binding checks pass.

## Data and rollback

- [ ] Back up the complete user data root before upgrading. Never edit canonical state, append-only ledgers, or checkpoint SQLite by hand.
- [ ] Confirm compatibility only for stores covered by passing upgrade/compatibility tests. Legacy checkpoints missing required evidence remain fail-closed; no implicit checkpoint migration is promised.
- [ ] For rollback, check out the reviewed `v0.9-scheduler-shadow-ops` release and restore only from a verified backup if an operator-directed recovery is needed. Do not run destructive migration or delete newer stores to force compatibility.
- [ ] Preserve the v1 evidence report and validation logs without including CV contents, credentials, tokens, or other secrets.

## Product claims

- [ ] Product description says human-governed; no claim of autonomous production apply readiness.
- [ ] `docs/KNOWN_LIMITATIONS.md`, operator docs, and the capability matrix agree with reachable code.
- [ ] Review pushed HEAD and ensure local HEAD equals remote HEAD and the worktree is clean.
