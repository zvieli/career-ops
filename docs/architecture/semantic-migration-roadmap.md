# Career-Ops v1.2 — Semantic Migration Roadmap & Shadow Execution Plan

**Architecture Milestone:** v1.2 — Semantic Intelligence Audit & System-1 Refactor Specification  
**Status:** DRAFT SPECIFICATION (AUDIT-ONLY — NO PRODUCTION REFACTOR APPLIED)  
**Strategy:** Phased, Non-Destructive Shadow Migration with Zero Downstream Disruption  

---

## 1. Migration Philosophy & Safety Principles

1. **NEVER A BIG-BANG CUTOVER:**
   Replacing all regexes, taxonomies, and keyword checks simultaneously invites catastrophic pipeline instability and false rejections. Migration proceeds strictly in sequential, independently verified phases.
2. **SHADOW EXECUTION FIRST:**
   Every new System-1 semantic component runs in **Shadow Mode** alongside the legacy heuristic for a minimum observation window (100 jobs or 14 calendar days). The legacy logic continues to drive production state and tracker updates; disagreements are logged as structured audit telemetry for human review.
3. **FAIL-SAFE DISAGREEMENT GATE:**
   If a System-1 component disagrees with legacy logic on a hard veto (e.g. legacy rejects, System 1 passes), the posting is routed to `NEEDS_REVIEW`—it is never silently rejected or submitted.
4. **INDEPENDENT VERIFIABILITY & ROLLBACK:**
   Every migration phase includes explicit offline verification commands and an instant, zero-downtime rollback mechanism via a feature flag.

---

## 2. Dependency-Derived Implementation Roadmap

The implementation sequence is dictated by the upstream data dependencies of the Career-Ops pipeline:

```
  Phase 0: Ground Truth & Evaluation Harness
    │
    ▼
  Phase 1: Canonical Entities & Bundled Job Semantic Profile (Tasks 1, 4, 5, 8, 9, 10, 11)
    │
    ▼
  Phase 2: Skill Extraction & Normalization (Tasks 2, 3)
    │
    ▼
  Phase 3: Seniority & Holistic YOE Interpretation (Tasks 6, 7)
    │
    ▼
  Phase 4: Candidate Capability & Requirement Matching (Tasks 12, 13)
    │
    ▼
  Phase 5: Candidate Fit Policy & Deterministic Gate Integration
    │
    ▼
  Phase 6: Deduplication & Semantic Requisition Comparison (Task 14)
    │
    ▼
  Phase 7: ATS Field & Custom Question Classification (Tasks 15, 16)
    │
    ▼
  Phase 8: Discovery Query Expansion & Search Optimization (Task 17)
    │
    ▼
  Phase 9: Presentation Surfaces & Telegram Explainability
```

---

### Phase 0: Ground Truth Corpus & Evaluation Harness
- **Prerequisites:** None.
- **Scope:** Implement the canonical semantic domain schemas (7 entities), runtime validation, provenance verification, policy safeguards, 25-case golden evaluation dataset (`evals/fixtures/golden-25.json`), legacy evaluation adapters, annotation protocol, and the offline evaluation runner `scripts/eval-semantic-benchmark.mjs`.
- **Delivered Files:**
  - Schemas: `src/agent/domain/semantic/schemas/*.json` (7 entities)
  - Domain logic: `src/agent/domain/semantic/semantic-entities.mjs`
  - Provenance: `src/agent/domain/semantic/provenance-validator.mjs`
  - Policy: `src/agent/domain/semantic/policy-safeguards.mjs`
  - Metrics: `src/agent/domain/semantic/evaluation-metrics.mjs`
  - Adapters: `src/agent/domain/semantic/adapters/legacy-eval-adapter.mjs`, `semantic-engine-interface.mjs`
  - Golden Fixture: `evals/fixtures/golden-25.json`, `evals/fixtures/candidate-early-career.json`
  - Annotation: `docs/architecture/annotation-protocol.md`, `scripts/annotate-benchmark.mjs`
  - Runner: `scripts/eval-semantic-benchmark.mjs`
  - Tests: `tests/agent/domain/semantic-schemas.test.mjs`, `semantic-provenance.test.mjs`, `policy-safeguards.test.mjs`, `legacy-eval-adapter.test.mjs`, `evaluation-metrics.test.mjs`, `golden-dataset.test.mjs`, `benchmark-cli.test.mjs`
- **Acceptance Criteria:** Benchmark runner executes across all samples with 0 crashes, enforces canonical schemas and evidence provenance, and reports baseline metrics for current legacy regex heuristics. Future 300-sample corpus builds upon this foundation.

