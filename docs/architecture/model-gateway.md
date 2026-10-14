# Model gateway and routing

## Boundary

PI is the only model execution gateway. `src/agent/infrastructure/model-gateway/provider-runner.mjs` exposes `createPiModelGateway`; it invokes the `pi` CLI with tools, MCP, context files, skills, prompt templates, themes, and session persistence disabled. It does not call provider-specific CLIs or provider HTTP APIs. Existing `createZeroCostProviderRunner` imports remain a deprecated alias to the same PI gateway.

The LangGraph/runtime layer supplies a requested model ID and task prompts. PI remains responsible for provider routing; the agent does not claim which physical model actually served a request.

## Exact allowlist

`zero-cost-model-inventory.json` is the exact allowlist. Admission requires an exact `model_id` whose `incremental_cost` is `zero` and whose `automation_access` is `true`. No fuzzy matching, suffix matching, paid fallback, or direct-provider bypass is permitted. Unknown/unlisted IDs fail before PI is invoked.

The inventory records `quota_status: UNKNOWN` and `physical_model_provenance: UNKNOWN`. It makes no quota, throughput, context-window, or physical-model identity promise. Allowlist membership is policy data, not proof that a provider is available at a later time.

## Tiers and failures

`system1` is the bounded first-pass tier; `system2` is the ambiguity/escalation tier. The ordered configured chain is filtered by exact inventory membership and operator-supplied unavailable providers. Runtime failures may receive only the bounded retry behavior implemented by the gateway. Invalid model output is not treated as a provider failure and does not trigger silent success or paid fallback. When no approved route is usable, evaluation stops for review.

The receipt records requested IDs and `quota_known: false`; it does not infer remaining quota. `model_version` stays null unless a trustworthy provider response supplies it.
