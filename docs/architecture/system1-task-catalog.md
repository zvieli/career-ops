# Career-Ops v1.2 — System-1 Semantic Task Catalog

**Architecture Milestone:** v1.2 — Semantic Intelligence Audit & System-1 Refactor Specification  
**Status:** DRAFT SPECIFICATION (AUDIT-ONLY — NO CODE REFACTOR APPLIED)  
**Target Logical Model Tier:** SYSTEM1 (Fast, Structured, Zero-Incremental-Cost Gateway)  
**Escalation Tier:** SYSTEM2 (Deep Reasoning Gateway — Ambiguity & High-Impact Uncertainty Only)  

---

## 1. Architectural Overview & Invariants

This catalog specifies the complete suite of seventeen (17) discrete System-1 semantic tasks designed to replace brittle regexes, keyword lists, static taxonomies, and hand-authored heuristics across the Career-Ops intelligence pipeline.

### Core Architectural Invariants:
1. **MODELS UNDERSTAND. CODE DECIDES.**
   System-1 tasks produce structured semantic evidence, relationships, and normalized concepts. Business decisions (e.g. apply vs discard, candidate fit thresholds, tracker status transitions, factuality gating) are executed strictly in deterministic code.
2. **DATA-ONLY ISOLATION & PROMPT INJECTION SAFETY:**
   Job descriptions, ATS form labels, and recruiter emails are untrusted external data. Model prompts strictly demarcate data boundaries (`<untrusted_job_description>`). No external text may modify system instructions, policy rules, tool permissions, or candidate facts.
3. **FAIL-CLOSED SCHEMA VALIDATION:**
   Every System-1 response must pass strict JSON schema validation (`additionalProperties: false`, bounded arrays, typed enums). If validation fails after bounded repair, the system fails closed to `NEEDS_REVIEW` or fallback; unvalidated text never drives business state.
4. **COMPUTATIONAL EFFICIENCY & BUNDLING:**
   Executing 17 separate LLM calls per job posting would introduce unacceptable latency and rate limits. The catalog supports **Task Bundling**: the composite task `JOB_SEMANTIC_PROFILE` executes sub-tasks (2 through 11) in a single structured extraction pass. Standalone tasks are invoked only during modular workflows (e.g. discovery query expansion, standalone ATS preparation, deduplication).
5. **DETERMINISTIC CACHING:**
   Every task output is cached by a cryptographic digest of `(task_id, task_version, prompt_version, model_id, normalized_input_hash)`.

---

## 2. Shared Provenance & Evidence Contracts

All System-1 tasks emit claims grounded in immutable provenance records.

```typescript
export interface ProvenanceRecord {
  source: "job_description" | "candidate_profile" | "cv_canonical" | "ats_form" | "email_reply" | "derived";
  source_hash: string;         // SHA-256 of the exact input text
  evidence_span: {
    start_char: number;        // UTF-8 start character offset
    end_char: number;          // UTF-8 end character offset
    verbatim_text: string;     // Exact substring matching source text
  };
  semantic_task: string;       // e.g. "SKILL_EXTRACTION"
  model_tier: "SYSTEM1" | "SYSTEM2";
  model_id: string;            // Exact physical model (e.g. "gemini-3.8-flash")
  prompt_version: string;      // e.g. "v1.2.0"
  schema_version: string;      // e.g. "v1.2.0"
  confidence: number;          // Bounded float [0.0, 1.0]
}
```

---

## 3. The 17 System-1 Task Specifications

```
                           ┌────────────────────────────────────────────────────────┐
                           │               JOB_SEMANTIC_PROFILE (Composite)         │
                           └───────────────────────────┬────────────────────────────┘
                                                       │
         ┌───────────────────┬───────────────────┬─────┴─────────────┬───────────────────┬───────────────────┐
         ▼                   ▼                   ▼                   ▼                   ▼                   ▼
  SKILL_EXTRACTION    REQUIREMENT_EXTR    ROLE_FAMILY_CLASS   SENIORITY_CLASS     WORK_MODEL_EXTR     DOMAIN_CLASS
         │                   │                   │                   │                   │                   │
         ▼                   ▼                   ▼                   ▼                   ▼                   ▼
  SKILL_NORMALIZ      REQ_IMPORTANCE      EXPERIENCE_REQ      EDUCATION_REQ
```

