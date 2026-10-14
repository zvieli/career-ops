# ADR-0002: Keep domain state separate from graph checkpoints

- **Status:** Accepted
- **Decision:** The application state machine remains the sole lifecycle authority; the ledger records events/artifact references; LangGraph checkpoints retain orchestration progress only.
- **Context:** Checkpoint replay must not rewrite canonical state or manufacture a successful application. Identity, URL, JD evidence, transition state, and ledger facts must be reconciled before retry.
- **Consequences:** Conflicts stop before evaluation or canonical mutation. A missing legacy JD hash may be accepted only where the current validator permits; a present conflicting hash is a hard stop. Recovery stays fail-closed and idempotent.
