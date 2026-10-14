# Upstream compatibility and maintenance

## Remotes and history

- `origin` is the product fork: `https://github.com/zvieli/career-ops.git`.
- `upstream` is the original project: `https://github.com/career-ops-hq/career-ops.git`.
- The migration branch is `refactor/fork-product-architecture`.
- The annotated tag `pre-fork-autonomy-baseline` preserves the pre-migration baseline. Upstream history was merged without rewriting prior commits.

## Path and updater policy

Upstream `update-system.mjs` selects files using its `SYSTEM_PATHS` and `USER_PATHS` manifests. Root commands, `lib/`, `providers/`, `modes/`, `templates/`, tests, documentation, and `package.json` have established compatibility behavior; do not relocate them wholesale. `FORK_PATHS.txt` declares fork-owned files outside those upstream/user manifests, primarily the canonical `src/agent/` tree and legacy shims.

`package.json` remains a root compatibility file and currently contains fork dependencies/scripts. A wholesale `node update-system.mjs apply` can replace that file with the upstream version and is not the fork's integration mechanism. Do not run a blind updater apply on the product fork. Use Git to fetch upstream, inspect changes, and selectively merge/cherry-pick compatible fixes; manually reconcile package metadata and rerun tests.

The upstream updater also manages broad `docs/`, `tests/`, and `templates/` prefixes. Product documentation under those prefixes is maintained in this fork by Git. Avoid applying upstream file replacement to this fork; retain unique fork documentation paths and review any future upstream path collision before integration.

## Selective update workflow

```bash
git fetch upstream
git log --oneline --left-right HEAD...upstream/main
git diff --stat HEAD...upstream/main
# inspect each proposed upstream change and its path ownership
# selectively merge or cherry-pick only reviewed changes
node validate-system-paths-coverage.mjs
node test-all.mjs
```

Never use an unreviewed blanket merge as an update strategy. A reviewed merge commit is acceptable when its full diff is understood and the fork-specific checks pass. Do not force-push or rewrite the preserved baseline.

## Compatibility rules

1. Keep upstream-owned root paths and CLI contracts stable.
2. Keep `src/agent/` canonical; legacy module/script paths may only delegate/re-export.
3. `FORK_PATHS.txt` must not overlap `SYSTEM_PATHS` or `USER_PATHS`; coverage validation enforces this.
4. Preserve the state machine, ledger, no-submit boundary, and candidate-fact safeguards across every upstream integration.
5. Keep LangGraph readiness NO and do not activate scheduling until a separately approved parity/reliability gate.
