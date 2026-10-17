// @ts-check
/**
 * decision-policy-engine.mjs — Phase 5 Deterministic Match Policy & Assessment Engine
 *
 * Implements deterministic policy evaluation over Phase-4 match results:
 * - "MODELS UNDERSTAND. CODE DECIDES."
 * - Phase 4 owns semantic match truth; Phase 5 owns deterministic policy over that truth.
 * - Traceable, bounded (0–100) scoring with full component reconstruction.
 * - Explicit separation of UNKNOWN (uncertainty) vs NO_EVIDENCE vs CONTRADICTS.
 * - INSUFFICIENT_INFORMATION distinguished from LOW_PRIORITY.
 * - Hard gates require explicit Phase-4 contradictions (absence never hard-gates).
 * - Zero protected attributes; zero automatic application/rejection actions.
 */

import {
  createPolicyAssessment,
  createRequirementPolicyResult
} from './semantic-entities.mjs';
import { getPolicyConfiguration } from './policy-configuration.mjs';

/**
 * Deterministically evaluate policy assessment for a job-candidate match.
 *
 * @param {object} params
 * @param {object} params.jobProfile JobSemanticProfile
 * @param {object} params.candidateProfile CandidateSemanticProfile
 * @param {object} params.matchProfile CandidateMatchProfile (Phase 4)
 * @param {object} [params.policyConfig] PolicyConfiguration
 * @returns {object} Strictly validated PolicyAssessment
 */