---

### Phase 1: Canonical Semantic Entities & Bundled Job Extraction
- **Status:** ENGINEERING COMPLETE (SHADOW MODE READY)
- **Scope Amendment:** Implements core job understanding bundling Tasks 1, 4, 5, 6, 7, 8, 9, 10, 11 into a single-pass System-1 profiler. Task 7 (Seniority) and Task 6 (Role Family) were pulled forward into Phase 1 to eliminate role/experience ambiguity. Tasks 2 & 3 (Skill Extraction and Concept Graph) remain in Phase 2.
- **Tasks Implemented:**
  - Task 1: `JOB_SEMANTIC_PROFILE` (Composite Master Extraction)
  - Task 4: `REQUIREMENT_EXTRACTION`
  - Task 5: `REQUIREMENT_IMPORTANCE_CLASSIFICATION`
  - Task 6: `ROLE_FAMILY_CLASSIFICATION`
  - Task 7: `SENIORITY_CLASSIFICATION` (Holistic title + YOE + duty scope)
  - Task 8: `EXPERIENCE_REQUIREMENT_EXTRACTION` (Required vs preferred YOE)
  - Task 9: `EDUCATION_REQUIREMENT_EXTRACTION`
  - Task 10: `WORK_MODEL_EXTRACTION`
  - Task 11: `DOMAIN_CLASSIFICATION`
- **Delivered Files:**
  - `src/agent/domain/semantic/job-semantic-profiler.mjs`
  - `src/agent/domain/semantic/adapters/semantic-engine.mjs`
  - `src/agent/domain/semantic/shadow/shadow-profiler.mjs`
  - `evals/fixtures/mock-profiler-response.json`
  - `scripts/eval-semantic-benchmark.mjs` (updated with `--engine semantic` & `--compare`)
  - Tests: `tests/agent/domain/job-semantic-profiler.test.mjs`, `semantic-engine.test.mjs`, `shadow-profiler.test.mjs`, `benchmark-cli.test.mjs`
- **Feature Flag & Rollback:** Gated by `config/profile.yml` -> `features.semantic_job_profile: false` (OFF) or `"shadow"` / `true` (SHADOW).
- **Shadow Mode Telemetry:** Non-destructive shadow execution alongside authoritative legacy heuristics. Emits structured disagreement telemetry (`LEGACY_REJECT_SEMANTIC_PASS`, `REQUIRED_YOE_MISMATCH`, etc.) without candidate PII. Disagreements involving hard vetoes route to `NEEDS_REVIEW` (Invariant 9). Production decisions remain 100% legacy-driven in Phase 1.

---

### Phase 2: Skill Extraction & Concept Normalization
- **Status:** ENGINEERING COMPLETE (SHADOW MODE ONLY)
- **Production Authority:** Legacy lexical authority preserved (`skill-extract.mjs`, `keyword-match.mjs`, `jd-skill-gap.mjs`). `PRODUCTION_SEMANTIC_CUTOVER = FALSE`.
- **Scope Implemented:**
  - Task 2: `SKILL_EXTRACTION` (Provenance-backed explicit technical skill mentions).
  - Task 3: `SKILL_NORMALIZATION` (Staged canonical concept normalization and stable identity).
- **Architecture Invariants:**
  - Models understand. Code decides.
  - Distinction between `SkillMention` (source-present, verbatim quote, exact UTF-16 span, requirement-linked) and `SkillConcept` (stable canonical concept_id, category, trusted aliases).
  - Identity registry (`skill-concept-seed.json`) is an identity registry, NOT an extraction vocabulary.
  - Strict uncertainty policy: when in doubt, do NOT merge. Related != equivalent.
  - No inference of unstated skills (e.g. FastAPI does not infer Python).
  - Staged normalization: Step A (exact canonical/trusted alias) -> Step B (candidate retrieval) -> Step C (optional batched semantic resolution) -> Step D (deterministic validation and declared-distinct guards).
  - Stable concept IDs: frozen canonical slug IDs and deterministic run-local hashes.
  - Lineage: Job -> JobRequirement -> SkillMention -> SkillConcept.
  - Shadow-only execution gated by `features.semantic_skill_intelligence: false | "shadow" | true`.
  - Offline evaluation: `scripts/eval-semantic-skills.mjs` over adversarial fixtures (`evals/fixtures/skill-intelligence-adversarial.json`).
