# v0.6 — Discovery quality, hydration, liveness, and coverage

This version audits executable adapter behavior and keeps recognition, discovery, hydration, liveness, and canonicalization separate. Capability metadata is descriptive; fixture coverage is not a live service check. External job content is data, never instructions. Scanner discovery does not submit applications or enable unattended production execution.

## Capability matrix

| Source | Discovery | Hydration | Liveness | Canonicalization | Fixture-tested | Live-public | Israel relevance | Evidence / limitation |
|---|---:|---:|---:|---:|---:|---:|---|---|
| Greenhouse | YES | YES | YES | YES | YES | YES | Medium | Public board/detail endpoints; per-job API liveness. |
| Lever | YES | YES | YES | YES | YES | YES | Medium | Public postings API; per-job detail and liveness. |
| Ashby | YES | YES | YES | YES | YES | YES | Medium | Public board/detail path; organization-level liveness verifies the posting. |
| Workday | YES | YES | YES | YES | YES | YES | HIGH | Configured public CXS tenant/site; public posting detail/liveness. |
| Comeet | YES | NO | NO | PARTIAL | YES | YES | HIGH | Configured tenant API URL/token required; no per-posting description/liveness route in this adapter. |
| Workable | YES | PARTIAL | YES | YES | YES | YES | Medium | Public widget descriptions; liveness API is separate. No shared full-JD detail endpoint contract was established; descriptions remain PARTIAL. |
| SmartRecruiters | YES | PARTIAL | YES | YES | YES | YES | Medium | Bounded optional detail enrichment; description sections can be absent; liveness requires matching posting identity/status. |
| Geektime Insider | YES | PARTIAL | NO | PARTIAL | YES | YES | HIGH | Public structured feed; description is a discovery observation. A recognized ATS destination can be handed to its provider for liveness/hydration; feed presence itself is not live evidence. |
| iCIMS | YES | PARTIAL | PARTIAL | PARTIAL | YES | YES | Low/medium | Bounded public HTML listing and JSON-LD date/location enrichment; no proven full-JD/liveness contract. |
| BambooHR | YES | PARTIAL | PARTIAL | PARTIAL | YES | YES | Low/medium | Public list/detail date enrichment; board redirect/health behavior is not posting liveness evidence. |
| Public Telegram | PARTIAL | NO | NO | PARTIAL | YES | YES | Medium | Public discovery only; message text is not a JD or liveness evidence. |
| Official careers destinations | PARTIAL | PARTIAL | PARTIAL | PARTIAL | YES | varies | varies | Known ATS routing is preferred; no generic arbitrary HTML crawler. Unknown pages fail closed. |
| Explicit RSS/Atom/JSON sources | PARTIAL | PARTIAL | PARTIAL | PARTIAL | source-specific | varies | varies | Existing source-specific adapters only; no arbitrary internet feed discovery. |
| Search handoff | PARTIAL | NO | NO | NO | source-specific | varies | varies | Search output remains a lead; snippets are not a full JD or proof of liveness. |

YES means executable and fixture-backed behavior exists for that operation; it does not mean every posting is supported. PARTIAL means only a constrained or incomplete path exists. NO means no source-native implementation is claimed. Live-public describes the interface being publicly reachable in the audited implementation, not a live health probe during this campaign.

## Recognized, not implemented

| Source | Status | Reason |
|---|---|---|
| AllJobs | RECOGNIZED_NOT_IMPLEMENTED | No documented public RSS/API or stable public structured contract was verified. Job-page markup/sitemap behavior was not verified as a safe stable ingestion interface. |
| JobMaster | RECOGNIZED_NOT_IMPLEMENTED | No documented public feed/API verified. |
| Drushim | RECOGNIZED_NOT_IMPLEMENTED | No documented public feed/API verified. |
| GotFriends | RECOGNIZED_NOT_IMPLEMENTED | No public structured feed/API verified. |
| LinkedIn | RECOGNIZED_NOT_IMPLEMENTED | No permitted automated public adapter verified; no login, cookie, CAPTCHA, or anti-bot workaround. Research handoff remains discovery-only. |
| Unknown careers HTML | RECOGNIZED_NOT_IMPLEMENTED | Generic arbitrary crawling is intentionally unsupported; route only to known ATS adapters or bounded verified page parsers. |
| Arbitrary RSS/JSON/sitemaps | RECOGNIZED_NOT_IMPLEMENTED | A feed must be explicitly configured and bounded; no universal crawler. |

Public-search research did not verify an acceptable deterministic AllJobs, JobMaster, Drushim, or GotFriends interface. No Israeli board adapter was added. No access controls or anti-bot restrictions were tested or bypassed.

## Data semantics and boundaries

- Hydration state vocabulary: `NOT_ATTEMPTED`, `FULL`, `PARTIAL`, `FAILED`, `UNSUPPORTED`, `BLOCKED`. A listing snippet or text whose completeness is not established is `PARTIAL`, never `FULL`.
- API hydration returns authoritative provider identity separately from discovery provenance. The original discovery source is retained; destination routing does not claim that the discovery feed hydrated the JD.
- Content hash is SHA-256 over the exact normalized hydrated text. `hydrated_at` is written only when hydration succeeds; it is not a posting date or liveness timestamp.
- Liveness remains conservative: `LIVE`, `CLOSED`, `NOT_FOUND`, `UNKNOWN`, `BLOCKED`, `ERROR`, and `UNSUPPORTED` are distinct concepts; unknown, blocked, timeout, and parse failure are never converted into closed.
- `jobs_normalized` requires a nonempty title and absolute HTTP(S) URL with hostname and no embedded credentials. Company can be absent where configured board identity supplies it.
- Source metrics are actual runtime counters. The scan command has no standalone JD hydration stage, so scan-receipt hydration counters are zero; liveness counters are populated only when verification runs. They are not fixture estimates or a quality ranking.
- URL/ATS ID evidence remains the identity boundary. Similar titles alone do not merge postings. Provider IDs are namespaced. Provenance URLs/IDs are observations, not universal dedup keys.
- Feed and job text are untrusted data. No content can modify tool routing, safety policy, or application-submission behavior.
- Shared provider HTTP protections, fixed-host API URLs, redirect refusal, request caps, and timeouts remain mandatory. No paid services, scheduler, form fill, or submission capability was added.

## Verification scope

Provider fixtures live under `tests/providers/`; hydration/liveness dispatch tests include `tests/browser-extract.test.mjs`, `tests/liveness-api-workable.test.mjs`, and scanner receipt tests. Queue provenance merge and repeat replay behavior are covered by `tests/agent/infrastructure/autonomous-pending-queue.test.mjs`. Fixture-tested does not imply a production run or a claim that an endpoint was live during this implementation.

Applications submitted: 0. Submit capability: NO. Autonomous production readiness: NO. Timer enabled: NO.