---

### Task 1: `JOB_SEMANTIC_PROFILE` (Composite Master Extraction)
- **Status:** IMPLEMENTED IN PHASE 1 (SHADOW MODE)
- **Description:** Single-pass extraction of job semantic dimensions from raw JD text. In Phase 1, bundles Tasks 4 through 11 (Requirements, Importance, Role Family, Seniority, Experience YOE, Education, Work Model, Domain) into a single bounded System-1 model gateway call. Tasks 2 & 3 (Skill Extraction and Concept Graph Normalization) remain Phase 2.
- **Input Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "title": { "type": "string" },
      "company": { "type": "string" },
      "jd_text": { "type": "string", "minLength": 50 },
      "source_url": { "type": "string", "format": "uri" }
    },
    "required": ["title", "company", "jd_text"],
    "additionalProperties": false
  }
  ```
- **Output Schema:** Canonical `JobSemanticProfile` (`src/agent/domain/semantic/schemas/JobSemanticProfile.json`).
- **Allowed Evidence:** Verbatim substrings from `jd_text`.
- **Provenance:** Every requirement, skill, and numeric constraint must carry an exact `evidence_span`.
- **Confidence:** Minimum confidence across extracted critical requirements (YOE, Education, Primary Domain).
- **Fallback:** Fast regex/heuristic Tier 0 extraction (`job-evaluator.mjs`) marked with `confidence: 0.2` and `status: "NEEDS_REVIEW"`.
- **SYSTEM2 Escalation:** Triggered if `overall_confidence < 0.75`, if YOE requirements are contradictory, or if ambiguous alternative qualifications exist.
- **Caching:** Cache key `sha256(task_version + prompt_version + sha256(jd_text))`. Retained for 30 days.
- **Safety:** Input wrapped in `<untrusted_job_description>` with delimiter escaping.

---

### Task 2: `SKILL_EXTRACTION`

- **Description:** Contextually extracts declared technologies, tools, architectures, and libraries from job or CV text, distinguishing substantive use from passing metaphors.
- **Input Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "text": { "type": "string" },
      "context_type": { "type": "string", "enum": ["JOB_DESCRIPTION", "CANDIDATE_CV", "STAR_STORY"] }
    },
    "required": ["text", "context_type"],
    "additionalProperties": false
  }
  ```
- **Output Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "raw_skills": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "surface_form": { "type": "string" },
            "category": { "type": "string", "enum": ["LANGUAGE", "FRAMEWORK", "DATABASE", "INFRASTRUCTURE", "AI_ML", "TOOL", "METHODOLOGY"] },
            "evidence_span": { "$ref": "#/definitions/EvidenceSpan" }
          },
          "required": ["surface_form", "category", "evidence_span"],
          "additionalProperties": false
        }
      }
    },
    "required": ["raw_skills"],
    "additionalProperties": false
  }
  ```
- **Allowed Evidence:** Substrings of `text`.
- **Provenance:** Exact character offsets and verbatim match against input.
- **Confidence:** Scored by linguistic clarity of technical usage vs general noun.
- **Fallback:** Core regex token extraction (`skill-extract.mjs`).
- **SYSTEM2 Escalation:** Disallowed (handled in System 1).
- **Caching:** Keyed on `sha256(text)`.
- **Safety:** Data-only parsing; prompt instructs model to ignore directives in text.

---

### Task 3: `SKILL_NORMALIZATION`

- **Description:** Normalizes extracted surface forms into canonical concept entities and maps relationship tiers (EXACT, EQUIVALENT, STRONG_RELATED, TRANSFERABLE, PARTIAL, NO_EVIDENCE, UNKNOWN).
- **Input Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "surface_form": { "type": "string" },
      "category": { "type": "string" }
    },
    "required": ["surface_form"],
    "additionalProperties": false
  }
  ```
