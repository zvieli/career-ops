// @ts-check
/**
 * policy-safeguards.mjs — Deterministic Policy Safeguards & Fail-Closed Evaluation Policy
 *
 * Core Invariant:
 * MODELS UNDERSTAND. CODE DECIDES. HUMANS AUTHORIZE.
 *
 * Safeguards:
 * 1. Preserves requirement uncertainty (ambiguous YOE, low confidence -> NEEDS_REVIEW).
 * 2. Preserves candidate-fact uncertainty (unknown work authorization -> NEEDS_REVIEW, never false rejection).
 * 3. Distinguishes explicit minimum experience from inferred seniority (title vs duties).
 * 4. Distinguishes legal eligibility from technical matching.
 * 5. Safe rejection handling: Shortfall >= 4 is NOT encoded as an unconditional instant discard.
 *    Instead, shortfall, confidence, and policy status are explicitly reported.
 * 6. Supports NEEDS_REVIEW as a first-class fail-safe state.
 */

import {
  POLICY_STATUSES,
  LEGAL_ELIGIBILITY_STATUSES
} from './semantic-entities.mjs';

/**
 * PROVISIONAL / UNCALIBRATED extraction confidence review threshold.
 * Extractions below this threshold fail closed to NEEDS_REVIEW.
 * Explicitly provisional until empirically calibrated against dual-human-verified benchmarks.
 */
export const PROVISIONAL_EXTRACTION_CONFIDENCE_THRESHOLD = 0.70;

/**
 * Evaluate deterministic candidate fit policy over structured semantic inputs.
 * Separates semantic understanding from deterministic decision thresholds.
 *
 * @param {object} params
 * @param {object} params.jobProfile - Validated JobSemanticProfile
 * @param {object} params.candidateProfile - Validated CandidateSemanticProfile
 * @param {object} [params.options] - Policy options
 * @param {boolean} [params.options.enforceSeniorTitleVeto=false] - Legacy title veto
 * @param {number} [params.options.confidenceThreshold] - Override extraction review threshold
 * @returns {{
 *   policy_status: "STRONG" | "REASONABLE" | "LONG_STRETCH" | "REJECT" | "NEEDS_REVIEW",
 *   shortfall: number,
 *   legal_eligibility_status: "ELIGIBLE" | "INELIGIBLE" | "NEEDS_REVIEW",
 *   reasons: string[],
 *   requires_human_review: boolean,
 *   is_false_reject_risk: boolean
 * }}
 */
