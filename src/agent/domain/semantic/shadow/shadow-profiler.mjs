// @ts-check
/**
 * shadow-profiler.mjs — Non-Destructive System-1 Shadow Mode & Disagreement Telemetry (Phase 1)
 *
 * Implements:
 * - Feature flag gating: features.semantic_job_profile ('shadow' | true | false)
 * - Shadow execution alongside authoritative legacy heuristics
 * - Structured disagreement detection (LEGACY_REJECT_SEMANTIC_PASS, REQUIRED_YOE_MISMATCH, etc.)
 * - Fail-safe routing: Invariant 9 (destructive veto disagreements route to NEEDS_REVIEW)
 * - PII-free audit telemetry logging
 */

import { runLegacyEvaluation } from '../adapters/legacy-eval-adapter.mjs';
import { SemanticEngine } from '../adapters/semantic-engine.mjs';
import { PROMPT_VERSION, PROFILER_TASK_VERSION } from '../job-semantic-profiler.mjs';
import { SEMANTIC_SCHEMA_VERSION } from '../semantic-entities.mjs';

export const DISAGREEMENT_TYPES = Object.freeze([
  'LEGACY_REJECT_SEMANTIC_PASS',
  'SEMANTIC_REJECT_LEGACY_PASS',
  'REQUIRED_YOE_MISMATCH',
  'PREFERRED_VS_REQUIRED_DISAGREEMENT',
  'ROLE_FAMILY_DISAGREEMENT',
  'SENIORITY_DISAGREEMENT',
  'EXTRACTION_ABSTENTION',
  'PROVENANCE_FAILURE'
]);

/**
 * Check if semantic profiling is enabled in shadow mode
 * @param {object} [profileConfig={}]
 * @returns {boolean}
 */
export function isSemanticShadowEnabled(profileConfig = {}) {
  const flag = profileConfig?.features?.semantic_job_profile;
  return flag === true || flag === 'shadow' || flag === 'true';
}

/**
 * Detect semantic vs legacy disagreements between evaluated profiles
 * @param {object} legacyResult
 * @param {object} semanticResult
 * @returns {{ has_disagreement: boolean, disagreements: string[], is_hard_veto_conflict: boolean }}
 */
export function detectDisagreements(legacyResult, semanticResult) {
  const disagreements = [];
  let isHardVetoConflict = false;

  if (semanticResult.status === 'ABSTAINED') {
    disagreements.push('EXTRACTION_ABSTENTION');
  }

  if (semanticResult.semantic_diagnostics?.error_code === 'PROVENANCE_VALIDATION_FAILED' ||
      (typeof semanticResult.semantic_diagnostics?.error_message === 'string' &&
       semanticResult.semantic_diagnostics.error_message.toLowerCase().includes('provenance'))) {
    disagreements.push('PROVENANCE_FAILURE');
  }

  const legacyFit = legacyResult.legacy_diagnostics?.fit_status;
  const semanticFit = semanticResult.semantic_diagnostics?.fit_status;

  // 1. Hard Veto Conflicts
  if (legacyFit === 'REJECT' && (semanticFit === 'STRONG' || semanticFit === 'REASONABLE')) {
    disagreements.push('LEGACY_REJECT_SEMANTIC_PASS');
    isHardVetoConflict = true; // Legacy vetoed an early-career friendly role
  } else if (semanticFit === 'REJECT' && (legacyFit === 'STRONG' || legacyFit === 'REASONABLE')) {
    disagreements.push('SEMANTIC_REJECT_LEGACY_PASS');
    isHardVetoConflict = true; // Semantic detected strict disqualifier that legacy missed
  }

  // 2. YOE Disagreements
  const legacyYoe = legacyResult.job_profile?.overall_yoe_required;
  const semanticYoe = semanticResult.job_profile?.overall_yoe_required;

  if (Number.isFinite(legacyYoe) && Number.isFinite(semanticYoe) && Math.abs(legacyYoe - semanticYoe) > 0.5) {
    disagreements.push('REQUIRED_YOE_MISMATCH');
  }

  // 3. Preferred vs Required Disagreement
  const legacyPref = legacyResult.job_profile?.overall_yoe_preferred;
  const semanticPref = semanticResult.job_profile?.overall_yoe_preferred;
  if ((Number.isFinite(legacyYoe) && Number.isFinite(semanticPref) && legacyYoe === semanticPref && semanticYoe !== legacyYoe) ||
      (legacyResult.legacy_diagnostics?.is_false_reject && legacyFit === 'REJECT')) {
    disagreements.push('PREFERRED_VS_REQUIRED_DISAGREEMENT');
  }

  // 4. Role Family Disagreement
  const legacyRole = legacyResult.job_profile?.role_family;
  const semanticRole = semanticResult.job_profile?.role_family;
  if (legacyRole && semanticRole && legacyRole !== semanticRole) {
    disagreements.push('ROLE_FAMILY_DISAGREEMENT');
  }

  // 5. Seniority Disagreement
  const legacySen = legacyResult.job_profile?.seniority?.level;
  const semanticSen = semanticResult.job_profile?.seniority?.level;
  if (legacySen && semanticSen && legacySen !== 'UNKNOWN' && semanticSen !== 'UNKNOWN' && legacySen !== semanticSen) {
    disagreements.push('SENIORITY_DISAGREEMENT');
  }

  return {
    has_disagreement: disagreements.length > 0,
    disagreements,
    is_hard_veto_conflict: isHardVetoConflict
  };
}