- **Output Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "canonical_name": { "type": "string" },
      "concept_id": { "type": "string" },
      "parent_domain": { "type": "string" },
      "equivalents": { "type": "array", "items": { "type": "string" } },
      "transferable_from": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["canonical_name", "concept_id", "parent_domain"],
    "additionalProperties": false
  }
  ```
- **Allowed Evidence:** Knowledge of software taxonomy; no JD evidence required.
- **Provenance:** Model tier and prompt version.
- **Confidence:** Fixed high for known standards; lower for proprietary internal terms.
- **Fallback:** Deterministic `CANONICAL` dictionary lookup from `skill-extract.mjs`.
- **SYSTEM2 Escalation:** Permitted only when comparing novel proprietary stacks against candidate proof points during tailoring.
- **Caching:** Keyed on `surface_form.toLowerCase().trim()`. Global TTL 90 days.
- **Safety:** Static ontology mapping; zero prompt injection risk.

---

### Task 4: `REQUIREMENT_EXTRACTION`

- **Description:** Deconstructs job requirements into atomic, verifiable requirement objects.
- **Input Schema:**
  ```json
  {
    "type": "object",
    "properties": { "jd_text": { "type": "string" } },
    "required": ["jd_text"],
    "additionalProperties": false
  }
  ```
- **Output Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "requirements": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "requirement_id": { "type": "string" },
            "description": { "type": "string" },
            "type": { "type": "string", "enum": ["TECHNICAL_SKILL", "YEARS_EXPERIENCE", "EDUCATION", "LEGAL_AUTHORIZATION", "LANGUAGE", "SECURITY_CLEARANCE", "SOFT_SKILL"] },
            "evidence_quote": { "type": "string" }
          },
          "required": ["requirement_id", "description", "type", "evidence_quote"],
          "additionalProperties": false
        }
      }
    },
    "required": ["requirements"],
    "additionalProperties": false
  }
  ```
- **Allowed Evidence:** Verbatim lines from `jd_text`.
- **Provenance:** Quote must exist verbatim in source text.
- **Confidence:** Syntactic certainty of requirement statement.
- **Fallback:** Line-by-line bullet parsing (`BULLET_LINE_RE`).
- **SYSTEM2 Escalation:** Escalates if requirement structure is ambiguous or narrative-only.
- **Caching:** Keyed on `sha256(jd_text)`.
- **Safety:** Data-only parsing in isolated block.

---

### Task 5: `REQUIREMENT_IMPORTANCE_CLASSIFICATION`

- **Description:** Classifies each atomic requirement into legal, mandatory, preferred, or narrative context.
- **Input Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "requirement_text": { "type": "string" },
      "section_header": { "type": "string" }
    },
    "required": ["requirement_text"],
    "additionalProperties": false
  }
  ```
- **Output Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "importance": { "type": "string", "enum": ["LEGAL_ADMINISTRATIVE", "REQUIRED", "PREFERRED", "OPTIONAL", "RESPONSIBILITY", "CONTEXT"] },
      "justification": { "type": "string" },
      "confidence": { "type": "number", "minimum": 0.0, "maximum": 1.0 }
    },
    "required": ["importance", "confidence"],
    "additionalProperties": false
  }
  ```
- **Allowed Evidence:** Modal verbs ("must", "required", "preferred", "bonus", "plus") and section header context.
- **Provenance:** Substring citation.
- **Confidence:** Clear modal verb = 1.0; ambiguous bullet header = 0.6.
- **Fallback:** Default to `REQUIRED` if under "Requirements" header; `PREFERRED` if under "Nice to have" or contains "bonus".
- **SYSTEM2 Escalation:** Escalates if requirement contradicts itself across sections.
- **Caching:** Keyed on `sha256(section_header + requirement_text)`.
- **Safety:** Classification only; does not authorize waiver.

