# Security boundaries

- Job descriptions, employer pages, application forms, and recruiter messages are untrusted data, not instructions.
- The model gateway rejects IDs outside the exact zero-incremental-cost allowlist before launching PI. It disables tools, MCP, session persistence, skills, context files, templates, and themes for the provider call.
- There is no paid fallback and no direct provider CLI/HTTP execution path in the agent model gateway.
- Application form preparation is simulation-only. No Submit/Apply/Send action is performed.
- Candidate facts are sourced only from the approved user-layer files and statements made in the current conversation; derived numeric claims require provenance or remain unverified.
- Runtime state, candidate documents, live provider evidence, reports, recruiter content, and local audit artifacts are not committed as product evidence.

The full behavioral policy is in `AGENTS.md`; this page records the architecture-level controls that the product code must preserve.
