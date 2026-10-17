// @ts-check
/**
 * semantic-engine.mjs — Real System-1 Semantic Engine Implementation (Phase 1)
 *
 * Implements the ISemanticEngine interface using the Phase 1 Job Semantic Profiler.
 *
 * Invariants:
 * - MODELS UNDERSTAND. CODE DECIDES. Model extracts semantic facts; deterministic policy decides fit status.
 * - Exact schema and provenance validation.
 * - Fail-closed: If gateway is unavailable or offline, reports an honest typed unavailable status.
 * - NEVER fabricates predictions.
 */

import { ISemanticEngine } from './semantic-engine-interface.mjs';
import {
  profileJobSemantic,
  SemanticProfilerError,
  createAbstentionProfile
} from '../job-semantic-profiler.mjs';
import {
  createMatchProfile,
  createRequirementMatch,
  createCandidateSemanticProfile,
  assertValidMatchProfile
} from '../semantic-entities.mjs';
import { evaluateSemanticFitPolicy } from '../policy-safeguards.mjs';
import { computeSourceHash } from '../provenance-validator.mjs';

export class SemanticEngine extends ISemanticEngine {
  /**
   * @param {object} [options={}]
   * @param {Function} [options.gateway] - Custom gateway
   * @param {string} [options.modelId] - Override model ID
   * @param {number} [options.timeoutMs] - Timeout in ms
   * @param {object} [options.mockResponse] - Direct mock response for deterministic testing
   */
  constructor(options = {}) {
    super(options);
    this.engineName = 'semantic-system1';
    this.isImplemented = true;
    this.gateway = options.gateway;
    this.modelId = options.modelId;
    this.timeoutMs = options.timeoutMs;
    this.mockResponse = options.mockResponse;
  }

