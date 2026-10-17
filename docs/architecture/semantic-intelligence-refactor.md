# Career-Ops v1.2 — Semantic Intelligence Architecture & System-1 Refactor Specification

**Milestone:** v1.2 — Semantic Intelligence Audit & System-1 Refactor Specification  
**Document Status:** COMPLETE ARCHITECTURE SPECIFICATION (AUDIT & PLANNING ONLY — NO REFACTOR APPLIED)  
**Baseline Git Commit:** `21889dfb99f6a5a8218d838e2c12bfe68a156c50`  
**Primary Architect:** Lead Coding Assistant (Astra High)  
**Execution Boundaries:** Read-Only Audit, Zero Production Changes, Zero Incremental Spend  

---

## 1. Executive Summary & Problem Statement

Career-Ops has reached v1.1 with mature autonomous job discovery, application lifecycle management, LangGraph orchestration, factuality-verified CV generation, ATS preparation, and human-in-the-loop Telegram supervision.

However, an exhaustive repository audit across all 2,228 tracked files reveals an architectural vulnerability: **substantial semantic intelligence is still implemented using brittle regular expressions, hard-coded keyword lists, static taxonomies, and hand-authored heuristics.**

### Core Audit Findings:
- **62 Distinct Heuristic Rule Families** were identified across production code.
- **22 Semantic Regexes** and **26 Hardcoded Keyword Sets** attempt natural language processing (e.g. detecting seniority, extracting skills, matching titles, classifying ATS form fields, and parsing visa requirements).
- **Duplicated Intelligence:** Critical semantic concepts are implemented independently across multiple layers (e.g. Seniority is classified using four conflicting keyword lists in `job-evaluator.mjs`, `candidate-fit-gate.mjs`, `role-matcher.mjs`, and `web/src/lib/analytics-metrics.mjs`).
- **High-Risk False Rejections:** Early-career candidates are routinely discarded by rigid title regexes (`\b(senior|staff|lead|architect)\b`) or naive YOE parsers that confuse preferred qualifications with mandatory minimums.

### The Objective of v1.2:
The goal is **NOT** to "replace every regex with an LLM." Regex is fast, zero-cost, and deterministic. Rather, the goal is:
1. **KEEP DETERMINISTIC LOGIC DETERMINISTIC:** Parsing URLs, requisition IDs, cryptographic hashes, mathematical GPA comparisons, file paths, and database state transitions must remain in code.
2. **MOVE SEMANTIC INTERPRETATION INTO A BOUNDED SYSTEM-1 LAYER:** Understanding context, skill equivalence, true seniority, and natural language requirements is delegated to structured, evidence-backed System-1 models.
3. **ESCALATE TO SYSTEM-2 ONLY FOR AMBIGUITY:** Deep reasoning is reserved strictly for contradictory requirements or high-impact edge cases.

---

## 2. Primary Architectural Principle

```
┌──────────────┐     ┌────────────────────────┐     ┌─────────────────────┐     ┌──────────────────────┐
│  RAW INPUT   │ ──> │ DETERMINISTIC PARSING  │ ──> │ SYSTEM-1 SEMANTIC   │ ──> │ DETERMINISTIC POLICY │
│ (JD, CV, ATS)│     │ (URL, IDs, Sanitation) │     │ (Entities, Spans)   │     │ (Thresholds, Vetoes) │
└──────────────┘     └────────────────────────┘     └──────────┬──────────┘     └──────────┬───────────┘
                                                               │                           │
                                                    Ambiguity / Low Conf        Uncertainty / High Impact
                                                               │                           │
                                                               ▼                           ▼
                                                    ┌─────────────────────┐     ┌──────────────────────┐
                                                    │ SYSTEM-2 REASONING  │     │ HUMAN REVIEW         │
                                                    │ (Deep Resolution)   │     │ (Telegram HITL)      │
                                                    └─────────────────────┘     └──────────────────────┘
```

> **"MODELS UNDERSTAND. CODE DECIDES."**

- **Models Understand:** System-1 models extract structured semantic facts, identify conceptual relationships, and cite exact textual spans. Models NEVER decide whether a candidate is rejected or whether an application is submitted.
- **Code Decides:** Deterministic business logic applies candidate thresholds (e.g. YOE shortfall $\ge 4$ years $\rightarrow$ REJECT), enforces legal and ethical safety boundaries (`DO_NOT_ANSWER`), manages lifecycle state, and logs audit ledgers.

---

## 3. End-to-End Current Intelligence Flow Map

The table below maps every stage of the current Career-Ops pipeline, identifying raw inputs, current semantic assumptions, owning symbols, and downstream dependencies.

