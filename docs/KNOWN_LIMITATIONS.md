# Known limitations — human-governed v1

This release is a locally operated, human-governed agent. It is not an autonomous application service.

## Capability limits

- Application submission is not supported. `FORM_FILLED` is not submission evidence; submission confirmation is a separate human assertion.
- Live employer-form filling is not supported. The legacy web `/api/apply/fill` and `/api/apply/drive` endpoints return HTTP 410; the web UI directs the candidate to enter answers on the employer site themselves.
- Fixture-controlled form fill exists only for isolated fixtures with an explicitly authorized trusted controller. It is not production ATS support.
- Employer/recruiter messaging, interview acceptance, and calendar scheduling are not supported.
- Scheduled execution is an externally triggered, bounded, one-shot shadow run. The scheduler is disabled when configuration is absent; enabling it does not install a timer or daemon.
- Scheduled provider coverage is currently limited to the providers explicitly supported by the shadow executor (Greenhouse and Lever). Unsupported providers and policies fail closed.
- Provider capacity skips are rediscoverable, not durably deferred. They can only be reconsidered if a later provider scan rediscovers them.

## Reliability and operations

- Coordination assumes a local filesystem and local-process ownership checks. This is not distributed exactly-once execution.
- Runtime limits use cooperative cancellation. An uncooperative in-process operation cannot be forcibly terminated.
- Corrupt or incomplete durable logs fail closed and require operator investigation; there is no automatic silent truncation/repair.
- Local path-based artifact publication checks reject static symlink escapes; they do not provide protection against a hostile same-user process racing path replacement on every supported filesystem.
- Legacy LangGraph checkpoints with missing required state/evidence are rejected. No automatic checkpoint migration is provided.
- Storage compatibility is bounded by the compatibility and upgrade tests; operators must back up the data root before upgrading or rolling back. Do not hand-edit canonical stores.
- Reviewer model provenance can be UNKNOWN when the configured subagent router cannot verify a returned model. That is a review-infrastructure blocker, not evidence that review passed.

## Data and privacy

- CVs, application evidence, review tasks, and operational receipts are local files with private-permission requirements on supported platforms. Filesystem permission semantics vary by operating system and deployment environment.
- Public job-provider reads are the scheduled network capability. This does not authorize employer form mutation, sending messages, or calendar changes.
- Generated application answers and artifacts remain drafts for human review. Missing candidate facts must remain missing; the system must not guess legal, identity, compensation, or experience facts.

## Accepted non-blocking issues

- `provider_attempts` distinguishes outbound HTTP requests from higher-level provider operations; check the runbook before interpreting the counter.
- Job listings above the configured run cap are rediscoverable rather than durably queued, as described above.
