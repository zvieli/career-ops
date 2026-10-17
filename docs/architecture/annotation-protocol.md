# Career-Ops v1.2 — Benchmark Annotation Protocol & Reviewer Guidelines

**Document Status:** ACTIVE OPERATIONAL PROTOCOL  
**Applies To:** `evals/fixtures/golden-25.json`, future 300-job benchmark corpus  
**Version:** v1.2.0  

---

## 1. Core Annotation Invariant

> **AI-GENERATED OR SYNTHETIC LABELS MUST NEVER BE DECLARED DUAL HUMAN VERIFIED.**

Benchmark ground truth serves as the immutable yardstick to measure model performance and detect false rejections. Fabricating human consensus compromises evaluation validity.

### The Five Annotation Lifecycle States:

| State | Definition | Permitted Usage |
|---|---|---|
| `UNLABELED` | Raw job posting collected with no annotations. | Ingestion queues, raw corpus storage. |
| `MODEL_PROPOSED` | Annotations proposed by a model or synthetic pipeline generator. | Developer testing, provisional evaluation. Human-ground-truth metrics must report as **provisional**. |
| `HUMAN_REVIEWED` | Reviewed and edited by a single qualified technical annotator. | Validation candidate. |
| `DUAL_HUMAN_VERIFIED` | Independently reviewed and agreed upon by two separate technical annotators. | Official Ground Truth Benchmark. |
| `ADJUDICATED` | Disagreements between dual annotators escalated to and resolved by a senior staff engineer. | Final Binding Ground Truth Benchmark. |

---

## 2. Reviewer Instructions: Step-by-Step

### 2.1 Role Family Classification
Classify the posting into exactly one canonical role family:
- `software_engineering`: Backend, Frontend, Full Stack, Mobile, General SWE.
- `ai_ml`: Machine learning, NLP, Computer Vision, RAG, LLM applications, Data Science.
- `data_engineering`: Data warehousing, ETL pipelines, Spark, Snowflake, Airflow.
- `devops_cloud`: Cloud systems, Kubernetes, CI/CD, Terraform, Site Reliability Engineering.
- `cybersecurity`: SOC, AppSec, Penetration testing, Security engineering.
- `product_management`: Product managers, Technical Product Owners.
- `qa_testing`: Manual and automation QA engineers.
- `other`: Non-SWE tech roles.

### 2.2 Seniority Level Determination
Do **NOT** rely exclusively on title tokens. Startups routinely inflate titles ("Lead Engineer", "Solutions Architect") while asking for 0–1 YOE.
- `INTERN`: Current university student, temporary role, 20 hrs/week.
- `JUNIOR`: 0 to 2 years of experience; mentorship expected.
- `ENTRY`: Specifically designated for new graduates (0 YOE required).
- `MID`: 2 to 5 years of experience; autonomous feature execution.
- `SENIOR`: 5+ years of experience or explicit technical mentorship/system architecture responsibility.
- `STAFF_PRINCIPAL`: Cross-organizational impact, principal architect.
- `DIRECTOR_PLUS`: Management, executive, head of engineering.
- `UNKNOWN`: Unspecified or contradictory.

### 2.3 Required vs Preferred YOE Rule
- **Required YOE:** Look for mandatory minimums ("Must have at least 3 years", "Minimum 2 YOE", "דרישות חובה: שנתיים ניסיון").
- **Preferred YOE:** Explicit bonuses ("Advantage: 3+ years", "Nice to have: experience with X", "יתרון: ניסיון של 3 שנים").
- **Ambiguity Rule:** If the posting says "3-5 years preferred but junior developers welcome", set `required_yoe: 0`, `preferred_yoe: 3`, and `yoe_is_ambiguous: true`.

### 2.4 Verbatim Text Span Rule (CRITICAL)
Every technical skill and legal requirement must cite an exact, unbroken character span from the source job description text:
```json
{
  "name": "FastAPI",
  "category": "TECHNICAL_SKILL",
  "verbatim_span": {
    "start_char": 214,
    "end_char": 221,
    "verbatim_quote": "FastAPI"
  }
}
```
**Invariant:** `raw_jd_text.slice(start_char, end_char) === verbatim_quote`.

### 2.5 Legal & Administrative Requirements
- `work_authorization_required`: True ONLY if explicit text mandates authorization or refuses sponsorship ("No visa sponsorship", "Must be authorized to work in Israel").
- `security_clearance_required`: True ONLY if explicit security clearance is demanded ("סיווג ביטחוני רמה 3 ומעלה").
- `citizenship_required`: True ONLY if Israeli or country-specific citizenship is mandated ("אזרחות ישראלית בלבד").

---

## 3. Disagreement & Adjudication Protocol

### When to Escalate to Adjudication:
1. **Seniority Mismatch:** Reviewer 1 marks `JUNIOR`, Reviewer 2 marks `MID` or `SENIOR`.
2. **YOE Disagreement:** Difference between annotated `required_yoe` > 0.5 years.
3. **Requirement Importance:** Reviewer 1 marks a skill `REQUIRED`, Reviewer 2 marks it `PREFERRED`.
4. **Fit Verdict Disagreement:** Reviewer 1 expects `STRONG`, Reviewer 2 expects `REJECT`.

### Adjudication Procedure:
1. Run `node scripts/annotate-benchmark.mjs --check-disagreements` to surface conflicting sample files.
2. The Adjudicator reviews both reviewer rationales and original verbatim spans.
3. The Adjudicator records the final binding annotation, marks `status: "ADJUDICATED"`, and signs with `annotator_id`.