/**
 * Run evaluation in shadow mode:
 * 1. Runs legacy evaluation as authoritative production driver.
 * 2. If features.semantic_job_profile is enabled, runs semantic engine in shadow.
 * 3. Records disagreements and returns structured telemetry.
 * 4. NEVER allows semantic results to alter production state in Phase 1.
 *
 * @param {object} params
 * @param {object} params.sample - Benchmark sample or live job posting
 * @param {object} [params.candidateFacts={}]
 * @param {object} [params.candidateProfile={}]
 * @param {object} [params.options={}]
 * @returns {Promise<{
 *   production_result: object,
 *   shadow_executed: boolean,
 *   shadow_result?: object,
 *   telemetry?: object
 * }>}
 */
export async function runShadowEvaluation({
  sample,
  candidateFacts = {},
  candidateProfile = {},
  options = {}
}) {
  const startTime = Date.now();

  // 1. Always execute authoritative Legacy evaluation
  const legacyResult = await runLegacyEvaluation({
    sample,
    candidateFacts,
    candidateProfile
  });

  const isEnabled = isSemanticShadowEnabled(candidateProfile) || options.forceShadow === true;

  if (!isEnabled) {
    return {
      production_result: legacyResult,
      shadow_executed: false
    };
  }

  // 2. Execute System-1 Semantic Engine in Shadow Mode
  const semanticEngine = new SemanticEngine({
    gateway: options.gateway,
    modelId: options.modelId,
    timeoutMs: options.timeoutMs,
    mockResponse: options.mockResponse
  });

  const semanticResult = await semanticEngine.evaluate({
    sample,
    candidateFacts,
    candidateProfile,
    options
  });

  // 3. Detect and classify disagreements
  const disagreementAnalysis = detectDisagreements(legacyResult, semanticResult);

  // 4. Build Telemetry Record (Strictly PII-free)
  const telemetry = {
    timestamp: new Date().toISOString(),
    job_id: sample.sample_id || sample.metadata?.job_id || 'unknown-job',
    title: sample.metadata?.raw_title || sample.metadata?.title || 'Unknown Title',
    company: sample.metadata?.company || 'Unknown Company',
    component: 'semantic_job_profile_shadow',
    legacy: {
      tier0_passed: legacyResult.legacy_diagnostics?.tier0_passed,
      fit_status: legacyResult.legacy_diagnostics?.fit_status,
      rejection_type: legacyResult.legacy_diagnostics?.rejection_type,
      yoe_required: legacyResult.job_profile?.overall_yoe_required,
      role_family: legacyResult.job_profile?.role_family,
      seniority_level: legacyResult.job_profile?.seniority?.level
    },
    semantic: {
      status: semanticResult.status,
      fit_status: semanticResult.semantic_diagnostics?.fit_status,
      rejection_type: semanticResult.semantic_diagnostics?.rejection_type,
      yoe_required: semanticResult.job_profile?.overall_yoe_required,
      role_family: semanticResult.job_profile?.role_family,
      seniority_level: semanticResult.job_profile?.seniority?.level,
      extraction_confidence: semanticResult.job_profile?.extraction_confidence,
      gateway_calls: semanticResult.semantic_diagnostics?.gateway_calls || 0
    },
    disagreement: {
      detected: disagreementAnalysis.has_disagreement,
      types: disagreementAnalysis.disagreements,
      is_hard_veto_conflict: disagreementAnalysis.is_hard_veto_conflict,
      recommended_routing: disagreementAnalysis.is_hard_veto_conflict ? 'NEEDS_REVIEW' : 'AUTHORITATIVE_LEGACY'
    },
    metadata: {
      task_version: PROFILER_TASK_VERSION,
      prompt_version: PROMPT_VERSION,
      schema_version: SEMANTIC_SCHEMA_VERSION,
      model_id: semanticResult.semantic_diagnostics?.model_id || 'system1-default',
      latency_ms: Date.now() - startTime
    }
  };

  return {
    production_result: legacyResult,
    shadow_executed: true,
    shadow_result: semanticResult,
    telemetry
  };
}

