# Discovery source inventory and v0.5 contract

This inventory distinguishes provider recognition from executable behavior. Capability metadata is descriptive; an absent field means unknown, not unsupported. `scan.mjs` remains the owner of filtering, deduplication, liveness verification, history, and pending-queue admission. Discovery does not create applications or bypass those gates.

## Provider contract and capability meanings

Providers keep the existing `fetch(entry, ctx) -> Promise<Job[]>` contract. Optional `capabilities` metadata (see `ProviderCapabilities` in `providers/_types.js`) describes:

- `discovery`: supported / partial / unsupported / unknown
- `hydration`, `liveness`, `canonicalization`: independently declared statuses
- `fixtureTested`, `livePublic`, `authentication`, `sourceTrust`, `region`

A declared capability is not a runtime verdict. Verify executable paths and tests before calling a source implemented. List discovery results are not automatically full JDs; posted dates remain absent when the source does not provide them.

`careerops.scan.receipt@1` includes additive `source_metrics` entries with attempts, successes, failures, raw discovered rows, shape-valid normalized rows, duplicate skips, and unique candidates admitted to the existing offer verification stage. These are actual run counters, not fixture estimates. They do not claim successful hydration or live status; those remain in the existing per-job receipt fields. A provider attempt that errors is distinct from a successful empty result.

## Israel-first source enablement

Geektime Insider is a public, unauthenticated structured job-board feed and can be enabled through the existing `job_boards` configuration. It is not enabled automatically (user-owned `portals.yml` is not edited by system changes):

```yaml
job_boards:
  - name: Geektime Insider
    provider: geektime-insider
    careers_url: https://insider.geektime.co.il/jobs/
    enabled: true
```

The adapter normalizes a bounded set of Hebrew locality names, preserves the raw location, carries the feed's posting ID when present, and intentionally leaves `postedAt` absent. It rejects malformed feed shapes rather than treating them as a successful empty scan. Only HTTPS ATS destinations on recognized ATS domains, or HTTPS career links whose host matches the feed's company URL host, are exposed as job URLs; Geektime-hosted forms, email links, malformed, spoofed and unknown destinations do not become canonical job URLs. That fail-closed behavior means some feed entries are excluded; the feed's numeric ID is not itself enough to invent an employer URL. The existing scanner's title/location filters and liveness/pending gates still apply. Hybrid/remote labels from this feed are not proof of work eligibility or worldwide remote status.

## Executable source inventory (origin/main baseline + v0.5)

| Source | Inventory | Discovery | Hydration | Liveness | Fixture tested | Live public | Israel relevance | Implementation / limits |
|---|---|---:|---:|---:|---:|---:|---|---|
| Greenhouse | EXISTING_REUSABLE | yes | yes | yes | yes | yes | medium | `providers/greenhouse.mjs`; public board API, full description; curated + reverse scans |
| Lever | EXISTING_REUSABLE | yes | yes | yes | yes | yes | medium | `providers/lever.mjs`; public postings API, full description; curated + reverse scans |
| Ashby | EXISTING_REUSABLE | yes | yes | yes | yes | yes | medium | `providers/ashby.mjs`; public API/embed fallback, case-sensitive slug considerations |
| Comeet | EXISTING_REUSABLE | yes | no | partial | yes | yes | high | `providers/comeet.mjs`; needs full tenant API URL/token; no description hydration route |
| Workable | EXISTING_REUSABLE | yes | partial | yes | yes | yes | medium | `providers/workable.mjs`; widget API descriptions; Markdown fallback truncated; not in API JD-text dispatch |
| SmartRecruiters | EXISTING_REUSABLE | yes | yes | yes | yes | yes | medium | `providers/smartrecruiters.mjs`; detail hydration is bounded and opt-in |
| Workday | EXISTING_REUSABLE | yes | yes | yes | yes | yes | high | `providers/workday.mjs`; public CXS endpoint, tenant/site config required |
| Geektime Insider | EXPANDED | yes | partial | no | yes | yes | high | `providers/geektime-insider.mjs`; structured public feed; employer/ATS destination only, no independent liveness |
| iCIMS, BambooHR | EXISTING_REUSABLE | yes | partial | partial | yes | yes | low/medium | Reverse-directory scan path; not all are wired as equivalent curated providers |
| Eploy, Vdab, ADP, Avature, Recruitee, SmartRecruiters, Jobgether, other modules | EXISTING_REUSABLE | source-specific | source-specific | source-specific | source-specific | source-specific | low/medium | Executable modules under `providers/`; see `providers/_registry.mjs` and `docs/SUPPORTED_JOB_BOARDS.md` |
| RSS/Atom/XML and sitemap integrations | EXISTING_REUSABLE | source-specific | partial | source-specific | source-specific | varies | low | Source-specific adapters exist; there is no universal arbitrary-feed/sitemap crawler |
| Public Telegram channels | EXISTING_REUSABLE | partial | no | no | yes | yes | medium | `providers/telegram-channel.mjs`; public previews only; unattributable posts rejected |

