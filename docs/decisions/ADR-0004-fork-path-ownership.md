# ADR-0004: Preserve upstream paths and isolate fork product code

- **Status:** Accepted
- **Decision:** Keep established upstream root files and path contracts in place; place canonical fork product code under `src/agent/`. Retain old import and CLI paths only as thin, tested shims.
- **Context:** `SYSTEM_PATHS`, plugins, scripts, and user workflows rely on stable paths. Moving upstream roots would weaken updater compatibility and create duplicate implementations.
- **Consequences:** `FORK_PATHS.txt` records the distinct product ownership layer. The fork integrates upstream through reviewed Git changes, not blind updater replacement. Root `package.json` remains an upstream compatibility path and must be reconciled during future updates.
