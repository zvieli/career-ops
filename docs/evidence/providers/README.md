# Provider-gateway evidence

The deterministic contract test is `tests/agent/infrastructure/pi-model-gateway.test.mjs`. It verifies that exact allowlisted IDs are passed through the PI CLI boundary and that unlisted IDs are rejected before invocation.

The machine inventory in `src/agent/infrastructure/model-gateway/zero-cost-model-inventory.json` records only exact requested IDs, zero incremental cost policy, automation admission, and explicit UNKNOWN values for quota and physical-model provenance. It is not a claim about current provider availability, quota, latency, or the physical backend that served a request.
