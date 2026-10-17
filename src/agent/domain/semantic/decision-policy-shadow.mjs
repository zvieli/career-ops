// @ts-check
/**
 * decision-policy-shadow.mjs — Phase 5 Match Policy Shadow Integration
 *
 * Implements shadow-only execution for match policy, ranking, and explainability:
 * - Feature flag gating: features.semantic_decision_policy = false | "shadow"
 * - Legacy ranking and decision authority remains 100% authoritative.
 * - PII-free telemetry: no names, emails, phones, raw CV text, or raw JD text.
 * - Non-destructive execution: semantic failures never break production.
 */

import { evaluatePolicyAssessment } from './decision-policy-engine.mjs';
import { getPolicyConfiguration, DEFAULT_POLICY_VERSION } from './policy-configuration.mjs';

/**
 * Determine decision policy mode from config: 'off' | 'shadow'
 * @param {object} [config]
 * @returns {'off' | 'shadow'}
 */
export function semanticDecisionPolicyMode(config = {}) {
  const feat = config?.features?.semantic_decision_policy;
  if (feat === 'shadow' || feat === true) return 'shadow';
  return 'off';
}

/**
 * Check if decision policy is enabled in shadow mode.
 * @param {object} [config]
 * @returns {boolean}
 */
export function isSemanticDecisionPolicyEnabled(config = {}) {
  return semanticDecisionPolicyMode(config) === 'shadow';
}

/**
 * Build privacy-safe telemetry without leaking candidate PII or raw text.
 *
 * @param {object} params
 * @param {string} params.jobId
 * @param {string} params.candidateId
 * @param {object} [params.assessment]
 * @param {number} [params.latencyMs=0]
 * @returns {object}
 */
export function buildDecisionPolicyShadowTelemetry({
  jobId,
  candidateId,
  assessment,
  latencyMs = 0
}) {
  return {
    component: 'semantic_decision_policy_shadow',
    version: assessment?.policy_version || DEFAULT_POLICY_VERSION,
    job_id: String(jobId),
    candidate_id: String(candidateId),
    timestamp: new Date().toISOString(),
    metrics: {
      latency_ms: latencyMs,
      requirements_evaluated: assessment?.telemetry?.requirements_evaluated || 0,
      unknown_required_count: assessment?.telemetry?.unknown_required_count || 0,
      contradiction_count: assessment?.telemetry?.contradiction_count || 0,
      normalized_score: assessment?.normalized_score || 0,
      priority_band: assessment?.priority_band || 'UNKNOWN',
      hard_gate_triggered: assessment?.hard_gate_triggered || false
    }
  };
}

/**
 * Run decision policy in shadow mode beside legacy decision systems.
 *
 * When shadow is OFF: returns legacy decision and reports shadowExecuted = false.
 * When shadow is ON: executes evaluatePolicyAssessment in shadow mode and returns both.
 *
 * @param {object} params
 * @param {object} params.jobProfile JobSemanticProfile
 * @param {object} params.candidateProfile CandidateSemanticProfile
 * @param {object} params.matchProfile CandidateMatchProfile (Phase 4)
 * @param {any} [params.legacyDecisionResult]
 * @param {object} [params.config={}]
 * @param {object} [params.options={}]
 * @returns {Promise<{
 *   authoritativeResult: any,
 *   policyAssessment: object | null,
 *   shadowExecuted: boolean,
 *   telemetry: object | null,
 *   shadowError?: string
 * }>}
 */
export async function runDecisionPolicyShadow({
  jobProfile,
  candidateProfile,
  matchProfile,
  legacyDecisionResult = null,
  config = {},
  options = {}
}) {
  const mode = semanticDecisionPolicyMode(config);

  if (mode !== 'shadow') {
    return {
      authoritativeResult: legacyDecisionResult,
      policyAssessment: null,
      shadowExecuted: false,
      telemetry: null
    };
  }

  const startTime = Date.now();
  try {
    const policyConfig = options.policyConfig || getPolicyConfiguration();
    const assessment = evaluatePolicyAssessment({
      jobProfile,
      candidateProfile,
      matchProfile,
      policyConfig
    });

    const latencyMs = Date.now() - startTime;
    const telemetry = buildDecisionPolicyShadowTelemetry({
      jobId: jobProfile?.job_id || 'unknown',
      candidateId: candidateProfile?.candidate_id || 'unknown',
      assessment,
      latencyMs
    });

    return {
      authoritativeResult: legacyDecisionResult,
      policyAssessment: assessment,
      shadowExecuted: true,
      telemetry
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    return {
      authoritativeResult: legacyDecisionResult,
      policyAssessment: null,
      shadowExecuted: true,
      telemetry: buildDecisionPolicyShadowTelemetry({
        jobId: jobProfile?.job_id || 'unknown',
        candidateId: candidateProfile?.candidate_id || 'unknown',
        assessment: null,
        latencyMs
      }),
      shadowError: err instanceof Error ? err.message : String(err)
    };
  }
}