---

### Task 6: `ROLE_FAMILY_CLASSIFICATION`

- **Description:** Maps job posting to candidate target archetypes and primary technical role families.
- **Input Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "title": { "type": "string" },
      "jd_text": { "type": "string" },
      "target_archetypes": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["title", "jd_text"],
    "additionalProperties": false
  }
  ```
- **Output Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "primary_family": { "type": "string" },
      "specialization": { "type": "string" },
      "matched_archetypes": { "type": "array", "items": { "type": "string" } },
      "is_target_match": { "type": "boolean" },
      "confidence": { "type": "number", "minimum": 0.0, "maximum": 1.0 }
    },
    "required": ["primary_family", "specialization", "is_target_match", "confidence"],
    "additionalProperties": false
  }
  ```
- **Allowed Evidence:** Title and JD responsibility summary.
- **Provenance:** Quoted title and responsibility lines.
- **Confidence:** Alignment clarity between title and JD duties.
- **Fallback:** `role-matcher.mjs` keyword taxonomy matching.
- **SYSTEM2 Escalation:** Escalates if role is a hybrid across non-adjacent engineering families.
- **Caching:** Keyed on `sha256(title + jd_text)`.
- **Safety:** Models categorize; code decides shortlist routing.

---

### Task 7: `SENIORITY_CLASSIFICATION`

- **Description:** Determines true operational seniority level by synthesizing title, explicit YOE, architectural autonomy, and team leadership signals.
- **Input Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "title": { "type": "string" },
      "responsibilities": { "type": "array", "items": { "type": "string" } },
      "required_yoe": { "type": ["number", "null"] }
    },
    "required": ["title"],
    "additionalProperties": false
  }
  ```
- **Output Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "level": { "type": "string", "enum": ["INTERN", "JUNIOR", "ENTRY", "MID", "SENIOR", "STAFF_PRINCIPAL", "DIRECTOR_PLUS", "UNKNOWN"] },
      "is_early_career_friendly": { "type": "boolean" },
      "evidence_signals": {
        "type": "object",
        "properties": {
          "title_level": { "type": "string" },
          "yoe_level": { "type": "string" },
          "responsibility_scope": { "type": "string", "enum": ["TASK_EXECUTION", "INDEPENDENT_FEATURE", "SYSTEM_OWNERSHIP", "CROSS_ORG_ARCHITECTURE"] }
        },
        "required": ["title_level", "responsibility_scope"],
        "additionalProperties": false
      },
      "confidence": { "type": "number", "minimum": 0.0, "maximum": 1.0 }
    },
    "required": ["level", "is_early_career_friendly", "evidence_signals", "confidence"],
    "additionalProperties": false
  }
  ```
- **Allowed Evidence:** Title text, YOE clauses, responsibility bullet phrases.
- **Provenance:** Spans in title and JD.
- **Confidence:** Agreement across title, YOE, and responsibilities = 1.0; disagreement = 0.5.
- **Fallback:** Regex seniority check (`SENIOR_TITLE`).
- **SYSTEM2 Escalation:** Escalates if title is 'Senior' but responsibilities/YOE explicitly describe junior mentorship roles (inflated title syndrome).
- **Caching:** Keyed on `sha256(title + required_yoe + responsibilities.join())`.
- **Safety:** Eliminates false-positive early career filtering.

---

### Task 8: `EXPERIENCE_REQUIREMENT_EXTRACTION`

- **Description:** Extracts numeric and qualitative professional experience requirements, separating overall YOE from skill-specific YOE.
- **Input Schema:**
  ```json
  {
    "type": "object",
    "properties": { "jd_text": { "type": "string" } },
    "required": ["jd_text"],
    "additionalProperties": false
  }
  ```