- **Delivered Files:**
  - `src/agent/domain/semantic/skill-concept-seed.json`
  - `src/agent/domain/semantic/skill-concept-registry.mjs`
  - `src/agent/domain/semantic/skill-intelligence.mjs`
  - `src/agent/domain/semantic/skill-normalization.mjs`
  - `src/agent/domain/semantic/skill-shadow.mjs`
  - `src/agent/domain/semantic/semantic-errors.mjs`
  - `src/agent/domain/semantic/schemas/SkillMention.json`
  - `src/agent/domain/semantic/schemas/JobSkillIntelligence.json`
  - `evals/fixtures/skill-intelligence-adversarial.json`
  - `scripts/eval-semantic-skills.mjs`
  - `docs/architecture/skill-intelligence.md`
  - Tests: `tests/agent/domain/skill-*.test.mjs` (8 suites, 104 tests)
- **Evaluation Limitations:** Benchmark metrics are PROVISIONAL and SYNTHETIC, not sufficient for production promotion.

---

### Phase 3: Candidate Semantic Intelligence
- **Status:** ENGINEERING COMPLETE (SHADOW MODE ONLY)
- **Production Authority:** Legacy candidate authority preserved (`src/agent/domain/candidate/candidate-fit-gate.mjs`). `PRODUCTION_SEMANTIC_CUTOVER = FALSE`.
- **Scope Implemented:**
  - `CandidateEvidence`: Atomic fact boundary with exact UTF-16 span provenance (`cv.md`, `article-digest.md`, etc.).
  - `CandidateExperience`: Experience classification (`EMPLOYMENT`, `INTERNSHIP`, `PERSONAL_PROJECT`, `ACADEMIC`, etc.) enforcing `PROJECT != EMPLOYMENT`.
  - `CandidateSkillEvidence`: Candidate technology mentions normalized to shared Phase-2 `SkillConcept` registry.
  - `CandidateCapability`: Explicit activity + object capabilities with responsibility levels and environment types.
  - `CandidateEducation` & `CandidateCertification`: Conservative status (`IN_PROGRESS` vs `COMPLETED`), separating coursework from certifications.
  - Fail-closed admission control: missing/invalid `evidence_role` rejected (`MISSING_EVIDENCE_ROLE`).
  - Source isolation: candidate data never alters job semantics; job data never alters candidate semantics.
  - Anti-matching boundary: Phase 3 performs no matching, ranking, or apply/reject decisions.
- **Delivered Files:**
  - `src/agent/domain/semantic/schemas/CandidateEvidence.json`
  - `src/agent/domain/semantic/schemas/CandidateExperience.json`
  - `src/agent/domain/semantic/schemas/CandidateSkillEvidence.json`
  - `src/agent/domain/semantic/schemas/CandidateEducation.json`
  - `src/agent/domain/semantic/schemas/CandidateCertification.json`
  - `src/agent/domain/semantic/candidate-semantic-profiler.mjs`
  - `src/agent/domain/semantic/candidate-shadow.mjs`
  - `evals/fixtures/candidate-semantic-adversarial.json` (25 cases)
  - `scripts/eval-candidate-semantic.mjs`
  - Tests: `tests/agent/domain/candidate-*.test.mjs` (8 suites, 67 tests)
- **Evaluation Limitations:** Benchmark metrics are PROVISIONAL and SYNTHETIC, not sufficient for production promotion.

---

### Phase 4: Candidate Capability & Requirement Matching
- **Status:** ENGINEERING COMPLETE (SHADOW MODE ONLY)
- **Production Authority:** Legacy candidate matching preserved (`src/agent/domain/candidate/candidate-fit-gate.mjs`). `PRODUCTION_SEMANTIC_CUTOVER = FALSE`.
- **Scope Implemented:**
  - `RequirementMatchResult`: Canonical requirement-level match entity with closed relation vocabulary (`SATISFIES`, `PARTIALLY_SUPPORTS`, `RELATED_BUT_INSUFFICIENT`, `CONTRADICTS`, `NO_EVIDENCE`, `UNKNOWN`).
  - `CandidateMatchProfile`: Unified collection with descriptive summary counts (zero weighted scores or ranking).
  - High-recall bounded candidate retrieval per JobRequirement across skills, capabilities, experiences, education, certifications, and atomic evidence.
  - System-1 semantic relationship classification with explicit non-extrapolation prompt.
  - Deterministic policy invariants:
    - No candidate evidence -> No SATISFIES.
    - Semantic relatedness != requirement satisfaction.
    - Project experience != professional employment (`PROJECT_EMPLOYMENT_CONFUSION`).
    - Test/local deployment != production (`TEST_PRODUCTION_CONFUSION`).
    - Coursework != certification (`COURSE_CERTIFICATION_CONFUSION`).
    - In-progress degree != completed degree (`DEGREE_INCOMPLETE`).
    - Unverified duration != duration satisfaction (`DURATION_UNVERIFIED`).
    - Model-invented / dangling IDs fail closed (`DANGLING_OR_INVALID_CANDIDATE_REFERENCE`).
    - Contradiction requires explicit evidence; absence is not contradiction.
  - Shadow-only execution mode (`features.semantic_requirement_matching = 'shadow'`) with PII-free telemetry.