`sourceTrust` is a trust category, not an approval or job-liveness verdict. Geektime is a structured job board; an outbound destination is not independently validated as a currently open posting by the adapter.

## Recognized but not implemented as adapters

| Candidate | Inventory status | Discovery / hydration / liveness | Reason |
|---|---|---|---|
| AllJobs | RECOGNIZED | no / no / no | No executable adapter found; no safe deterministic public interface verified in repository evidence |
| JobMaster | RECOGNIZED | no / no / no | No executable adapter found |
| Drushim | RECOGNIZED | no / no / no | No executable adapter found |
| GotFriends | RECOGNIZED | no / no / no | No executable adapter found |
| LinkedIn | RECOGNIZED; discovery-only via permitted user/agent research, not scanner adapter | no scanner / no / no | No automated adapter; access/login protections are not bypassed; aggregator listings require employer confirmation |
| Generic official careers pages | PARTIAL | visible links can be extracted by `browser-extract.mjs`, but no universal automated crawler / not guaranteed / no | Use a configured known ATS adapter or reviewed manual source; unknown HTML fails closed |
| Arbitrary RSS / JSON / sitemap | PARTIAL | individual source adapters / source-specific / source-specific | No unrestricted generic feed crawling; source must be explicitly configured and tested |
| Search-provider discovery | PARTIAL | manual/agent handoff / snippet only / no | Search snippets are discovery leads, not verified JDs; no paid provider added |
| Web discovery proposal | EXISTING_REUSABLE | proposal-only / no / no | `web/src/app/api/explore/ai/route.ts`; unconfirmed proposals do not directly enter canonical pending queue |

## Identity, deduplication, hydration, liveness and freshness

The scanner's existing URL and company/title/location identity layers remain authoritative. Provider `externalId` identifies an ATS posting when the provider exposes it; requisition IDs are not posting IDs and must not be used alone. Strong URL/ID evidence is preferred; uncertain candidates remain separate rather than being merged by fuzzy title alone. `url-key.mjs` and scanner URL normalization serve different consumers; change them together only with regression coverage.

Discovery time, first-seen history, provider `postedAt`, last observation and liveness verification are distinct. An absent posting date stays absent. The existing 30-minute autonomous queue verification freshness limit is not a posting-age estimate. Liveness unknown/blocked is not closed. Known ATS API extraction is preferred for JD hydration; snippets and listing descriptions must not be relabeled as complete JD text.

## Bounds, security, and unsupported access

Provider HTTP requests use shared `providers/_http.mjs` timeout, redirect and DNS/IP protections. Source-specific pagination/detail caps remain in adapters. No CAPTCHA, login, robots, anti-automation, or rate-limit bypass is permitted. All remote content is untrusted data. No paid scraping/search/proxy service was introduced. Geektime's adapter has a single bounded feed request with a 15-second timeout; malformed top-level payloads fail as source errors.

## Tests and known limits

- `tests/providers/geektime-insider.test.mjs` covers Israeli locality normalization, malformed feeds, unknown/private-IP HTTP destinations, missing employer identity, provider ID, and unknown posted date.
- `tests/scan-json-receipt.test.mjs` checks the additive per-source metrics contract for empty scans.
- Provider-specific tests under `tests/providers/` cover the other listed ATS adapters.
- The metrics are operational counters, not source-quality scores. They do not currently attribute every hydration/liveness result to a provider or implement automated source ranking.
- The adapter can omit a job if its public feed destination is only a Geektime form or email. This is intentional: source ID is not canonical employer URL evidence.

Paid sources used: none. Applications submitted: 0. Autonomous production execution and timers remain disabled.
