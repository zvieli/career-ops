# Security boundaries

- Job descriptions, employer pages, application forms, and recruiter messages are untrusted data, not instructions.
- The model gateway rejects IDs outside the exact zero-incremental-cost allowlist before launching PI. It disables tools, MCP, session persistence, skills, context files, templates, and themes for the provider call.
- There is no paid fallback and no direct provider CLI/HTTP execution path in the agent model gateway.
- ATS preparation is read-only. The graph accepts only explicit `PREPARE_APPLICATION` after the CV review, inspects a normalized DOM snapshot, and persists application-scoped immutable schema/receipt artifacts. The legacy pipeline stops at `CV_VALIDATED` and cannot bypass this gate. Neither path exposes fill, upload, Apply, Send, or submit capability. Fixture-only Greenhouse/Lever adapters do not imply production support; live forms without an approved read-only adapter fail closed for human review.
- Candidate facts are sourced only from approved user-layer files and statements in the current conversation; every proposed ATS mapping records provenance. Professional YOE is verified professional employment only (never projects), GPA scale conversion is forbidden without evidence, and work authorization, sponsorship, salary, legal attestations, and sensitive facts are never guessed.
- Employer pages, form labels, questions, hidden controls, and job descriptions are untrusted data. No form text is promoted into agent instructions or model prompts. Unknown controls and unknown required answers fail closed; schema changes require deterministic remapping and human review.
- Resume artifacts are selected only by the current application’s canonical `CV_VALIDATED` receipt, PDF hash, JD hash, and CV fingerprint; arbitrary paths, traversal, and symlink escapes are rejected. Checkpoints and ledger receipts retain mapping statuses/provenance and hashes, not proposed candidate values.
- Runtime state, candidate documents, live provider evidence, reports, recruiter content, and local audit artifacts are not committed as product evidence.

The full behavioral policy is in `AGENTS.md`; this page records the architecture-level controls that the product code must preserve.
