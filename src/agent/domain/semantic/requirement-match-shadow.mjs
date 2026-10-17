// @ts-check
/**
 * requirement-match-shadow.mjs — Phase 4 Requirement Matching Shadow Integration
 *
 * Implements shadow-only execution for evidence-aware requirement matching:
 * - Feature flag gating: features.semantic_requirement_matching = false | "shadow"
 * - Legacy candidate matching remains 100% authoritative.
 * - PII-free telemetry: no names, emails, phones, raw CV text, or raw JD text.
 * - Non-destructive execution: semantic failures never break production.
 */

import {
  profileCandidateRequirementMatches,
  REQUIREMENT_MATCHING_TASK_VERSION
} from './requirement-matcher.mjs';

/**
 * Determine requirement matching mode from config: 'off' | 'shadow'
 * @param {object} [config]
 * @returns {'off' | 'shadow'}
 */
export function semanticRequirementMatchingMode(config = {}) {
  const feat = config?.features?.semantic_requirement_matching;
  if (feat === 'shadow' || feat === true) return 'shadow';
  return 'off';
}

/**
 * Check if requirement matching is enabled in shadow mode.
 * @param {object} [config]
 * @returns {boolean}
 */
export function isSemanticRequirementMatchingEnabled(config = {}) {
  return semanticRequirementMatchingMode(config) === 'shadow';
}

/**
 * Build privacy-safe telemetry without leaking candidate PII or raw text.
 *
 * @param {object} params
 * @param {string} params.jobId
 * @param {string} params.candidateId
 * @param {object} [params.matchProfile]
 * @param {number} [params.modelCalls=0]
 * @param {number} [params.latencyMs=0]
 * @returns {object}
 */
export function buildRequirementMatchingShadowTelemetry({
  jobId,
  candidateId,
  matchProfile,
  modelCalls = 0,
  latencyMs = 0
}) {
  const summary = matchProfile?.descriptive_summary || {};
  return {
    component: 'semantic_requirement_matching_shadow',
    version: REQUIREMENT_MATCHING_TASK_VERSION,
    job_id: String(jobId),
    candidate_id: String(candidateId),
    timestamp: new Date().toISOString(),
    metrics: {
      latency_ms: latencyMs,
      model_calls: modelCalls,
      requirements_total: summary.requirements_total || 0,
      satisfies: summary.satisfies || 0,
      partially_supports: summary.partially_supports || 0,
      related_but_insufficient: summary.related_but_insufficient || 0,
      contradicts: summary.contradicts || 0,
      no_evidence: summary.no_evidence || 0,
      unknown: summary.unknown || 0
    }
  };
}

/**
 * Run requirement matching in shadow mode beside legacy matching.
 *
 * When shadow is OFF: returns legacy result and reports shadow_executed = false.
 * When shadow is ON: executes profileCandidateRequirementMatches and returns both.
 *
 * @param {object} params
 * @param {object} params.jobProfile JobSemanticProfile
 * @param {object} params.candidateProfile CandidateSemanticProfile
 * @param {any} [params.legacyMatchResult]
 * @param {object} [params.config={}]
 * @param {object} [params.options={}]
 * @returns {Promise<{
 *   authoritativeResult: any,
 *   matchProfile: object | null,
 *   shadowExecuted: boolean,
 *   telemetry: object | null,
 *   shadowError?: string
 * }>}
 */
export async function runRequirementMatchingShadow({
  jobProfile,
  candidateProfile,
  legacyMatchResult = null,
  config = {},
  options = {}
}) {
  const mode = semanticRequirementMatchingMode(config);

  if (mode !== 'shadow') {
    return {
      authoritativeResult: legacyMatchResult,
      matchProfile: null,
      shadowExecuted: false,
      telemetry: null
    };
  }

  const startTime = Date.now();
  try {
    const matchProfile = await profileCandidateRequirementMatches({
      jobProfile,
      candidateProfile,
      modelRunner: options.modelRunner,
      options
    });

    const latencyMs = Date.now() - startTime;
    const telemetry = buildRequirementMatchingShadowTelemetry({
      jobId: jobProfile?.job_id || 'unknown',
      candidateId: candidateProfile?.candidate_id || 'unknown',
      matchProfile,
      modelCalls: matchProfile?.telemetry?.model_calls || 0,
      latencyMs
    });

    return {
      authoritativeResult: legacyMatchResult,
      matchProfile,
      shadowExecuted: true,
      telemetry
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    return {
      authoritativeResult: legacyMatchResult,
      matchProfile: null,
      shadowExecuted: true,
      telemetry: buildRequirementMatchingShadowTelemetry({
        jobId: jobProfile?.job_id || 'unknown',
        candidateId: candidateProfile?.candidate_id || 'unknown',
        matchProfile: null,
        modelCalls: 0,
        latencyMs
      }),
      shadowError: err instanceof Error ? err.message : String(err)
    };
  }
}