- **Delivered Files:**
  - `src/agent/domain/semantic/schemas/RequirementMatchResult.json`
  - `src/agent/domain/semantic/schemas/CandidateMatchProfile.json`
  - `src/agent/domain/semantic/schemas/MatchProfile.json` (unified with `oneOf`)
  - `src/agent/domain/semantic/candidate-evidence-retriever.mjs`
  - `src/agent/domain/semantic/requirement-matcher.mjs`
  - `src/agent/domain/semantic/requirement-match-shadow.mjs`
  - `evals/fixtures/requirement-matching-adversarial.json` (30 cases)
  - `scripts/eval-requirement-matching.mjs`
  - Tests: `tests/agent/domain/requirement-match-*.test.mjs`, `tests/agent/domain/candidate-evidence-retriever.test.mjs`
- **Evaluation Limitations:** Benchmark metrics are PROVISIONAL and SYNTHETIC, not sufficient for production cutover.

---

### Phase 5: Decision Policy, Ranking & Explainability
- **Status:** ENGINEERING COMPLETE (SHADOW MODE ONLY)
- **Production Authority:** Legacy candidate fit and ranking authority preserved (`src/agent/domain/candidate/candidate-fit-gate.mjs`). `PRODUCTION_DECISION_CUTOVER = FALSE`.
- **Scope Implemented:**
  - `PolicyAssessment`: Deterministic policy evaluation, component breakdown, bounded score (0–100), priority bands (`HIGH_PRIORITY`, `MEDIUM_PRIORITY`, `LOW_PRIORITY`, `INSUFFICIENT_INFORMATION`).
  - `RequirementPolicyResult`: Deterministic per-requirement policy audit trail.
  - `PolicyConfiguration`: Versioned match policy rules, weights, and component limits as data.
  - Multi-job ranking: pure deterministic ranking (`rankJobAssessments`), permutation-invariant, with explicit tie-breakers (score → contradictions → required coverage → unknowns → stable ID).
  - Explainability: evidence-grounded structured explanation facts (`POSITIVE`, `NEGATIVE`, `UNCERTAINTY`, `BLOCKER`) and deterministic prose formatter.
  - Non-authoritative presentation renderer: optional LLM prose formatting is presentation-only and cannot alter scores, bands, or facts.
  - Uncertainty distinction: `INSUFFICIENT_INFORMATION != LOW_PRIORITY`.
  - Contradiction distinction: `CONTRADICTS != NO_EVIDENCE`.
  - Hard gates require explicit Phase-4 contradiction; absence never hard-gates.
  - Fairness boundary: sensitive/protected attributes cannot influence scoring or ranking.
  - Shadow-only execution mode (`features.semantic_decision_policy = 'shadow'`) with PII-free telemetry.
- **Delivered Files:**
  - `src/agent/domain/semantic/schemas/PolicyAssessment.json`
  - `src/agent/domain/semantic/schemas/PolicyConfiguration.json`
  - `src/agent/domain/semantic/schemas/RequirementPolicyResult.json`
  - `src/agent/domain/semantic/policy-configuration.mjs`
  - `src/agent/domain/semantic/decision-policy-engine.mjs`
  - `src/agent/domain/semantic/job-ranker.mjs`
  - `src/agent/domain/semantic/policy-explanation-renderer.mjs`
  - `src/agent/domain/semantic/decision-policy-shadow.mjs`
  - `evals/fixtures/decision-policy-adversarial.json` (30 cases)
  - `scripts/eval-decision-policy.mjs`
  - Tests: `tests/agent/domain/decision-policy-*.test.mjs`, `tests/agent/domain/job-ranker.test.mjs`, `tests/agent/domain/policy-explanation.test.mjs`
- **Evaluation Limitations:** Benchmark metrics are PROVISIONAL and SYNTHETIC, not sufficient for production cutover.

---

