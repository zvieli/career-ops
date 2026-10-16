# Application answer preparation (manual entry only)

Career-ops can help prepare reviewable answers for an application. It does **not** fill a live employer form, upload a CV to an employer, bypass login/CAPTCHA, or submit an application. The candidate must review the prepared content and perform any external action themselves.

## Current capability

- Read-only job and form context may inform answer preparation, subject to the source-of-truth and untrusted-content rules in `AGENTS.md`.
- Candidate facts come from primary user-authored sources such as `cv.md`, `config/profile.yml`, `article-digest.md`, and `modes/_profile.md`; generated tailored CVs are draft evidence, not independent truth.
- Missing, unsupported, or conflicting facts stay blank and require human review. Never guess work authorization, visa/citizenship, experience duration, GPA scale, dates, salary expectations, phone, profile links, or relocation/location facts.
- The legacy web routes `/api/apply/fill` and `/api/apply/drive` are disabled and return HTTP 410. The application UI instructs the user to enter answers manually on the employer's site.
- Fixture-only controlled fill is available to isolated tests only, behind an explicit human authorization and trusted fixture controller. It does not enable live ATS support.

## External boundaries

Career-ops does not:

- submit an application or treat navigation/final review as proof of submission;
- send recruiter/employer messages or replies;
- accept interview invitations or mutate a calendar;
- bypass authentication or CAPTCHA;
- perform live employer form fill.

A human may separately choose to act on an employer site. Career-ops cannot make or confirm that decision automatically. To record a submission, use the explicit operator confirmation workflow only after the human has submitted externally.

## Troubleshooting

If an older UI or client still calls `/api/apply/fill` or `/api/apply/drive`, it receives HTTP 410 by design. Update the local application and prepare answers for manual entry; do not retry through another route, browser, provider, or account.