  /**
   * Evaluate a job posting against candidate facts using System-1 semantic extraction
   *
   * @param {object} params
   * @param {object} params.sample - Benchmark sample
   * @param {object} [params.candidateFacts={}] - Canonical candidate facts
   * @param {object} [params.candidateProfile={}] - Candidate profile config
   * @param {object} [params.options={}] - Execution options
   * @returns {Promise<{
   *   status: "SUCCESS" | "ABSTAINED" | "UNAVAILABLE",
   *   job_profile?: object,
   *   match_profile?: object,
   *   semantic_diagnostics: {
   *     fit_status: "STRONG" | "REASONABLE" | "LONG_STRETCH" | "REJECT" | "NEEDS_REVIEW",
   *     rejection_type: "NONE" | "POLICY_DISCARD" | "HEURISTIC_DISCARD" | "ELIGIBILITY_DISCARD" | "MISSING_INFO" | "UNCERTAIN",
   *     is_false_reject: boolean,
   *     latency_ms: number,
   *     gateway_calls: number,
   *     model_id: string,
   *     error_code?: string,
   *     error_message?: string
   *   }
   * }>}
   */
  async evaluate({
    sample,
    candidateFacts = {},
    candidateProfile = {},
    options = {}
  }) {
    const startTime = Date.now();
    const rawJd = sample.raw_jd_text || '';
    const title = sample.metadata?.raw_title || sample.metadata?.title || '';
    const company = sample.metadata?.company || '';
    const sampleId = sample.sample_id || `sample-${Date.now()}`;
    const candYoe = candidateFacts.professional_years ?? 0;

    // 1. Invoke System-1 Job Semantic Profiler
    let profilerResult;
    try {
      profilerResult = await profileJobSemantic(
        {
          jdText: rawJd,
          title,
          company,
          jobId: sampleId,
          sourceUrl: sample.metadata?.source_url
        },
        {
          gateway: options.gateway || this.gateway,
          modelId: options.modelId || this.modelId,
          timeoutMs: options.timeoutMs || this.timeoutMs,
          mockResponse: options.mockResponse || this.mockResponse
        }
      );
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const isUnavailable =
        err.code === 'MODEL_UNAVAILABLE' ||
        err.code === 'CLI_UNAVAILABLE' ||
        err.code === 'MODEL_TIMEOUT' ||
        err.code === 'MODEL_TRANSPORT_ERROR';

      if (isUnavailable) {
        return {
          status: 'UNAVAILABLE',
          semantic_diagnostics: {
            fit_status: 'NEEDS_REVIEW',
            rejection_type: 'UNCERTAIN',
            is_false_reject: false,
            latency_ms: latencyMs,
            gateway_calls: 0,
            model_id: this.modelId || 'system1-default',
            error_code: err.code || 'MODEL_UNAVAILABLE',
            error_message: err.message
          }
        };
      }

      // If extraction failed due to malformed output or low confidence, create safe abstention profile
      const abstainedProfile = createAbstentionProfile(
        { jdText: rawJd, title, company, jobId: sampleId },
        err.message,
        { modelId: this.modelId }
      );

      const abstainedMatch = createMatchProfile({
        match_id: `match-abstain-${sampleId}`,
        job_id: sampleId,
        candidate_hash: computeSourceHash(JSON.stringify(candidateFacts)),
        requirement_matches: [],
        yoe_comparison: {
          required_yoe: null,
          candidate_verified_yoe: candYoe,
          shortfall: 0,
          policy_status: 'NEEDS_REVIEW'
        },
        legal_eligibility_status: 'NEEDS_REVIEW',
        critical_gaps: [],
        transferable_strengths: [],
        overall_match_score: 2.5
      });

      return {
        status: 'ABSTAINED',
        job_profile: abstainedProfile,
        match_profile: abstainedMatch,
        semantic_diagnostics: {
          fit_status: 'NEEDS_REVIEW',
          rejection_type: 'UNCERTAIN',
          is_false_reject: false,
          latency_ms: latencyMs,
          gateway_calls: 1,
          model_id: this.modelId || 'system1-default',
          error_code: err.code || 'EXTRACTION_FAILED',
          error_message: err.message
        }
      };
    }

    const { profile: jobProfile, telemetry } = profilerResult;

    // 2. Prepare Candidate Profile for Policy Evaluation
    const candidateSemanticProfile = createCandidateSemanticProfile({
      candidate_id: candidateFacts.candidate_id || 'cand-default',
      candidate_hash: computeSourceHash(JSON.stringify(candidateFacts)),
      verified_yoe: candYoe,
      verified_yoe_source: candidateFacts.professional_years_source || 'cv.md',
      capabilities: [],
      education: (candidateFacts.degrees || []).map((deg) => ({
        degree: deg,
        field: 'Computer Science',
        institution: null,
        gpa: candidateFacts.gpa || null,
        gpa_scale: candidateFacts.gpa_scale || null,
        is_verified: true,
        source_file: 'cv.md',
        source_quote: deg
      })),
      legal_eligibility: {
        work_authorization: candidateFacts.work_authorization !== undefined ? candidateFacts.work_authorization : null,
        security_clearance: candidateFacts.security_clearance !== undefined ? candidateFacts.security_clearance : null,
        citizenship: Array.isArray(candidateFacts.citizenship) ? candidateFacts.citizenship : null,
        requires_sponsorship: candidateFacts.requires_sponsorship !== undefined ? candidateFacts.requires_sponsorship : null
      },
      target_roles: ['software_engineering', 'ai_ml'],
      provenance_summary: {
        cv_hash: computeSourceHash(JSON.stringify(candidateFacts))
      }
    });

    // 3. Evaluate Deterministic Policy (CODE DECIDES)
    const policyResult = evaluateSemanticFitPolicy({
      jobProfile,
      candidateProfile: candidateSemanticProfile,
      options: {
        enforceSeniorTitleVeto: false // Semantic engine eliminates brittle title-only veto
      }
    });

    // 4. Build Requirement Matches
    const requirementMatches = (jobProfile.requirements || []).map((req) => {
      const isYoe = req.type === 'YEARS_EXPERIENCE';
      const isGap = isYoe ? policyResult.shortfall > 0 : false;
      return createRequirementMatch({
        requirement_id: req.requirement_id,
        relation: isYoe ? (policyResult.shortfall === 0 ? 'EXACT' : 'PARTIAL') : 'UNKNOWN',
        evidence_quote: req.evidence_span.verbatim_quote,
        is_gap: isGap,
        match_confidence: req.confidence
      });
    });

    // Score calculation based on deterministic policy status
    let matchScore = 4.0;
    if (policyResult.policy_status === 'STRONG') matchScore = 4.8;
    else if (policyResult.policy_status === 'REASONABLE') matchScore = 4.2;
    else if (policyResult.policy_status === 'LONG_STRETCH') matchScore = 3.5;
    else if (policyResult.policy_status === 'REJECT') matchScore = 1.5;
    else if (policyResult.policy_status === 'NEEDS_REVIEW') matchScore = 2.5;

    const matchProfile = createMatchProfile({
      match_id: `match-sem-${sampleId}`,
      job_id: sampleId,
      candidate_hash: candidateSemanticProfile.candidate_hash,
      requirement_matches: requirementMatches,
      yoe_comparison: {
        required_yoe: jobProfile.overall_yoe_required,
        candidate_verified_yoe: candYoe,
        shortfall: policyResult.shortfall,
        policy_status: policyResult.policy_status
      },
      legal_eligibility_status: policyResult.legal_eligibility_status,
      critical_gaps: policyResult.shortfall >= 4 ? [`YOE shortfall of ${policyResult.shortfall} years`] : [],
      transferable_strengths: [],
      overall_match_score: matchScore
    });

    assertValidMatchProfile(matchProfile);

    // Rejection classification
    let rejectionType = 'NONE';
    if (policyResult.policy_status === 'REJECT') {
      if (policyResult.legal_eligibility_status === 'INELIGIBLE') {
        rejectionType = 'ELIGIBILITY_DISCARD';
      } else if (policyResult.shortfall >= 4) {
        rejectionType = 'POLICY_DISCARD';
      } else {
        rejectionType = 'HEURISTIC_DISCARD';
      }
    } else if (policyResult.policy_status === 'NEEDS_REVIEW') {
      rejectionType = 'UNCERTAIN';
    }

    const latencyMs = Date.now() - startTime;

    return {
      status: 'SUCCESS',
      job_profile: jobProfile,
      match_profile: matchProfile,
      semantic_diagnostics: {
        fit_status: policyResult.policy_status,
        rejection_type: rejectionType,
        is_false_reject: false,
        latency_ms: latencyMs,
        gateway_calls: telemetry.gateway_calls,
        model_id: telemetry.model_id
      }
    };
  }
}
