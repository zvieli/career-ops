// @ts-check
/**
 * policy-explanation-renderer.mjs — Phase 5 Evidence-Backed Explainability & Presentation Engine
 *
 * Implements transparent, evidence-grounded explanations:
 * - Deterministic structured explanations are primary and fully traceable.
 * - Every explanation fact links to requirement_id, reason_code, and evidence_ids.
 * - Optional LLM prose formatting is strictly PRESENTATION_ONLY and non-authoritative:
 *   it cannot alter scores, bands, or facts, and falls back to deterministic prose on failure.
 */

/**
 * Generate a complete, deterministic, evidence-backed explanation structure from a PolicyAssessment.
 *
 * @param {object} policyAssessment PolicyAssessment
 * @returns {object} Structured explanation object
 */
export function generateStructuredExplanation(policyAssessment) {
  if (!policyAssessment || typeof policyAssessment !== 'object') {
    throw new TypeError('policyAssessment must be a valid object');
  }

  const facts = Array.isArray(policyAssessment.explanation_facts) ? policyAssessment.explanation_facts : [];

  const positives = facts.filter((f) => f.type === 'POSITIVE');
  const negatives = facts.filter((f) => f.type === 'NEGATIVE');
  const uncertainties = facts.filter((f) => f.type === 'UNCERTAINTY');
  const blockers = facts.filter((f) => f.type === 'BLOCKER');

  return {
    assessment_id: policyAssessment.policy_assessment_id,
    job_id: policyAssessment.job_id,
    candidate_id: policyAssessment.candidate_id,
    priority_band: policyAssessment.priority_band,
    normalized_score: policyAssessment.normalized_score,
    policy_version: policyAssessment.policy_version,
    summary: {
      total_requirements: policyAssessment.telemetry?.requirements_evaluated || 0,
      positive_count: positives.length,
      negative_count: negatives.length,
      uncertainty_count: uncertainties.length,
      blocker_count: blockers.length
    },
    top_positive_reasons: positives.map((f) => ({
      requirement_id: f.requirement_id,
      statement: f.statement,
      evidence_ids: f.evidence_ids || []
    })),
    top_negative_reasons: negatives.map((f) => ({
      requirement_id: f.requirement_id,
      statement: f.statement,
      reason_code: f.reason_code
    })),
    uncertainty_reasons: uncertainties.map((f) => ({
      requirement_id: f.requirement_id,
      statement: f.statement,
      reason_code: f.reason_code
    })),
    blocker_reasons: blockers.map((f) => ({
      requirement_id: f.requirement_id,
      statement: f.statement,
      reason_code: f.reason_code
    })),
    score_components: policyAssessment.aggregate_components || {}
  };
}

/**
 * Generate deterministic evidence-grounded prose without calling any external model.
 *
 * @param {object} structuredExplanation Structured explanation from generateStructuredExplanation
 * @returns {string} Factual, evidence-grounded prose
 */
export function formatDeterministicProse(structuredExplanation) {
  const lines = [];

  const band = structuredExplanation.priority_band;
  const score = structuredExplanation.normalized_score;
  const s = structuredExplanation.summary;

  lines.push(`Opportunity Assessment: ${band} (Score: ${score}/100, Policy: ${structuredExplanation.policy_version})`);

  if (s.blocker_count > 0) {
    lines.push(`\n⚠️ Blockers (${s.blocker_count}):`);
    structuredExplanation.blocker_reasons.forEach((b) => {
      lines.push(`  - ${b.statement}`);
    });
  }

  if (s.positive_count > 0) {
    lines.push(`\n✅ Supported Requirements (${s.positive_count}):`);
    structuredExplanation.top_positive_reasons.forEach((p) => {
      lines.push(`  - ${p.statement} [Evidence: ${p.evidence_ids.join(', ')}]`);
    });
  }

  if (s.negative_count > 0) {
    lines.push(`\n❌ Unmet / Partial Requirements (${s.negative_count}):`);
    structuredExplanation.top_negative_reasons.forEach((n) => {
      lines.push(`  - ${n.statement}`);
    });
  }

  if (s.uncertainty_count > 0) {
    lines.push(`\n❓ Information Gaps (${s.uncertainty_count}):`);
    structuredExplanation.uncertainty_reasons.forEach((u) => {
      lines.push(`  - ${u.statement}`);
    });
  }

  return lines.join('\n');
}

/**
 * Render policy explanation prose.
 * If modelRunner is provided, it may rephrase for readability, but can NEVER alter score or facts.
 * Falls back to deterministic prose on model absence or failure.
 *
 * @param {object} params
 * @param {object} params.policyAssessment PolicyAssessment
 * @param {Function} [params.modelRunner] Optional presentation-only LLM runner
 * @param {object} [params.options]
 * @returns {Promise<{
 *   structured: object,
 *   prose: string,
 *   presentation_only: boolean,
 *   model_formatted: boolean
 * }>}
 */
export async function renderPolicyExplanation({
  policyAssessment,
  modelRunner,
  options = {}
}) {
  const structured = generateStructuredExplanation(policyAssessment);
  const authoritativeProse = formatDeterministicProse(structured);

  if (typeof modelRunner !== 'function' || options.deterministicOnly) {
    return {
      structured,
      prose: authoritativeProse,
      authoritative_prose: authoritativeProse,
      raw_model_presentation: null,
      presentation_only: true,
      model_formatted: false
    };
  }

  let modelResponse = null;
  let modelFormatted = false;

  try {
    modelResponse = await modelRunner({
      task: 'EXPLANATION_FACT_REPHRASING',
      structuredFacts: structured,
      instruction: 'Provide optional presentation feedback on admitted factual statements.'
    });
    if (modelResponse) {
      modelFormatted = true;
    }
  } catch (err) {
    modelFormatted = false;
  }

  // Authoritative user-visible prose is 100% deterministic and grounded in admitted facts.
  // Model output is retained strictly as raw_model_presentation metadata and can never alter user-visible prose.
  return {
    structured,
    prose: authoritativeProse,
    authoritative_prose: authoritativeProse,
    raw_model_presentation: modelResponse,
    presentation_only: true,
    model_formatted: modelFormatted
  };
}