| Stage | Raw Input | Semantic Assumptions | Owning Module & Symbol | Logic Type | Downstream Decisions Affected |
|---|---|---|---|---|---|
| **1. DISCOVERY** | Portal URLs, ATS listings, API feeds | Keywords in titles reflect relevance; non-listed titles are irrelevant | `scan.mjs` (`buildPositiveTitleFilter`), `title-keywords.mjs` | Heuristic (Regex) | Which jobs enter the inbox (`data/pipeline.md`) |
| **2. HYDRATION** | HTML / JSON from ATS or scraper | Location strings match static country lists; no-sponsorship text means unviable | `scan.mjs` (`buildCountryEligibilityFilter`, `buildVisaFilter`) | Heuristic (Regex) | Which postings are discarded before token spend |
| **3. NORMALIZATION** | Raw location, company, title strings | Roman numerals (I-VI) and Arabic numbers define levels; locations match stopwords | `role-matcher.mjs` (`normalizeTitle`, `LEVEL_RE`, `ROLE_STOPWORDS`) | Heuristic (Regex + Set) | Tracker row identity and deduplication |
| **4. DEDUPLICATION** | URL, Req ID, Title, Company | Two titles with Jaccard overlap $\ge 0.65$ are the same requisition | `merge-tracker.mjs`, `role-matcher.mjs` (`roleFuzzyMatch`) | Heuristic (Jaccard + Rules) | Whether a job creates a new row or merges into an existing row |
| **5. ROLE CLASSIF.** | Job Title, JD text | All software jobs fit into 10 static enum families | `job-evaluator.mjs` (`VALID_ROLE_FAMILIES`) | Heuristic (Fixed Enum) | Archetype alignment score and reporting |
| **6. SKILL EXTRACTION** | Raw JD text, CV markdown | Skills are capitalized words not in `STOPWORDS` or in a 100-item array | `skill-extract.mjs` (`SKILL_TOKENS`), `jd-skill-gap.mjs` (`SKILL_TOKEN_RE`) | Heuristic (Regex + Blacklist) | ATS keyword match score, upskill gaps, CV tailoring |
| **7. REQ. EXTRACTION** | Raw JD text | Numeric `\d+\+? years` regex captures mandatory experience floor | `job-evaluator.mjs` (`filterTier0`), `candidate-fit-gate.mjs` (`detectRequiredEligibility`) | Heuristic (Regex) | Tier 0 instant rejection, eligibility gate |
| **8. CANDIDATE MATCH** | Extracted JD skills, CV skills | Technologies match via exact string or static 2D synonym tuple | `keyword-match.mjs` (`SYNONYMS`), `jd-skill-gap.mjs` (`classifySkill`) | Heuristic (Array lookup) | Skill gap report, match percentage |
| **9. CANDIDATE FIT** | YOE, Degree, GPA, Eligibility | YOE shortfall $\ge 4$ rejects; degree names match regex; senior in title rejects | `candidate-fit-gate.mjs` (`evaluateCandidateFit`, `SENIOR_TITLE`) | Hybrid (Regex + Deterministic Policy) | Candidate fit status (STRONG, REASONABLE, LONG_STRETCH, REJECT) |
| **10. SCORING & FIT** | Fit status, comp research, culture | Cultural signal capped at 2/5 if requirements contradicted; Global 1-5 | `modes/_shared.md`, `modes/oferta.md` (Block A-H) | Hybrid (LLM Rubric + Code Caps) | Overall 1-5 score in tracker and report |
| **11. SHORTLIST** | Evaluation report, Global score | Score $\ge 4.0$ recommends applying; $< 3.5$ recommends discarding | `modes/_shared.md` | Deterministic Policy | Candidate recommendation in Telegram and CLI |
| **12. CV TAILORING** | Canonical `cv.md`, LaTeX template | Bullets containing JD keywords via `.includes()` get +3 priority boost | `cv-tailoring-engine.mjs` (`scoreBullet`) | Heuristic (Substring count) | Tailored CV bullet ordering and emphasis |
| **13. ATS PREPARATION** | Scraped ATS form fields | Regex on field label identifies semantic type; sensitive fields marked DO_NOT_ANSWER | `ats-preparation.mjs` (`semanticTypeFor`, `classifyCustomQuestion`) | Hybrid (Regex + Policy) | Form mapping receipt, review checklist |
| **14. TELEGRAM REVIEW** | Evaluation receipt, fit rationale | Notification formats hardcoded summary; explanation derived ad-hoc | `telegram.mjs`, `operator.mjs` | Deterministic Presentation | Human approval / rejection decision |

---

## 4. Structural Regex vs Semantic Regex

A foundational rule of this architecture is the mandatory distinction between **STRUCTURAL_REGEX** and **SEMANTIC_REGEX**.

```
                        REGEX DISCRIMINATION MATRIX
  ┌──────────────────────────────────────────┬──────────────────────────────────────────┐
  │ STRUCTURAL_REGEX (KEEP DETERMINISTIC)    │ SEMANTIC_REGEX (MIGRATE TO SYSTEM-1)     │
  ├──────────────────────────────────────────┼──────────────────────────────────────────┤
  │ URLs, Hostnames, Requisition IDs         │ Natural language job title interpretation│
  │ Machine formats (JSON, ISO-8601 dates)   │ Seniority level & leadership scope       │
  │ Exact delimiters (Markdown tables, tags) │ Mandatory vs preferred YOE clauses       │
  │ Cryptographic hashes, UUIDs              │ Technical skill & library identification │
  │ Filesystem paths & security boundaries   │ Legal work authorization & clearance     │
  │ Verbatim number & currency extraction    │ ATS form field intent & question meaning │
  │ HTML layout & font embedding checks      │ Email reply sentiment & interview intent │
  └──────────────────────────────────────────┴──────────────────────────────────────────┘
```

