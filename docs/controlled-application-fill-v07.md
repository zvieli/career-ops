# Controlled application fill (v0.7 fixture boundary)

The ordinary graph flow remains preparation-only. Form mutation is reached only after `ATS_PREPARATION_REVIEW` receives the distinct `FILL_APPLICATION` decision. `PREPARE_APPLICATION`, `CONTINUE_MANUALLY`, and `STOP` never authorize mutation. The queue runner does not inject a fill controller, and the implementation does not support live ATS mutation.

## Trusted fixture controller

`controlled-fill-browser.mjs` owns its Playwright browser, context, and local fixture page. Callers receive a module-branded controller with fixed operations only; they do not receive the page or generic evaluate, click, navigation, or submit capabilities. The page is loaded by intercepting the exact initial ATS URL and fulfilling that one navigation with bounded local fixture HTML; the request is never sent to an employer. `addInitScript` runs on this new document before any fixture script. Every later HTTP(S) request is blocked. The controller fails closed if the installed Playwright cannot intercept WebSockets.

The executor revalidates the exact application URL and extracted schema hash, then binds fields by stable ID. It can set supported text-like fields, uniquely identified select/radio choices, and one supported non-attestation checkbox. It can attach only the application-scoped, source-validated PDF bound by the CV, JD, and preparation receipts. Existing attachments must be the exact single file by SHA-256, filename, and size. Sensitive, legal, demographic, authorization, and identity fields are blocked independently at the domain and browser layers; hidden, disabled, ambiguous, unsupported, or user-populated targets are not overwritten.

The fixture context blocks HTTP(S) requests and WebSocket connections, disables WebRTC/WebTransport escape primitives, and prevents form submit/requestSubmit. Its submission counter remains closure-private behind a non-configurable snapshot accessor; the prototype interlocks are non-configurable and non-writable. It records blocked submission, navigation, popup, and network attempts. Any detected interlock turns the result into `APPLICATION_FILL_NEEDS_REVIEW`, never a successful fill. These controls describe this local fixture harness only; they do not establish the safety of a live ATS or a production browser.

## Recovery and review

Before each mutation the executor fsyncs a durable `MUTATION_STARTED` journal record; after a read-back it records verified progress. A restart can recognize an already-verified value or exact uploaded file. An uncertain or changed value is never replayed automatically and requires review. Receipt hashes are deterministic across recovery and contain hashes/references, not raw field values.

A verified fill writes an immutable receipt and `APPLICATION_FILLED` ledger event, then transitions to canonical `FORM_FILLED` with the JD/schema/receipt bindings and explicit false submission flags. Recovery validates the canonical metadata, preparation/CV receipts, mappings, event, artifact-store hash, and receipt body before reconstructing the final-review result; it does not re-run browser mutation. Legacy `FORM_FILLED` states without complete evidence are not eligible for this recovery path.

`FINAL_HUMAN_REVIEW` is a hard pause. It exposes receipt evidence and states that the current page is not attached; after process recovery the receipt proves a historical fixture fill, not that a filled page still exists. There is no submit, apply, send, or finalize node or capability. Any real employer application remains outside this graph and requires the user to operate it themselves.

## Deliberate limitations

- Fixture coverage is not evidence that a live ATS fill is reversible or safe. Live mutation, production queue wiring, and real employer forms remain unsupported.
- Authentication, MFA, CAPTCHA, account creation, conditional/multi-page workflows, multi-checkbox groups, custom widgets, and unsupported field types stop for manual review.
- Conditional schema changes stop after the first mutation; newly revealed fields are not filled under the stale authorization.
- A successful fixture receipt records local form state only. It does not mean an application was submitted or that a real employer received anything.
- Page labels and values are untrusted data, not instructions.
