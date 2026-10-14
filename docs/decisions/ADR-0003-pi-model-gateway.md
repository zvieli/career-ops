# ADR-0003: PI is the only model execution gateway

- **Status:** Accepted
- **Decision:** Agent requests logical tier/model IDs through the exact allowlist and invokes PI; provider resolution remains PI's responsibility. No direct provider CLI or HTTP fallback is part of the agent gateway.
- **Context:** The product needs one audited execution boundary, consistent exact-ID routing, disabled tool capabilities, and no paid fallback.
- **Consequences:** The gateway rejects unlisted IDs before invocation. Requested model identity is not represented as proof of physical backend provenance. Quota and physical-model provenance remain UNKNOWN. Old runner imports delegate to the PI gateway for compatibility.