- **Output Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "overall_years_required": { "type": ["number", "null"] },
      "overall_years_preferred": { "type": ["number", "null"] },
      "skill_specific_years": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "skill": { "type": "string" },
            "years": { "type": "number" },
            "is_mandatory": { "type": "boolean" }
          },
          "required": ["skill", "years", "is_mandatory"],
          "additionalProperties": false
        }
      },
      "is_ambiguous": { "type": "boolean" },
      "evidence_quotes": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["overall_years_required", "overall_years_preferred", "is_ambiguous", "evidence_quotes"],
    "additionalProperties": false
  }
  ```
- **Allowed Evidence:** Verbatim YOE sentences in JD.
- **Provenance:** Exact quote matching source JD.
- **Confidence:** Clarity of numeric statement.
- **Fallback:** Regex numeric matcher (`\d+\+?\s*years`).
- **SYSTEM2 Escalation:** Escalates if YOE is expressed as a range across contradictory educational tiers ("BS with 5 years or MS with 2 years").
- **Caching:** Keyed on `sha256(jd_text)`.
- **Safety:** Code policy evaluates candidate shortfall against this extracted number.

---

### Task 9: `EDUCATION_REQUIREMENT_EXTRACTION`

- **Description:** Extracts degree level, required fields of study, GPA thresholds, and equivalent experience allowances.
- **Input Schema:**
  ```json
  {
    "type": "object",
    "properties": { "jd_text": { "type": "string" } },
    "required": ["jd_text"],
    "additionalProperties": false
  }
  ```
- **Output Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "min_degree_level": { "type": ["string", "null"], "enum": ["NONE", "ASSOCIATE", "BACHELOR", "MASTER", "DOCTORATE", null] },
      "fields_of_study": { "type": "array", "items": { "type": "string" } },
      "equivalent_experience_allowed": { "type": "boolean" },
      "min_gpa": { "type": ["number", "null"] },
      "gpa_scale": { "type": ["string", "null"] },
      "evidence_quote": { "type": "string" }
    },
    "required": ["min_degree_level", "fields_of_study", "equivalent_experience_allowed", "evidence_quote"],
    "additionalProperties": false
  }
  ```
- **Allowed Evidence:** Education section quotes.
- **Provenance:** Quote in JD.
- **Confidence:** Clear degree requirement = 1.0; implicit preference = 0.7.
- **Fallback:** `degreeLevel()` regex check.
- **SYSTEM2 Escalation:** Escalates on foreign degree equivalence questions.
- **Caching:** Keyed on `sha256(jd_text)`.
- **Safety:** Code compares candidate degree against this structured output.

---

### Task 10: `WORK_MODEL_EXTRACTION`

- **Description:** Extracts remote, hybrid, or onsite working policy, location boundaries, and timezone constraints.
- **Input Schema:**
  ```json
  {
    "type": "object",
    "properties": { "jd_text": { "type": "string" }, "raw_location": { "type": "string" } },
    "required": ["jd_text"],
    "additionalProperties": false
  }
  ```
- **Output Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "work_model": { "type": "string", "enum": ["REMOTE", "HYBRID", "ONSITE", "UNKNOWN"] },
      "allowed_locations": { "type": "array", "items": { "type": "string" } },
      "hybrid_days_in_office": { "type": ["number", "null"] },
      "timezone_restrictions": { "type": "array", "items": { "type": "string" } },
      "evidence_quote": { "type": "string" }
    },
    "required": ["work_model", "allowed_locations", "evidence_quote"],
    "additionalProperties": false
  }
  ```
- **Allowed Evidence:** Location string and JD text clauses.
- **Provenance:** Quoted phrase in JD.
- **Confidence:** Explicit "100% remote" = 1.0; vague "flexible" = 0.5.
- **Fallback:** Regex location keyword checks.
- **SYSTEM2 Escalation:** Escalates on contradictory remote statements (e.g. "Remote role based in Berlin office").
- **Caching:** Keyed on `sha256(raw_location + jd_text)`.
- **Safety:** Direct input to candidate location gate.

---

### Task 11: `DOMAIN_CLASSIFICATION`

- **Description:** Identifies industry vertical, technological stack maturity, and architectural paradigms (e.g. Agentic AI, Fintech, Cloud Infrastructure).
- **Input Schema:**
  ```json
  {
    "type": "object",
    "properties": { "company": { "type": "string" }, "jd_text": { "type": "string" } },
    "required": ["jd_text"],
    "additionalProperties": false
  }
  ```
- **Output Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "primary_vertical": { "type": "string" },
      "technical_domain": { "type": "string" },
      "architectural_style": { "type": "string", "enum": ["MONOLITH", "MICROSERVICES", "EVENT_DRIVEN", "AGENTIC_AI", "EMBEDDED", "DATA_PIPELINE", "UNKNOWN"] }
    },
    "required": ["primary_vertical", "technical_domain", "architectural_style"],
    "additionalProperties": false
  }
  ```
