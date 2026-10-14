# Controlled application fill (v0.7 boundary)

The graph's ordinary flow remains preparation-only. Form mutation can be reached only after `ATS_PREPARATION_REVIEW` receives the distinct `FILL_APPLICATION` decision. `PREPARE_APPLICATION`, `CONTINUE_MANUALLY`, and `STOP` do not authorize mutation. The graph accepts a fill adapter only when it is explicitly marked `FIXTURE_TEST`, matches Greenhouse or Lever, and provides the narrow inspect/fill/read-back surface.

`src/agent/domain/applications/controlled-fill.mjs` re-inspects the exact application URL, compares the normalized schema hash, binds fields by stable ID, skips all mappings other than `READY`, blocks sensitive/legal semantics independently, allows only basic text-like controls, verifies values by DOM read-back, and emits a content-addressed receipt with `submission_performed: false` and `submit_capability: false`. Replay checks previous fill evidence and refuses to overwrite changed user values.

## Deliberate limitations

- **No live mutation provider is supported.** Fixture coverage is not evidence that a live ATS fill is reversible or safe. The runtime refuses to proceed without an injected `FIXTURE_TEST` adapter.
- Select, radio, checkbox, upload, custom widgets, multi-page forms, authentication and CAPTCHA are not implemented by this fill executor and must remain manual/review-only.
- No fixture server network monitor, upload binding, crash-resume protocol, or production-browser submit instrumentation is supplied by this initial slice. Do not use this as production automation.
- Page labels and values are untrusted data, not instructions. No page-provided text is executed as agent instruction.

The executor has no click, keyboard, navigation, upload, or submit operation. It does not authorize a human or agent to submit; final human review remains a pause, and any subsequent application submission must be performed manually outside this graph.