### Concrete Repository Examples:
- **STRUCTURAL_REGEX (Retained):**
  - `REQ_NUMBER_RE` (`url-key.mjs:35`): `/(?:req|job\s*id|ref|r_)[\s:-]*([a-z0-9_-]*\d[a-z0-9_-]*)/i` parses machine-readable requisition identifiers.
  - `DESCRIPTOR_RE` (`verify-cv-structure.mjs:35`): `/\s*[·•-]\s*(.+)$/` validates layout punctuation in CV titles.
  - `MONEY_RE` (`salary-gap.mjs:45`): Regex extracting numerical currency values after semantic compensation text is located.
  - `sanitizeUntrustedContent` (`job-evaluator.mjs:94`): Escaping XML tag delimiters for prompt injection security.
- **SEMANTIC_REGEX (Replaced by System 1):**
  - `SENIOR_TITLE` (`candidate-fit-gate.mjs:3`): `/\b(senior|sr\.?|lead|principal|staff|director|head|chief)\b/i` attempts to deduce career level from an isolated title token.
  - `detectRequiredEligibility` (`candidate-fit-gate.mjs:21`): Regex attempting to parse immigration law and clearance requirements from unstructured prose.
  - `SKILL_TOKEN_RE` (`jd-skill-gap.mjs:217`): Capitalized word regex pretending that capitalization equals technical competence.
  - `semanticTypeFor` (`ats-preparation.mjs:48`): Cascading label regexes guessing form field semantics.

---

## 5. Canonical Semantic Entities & Detailed Strict Schemas

The System-1 architecture introduces seven (7) core domain entities. Every entity is defined with `additionalProperties: false`, strict type constraints, and immutable textual provenance.

### 5.1 `SkillConcept`
Represents an atomic technical competency, library, language, or methodology.

```json
{
  "$id": "https://career-ops.org/schemas/SkillConcept.json",
  "type": "object",
  "properties": {
    "concept_id": { "type": "string", "pattern": "^[a-z0-9-]+$" },
    "canonical_name": { "type": "string" },
    "category": { "type": "string", "enum": ["LANGUAGE", "FRAMEWORK", "DATABASE", "INFRASTRUCTURE", "AI_ML", "TOOL", "METHODOLOGY", "ARCHITECTURE"] },
    "surface_forms": { "type": "array", "items": { "type": "string" } },
    "parent_concept_id": { "type": ["string", "null"] },
    "ecosystem": { "type": "string" }
  },
  "required": ["concept_id", "canonical_name", "category", "surface_forms"],
  "additionalProperties": false
}
```

### 5.2 `CandidateCapability`
Represents a candidate's verified capability grounded in primary source documentation (`cv.md`, `article-digest.md`).

```json
{
  "$id": "https://career-ops.org/schemas/CandidateCapability.json",
  "type": "object",
  "properties": {
    "capability_id": { "type": "string" },
    "concept_id": { "type": "string" },
    "name": { "type": "string" },
    "depth": { "type": "string", "enum": ["EXPOSURE", "PRACTICAL", "PRODUCTION", "EXPERT"] },
    "years_experience": { "type": ["number", "null"] },
    "provenance": {
      "type": "object",
      "properties": {
        "source_file": { "type": "string", "enum": ["cv.md", "article-digest.md", "user-stated"] },
        "verbatim_quote": { "type": "string" },
        "source_hash": { "type": "string" }
      },
      "required": ["source_file", "verbatim_quote", "source_hash"],
      "additionalProperties": false
    }
  },
  "required": ["capability_id", "concept_id", "name", "depth", "provenance"],
  "additionalProperties": false
}
```

### 5.3 `JobRequirement`
Represents an atomic requirement extracted from a job description.

```json
{
  "$id": "https://career-ops.org/schemas/JobRequirement.json",
  "type": "object",
  "properties": {
    "requirement_id": { "type": "string" },
    "type": { "type": "string", "enum": ["TECHNICAL_SKILL", "YEARS_EXPERIENCE", "EDUCATION", "LEGAL_ADMINISTRATIVE", "WORK_MODEL", "SECURITY_CLEARANCE", "LANGUAGE", "DOMAIN_KNOWLEDGE"] },
    "importance": { "type": "string", "enum": ["LEGAL_MANDATORY", "REQUIRED", "PREFERRED", "OPTIONAL", "RESPONSIBILITY", "CONTEXT"] },
    "description": { "type": "string" },
    "target_concept_id": { "type": ["string", "null"] },
    "min_years": { "type": ["number", "null"] },
    "evidence_span": {
      "type": "object",
      "properties": {
        "start_char": { "type": "integer" },
        "end_char": { "type": "integer" },
        "verbatim_quote": { "type": "string" }
      },
      "required": ["start_char", "end_char", "verbatim_quote"],
      "additionalProperties": false
    },
    "confidence": { "type": "number", "minimum": 0.0, "maximum": 1.0 }
  },
  "required": ["requirement_id", "type", "importance", "description", "evidence_span", "confidence"],
  "additionalProperties": false
}
```

### 5.4 `JobSemanticProfile`
The comprehensive semantic representation of an evaluated job posting.

