// @ts-check
/**
 * candidate-shadow.mjs — Phase 3 Candidate Semantic Shadow Integration
 *
 * Implements shadow-only execution for candidate semantic profiling:
 * - Feature flag gating: features.semantic_candidate_profile = false | "shadow"
 * - Legacy candidate behavior remains authoritative.
 * - PII-free telemetry: no names, emails, phones, or raw text leaked.
 * - Non-destructive execution: semantic failures never break production.
 */

import { profileCandidateSemantic } from './candidate-semantic-profiler.mjs';
import { getDefaultSkillConceptRegistry } from './skill-concept-registry.mjs';

export const CANDIDATE_SHADOW_TASK_VERSION = 'v1.3.0-phase3';
export const CANDIDATE_DISAGREEMENT_TYPES = Object.freeze([
  'EXPERIENCE_INFLATION_DETECTED',
  'UNSUPPORTED_SKILL_DETECTED',
  'UNSUPPORTED_CAPABILITY_DETECTED',
  'FALSE_EDUCATION_COMPLETION',
  'FALSE_CERTIFICATION',
  'PROMPT_INJECTION_DETECTED',
  'PROVENANCE_FAILURE',
  'SEMANTIC_ENGINE_FAILURE'
]);

/**
 * Determine candidate semantic mode from config: 'off' | 'shadow'
 * @param {object} [config]
 * @returns {'off' | 'shadow'}
 */
export function semanticCandidateProfileMode(config = {}) {
  const feat = config?.features?.semantic_candidate_profile;
  if (feat === 'shadow' || feat === true) return 'shadow';
  return 'off';
}

/**
 * Check if candidate semantic profiling is enabled (shadow mode).
 * @param {object} [config]
 * @returns {boolean}
 */
export function isSemanticCandidateProfileEnabled(config = {}) {
  return semanticCandidateProfileMode(config) === 'shadow';
}

/**
 * Build privacy-safe telemetry without leaking candidate PII.
 *
 * @param {object} params
 * @param {string} params.candidateId
 * @param {object} [params.candidateProfile]
 * @param {Array<string>} [params.disagreements=[]]
 * @param {number} [params.modelCalls=0]
 * @param {number} [params.latencyMs=0]
 * @returns {object}
 */
export function buildCandidateShadowTelemetry({
  candidateId,
  candidateProfile,
  disagreements = [],
  modelCalls = 0,
  latencyMs = 0
}) {
  return {
    component: 'semantic_candidate_profile_shadow',
    version: CANDIDATE_SHADOW_TASK_VERSION,
    candidate_id: candidateId,
    timestamp: new Date().toISOString(),
    metrics: {
      latency_ms: latencyMs,
      model_calls: modelCalls,
      evidence_count: candidateProfile?.evidence?.length || 0,
      experiences_count: candidateProfile?.experiences?.length || 0,
      skills_count: candidateProfile?.skills?.length || 0,
      capabilities_count: candidateProfile?.capabilities?.length || 0,
      education_count: candidateProfile?.education?.length || 0,
      certifications_count: candidateProfile?.certifications?.length || 0
    },
    disagreements: {
      has_disagreements: disagreements.length > 0,
      types: disagreements
    }
  };
}

/**
 * Run candidate shadow evaluation.
 *
 * When shadow is OFF: returns legacy facts and reports shadow_executed = false.
 * When shadow is ON: executes profileCandidateSemantic in shadow mode and returns both.
 *
 * @param {object} params
 * @param {string} params.sourceText
 * @param {string} [params.sourceId='cv.md']
 * @param {string} [params.candidateId='cand-default']
 * @param {object} [params.legacyFacts={}]
 * @param {object} [params.config={}]
 * @param {object} [params.options={}]
 * @returns {Promise<{
 *   shadow_executed: boolean,
 *   legacy_facts: object,
 *   candidate_profile: object | null,
 *   telemetry: object | null
 * }>}
 */
export async function runCandidateShadowEvaluation({
  sourceText,
  sourceId = 'cv.md',
  candidateId = 'cand-default',
  legacyFacts = {},
  config = {},
  options = {}
}) {
  const isEnabled = isSemanticCandidateProfileEnabled(config) || options.forceShadow === true;
  if (!isEnabled) {
    return {
      shadow_executed: false,
      legacy_facts: legacyFacts,
      candidate_profile: null,
      telemetry: null
    };
  }

  const startTime = Date.now();
  let candidateProfile = null;
  const disagreements = [];

  try {
    const result = await profileCandidateSemantic({
      sourceText,
      sourceId,
      candidateId,
      registry: options.registry || getDefaultSkillConceptRegistry(),
      options
    });
    candidateProfile = result.profile;

    // Check for provenance, injection, inflation, or certification rejections across all categories
    const d = candidateProfile.diagnostics || {};
    const allRejected = [
      ...(d.rejected_evidence || []),
      ...(d.rejected_experiences || []),
      ...(d.rejected_skills || []),
      ...(d.rejected_capabilities || []),
      ...(d.rejected_education || []),
      ...(d.rejected_certifications || [])
    ];

    if (allRejected.some((r) => r.reason === 'PROMPT_INJECTION_REJECTED')) {
      disagreements.push('PROMPT_INJECTION_DETECTED');
    }
    if (allRejected.some((r) =>
      r.reason === 'QUOTE_NOT_FOUND_IN_SOURCE' ||
      r.reason === 'SPAN_VALIDATION_FAILED' ||
      r.reason === 'AMBIGUOUS_EVIDENCE_REFERENCE' ||
      r.reason === 'EVIDENCE_REFERENCE_MISMATCH' ||
      r.reason === 'DUPLICATE_EVIDENCE_OCCURRENCE_OVERFLOW'
    )) {
      disagreements.push('PROVENANCE_FAILURE');
    }
    if (allRejected.some((r) => r.reason === 'PROJECT_EMPLOYMENT_CONFUSION')) {
      disagreements.push('EXPERIENCE_INFLATION_DETECTED');
    }
    if (allRejected.some((r) => r.reason === 'FALSE_COMPLETION_INFERRED')) {
      disagreements.push('FALSE_EDUCATION_COMPLETION');
    }
    if (allRejected.some((r) =>
      r.reason === 'FALSE_CERTIFICATION_INFERRED' ||
      r.reason === 'MISSING_CERTIFICATION_STATE' ||
      r.reason === 'INVALID_CERTIFICATION_STATE'
    )) {
      disagreements.push('FALSE_CERTIFICATION');
    }
  } catch (err) {
    disagreements.push('SEMANTIC_ENGINE_FAILURE');
  }

  const latencyMs = Date.now() - startTime;
  const telemetry = buildCandidateShadowTelemetry({
    candidateId,
    candidateProfile,
    disagreements,
    modelCalls: candidateProfile?.telemetry?.model_calls || 0,
    latencyMs
  });

  return {
    shadow_executed: true,
    legacy_facts: legacyFacts,
    candidate_profile: candidateProfile,
    telemetry
  };
}
