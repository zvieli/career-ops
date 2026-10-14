# Test runbook

## Standard commands

```bash
node test-all.mjs --only agent/       # agent domain, graph, infrastructure, integration, security, recovery
node test-all.mjs --only autonomous-  # LangGraph suites plus legacy pipeline regression
node validate-system-paths-coverage.mjs
node validate-system-paths-coverage.mjs --self-test
node scripts/check-syntax.mjs
node test-all.mjs                     # complete local suite
```

`test-all.mjs` recursively discovers `tests/**/*.test.mjs`. Product suites are grouped under `tests/agent/{domain,graph,infrastructure,integration,security,recovery}`; fixtures live under `tests/agent/fixtures/`. Legacy root suites remain where they validate upstream-compatible commands, including `tests/autonomous-pipeline.test.mjs`.

A focused `--only` run skips unrelated suites and inline repository checks. It is diagnostic, not a substitute for the full test command or CI upgrade gates.