```json
{
  "$id": "https://career-ops.org/schemas/JobSemanticProfile.json",
  "type": "object",
  "properties": {
    "job_id": { "type": "string" },
    "title": { "type": "string" },
    "company": { "type": "string" },
    "role_family": { "type": "string" },
    "specialization": { "type": "string" },
    "seniority": {
      "type": "object",
      "properties": {
        "level": { "type": "string", "enum": ["INTERN", "JUNIOR", "ENTRY", "MID", "SENIOR", "STAFF_PRINCIPAL", "DIRECTOR_PLUS", "UNKNOWN"] },
        "is_early_career_friendly": { "type": "boolean" },
        "rationale": { "type": "string" }
      },
      "required": ["level", "is_early_career_friendly", "rationale"],
      "additionalProperties": false
    },
    "work_model": {
      "type": "object",
      "properties": {
        "type": { "type": "string", "enum": ["REMOTE", "HYBRID", "ONSITE", "UNKNOWN"] },
        "allowed_jurisdictions": { "type": "array", "items": { "type": "string" } }
      },
      "required": ["type", "allowed_jurisdictions"],
      "additionalProperties": false
    },
    "requirements": { "type": "array", "items": { "$ref": "JobRequirement.json" } },
    "overall_yoe_required": { "type": ["number", "null"] },
    "overall_yoe_preferred": { "type": ["number", "null"] },
    "extraction_confidence": { "type": "number", "minimum": 0.0, "maximum": 1.0 },
    "jd_hash": { "type": "string" },
    "model_metadata": {
      "type": "object",
      "properties": {
        "model_id": { "type": "string" },
        "prompt_version": { "type": "string" },
        "schema_version": { "type": "string" }
      },
      "required": ["model_id", "prompt_version", "schema_version"],
      "additionalProperties": false
    }
  },
  "required": ["job_id", "title", "company", "role_family", "seniority", "work_model", "requirements", "jd_hash", "model_metadata"],
  "additionalProperties": false
}
```

### 5.5 `CandidateSemanticProfile`
The comprehensive semantic representation of candidate facts grounded in primary evidence (`cv.md`, `article-digest.md`, `config/profile.yml`, `user-stated`).

```json
{
  "$id": "https://career-ops.org/schemas/CandidateSemanticProfile.json",
  "type": "object",
  "properties": {
    "candidate_id": { "type": "string" },
    "candidate_hash": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
    "verified_yoe": { "type": "number", "minimum": 0 },
    "verified_yoe_source": { "type": "string", "enum": ["cv.md", "config/profile.yml", "user-stated"] },
    "capabilities": { "type": "array", "items": { "$ref": "CandidateCapability.json" } },
    "education": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "degree": { "type": "string" },
          "field": { "type": "string" },
          "institution": { "type": ["string", "null"] },
          "gpa": { "type": ["number", "null"] },
          "gpa_scale": { "type": ["string", "null"] },
          "is_verified": { "type": "boolean" },
          "source_file": { "type": "string", "enum": ["cv.md", "config/profile.yml", "user-stated"] },
          "source_quote": { "type": "string" }
        },
        "required": ["degree", "field", "is_verified", "source_file", "source_quote"],
        "additionalProperties": false
      }
    },
    "legal_eligibility": {
      "type": "object",
      "properties": {
        "work_authorization": { "type": ["boolean", "null"] },
        "security_clearance": { "type": ["boolean", "null"] },
        "citizenship": { "type": ["array", "null"], "items": { "type": "string" } },
        "requires_sponsorship": { "type": ["boolean", "null"] }
      },
      "required": ["work_authorization", "security_clearance", "citizenship"],
      "additionalProperties": false
    },
    "target_roles": { "type": "array", "items": { "type": "string" } },
    "provenance_summary": {
      "type": "object",
      "properties": {
        "cv_hash": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
        "profile_config_hash": { "type": ["string", "null"] },
        "article_digest_hash": { "type": ["string", "null"] }
      },
      "required": ["cv_hash"],
      "additionalProperties": false
    }
  },
  "required": [
    "candidate_id",
    "candidate_hash",
    "verified_yoe",
    "verified_yoe_source",
    "capabilities",
    "education",
    "legal_eligibility",
    "target_roles",
    "provenance_summary"
  ],
  "additionalProperties": false
}
```

### 5.6 `RequirementMatch`
Represents the evaluated match between a single job requirement and the candidate's capabilities.

```json
{
  "$id": "https://career-ops.org/schemas/RequirementMatch.json",
  "type": "object",
  "properties": {
    "requirement_id": { "type": "string" },
    "relation": { "type": "string", "enum": ["EXACT", "EQUIVALENT", "STRONG_RELATED", "TRANSFERABLE", "PARTIAL", "NO_EVIDENCE", "UNKNOWN"] },
    "matched_capability_id": { "type": ["string", "null"] },
    "evidence_quote": { "type": "string" },
    "candidate_proof_quote": { "type": "string" },
    "is_gap": { "type": "boolean" },
    "match_confidence": { "type": "number", "minimum": 0.0, "maximum": 1.0 }
  },
  "required": ["requirement_id", "relation", "is_gap", "match_confidence"],
  "additionalProperties": false
}
```

### 5.7 `MatchProfile`
The comprehensive match artifact joining a `JobSemanticProfile` with a candidate profile.