export function evaluatePolicyAssessment({
  jobProfile,
  candidateProfile,
  matchProfile,
  policyConfig = getPolicyConfiguration()
}) {
  const startTime = Date.now();

  if (!jobProfile || typeof jobProfile !== 'object') {
    throw new TypeError('jobProfile must be a valid object');
  }
  if (!candidateProfile || typeof candidateProfile !== 'object') {
    throw new TypeError('candidateProfile must be a valid object');
  }
  if (!matchProfile || typeof matchProfile !== 'object') {
    throw new TypeError('matchProfile must be a valid object');
  }

  const jobId = String(jobProfile.job_id);
  const candidateId = String(candidateProfile.candidate_id);
  const matchProfileId = String(matchProfile.match_profile_id || `cmp-${jobId}-${candidateId}`);
  const policyVersion = String(policyConfig.policy_version);

  const requirements = Array.isArray(jobProfile.requirements) ? jobProfile.requirements : [];
  const reqMatches = Array.isArray(matchProfile.requirement_matches) ? matchProfile.requirement_matches : [];

  const matchMap = new Map(reqMatches.map((m) => [m.requirement_id, m]));

  const reqPolicyResults = [];
  const explanationFacts = [];
  const positiveReasons = [];
  const riskReasons = [];
  const blockerReasons = [];

  let hardGateTriggered = false;

  // 1. Per-Requirement Policy Evaluation
  for (const req of requirements) {
    const reqId = String(req.requirement_id);
    const m = matchMap.get(reqId);

    // Reference integrity: if a requirement is missing from matchProfile, fail-closed
    if (!m) {
      throw new Error(`Missing RequirementMatchResult for requirement: ${reqId}`);
    }

    const importance = req.importance || 'REQUIRED';
    const relation = m.relation;

    const importanceWeight = policyConfig.importance_weights[importance] ?? 1.0;
    const policyValue = policyConfig.relation_values[relation] ?? 0.0;
    const contribution = policyValue * importanceWeight;

    const sourceRefIds = Array.isArray(m.candidate_evidence_ids) ? [...m.candidate_evidence_ids] : [];

    // Capture complete Phase-4 support references across all 6 categories
    const supportReferences = {
      evidence_ids: Array.isArray(m.candidate_evidence_ids) ? [...m.candidate_evidence_ids] : [],
      skill_evidence_ids: Array.isArray(m.candidate_skill_evidence_ids) ? [...m.candidate_skill_evidence_ids] : [],
      capability_ids: Array.isArray(m.candidate_capability_ids) ? [...m.candidate_capability_ids] : [],
      experience_ids: Array.isArray(m.candidate_experience_ids) ? [...m.candidate_experience_ids] : [],
      education_ids: Array.isArray(m.candidate_education_ids) ? [...m.candidate_education_ids] : [],
      certification_ids: Array.isArray(m.candidate_certification_ids) ? [...m.candidate_certification_ids] : []
    };

    const allRefIds = [
      ...supportReferences.evidence_ids,
      ...supportReferences.skill_evidence_ids,
      ...supportReferences.capability_ids,
      ...supportReferences.experience_ids,
      ...supportReferences.education_ids,
      ...supportReferences.certification_ids
    ];

    // Check Hard Gates: ONLY from versioned PolicyConfiguration.hard_gates
    // Generic policy-as-data lookup based on trigger_source + trigger_value
    // Zero requirement-specific or hardcoded name branches
    let reqHardGate = false;
    let triggeredGate = null;

    if (relation === 'CONTRADICTS' && Array.isArray(policyConfig.hard_gates)) {
      for (const gate of policyConfig.hard_gates) {
        let conditionMatches = false;

        switch (gate.trigger_source) {
          case 'REQUIREMENT_TYPE':
            conditionMatches = req.type === gate.trigger_value;
            break;
          case 'MATCH_REASON_CODE':
            conditionMatches = Array.isArray(m.reason_codes) && m.reason_codes.includes(gate.trigger_value);
            break;
          case 'UNRESOLVED_DIMENSION':
            conditionMatches = Array.isArray(m.unresolved_dimensions) && m.unresolved_dimensions.includes(gate.trigger_value);
            break;
          case 'RELATION':
            conditionMatches = m.relation === gate.trigger_value;
            break;
          default:
            conditionMatches = false;
            break;
        }

        if (conditionMatches) {
          reqHardGate = true;
          triggeredGate = gate;
          hardGateTriggered = true;
          blockerReasons.push(`Hard gate "${gate.gate_id}" triggered: ${gate.reason_code}`);
          break;
        }
      }
    }

    const reasonCodes = [`${importance}_${relation}`];
    if (reqHardGate && triggeredGate) {
      reasonCodes.push('HARD_GATE_TRIGGERED', triggeredGate.reason_code);
    }

    // Build explanation fact
    let factType = 'POSITIVE';
    if (reqHardGate || relation === 'CONTRADICTS') {
      factType = 'BLOCKER';
    } else if (relation === 'UNKNOWN') {
      factType = 'UNCERTAINTY';
    } else if (relation === 'NO_EVIDENCE' || relation === 'RELATED_BUT_INSUFFICIENT' || relation === 'PARTIALLY_SUPPORTS') {
      factType = 'NEGATIVE';
    }

    const statement = formatFactStatement(req, m);
    explanationFacts.push({
      requirement_id: reqId,
      type: factType,
      reason_code: reasonCodes[0],
      evidence_ids: allRefIds,
      statement
    });

    if (factType === 'POSITIVE') {
      positiveReasons.push(statement);
    } else if (factType === 'NEGATIVE') {
      riskReasons.push(statement);
    } else if (factType === 'UNCERTAINTY') {
      riskReasons.push(`Uncertainty: ${statement}`);
    }

    // Phase 5 must never fabricate requirement_match_id
    if (!m.requirement_match_id) {
      throw new Error(`Missing requirement_match_id for requirement: ${reqId}. Phase 5 cannot fabricate match identity.`);
    }

    reqPolicyResults.push(createRequirementPolicyResult({
      requirement_id: reqId,
      requirement_match_id: String(m.requirement_match_id),
      importance,
      relation,
      policy_value: policyValue,
      importance_weight: importanceWeight,
      contribution,
      hard_gate_triggered: reqHardGate,
      reason_codes: reasonCodes,
      support_references: supportReferences,
      source_reference_ids: allRefIds
    }));
  }

  // 2. Score Component Partitioning
  const requiredList = reqPolicyResults.filter((r) => r.importance === 'REQUIRED' || r.importance === 'LEGAL_MANDATORY');
  const preferredList = reqPolicyResults.filter((r) => r.importance === 'PREFERRED');
  const optionalList = reqPolicyResults.filter((r) => r.importance === 'OPTIONAL' || r.importance === 'RESPONSIBILITY' || r.importance === 'CONTEXT');

  const requiredUnknownCount = requiredList.filter((r) => r.relation === 'UNKNOWN').length;
  const totalUnknownCount = reqPolicyResults.filter((r) => r.relation === 'UNKNOWN').length;
  const totalContradictions = reqPolicyResults.filter((r) => r.relation === 'CONTRADICTS').length;

  const scales = policyConfig.score_component_scales;
  const scoreBreakdown = [];

  // Required Coverage Component (Max 70)
  let requiredCoverage = 0;
  if (requiredList.length > 0) {
    const maxPossibleRequired = requiredList.reduce((acc, r) => acc + (1.0 * r.importance_weight), 0);
    const actualRequired = requiredList.reduce((acc, r) => acc + Math.max(0, r.contribution), 0);
    requiredCoverage = maxPossibleRequired > 0 ? (actualRequired / maxPossibleRequired) * scales.required_max : 0;
  }
  requiredCoverage = Math.max(0, Math.min(scales.required_max, Math.round(requiredCoverage * 10) / 10));

  scoreBreakdown.push({
    component: 'REQUIRED_COVERAGE',
    input_ids: requiredList.map((r) => r.requirement_id),
    raw_value: requiredList.length > 0 ? requiredCoverage / scales.required_max : 0,
    weight: scales.required_max,
    contribution: requiredCoverage,
    reason_code: 'REQUIRED_REQUIREMENTS_EVALUATION'
  });

  // Preferred Coverage Component (Max 20)
  let preferredCoverage = 0;
  if (preferredList.length > 0) {
    const maxPossiblePreferred = preferredList.reduce((acc, r) => acc + (1.0 * r.importance_weight), 0);
    const actualPreferred = preferredList.reduce((acc, r) => acc + Math.max(0, r.contribution), 0);
    preferredCoverage = maxPossiblePreferred > 0 ? (actualPreferred / maxPossiblePreferred) * scales.preferred_max : 0;
  }
  preferredCoverage = Math.max(0, Math.min(scales.preferred_max, Math.round(preferredCoverage * 10) / 10));

  scoreBreakdown.push({
    component: 'PREFERRED_COVERAGE',
    input_ids: preferredList.map((r) => r.requirement_id),
    raw_value: preferredList.length > 0 ? preferredCoverage / scales.preferred_max : 0,
    weight: scales.preferred_max,
    contribution: preferredCoverage,
    reason_code: 'PREFERRED_REQUIREMENTS_EVALUATION'
  });

  // Optional Bonus Component (Max 10)
  let optionalBonus = 0;
  if (optionalList.length > 0) {
    const maxPossibleOptional = optionalList.reduce((acc, r) => acc + (1.0 * r.importance_weight), 0);
    const actualOptional = optionalList.reduce((acc, r) => acc + Math.max(0, r.contribution), 0);
    optionalBonus = maxPossibleOptional > 0 ? (actualOptional / maxPossibleOptional) * scales.optional_max : 0;
  }
  optionalBonus = Math.max(0, Math.min(scales.optional_max, Math.round(optionalBonus * 10) / 10));

  scoreBreakdown.push({
    component: 'OPTIONAL_BONUS',
    input_ids: optionalList.map((r) => r.requirement_id),
    raw_value: optionalList.length > 0 ? optionalBonus / scales.optional_max : 0,
    weight: scales.optional_max,
    contribution: optionalBonus,
    reason_code: 'OPTIONAL_REQUIREMENTS_EVALUATION'
  });

  // Contradiction Penalty
  const contradictionPenalty = totalContradictions * scales.contradiction_penalty_per_item;
  scoreBreakdown.push({
    component: 'CONTRADICTION_PENALTY',
    input_ids: reqPolicyResults.filter((r) => r.relation === 'CONTRADICTS').map((r) => r.requirement_id),
    raw_value: totalContradictions,
    weight: scales.contradiction_penalty_per_item,
    contribution: -contradictionPenalty,
    reason_code: 'EXPLICIT_CONTRADICTIONS_PENALTY'
  });

  // Uncertainty Penalty
  const uncertaintyPenalty = requiredUnknownCount * scales.uncertainty_penalty_per_item;
  scoreBreakdown.push({
    component: 'UNCERTAINTY_PENALTY',
    input_ids: requiredList.filter((r) => r.relation === 'UNKNOWN').map((r) => r.requirement_id),
    raw_value: requiredUnknownCount,
    weight: scales.uncertainty_penalty_per_item,
    contribution: -uncertaintyPenalty,
    reason_code: 'REQUIRED_UNKNOWN_PENALTY'
  });

  // Evidence Quality Component (using configured evidence_quality_max from policyConfig)
  const evidenceQualityMax = scales.evidence_quality_max;
  if (typeof evidenceQualityMax !== 'number' || Number.isNaN(evidenceQualityMax)) {
    throw new Error('policyConfig.score_component_scales.evidence_quality_max is required and must be a number');
  }

  let evidenceQuality = 0;
  const verifiedMatches = reqPolicyResults.filter((r) => r.relation === 'SATISFIES' && r.source_reference_ids.length > 0);
  if (reqPolicyResults.length > 0 && verifiedMatches.length === reqPolicyResults.length) {
    evidenceQuality = evidenceQualityMax;
  } else if (verifiedMatches.length > 0) {
    evidenceQuality = Math.round((verifiedMatches.length / reqPolicyResults.length) * evidenceQualityMax * 10) / 10;
  }

  scoreBreakdown.push({
    component: 'EVIDENCE_QUALITY',
    input_ids: verifiedMatches.map((r) => r.requirement_id),
    raw_value: verifiedMatches.length,
    weight: evidenceQualityMax,
    contribution: evidenceQuality,
    reason_code: 'SOURCE_PROVENANCE_COMPLETENESS'
  });

  // 3. Score Normalization & Bounding
  const rawScore = requiredCoverage + preferredCoverage + optionalBonus + evidenceQuality - (contradictionPenalty + uncertaintyPenalty);
  let normalizedScore = Math.max(0, Math.min(100, Math.round(rawScore * 10) / 10));

  // 4. Priority Band Determination
  let priorityBand = 'LOW_PRIORITY';
  const thresholds = policyConfig.priority_band_thresholds;

  const isZeroRequirements = requirements.length === 0;
  const isAllUnknown = requirements.length > 0 && totalUnknownCount === requirements.length;
  const isHighUnknownRatio = requiredList.length > 0 && (requiredUnknownCount / requiredList.length) >= thresholds.max_tolerated_unknown_required_ratio;

  if (isZeroRequirements || isAllUnknown || isHighUnknownRatio) {
    // LOW INFORMATION != LOW FIT
    priorityBand = 'INSUFFICIENT_INFORMATION';
  } else if (hardGateTriggered) {
    // Execute configured hard-gate actions generically
    const triggeredGates = (policyConfig.hard_gates || []).filter((g) =>
      reqPolicyResults.some((r) => r.hard_gate_triggered && r.reason_codes.includes(g.reason_code))
    );

    if (triggeredGates.some((g) => g.action === 'BLOCK_OPPORTUNITY')) {
      normalizedScore = 0;
      priorityBand = 'LOW_PRIORITY';
    } else if (triggeredGates.some((g) => g.action === 'CAP_PRIORITY_LOW')) {
      normalizedScore = Math.min(normalizedScore, 25);
      priorityBand = 'LOW_PRIORITY';
    } else if (triggeredGates.some((g) => g.action === 'REQUIRE_HUMAN_REVIEW')) {
      priorityBand = 'INSUFFICIENT_INFORMATION';
    } else {
      normalizedScore = Math.min(normalizedScore, 25);
      priorityBand = 'LOW_PRIORITY';
    }
  } else if (normalizedScore >= thresholds.high_priority_floor) {
    priorityBand = 'HIGH_PRIORITY';
  } else if (normalizedScore >= thresholds.medium_priority_floor) {
    priorityBand = 'MEDIUM_PRIORITY';
  } else {
    priorityBand = 'LOW_PRIORITY';
  }

  const elapsedMs = Date.now() - startTime;

  return createPolicyAssessment({
    policy_assessment_id: `passess-${jobId}-${candidateId}`,
    job_id: jobId,
    candidate_id: candidateId,
    match_profile_id: matchProfileId,
    policy_version: policyVersion,
    requirement_policy_results: reqPolicyResults,
    aggregate_components: {
      required_coverage: requiredCoverage,
      preferred_coverage: preferredCoverage,
      optional_bonus: optionalBonus,
      contradiction_penalty: contradictionPenalty,
      uncertainty_penalty: uncertaintyPenalty,
      evidence_quality_component: evidenceQuality
    },
    raw_score: Math.round(rawScore * 10) / 10,
    normalized_score: normalizedScore,
    priority_band: priorityBand,
    hard_gate_triggered: hardGateTriggered,
    blocker_reasons: blockerReasons,
    risk_reasons: riskReasons,
    positive_reasons: positiveReasons,
    explanation_facts: explanationFacts,
    score_breakdown: scoreBreakdown,
    telemetry: {
      requirements_evaluated: reqPolicyResults.length,
      unknown_required_count: requiredUnknownCount,
      contradiction_count: totalContradictions,
      latency_ms: elapsedMs
    }
  });
}

/**
 * Format a clear, evidence-grounded statement for an explanation fact.
 * @param {object} req
 * @param {object} m
 * @returns {string}
 */
function formatFactStatement(req, m) {
  const desc = req.description || req.requirement_id;
  switch (m.relation) {
    case 'SATISFIES':
      return `Requirement "${desc}" is satisfied by candidate evidence`;
    case 'PARTIALLY_SUPPORTS':
      return `Requirement "${desc}" is partially supported: ${m.unresolved_dimensions?.join(', ') || 'unsupported dimensions'}`;
    case 'RELATED_BUT_INSUFFICIENT':
      return `Requirement "${desc}" is related but insufficient: ${m.unresolved_dimensions?.join(', ') || 'criteria unmet'}`;
    case 'CONTRADICTS':
      return `Requirement "${desc}" directly contradicts explicit candidate fact`;
    case 'NO_EVIDENCE':
      return `Requirement "${desc}" has no candidate evidence`;
    case 'UNKNOWN':
    default:
      return `Requirement "${desc}" status is unknown due to incomplete information`;
  }
}
