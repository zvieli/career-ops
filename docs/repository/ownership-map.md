# Repository ownership map

This is the product/repository ownership contract. Upstream ancestry is preserved; ownership is determined by path and updater policy, not by whether a file is new in this checkout.

## Ownership classes

| Class | Meaning | Representative paths |
|---|---|---|
| `UPSTREAM_COMPATIBILITY` | Stable upstream CLI/runtime contracts. Keep root paths and behavior compatible. | `update-system.mjs`, `path-resolver.mjs`, `pipeline-lock.mjs`, `scan.mjs`, `test-all.mjs`, root utilities, `providers/`, `modes/`, `templates/`, `tests/`, and root package metadata |
| `SHARED_DOMAIN_CORE` | Deterministic Career Ops behavior reused by the fork; do not fork/rewrite it merely to change orchestration. | tracker parsing/merging, URL identity, liveness, profile/CV validation, provider registry and existing scoring contracts |
| `FORK_PRODUCT_CODE` | Product-specific agent implementation; upstream's update-system must not replace it. | `src/agent/`, plus exact legacy compatibility entrypoints listed in `FORK_PATHS.txt` |
| `RUNTIME_DATA` | Candidate/application state, local configuration and evidence. Never baseline or publish. | `data/`, `reports/`, `output/`, `jds/`, `cv/`, `config/profile.yml`, `portals.yml`, `.pi/`, recruiter receipts and local checkpoints |
| `GENERATED_ARTIFACT` | Rebuildable or run-local output; ignored or kept in local scratch. | PDFs, SQLite/checkpoint files, `diff*.txt`, `acceptance-report.json`, test logs, `node_modules/` |
| `DOCUMENTATION_CURRENT` | Normative product documentation; authoritative locations are listed in `docs/architecture/overview.md`. | `docs/architecture/`, `docs/operations/`, `docs/decisions/`, `docs/repository/` |
| `DOCUMENTATION_HISTORICAL` | Preserved prior proposals/evidence which do not define current policy. | `docs/archive/`; legacy private run dossiers remain local and ignored |
| `TEST_INFRASTRUCTURE` | Upstream regression suite plus explicitly grouped product tests. | Existing `tests/`; new `tests/agent/{graph,domain,infrastructure,integration,security,recovery}/` |

## Product ownership and updater boundary

`FORK_PATHS.txt` is the repository's explicit list of fork-owned paths. `validate-system-paths-coverage.mjs` validates its syntax, rejects overlap with upstream `SYSTEM_PATHS`/user paths, and checks every tracked file is covered by upstream, user, or fork ownership. The canonical agent implementation lives under `src/agent/`, which is outside `SYSTEM_PATHS`.

Root files in `SYSTEM_PATHS` are not moved for aesthetic reasons. The legacy `autonomous-pipeline.mjs`, existing commands, and `lib/` import paths remain compatibility surfaces while callers migrate. Their thin re-exports are listed explicitly in `FORK_PATHS.txt`; they contain no second implementation.

Important exception: `package.json`, `.gitignore`, `docs/`, `tests/`, `templates/`, and several root modules are updater contracts. The root package manifest currently carries fork dependencies/scripts, so a wholesale `update-system.mjs apply` may replace them. This product fork uses Git history and selective upstream integration, not blind updater application. See `upstream-compatibility.md`.

## Candidate and runtime data boundary

Personal CV/profile files, actual job-search research, application state, live run receipts, recruiter content, checkpoints, and generated CV/PDFs are local data. `.gitignore` excludes these paths. A baseline commit is built from an explicit source/docs/test allowlist; never use `git add .` on a personalized checkout.

`docs/israel-research/`, `docs/autonomy/`, `cv/`, `task.md`, and transient audit outputs were present locally during this migration. They remain on disk and are ignored; they are not product source, public evidence, or part of the baseline.