```json
{
  "$id": "https://career-ops.org/schemas/MatchProfile.json",
  "type": "object",
  "properties": {
    "match_id": { "type": "string" },
    "job_id": { "type": "string" },
    "candidate_hash": { "type": "string" },
    "requirement_matches": { "type": "array", "items": { "$ref": "RequirementMatch.json" } },
    "yoe_comparison": {
      "type": "object",
      "properties": {
        "required_yoe": { "type": ["number", "null"] },
        "candidate_verified_yoe": { "type": "number" },
        "shortfall": { "type": "number" },
        "policy_status": { "type": "string", "enum": ["STRONG", "REASONABLE", "LONG_STRETCH", "REJECT", "NEEDS_REVIEW"] }
      },
      "required": ["candidate_verified_yoe", "shortfall", "policy_status"],
      "additionalProperties": false
    },
    "legal_eligibility_status": { "type": "string", "enum": ["ELIGIBLE", "INELIGIBLE", "NEEDS_REVIEW"] },
    "critical_gaps": { "type": "array", "items": { "type": "string" } },
    "transferable_strengths": { "type": "array", "items": { "type": "string" } },
    "overall_match_score": { "type": "number", "minimum": 1.0, "maximum": 5.0 }
  },
  "required": ["match_id", "job_id", "candidate_hash", "requirement_matches", "yoe_comparison", "legal_eligibility_status", "overall_match_score"],
  "additionalProperties": false
}
```

---

## 6. Skill Intelligence Design

The current system relies on a static 100-technology array (`SKILL_TOKENS`), a 30-pair synonym table (`SYNONYMS`), and capitalized regexes with a blacklist (`STOPWORDS`). This design creates severe blind spots and false gaps.

### 6.1 The 7-Tier Conceptual Relationship Model
System 1 categorizes candidate-to-job skill relationships into seven precise tiers:

```
  ┌─────────────────┬────────────────────────────────────────────────────────────────────────┐
  │ Relationship    │ Semantic Definition & Criteria                                         │
  ├─────────────────┼────────────────────────────────────────────────────────────────────────┤
  │ EXACT           │ Identical technology or standardized surface form (JS == JavaScript)    │
  │ EQUIVALENT      │ Functionally identical role in ecosystem (PostgreSQL == Postgres)      │
  │ STRONG_RELATED  │ Direct parent/child or tight ecosystem integration (FastAPI -> Python) │
  │ TRANSFERABLE    │ Same architectural paradigm across stacks (Durable Functions -> Celery)│
  │ PARTIAL         │ Partial conceptual overlap without direct architectural translation    │
  │ NO_EVIDENCE     │ No evidence found in candidate primary records                         │
  │ UNKNOWN         │ Ambiguous or unverified proprietary technology                         │
  └─────────────────┴────────────────────────────────────────────────────────────────────────┘
```

### 6.2 Canonical Test Case Resolutions (Without Static Dictionaries):

| Test Case | Legacy Behavior | Future System-1 Resolution | Relation Tier | Evidence Test |
|---|---|---|---|---|
| **JS vs JavaScript** | Handled only if in `SYNONYMS` | Exact alias resolution to `SkillConcept:javascript` | `EXACT` | Canonical ID match |
| **Node vs Node.js** | Handled only if in `CANONICAL` | Exact alias resolution to `SkillConcept:nodejs` | `EXACT` | Canonical ID match |
| **REST API vs Backend API** | Fails; marked as skill gap | Recognizes architectural equivalence in API development | `EQUIVALENT` | Paradigm match |
| **FastAPI vs Python Backend** | Fails; marked as skill gap | Identifies FastAPI as a primary modern Python backend framework | `STRONG_RELATED` | Ecosystem subsumption |
| **Azure Durable Functions vs Distributed Event-Driven** | Fails; marked as skill gap | Identifies stateful orchestration as transferable to event-driven architectures | `TRANSFERABLE` | Pattern match + candidate quote |
| **LangGraph vs Agent Orchestration** | Fails; LangGraph unlisted | Recognizes LangGraph as a cyclic multi-agent orchestration framework | `STRONG_RELATED` | Specialization match |
| **RAG vs Information Retrieval / LLMs** | Fails unless exact spelled RAG | Maps Retrieval-Augmented Generation to LLM information retrieval | `EQUIVALENT` | Conceptual expansion |

---

## 7. Seniority & Experience Intelligence

### The Failure of Title-Only Regexes
Currently, `candidate-fit-gate.mjs` and `job-evaluator.mjs` execute:
```javascript
const SENIOR_TITLE = /\b(senior|sr\.?|lead|principal|staff|director|head|chief)\b/i;
if (SENIOR_TITLE.test(title)) return { status: 'REJECT' };
```
**Why this fails:**
1. Corporate title inflation: many startups title entry-level roles "Lead AI Engineer" or "Architect" while asking for 1–2 years of experience.
2. Mentee / Support titles: "Associate to Tech Lead" or "Junior Solutions Architect" are falsely rejected.
3. Multilingual titles: Hebrew postings with "בכיר" (senior) or German "Projektleiter" bypass ASCII regexes.

### The Holistic Seniority Evidence Model
System-1 task `SENIORITY_CLASSIFICATION` evaluates seniority across four distinct evidence vectors:
1. **Title Token Weight:** Primary title label and prefixes/suffixes.
2. **Explicit Required YOE:** Minimum years of professional experience demanded in the text.
3. **Responsibility & Ownership Scope:**
   - *Task Execution* (Junior/Entry)
   - *Feature Autonomy* (Mid)
   - *System Architecture & Mentorship* (Senior)
   - *Cross-Organizational Strategy* (Staff/Principal)
