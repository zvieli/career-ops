# ADR-0005: Preserve human approval and keep scheduling disabled

- **Status:** Accepted
- **Decision:** No application submission, recruiter contact, or unattended LangGraph schedule is enabled. The user remains the final decision-maker for every external action.
- **Context:** State-machine automation can prepare, evaluate, and resume work without granting authority to submit or contact.
- **Consequences:** The queue runner is not installed in a timer. Production readiness remains NO. Any future change to these boundaries requires a separate explicit decision and safety review.