- **Allowed Evidence:** Company mission and technical stack overview.
- **Provenance:** Quote in JD.
- **Confidence:** Model domain clarity.
- **Fallback:** Static domain lookup from `portals.yml`.
- **SYSTEM2 Escalation:** Disallowed.
- **Caching:** Keyed on `sha256(company + jd_text)`.
- **Safety:** Informs North Star score; does not hard-veto.

---

### Task 12: `CANDIDATE_CAPABILITY_EXTRACTION`

- **Description:** Extracts verified technical capabilities, achievements, and architectural scope from candidate's primary files (`cv.md`, `article-digest.md`).
- **Input Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "cv_markdown": { "type": "string" },
      "article_digest_markdown": { "type": "string" }
    },
    "required": ["cv_markdown"],
    "additionalProperties": false
  }
  ```
- **Output Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "capabilities": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "capability_id": { "type": "string" },
            "name": { "type": "string" },
            "category": { "type": "string" },
            "depth": { "type": "string", "enum": ["EXPOSURE", "PRACTICAL", "PRODUCTION", "EXPERT"] },
            "evidence_quote": { "type": "string" },
            "source_file": { "type": "string" }
          },
          "required": ["capability_id", "name", "category", "depth", "evidence_quote", "source_file"],
          "additionalProperties": false
        }
      }
    },
    "required": ["capabilities"],
    "additionalProperties": false
  }
  ```
- **Allowed Evidence:** Only primary user files (`cv.md`, `article-digest.md`).
- **Provenance:** Verbatim source quotes and file origin.
- **Confidence:** Must be 1.0 (primary ground truth).
- **Fallback:** Deterministic section heading parse.
- **SYSTEM2 Escalation:** Disallowed.
- **Caching:** Keyed on `sha256(cv_markdown + article_digest_markdown)`. Cached per candidate revision.
- **Safety:** NEVER fabricates; captures only what is written in primary files.

---

### Task 13: `REQUIREMENT_CANDIDATE_MATCH`

- **Description:** Evaluates semantic alignment between an atomic job requirement and candidate capabilities.
- **Input Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "requirement": { "$ref": "#/definitions/JobRequirement" },
      "candidate_capabilities": { "type": "array", "items": { "$ref": "#/definitions/CandidateCapability" } }
    },
    "required": ["requirement", "candidate_capabilities"],
    "additionalProperties": false
  }
  ```
- **Output Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "relation": { "type": "string", "enum": ["EXACT", "EQUIVALENT", "STRONG_RELATED", "TRANSFERABLE", "PARTIAL", "NO_EVIDENCE", "UNKNOWN"] },
      "matched_capability_id": { "type": ["string", "null"] },
      "match_rationale": { "type": "string" },
      "confidence": { "type": "number", "minimum": 0.0, "maximum": 1.0 }
    },
    "required": ["relation", "match_rationale", "confidence"],
    "additionalProperties": false
  }
  ```