4. **Hiring Context Language:** Phrases like "new grad", "early career", "mentorship provided", "fast learner" strongly override elevated titles.

---

## 8. Matching Engine: Evidence vs Deterministic Policy

To maintain deterministic control, the matching engine separates semantic evidence generation from business policy enforcement.

```
┌─────────────────────────────────┐       ┌─────────────────────────────────┐
│     SYSTEM-1 SEMANTIC EVIDENCE   │       │   DETERMINISTIC BUSINESS POLICY │
│  - Extracted Required YOE: 3.0  │ ───>  │  - Candidate YOE: 1.0           │
│  - YOE Context: MANDATORY       │       │  - Shortfall = 3.0 - 1.0 = 2.0  │
│  - Skills Matched: 4/5          │       │  - Policy: Shortfall in [1, 3]  │
│  - Degree: BSc Equivalent       │       │    ==> Status: "LONG_STRETCH"   │
└─────────────────────────────────┘       └─────────────────────────────────┘
```

### Deterministic Policy Rules (Code Decides):
- $\text{Shortfall} \ge 4 \text{ years} \implies \text{REJECT}$ (Candidate cannot overcome 4+ year gap).
- $0 < \text{Shortfall} < 4 \text{ years} \implies \text{LONG_STRETCH}$ (Permissible stretch for high technical fit).
- $\text{Shortfall} \le 0 \text{ years} \implies \text{STRONG}$ (Meets or exceeds experience floor).
- $\text{Preferred YOE Shortfall only} \implies \text{REASONABLE}$.
- $\text{Required Eligibility Fact} == \text{false} \implies \text{REJECT}$.
- $\text{Required Eligibility Fact} == \text{unknown} \implies \text{NEEDS_REVIEW}$ (Fail-closed).

---

## 9. Deduplication Intelligence: Hybrid Architecture

Deduplication protects the application tracker from duplicated entries while ensuring distinct openings at the same company are never merged.

### The Multi-Tier Deduplication Cascade:
1. **Tier 1 (Deterministic URL Key):** Canonical URL normalization via `url-key.mjs` (tracking params stripped, host lowercased, SPA job route preserved).
2. **Tier 2 (Deterministic Requisition ID):** Exact match on extracted Requisition Number (`JR-10423`). A mismatch in verified req numbers is proof of distinct openings.
3. **Tier 3 (Semantic Requisition Comparison):** When titles and URLs differ slightly at the same company, System-1 task `JOB_DUPLICATE_SEMANTIC_COMPARISON` evaluates job responsibilities, locations, and teams.
4. **Fail-Safe Invariant on Uncertainty:** If System 1 returns `confidence < 0.80` or `is_duplicate == false`, the engine **always creates a new tracker row**. Destructive row overwrites on uncertainty are strictly forbidden.

---

## 10. ATS Semantic Classification & Ethical Safeguards

### Ethical Safeguards & Legal Attestations:
1. **NEVER AUTO-ANSWER LEGAL ATTESTATIONS:**
   System 1 classifies fields asking for truthfulness certifications, background check consent, or terms agreement as `LEGAL_ATTESTATION`. Deterministic policy in `ats-preparation.mjs` immediately sets `status: "DO_NOT_ANSWER"` with provenance `human_confirmation_required`.
2. **NEVER INVENT SENSITIVE DEMOGRAPHICS:**
   Questions concerning race, gender, veteran status, disability, sexual orientation, or visa sponsorship are flagged as `SENSITIVE`. No values are ever inferred or proposed automatically.
3. **PROPOSED VALUES REQUIRE CANONICAL SOURCE:**
   Every proposed field value (e.g. email, phone, LinkedIn URL, GPA) must trace to an explicit verified key in `candidateFacts`.

---

## 11. System 1 / System 2 Routing Policy

Career-Ops utilizes the model gateway's logical tiers to enforce cost and latency ceilings:

```
┌──────────────────────────────────────────┬──────────────────────────────────────────┐
│ SYSTEM 1 (Zero-Cost Gateway)             │ SYSTEM 2 (Deep Reasoning Gateway)        │
│ Models: Gemini 3.8 Flash, Nemotron 3.5   │ Models: GPT-6 Astra, GPT-6.1 Sol, Pro    │
├──────────────────────────────────────────┼──────────────────────────────────────────┤
│ Single-pass extraction                   │ Contradictory YOE / educational ranges   │
│ Entity normalization & categorization    │ Ambiguous legal eligibility clauses      │
│ Surface form to concept mapping          │ Subtle cross-domain capability transfer  │
│ Low-depth semantic comparisons           │ Complex salary / equity trade-off review │
│ Target Latency: < 2500ms                 │ Target Latency: < 10000ms                │
│ Call Volume: ~90% of jobs                │ Call Volume: ~10% of jobs (Escalated)    │
└──────────────────────────────────────────┴──────────────────────────────────────────┘
```