### Phase 6: Deduplication & Semantic Requisition Comparison
- **Replaces:** `role-matcher.mjs` `roleFuzzyMatch` Jaccard threshold (RZ-08), `MTS_PREFIX` (RZ-06), `ROLE_STOPWORDS` (RZ-05), `SHORT_SPECIALTY` (RZ-07).
- **Scope:** Deploy `JOB_DUPLICATE_SEMANTIC_COMPARISON`. Tier 1-3 (URL, Req ID, Report #) remain deterministic; Tier 4 fuzzy title match replaced by semantic duplicate evaluation with fail-safe preservation.
- **Target Files:**
  - Create: `src/agent/domain/semantic/job-dedup-intelligence.mjs`
  - Modify: `merge-tracker.mjs`
  - Modify: `dedup-tracker.mjs`
  - Test: `tests/semantic-dedup.test.mjs`
- **Acceptance Criteria:** Destructive row loss equals strictly 0; duplicate detection recall $> 95\%$ on title variants.

---

### Phase 7: ATS Field & Custom Question Classification
- **Replaces:** `ats-preparation.mjs` `semanticTypeFor` (AG-09) and `classifyCustomQuestion` (AG-10).
- **Scope:** Deploy `ATS_FIELD_SEMANTIC_CLASSIFICATION` and `CUSTOM_APPLICATION_QUESTION_CLASSIFICATION`. Strict deterministic boundary: model classifies, code enforces `DO_NOT_ANSWER` for sensitive fields and legal attestations.
- **Target Files:**
  - Create: `src/agent/domain/semantic/ats-semantic-classifier.mjs`
  - Modify: `src/agent/domain/applications/ats-preparation.mjs`
  - Test: `tests/agent/domain/ats-preparation.test.mjs`
- **Acceptance Criteria:** Zero auto-fill proposals for legal attestations or demographic fields; 100% classification accuracy on standard contact/education fields.

---

### Phase 8: Discovery Query Expansion
- **Replaces:** Static role keyword arrays in `portals.example.yml` and manual title expansion.
- **Scope:** Deploy `DISCOVERY_QUERY_EXPANSION` to generate dynamic portal search keywords and negative filters based on candidate profile.
- **Target Files:**
  - Create: `src/agent/domain/semantic/discovery-expander.mjs`
  - Modify: `scan.mjs`
  - Test: `tests/discovery-expander.test.mjs`
- **Acceptance Criteria:** Discovers 25% more relevant postings within candidate archetypes without increasing spam/irrelevant scan influx.

---

### Phase 9: Presentation Surfaces & Telegram Explainability
- **Scope:** Wire structured `MatchProfile` and provenance spans directly into Telegram notifications (`telegram.mjs`), report generation (`oferta.md`), and web dashboard views. Eliminate diverging explanation heuristics.
- **Target Files:**
  - Modify: `telegram.mjs`
  - Modify: `modes/oferta.md`
  - Modify: `web/src/components/`
  - Test: `tests/presentation-explainability.test.mjs`
- **Acceptance Criteria:** Telegram alert, PDF report, and dashboard display the exact same evidence quotes and match rationales.

---

## 3. Shadow Mode Architecture & Disagreement Schema

```
  RAW JD ──┬──> [ Legacy Heuristic / Regex ] ────> Legacy Verdict ──┐
           │                                                        ├──> [ Disagreement Logger ] ──> data/shadow-telemetry.jsonl
           └───> [ System 1 Semantic Task ]  ────> Semantic Verdict ┘
                                                       │
                                      (Shadow Mode: Legacy Drives State)
```

### Shadow Telemetry Record Schema:
```json
{
  "timestamp_utc": "2026-10-16T19:45:00Z",
  "job_id": "JOB-042",
  "source_url": "https://company.com/jobs/123",
  "component": "SENIORITY_CLASSIFICATION",
  "legacy_result": { "passed": false, "reason": "SENIOR_TITLE_FILTERED", "raw_token": "lead" },
  "semantic_result": { "level": "JUNIOR", "confidence": 0.92, "is_early_career_friendly": true },
  "disagreement_type": "LEGACY_FALSE_REJECT_CANDIDATE",
  "evidence_span": "Software Engineer - Tech Lead mentee program",
  "human_adjudication": null
}
```

### Promotion Gate Criteria:
A phase is promoted from Shadow to Primary only when:
1. Minimum **100 consecutive jobs** processed in shadow mode.
2. Disagreement review reveals **zero ungrounded hallucinations**.
3. False Reject Rate is proven lower than legacy heuristics with statistical significance.
4. Latency and gateway budgets remain within zero-incremental-cost bounds.