- **Allowed Evidence:** Explicit candidate capability quotes and job requirement text.
- **Provenance:** Linked requirement ID and capability ID.
- **Confidence:** Linguistic and conceptual distance.
- **Fallback:** Exact keyword token match (`keyword-match.mjs`).
- **SYSTEM2 Escalation:** Escalates if relationship is borderline between TRANSFERABLE and NO_EVIDENCE on a mandatory requirement.
- **Caching:** Keyed on `sha256(requirement.id + candidate_hash)`.
- **Safety:** Never infers candidate skills absent from primary evidence.

---

### Task 14: `JOB_DUPLICATE_SEMANTIC_COMPARISON`

- **Description:** Compares two job postings at the same company to determine if they represent the exact same requisition or distinct job openings.
- **Input Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "job_a": { "type": "object", "properties": { "title": { "type": "string" }, "jd_excerpt": { "type": "string" }, "location": { "type": "string" } }, "required": ["title", "jd_excerpt"] },
      "job_b": { "type": "object", "properties": { "title": { "type": "string" }, "jd_excerpt": { "type": "string" }, "location": { "type": "string" } }, "required": ["title", "jd_excerpt"] }
    },
    "required": ["job_a", "job_b"],
    "additionalProperties": false
  }
  ```
- **Output Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "is_duplicate": { "type": "boolean" },
      "confidence": { "type": "number", "minimum": 0.0, "maximum": 1.0 },
      "relationship": { "type": "string", "enum": ["EXACT_REPOST", "TITLE_VARIANT_SAME_REQ", "DIFFERENT_SENIORITY_LEVEL", "DIFFERENT_TEAM_SAME_ROLE", "ENTIRELY_DIFFERENT_JOB"] },
      "rationale": { "type": "string" }
    },
    "required": ["is_duplicate", "confidence", "relationship", "rationale"],
    "additionalProperties": false
  }
  ```
- **Allowed Evidence:** Title, responsibilities, and team descriptors in both excerpts.
- **Provenance:** Quote comparisons from both jobs.
- **Confidence:** Level of certainty regarding requisition identity.
- **Fallback:** Return `is_duplicate: false` (fail-safe: preserve both rows).
- **SYSTEM2 Escalation:** Escalates if confidence is between 0.4 and 0.7.
- **Caching:** Keyed on `sha256(job_a.id + job_b.id)`.
- **Safety:** Uncertain duplicates are NEVER merged automatically.

---

### Task 15: `ATS_FIELD_SEMANTIC_CLASSIFICATION`

- **Description:** Semantically categorizes an ATS application form field label/name to match against canonical candidate profile fields.
- **Input Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "label": { "type": "string" },
      "name": { "type": "string" },
      "control_type": { "type": "string" },
      "options": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["label", "control_type"],
    "additionalProperties": false
  }
  ```
- **Output Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "semantic_type": { "type": "string", "enum": ["FULL_NAME", "FIRST_NAME", "LAST_NAME", "EMAIL", "PHONE", "LOCATION", "LINKEDIN_URL", "GITHUB_URL", "PORTFOLIO_URL", "RESUME", "EDUCATION", "DEGREE", "GRADUATION_YEAR", "GPA", "WORK_AUTHORIZATION", "VISA_SPONSORSHIP", "YEARS_EXPERIENCE", "SPECIFIC_EXPERIENCE_YEARS", "SALARY_EXPECTATION", "NOTICE_PERIOD", "CUSTOM_QUESTION", "UNKNOWN"] },
      "confidence": { "type": "number", "minimum": 0.0, "maximum": 1.0 },
      "is_sensitive_or_legal": { "type": "boolean" }
    },
    "required": ["semantic_type", "confidence", "is_sensitive_or_legal"],
    "additionalProperties": false
  }
  ```
- **Allowed Evidence:** Field label, name attribute, and dropdown options.
- **Provenance:** Field text in form snapshot.
- **Confidence:** Linguistic clarity of field purpose.
- **Fallback:** `semanticTypeFor()` regex classifier.
- **SYSTEM2 Escalation:** Disallowed.
- **Caching:** Keyed on `sha256(label + name + control_type)`.
- **Safety:** Classifies field type only; strictly forbidden from generating answers to legal or sensitive fields.

