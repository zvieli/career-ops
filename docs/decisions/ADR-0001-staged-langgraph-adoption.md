# ADR-0001: Stage LangGraph adoption

- **Status:** Accepted; production readiness remains **NO**
- **Decision:** Introduce LangGraph beneath `src/agent/` as a staged orchestration path. Keep `autonomous-pipeline.mjs` as the legacy production rollback/reference. Do not switch systemd, timer, or unattended scheduling.
- **Context:** Durable graph checkpoints and resumable nodes are useful, but orchestration is not authoritative application state. Full migration before parity/recovery evidence risks duplicated or conflicting state transitions.
- **Consequences:** Graph work must reconcile to the existing state machine and ledger. The legacy pipeline remains independently callable. A future production cutover requires explicit parity, recovery, security, observability, and human-approval evidence; it is not implied by this ADR.
