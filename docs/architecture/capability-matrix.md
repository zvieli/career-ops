# Human-governed capability matrix

This is the authoritative v1 capability statement. “YES” means the bounded capability exists; it does not authorize adjacent actions.

| Capability | v1 status | Boundary |
|---|---:|---|
| Discover supported jobs | YES | Supported public providers only |
| Hydrate and check liveness | YES | Provider/API paths with bounds; unsupported or uncertain results fail closed to review |
| Deduplicate and evaluate | YES | Conservative evaluation; unknown facts are not invented |
| Create local human-review tasks | YES | Durable, idempotent local workflow |
| Generate CV/PDF artifacts | YES | Explicit human-gated, source-backed generation |
| Prepare ATS fields/answers | YES | Draft-only; missing or conflicting facts require human review |
| Controlled form fill | YES, fixtures only | Isolated local fixture + explicit authorization + trusted controller |
| Fill a live employer form | NO | Legacy web `/api/apply/fill` and `/api/apply/drive` endpoints return HTTP 410 |
| Submit an application | NO | Submission remains an external human action; confirmation is a separate human assertion |
| Contact recruiter/employer | NO | No send capability |
| Accept interview or schedule | NO | No calendar mutation capability |
| Automatically make human decisions | NO | Decisions require a human-authored receipt |
| Scheduled discovery | YES, shadow only | Externally triggered one-shot; disabled by default; no hidden timer/daemon |
| Automatically resume LangGraph decisions | NO | Scheduled shadow path cannot resume the graph |
| Autonomous production apply readiness | NO | Not supported or claimed |

## Network policy

Scheduled shadow execution makes bounded public GET requests only through its approved provider adapters and liveness checks. It does not browse employer pages, perform form POSTs, send messages, accept invitations, or mutate calendars. The interactive legacy web apply routes are disabled for live fill; fixture browser network access remains isolated by the controlled-fill test harness.

See also [scheduler shadow operations](../operations/scheduler-shadow.md), [known limitations](../KNOWN_LIMITATIONS.md), and [application answer preparation](../APPLY_AUTOFILL.md).