---

### Task 16: `CUSTOM_APPLICATION_QUESTION_CLASSIFICATION`

- **Description:** Classifies free-form employer application questions into legal attestations, sensitive demographics, technical prompts, or narrative background.
- **Input Schema:**
  ```json
  {
    "type": "object",
    "properties": { "question_text": { "type": "string" } },
    "required": ["question_text"],
    "additionalProperties": false
  }
  ```
- **Output Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "category": { "type": "string", "enum": ["LEGAL_ATTESTATION", "SENSITIVE_DEMOGRAPHIC", "COMPENSATION_NOTICE", "TECHNICAL_WRITTEN_PROMPT", "EXPERIENCE_VERIFICATION", "UNKNOWN"] },
      "requires_human_answering": { "type": "boolean" },
      "rationale": { "type": "string" }
    },
    "required": ["category", "requires_human_answering", "rationale"],
    "additionalProperties": false
  }
  ```
- **Allowed Evidence:** Question text.
- **Provenance:** Form label quote.
- **Confidence:** Certainty of question category.
- **Fallback:** `classifyCustomQuestion()` regex check; defaults to `requires_human_answering: true`.
- **SYSTEM2 Escalation:** Disallowed.
- **Caching:** Keyed on `sha256(question_text)`.
- **Safety:** If `LEGAL_ATTESTATION` or `SENSITIVE_DEMOGRAPHIC`, deterministic code marks field `DO_NOT_ANSWER`.

---

### Task 17: `DISCOVERY_QUERY_EXPANSION`

- **Description:** Dynamically expands candidate target archetypes into synonymous search queries and portal keywords, replacing fixed role keyword arrays.
- **Input Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "target_archetypes": { "type": "array", "items": { "type": "string" } },
      "candidate_strengths": { "type": "array", "items": { "type": "string" } },
      "locale": { "type": "string" }
    },
    "required": ["target_archetypes"],
    "additionalProperties": false
  }
  ```
- **Output Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "search_queries": { "type": "array", "items": { "type": "string" } },
      "positive_title_keywords": { "type": "array", "items": { "type": "string" } },
      "negative_title_keywords": { "type": "array", "items": { "type": "string" } },
      "suggested_adjacent_titles": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["search_queries", "positive_title_keywords", "negative_title_keywords"],
    "additionalProperties": false
  }
  ```
- **Allowed Evidence:** Candidate profile archetypes and known market title conventions.
- **Provenance:** Derived task with profile hash.
- **Confidence:** Fixed 1.0 (generative exploration).
- **Fallback:** Static queries from `portals.example.yml`.
- **SYSTEM2 Escalation:** Disallowed.
- **Caching:** Keyed on `sha256(target_archetypes.join() + locale)`. Cached for 7 days.
- **Safety:** Generated keywords pass through regex sanity checks before entering scanner config.

---

## 4. Execution Bundling Matrix

| Invocations | Tasks Included | Primary Consumer | Gateway Target |
|---|---|---|---|
| **Bundle A (`JOB_SEMANTIC_PROFILE`)** | Tasks 2, 4, 5, 6, 7, 8, 9, 10, 11 | `auto-pipeline`, `oferta`, `job-evaluator.mjs` | System 1 (Single Call) |
| **Bundle B (`MATCH_EVALUATION`)** | Tasks 3, 13 | `candidate-fit-gate.mjs`, `matching.mjs` | System 1 (Batch Call) |
| **Standalone: Deduplication** | Task 14 | `merge-tracker.mjs`, `dedup-tracker.mjs` | System 1 (On Ambiguity) |
| **Standalone: ATS Preparation** | Tasks 15, 16 | `ats-preparation.mjs` | System 1 (On Form Extraction) |
| **Standalone: Discovery** | Task 17 | `titles mode`, `scan config setup` | System 1 (Periodic / Weekly) |
| **Standalone: Candidate Profile** | Task 12 | `master-profile mode`, `cv.md update` | System 1 (On CV Edit) |