### Concrete Escalation Triggers (System 1 $\rightarrow$ System 2):
1. `extraction_confidence < 0.75` on mandatory requirements.
2. Contradictory statements within JD (e.g. "Entry-level position" with "Minimum 7 years experience required").
3. Complex alternative qualifications ("Bachelor's + 5 years OR Master's + 2 years OR PhD without experience").
4. High-impact transferability questions on candidate's primary archetype.

---

## 12. Areas That Must NEVER Use an LLM

To protect data integrity, security, and process consistency, the following components must **NEVER** be driven by generative model inference:

```
  ┌────────────────────────────────────────────────────────────────────────┐
  │                   NEVER MODEL-DRIVEN INVARIANTS                        │
  ├────────────────────────────────────────────────────────────────────────┤
  │ 1. Application Identity & Primary Keys (Hash of URL + Req ID)          │
  │ 2. Canonical Status Transitions (Evaluated -> Applied -> Interview)    │
  │ 3. Status Transition Ledger Append-Only Integrity (status-log.tsv)     │
  │ 4. Git Worktree & Path Validation (Path Traversal Protections)         │
  │ 5. SHA-256 Checksums of CV PDFs, Form Schemas, and Artifacts          │
  │ 6. Verification of Quantitative Metrics in cv.md (Number Grounding)    │
  │ 7. Durable `user-cannot-confirm` Provenance Markers                    │
  │ 8. Direct Live ATS Form Field Typing or Submission Clicking            │
  │ 9. Cryptographic Signatures & API Tokens                               │
  │ 10. Execution of External Shell Commands / Network Requests            │
  └────────────────────────────────────────────────────────────────────────┘
```

---

## 13. Top 20 Highest-Risk Semantic Heuristics

The table below catalogs the twenty highest-risk semantic heuristics identified in the audit, detailing their failure modes and refactor priority:

| Rank | ID | File & Symbol | Domain | Heuristic Type | Primary Failure Mode & Business Risk | Classification | Risk |
|---|---|---|---|---|---|---|---|
| **1** | `AG-06` | `candidate-fit-gate.mjs:18` `detectRequiredEligibility` | REQUIREMENT | Semantic Regex | Misidentifies legal sponsorship; false-rejects on positive statements ("sponsorship available") | HYBRID_SYSTEM1_DETERMINISTIC | CRITICAL |
| **2** | `AG-10` | `ats-preparation.mjs:194` `classifyCustomQuestion` | ATS | Semantic Regex | Misses unfamiliar legal attestation wording; risks automated answer proposal | HYBRID_SYSTEM1_DETERMINISTIC | CRITICAL |
| **3** | `AG-11` | `ats-preparation.mjs:134` `mapApplicationFields` | ATS | Policy Logic | Sensitive fields require strict DO_NOT_ANSWER; must not be loosened | KEEP_DETERMINISTIC | CRITICAL |
| **4** | `RZ-21` | `story-provenance-check.mjs:35` `PROVENANCE_TAG_RE` | CV | Structural Regex | Must enforce `user-cannot-confirm` durably; LLM must never override | KEEP_DETERMINISTIC | CRITICAL |
| **5** | `RZ-24` | `verify-cv-facts.mjs:44` `TOOL_PROSE_WORDS` | CV | Keyword Blacklist | Tool-of-trade conflation check; must remain strict deterministic gate | KEEP_DETERMINISTIC | CRITICAL |
| **6** | `RZ-25` | `verify-cv-facts.mjs:210` `extractQuantifiedClaims` | CV | Structural Regex | Metric verbatim source grounding; zero tolerance for hallucinated numbers | KEEP_DETERMINISTIC | CRITICAL |
| **7** | `RZ-33` | `url-key.mjs:120` `normalizeUrl` | DEDUP | Structural Regex | URL deduplication key derivation; model inference would break hash keys | KEEP_DETERMINISTIC | CRITICAL |
| **8** | `AC-04` | `providers/_registry.mjs:45` `resolveProvider` | DISCOVERY | Structural Regex | Hostname routing to scraper adapters; deterministic router | KEEP_DETERMINISTIC | CRITICAL |
| **9** | `UI-03` | `web/src/lib/apply/cv-match.mjs:27` `hasToken` | CV | Structural Regex | Matching output PDF to application; must prevent serving wrong document | KEEP_DETERMINISTIC | CRITICAL |
| **10** | `AG-04` | `job-evaluator.mjs:94` `sanitizeUntrustedContent` | OTHER | Structural Regex | Prompt injection demarcation; core security boundary | KEEP_DETERMINISTIC | CRITICAL |
| **11** | `AG-01` | `job-evaluator.mjs:333` `filterTier0` | SENIORITY | Semantic Regex | False-rejects junior roles containing 'lead' or 'architect' tokens | HYBRID_SYSTEM1_DETERMINISTIC | HIGH |
| **12** | `AG-05` | `candidate-fit-gate.mjs:3` `SENIOR_TITLE` | SENIORITY | Semantic Regex | Premature title-based rejection before evaluating actual YOE or duties | HYBRID_SYSTEM1_DETERMINISTIC | HIGH |
| **13** | `AG-07` | `candidate-fit-gate.mjs:9` `degreeLevel` | EDUCATION | Semantic Regex | Fails on international/Israeli degree titles (Practical Engineer, etc.) | HYBRID_SYSTEM1_DETERMINISTIC | HIGH |
| **14** | `AG-08` | `candidate-fit-gate.mjs:50` `evaluateCandidateFit` | MATCHING | Scoring Rule | Enforces shortfall thresholds; must stay deterministic in code | KEEP_DETERMINISTIC | HIGH |
| **15** | `AG-09` | `ats-preparation.mjs:48` `semanticTypeFor` | ATS | Semantic Regex | Multilingual ATS labels fail regex; misclassifies form fields | HYBRID_SYSTEM1_DETERMINISTIC | HIGH |
| **16** | `RZ-03` | `role-matcher.mjs:11` `SENIORITY_TOKENS` | SENIORITY | Keyword Set | Tracker deduplication fails on non-standard seniority titles | REPLACE_WITH_SYSTEM1 | HIGH |
| **17** | `RZ-08` | `role-matcher.mjs:182` `roleFuzzyMatch` | DEDUP | Scoring Rule | Jaccard title overlap collapses distinct requisitions or duplicates rows | HYBRID_SYSTEM1_DETERMINISTIC | HIGH |
| **18** | `RZ-09` | `skill-extract.mjs:23` `SKILL_TOKENS` | SKILL | Skill List | 100-item static array is blind to modern AI tools (LangGraph, Polars, Qdrant) | REPLACE_WITH_SYSTEM1 | HIGH |
| **19** | `RZ-10` | `skill-extract.mjs:128` `CANONICAL` | SKILL | Keyword Set | Static alias map cannot handle semantic equivalence or ecosystem links | REPLACE_WITH_SYSTEM1 | HIGH |
| **20** | `RZ-15` | `jd-skill-gap.mjs:217` `SKILL_TOKEN_RE` | SKILL | Semantic Regex | Misses all lowercase skills; capitalized regex captures non-skills | REPLACE_WITH_SYSTEM1 | HIGH |