/**
 * Hook to execute System-1 semantic profiler in shadow mode from the live evaluation path (e.g. evaluateJob).
 * Non-destructive: legacy evaluation result remains 100% production-authoritative.
 *
 * @param {object} params
 * @param {{ jdText: string, title?: string, company?: string, jobId?: string }} params.job
 * @param {object} params.legacyResult - Authoritative result produced by legacy evaluateJob
 * @param {object} [params.candidateProfile={}]
 * @param {object} [params.options={}]
 * @returns {Promise<{ shadow_executed: boolean, telemetry?: object }>}
 */
export async function runShadowProfilerHook({
  job,
  legacyResult,
  candidateProfile = {},
  options = {}
}) {
  const isEnabled = isSemanticShadowEnabled(candidateProfile) || options.forceShadow === true;
  if (!isEnabled) {
    return { shadow_executed: false };
  }

  const startTime = Date.now();
  try {
    const semanticEngine = new SemanticEngine({
      gateway: options.gateway,
      modelId: options.modelId,
      timeoutMs: options.timeoutMs ?? 30_000,
      mockResponse: options.mockResponse
    });

    const sample = {
      sample_id: job.jobId || `live-${Date.now()}`,
      metadata: { raw_title: job.title || '', company: job.company || '' },
      raw_jd_text: job.jdText || ''
    };

    const candidateFacts = candidateProfile.verified_candidate_facts || candidateProfile;

    const semanticResult = await semanticEngine.evaluate({
      sample,
      candidateFacts,
      candidateProfile,
      options
    });

    const legacyDiagnostic = {
      fit_status: legacyResult.status === 'REJECTED' ? 'REJECT' : legacyResult.status === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : 'STRONG',
      tier0_passed: legacyResult.tier !== 0,
      rejection_type: legacyResult.status === 'REJECTED' ? 'HEURISTIC_DISCARD' : 'NONE'
    };

    const legacyAdapted = {
      legacy_diagnostics: legacyDiagnostic,
      job_profile: {
        overall_yoe_required: legacyResult.extraction?.required_yoe ?? null,
        overall_yoe_preferred: legacyResult.extraction?.preferred_yoe ?? null,
        role_family: legacyResult.extraction?.role_family || 'other',
        seniority: { level: 'UNKNOWN' }
      }
    };

    const disagreementAnalysis = detectDisagreements(legacyAdapted, semanticResult);

    const telemetry = {
      timestamp: new Date().toISOString(),
      job_id: sample.sample_id,
      title: job.title || 'Unknown Title',
      company: job.company || 'Unknown Company',
      component: 'live_evaluation_shadow_hook',
      legacy: {
        status: legacyResult.status,
        tier: legacyResult.tier,
        reason: legacyResult.reason,
        yoe_required: legacyResult.extraction?.required_yoe ?? null,
        role_family: legacyResult.extraction?.role_family ?? null
      },
      semantic: {
        status: semanticResult.status,
        fit_status: semanticResult.semantic_diagnostics?.fit_status,
        yoe_required: semanticResult.job_profile?.overall_yoe_required ?? null,
        role_family: semanticResult.job_profile?.role_family ?? null,
        seniority_level: semanticResult.job_profile?.seniority?.level ?? null,
        confidence: semanticResult.job_profile?.extraction_confidence ?? null,
        gateway_calls: semanticResult.semantic_diagnostics?.gateway_calls || 0
      },
      disagreement: {
        detected: disagreementAnalysis.has_disagreement,
        types: disagreementAnalysis.disagreements,
        is_hard_veto_conflict: disagreementAnalysis.is_hard_veto_conflict,
        recommended_routing: disagreementAnalysis.is_hard_veto_conflict ? 'NEEDS_REVIEW' : 'AUTHORITATIVE_LEGACY'
      },
      metadata: {
        task_version: PROFILER_TASK_VERSION,
        prompt_version: PROMPT_VERSION,
        schema_version: SEMANTIC_SCHEMA_VERSION,
        model_id: semanticResult.semantic_diagnostics?.model_id || 'system1-default',
        latency_ms: Date.now() - startTime
      }
    };

    return {
      shadow_executed: true,
      telemetry
    };
  } catch (err) {
    return {
      shadow_executed: true,
      telemetry: {
        timestamp: new Date().toISOString(),
        component: 'live_evaluation_shadow_hook',
        error: err.message,
        error_code: err.code || 'SHADOW_EXECUTION_FAILED'
      }
    };
  }
}