export function evaluateSemanticFitPolicy({
  jobProfile,
  candidateProfile,
  options = {}
}) {
  const reasons = [];
  let requiresHumanReview = false;
  let isFalseRejectRisk = false;

  const confidenceThreshold = typeof options.confidenceThreshold === 'number'
    ? options.confidenceThreshold
    : PROVISIONAL_EXTRACTION_CONFIDENCE_THRESHOLD;

  // 1. Validate Extraction Integrity & Confidence
  if (!jobProfile || typeof jobProfile !== 'object') {
    return {
      policy_status: 'NEEDS_REVIEW',
      shortfall: 0,
      legal_eligibility_status: 'NEEDS_REVIEW',
      reasons: ['Job semantic profile is missing or invalid.'],
      requires_human_review: true,
      is_false_reject_risk: false
    };
  }

  if (jobProfile.extraction_confidence < confidenceThreshold) {
    reasons.push(`Low extraction confidence (${jobProfile.extraction_confidence.toFixed(2)} < threshold ${confidenceThreshold.toFixed(2)}): requires human inspection.`);
    requiresHumanReview = true;
  }

  // 2. Evaluate Legal Eligibility Independently from Technical Fit
  let legalStatus = 'ELIGIBLE';
  const legalRequirements = (jobProfile.requirements || []).filter(
    (r) => r.type === 'LEGAL_ADMINISTRATIVE' || r.type === 'SECURITY_CLEARANCE'
  );

  const candidateLegal = candidateProfile?.legal_eligibility || {};

  for (const req of legalRequirements) {
    if (req.type === 'SECURITY_CLEARANCE' && req.importance === 'LEGAL_MANDATORY') {
      if (candidateLegal.security_clearance === false) {
        legalStatus = 'INELIGIBLE';
        reasons.push('Position requires security clearance which candidate does not hold.');
      } else if (candidateLegal.security_clearance === null || candidateLegal.security_clearance === undefined) {
        legalStatus = 'NEEDS_REVIEW';
        reasons.push('Security clearance requirement unknown for candidate.');
        requiresHumanReview = true;
      }
    }

    if (req.type === 'LEGAL_ADMINISTRATIVE' && req.importance === 'LEGAL_MANDATORY') {
      if (candidateLegal.work_authorization === false) {
        legalStatus = 'INELIGIBLE';
        reasons.push('Position requires work authorization which candidate does not possess.');
      } else if (candidateLegal.work_authorization === null || candidateLegal.work_authorization === undefined) {
        // Crucial invariant: Unknown work authorization is NEVER an automatic rejection!
        if (legalStatus !== 'INELIGIBLE') {
          legalStatus = 'NEEDS_REVIEW';
        }
        reasons.push('Candidate work authorization status is unknown; requires verification.');
        requiresHumanReview = true;
      }
    }
  }

  // 3. Seniority vs Title Nuance
  const title = jobProfile.title || '';
  const seniority = jobProfile.seniority || { level: 'UNKNOWN', is_early_career_friendly: false };
  const hasSeniorTitleToken = /\b(senior|sr\.?|lead|principal|staff|director|head|chief)\b/i.test(title);

  // If title has a senior token, but posting explicitly states early-career friendly or YOE <= 2
  if (hasSeniorTitleToken && (seniority.is_early_career_friendly || (jobProfile.overall_yoe_required !== null && jobProfile.overall_yoe_required <= 2))) {
    isFalseRejectRisk = true;
    reasons.push(`Title "${title}" contains elevated keyword, but requirements indicate early-career viability (${seniority.rationale || 'low YOE requirement'}).`);
  }

  // Optional legacy strict veto (for comparison in legacy adapter)
  if (options.enforceSeniorTitleVeto && hasSeniorTitleToken) {
    return {
      policy_status: 'REJECT',
      shortfall: 0,
      legal_eligibility_status: legalStatus,
      reasons: ['Senior/lead title conflicts with early-career title filter.'],
      requires_human_review: false,
      is_false_reject_risk: isFalseRejectRisk
    };
  }

  // If legal status is strictly INELIGIBLE, mark REJECT
  if (legalStatus === 'INELIGIBLE') {
    return {
      policy_status: 'REJECT',
      shortfall: 0,
      legal_eligibility_status: 'INELIGIBLE',
      reasons,
      requires_human_review: false,
      is_false_reject_risk: false
    };
  }

  // 4. Years of Experience Comparison
  const requiredYoe = jobProfile.overall_yoe_required;
  const verifiedYoe = candidateProfile?.verified_yoe;
  let shortfall = 0;
  let policyStatus = 'STRONG';

  if (requiredYoe !== null && requiredYoe !== undefined && Number.isFinite(requiredYoe)) {
    if (verifiedYoe === null || verifiedYoe === undefined || !Number.isFinite(verifiedYoe)) {
      policyStatus = 'NEEDS_REVIEW';
      reasons.push('Candidate verified professional YOE is unavailable for required YOE evaluation.');
      requiresHumanReview = true;
    } else {
      shortfall = Math.max(0, requiredYoe - verifiedYoe);

      if (shortfall >= 4) {
        // High shortfall
        policyStatus = 'REJECT';
        reasons.push(`Required professional YOE (${requiredYoe}) exceeds candidate verified YOE (${verifiedYoe}) by ${shortfall} years.`);
      } else if (shortfall > 0) {
        policyStatus = 'LONG_STRETCH';
        reasons.push(`Required professional YOE (${requiredYoe}) exceeds candidate verified YOE (${verifiedYoe}) by ${shortfall} years (stretch).`);
      } else {
        policyStatus = 'STRONG';
      }
    }
  }

  // Preferred YOE Check
  const preferredYoe = jobProfile.overall_yoe_preferred;
  if (policyStatus === 'STRONG' && preferredYoe !== null && Number.isFinite(preferredYoe) && Number.isFinite(verifiedYoe)) {
    if (preferredYoe > verifiedYoe) {
      policyStatus = 'REASONABLE';
      reasons.push(`Candidate meets required YOE, but preferred YOE (${preferredYoe}) exceeds candidate YOE (${verifiedYoe}).`);
    }
  }

  // If extraction confidence is low or legal status is NEEDS_REVIEW, the overall policy cannot be unconditionally STRONG/REASONABLE
  if (jobProfile.extraction_confidence < confidenceThreshold || legalStatus === 'NEEDS_REVIEW') {
    requiresHumanReview = true;
    if (policyStatus === 'STRONG' || policyStatus === 'REASONABLE') {
      policyStatus = 'NEEDS_REVIEW';
    }
  }

  if (reasons.length === 0) {
    reasons.push('Candidate satisfies all verified requirements without prohibitive gaps.');
  }

  return {
    policy_status: policyStatus,
    shortfall,
    legal_eligibility_status: legalStatus,
    reasons,
    requires_human_review: requiresHumanReview,
    is_false_reject_risk: isFalseRejectRisk
  };
}