---

## 14. Duplicated Intelligence Areas & Remediation

The audit identified significant code duplication where the same semantic decision is implemented independently in disparate files:

### 14.1 Seniority Classification Quadruplication:
- **Implementations:**
  1. `src/agent/domain/jobs/job-evaluator.mjs`: `seniorRegex = /\b(senior|staff|principal|lead|director|vp|head of|architect)\b/i;`
  2. `src/agent/domain/candidate/candidate-fit-gate.mjs`: `const SENIOR_TITLE = /\b(senior|sr\.?|lead|principal|staff|director|head|chief)\b/i;`
  3. `role-matcher.mjs`: `SENIORITY_TOKENS = new Set(['senior', 'sr', 'lead', 'principal', ...])`
  4. `web/src/lib/analytics-metrics.mjs`: `/\b(senior|sr\.?|expert)\b/` and `/\b(junior|jr\.?|graduate|...)\b/`
- **Remediation:** Centralize in System-1 task `SENIORITY_CLASSIFICATION`. All agent, tracker, and web analytics surfaces consume `JobSemanticProfile.seniority`.

### 14.2 Skill Dictionaries & Synonym Duplication:
- **Implementations:**
  1. `skill-extract.mjs`: `SKILL_TOKENS` (100 technologies) + `CANONICAL` aliases.
  2. `keyword-match.mjs`: `SYNONYMS` (30 tuple pairs).
  3. `jd-skill-gap.mjs`: `SKILL_TOKEN_RE` + `STOPWORDS`.
  4. `analyze-patterns.mjs`: Inline tech regex.
- **Remediation:** Centralize in System-1 tasks `SKILL_EXTRACTION` and `SKILL_NORMALIZATION`. All tools consume canonical `SkillConcept` IDs.

### 14.3 ATS Heading & Field Recognition Duplication:
- **Implementations:**
  1. `ats-preparation.mjs`: `semanticTypeFor()` regexes.
  2. `verify-ats.mjs`: Multilingual `SECTION_HEADINGS` (18 languages).
  3. `keyword-match.mjs`: `KEYWORDS_HEADINGS`.
- **Remediation:** Centralize in System-1 task `ATS_FIELD_SEMANTIC_CLASSIFICATION`.

---

## 15. Final Metrics & Inventory Verification Summary

The figures below are derived dynamically from `docs/architecture/semantic-heuristics-inventory.json`:

```
============================================================
FINAL AUDIT METRICS SUMMARY
============================================================
TOTAL_HEURISTICS_FOUND:                62
STRUCTURAL_REGEX_COUNT:                14
SEMANTIC_REGEX_COUNT:                  22
HARDCODED_KEYWORD_SETS:                26
HARDCODED_SKILL_LISTS:                  1
HARDCODED_ROLE_TAXONOMIES:              2
HARDCODED_SCORING_RULES:               15

CLASSIFICATION BREAKDOWN:
  KEEP_DETERMINISTIC:                  23
  REPLACE_WITH_SYSTEM1:                16
  HYBRID_SYSTEM1_DETERMINISTIC:        23
  ESCALATE_TO_SYSTEM2:                  0
  REMOVE:                               0
  UNKNOWN_NEEDS_REVIEW:                 0
  TOTAL:                               62 (100% reconciled)

RISK BREAKDOWN:
  CRITICAL:                            10
  HIGH:                                24
  MEDIUM:                              21
  LOW:                                  7
  TOTAL:                               62 (100% reconciled)
============================================================
```
