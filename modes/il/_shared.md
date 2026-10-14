# Israel Market Context (Supplemental)

This file adds reusable market context to the baseline `modes/_shared.md`. It does not replace the baseline evaluation rules and contains no candidate-specific facts or targeting policy. Apply the user's primary profile and explicit instructions for candidate fit. Do not infer missing facts.

## Titles and seniority

- Israeli postings may use “Developer” and “Engineer” for similar work; compare responsibilities and requirements rather than treating the title wording as decisive.
- Preserve distinctions among “Junior,” “Graduate,” “Student,” and “Entry Level.” Do not normalize them into one seniority label or infer one when the posting omits it.
- Treat “2+ years” as a stretch signal, not an automatic rejection, unless the candidate's own profile or policy sets a stricter threshold. For an early-career candidate whose profile supports that description, treat explicit “4+ years” and Senior/Lead roles conservatively; still distinguish a stretch from a hard requirement.
- Preserve the posting's distinction between “required” and “preferred,” “advantage,” or equivalent wording. Do not promote preferences into requirements or weaken requirements into preferences.

## Candidate facts and eligibility

- Military service, unit, rank, technical duties, or security experience must never be inferred from location, employer, language, or other background clues.
- Citizenship, work authorization, residency, and security clearance are unknown unless supported by the candidate's primary profile or a direct statement in the current conversation. Do not infer eligibility.
- Mixed Hebrew/English job descriptions may occur. Preserve the source meaning of both languages; uncertainty in a translation remains uncertainty.
- Unknown candidate facts remain unknown. Do not manufacture experience, qualifications, location, language ability, or eligibility to improve apparent fit.

## Source and application discipline

9. Never add or edit tracker rows by hand. Write one headed TSV in `batch/tracker-additions/` and merge with `node merge-tracker.mjs`; update existing status through `node set-status.mjs`.

- Prefer the employer's direct careers page or verified employer ATS posting as the canonical source over aggregator copies. Do not merge distinct requisitions based only on similar titles or aggregator URLs.
- Follow existing Career Ops source-verification and conservative deduplication rules; this market note does not authorize scraping new boards or undocumented endpoints.
- Drafting and evaluation do not authorize a final application submission. The candidate must review and submit any application themselves.

## Language and location handling

- `language.output` remains the authority for human-facing prose; the Israel supplemental mode does not change it.
- Current portal location terms are English spellings only. Runtime Hebrew/English locality alias equivalence is not implemented; do not claim that Hebrew location strings are normalized to English.
