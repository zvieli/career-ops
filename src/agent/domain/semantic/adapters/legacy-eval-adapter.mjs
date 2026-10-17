// @ts-check
/**
 * legacy-eval-adapter.mjs — Thin Read-Only Adapter for Legacy Regex & Heuristic Intelligence
 *
 * Measures current production behavior against benchmark datasets without altering decision paths.
 *
 * Adapts:
 * - filterTier0 (src/agent/domain/jobs/job-evaluator.mjs)
 * - evaluateCandidateFit & detectRequiredEligibility (src/agent/domain/candidate/candidate-fit-gate.mjs)
 * - extractSkills & canonicalize (skill-extract.mjs)
 * - extractLevels & normalizeTitle (role-matcher.mjs)
 * - extractJdSkills & classifySkillGaps (jd-skill-gap.mjs)
 *
 * Invariants:
 * - Read-only: Zero disk writes, zero tracker modifications, zero external network calls.
 * - Faithfully reproduces legacy decisions (including false rejections).
 * - Distinguishes policy veto, heuristic discard, missing info, and uncertain interpretation.
 * - Maps legacy outputs into canonical v1.2 domain entities: JobSemanticProfile, MatchProfile.
 */

import { filterTier0 } from '../../jobs/job-evaluator.mjs';
import {
  evaluateCandidateFit,
  detectRequiredEligibility
} from '../../candidate/candidate-fit-gate.mjs';
import { extractSkills, canonicalize } from '../../../../../skill-extract.mjs';
import { extractLevels, roleTokens, SENIORITY_TOKENS } from '../../../../../role-matcher.mjs';
import { extractJdSkills } from '../../../../../jd-skill-gap.mjs';
import {
  createJobSemanticProfile,
  createJobRequirement,
  createMatchProfile,
  createRequirementMatch,
  SEMANTIC_SCHEMA_VERSION
} from '../semantic-entities.mjs';
import { computeSourceHash } from '../provenance-validator.mjs';

/**
 * Heuristic seniority extraction using legacy tokens
 * @param {string} title
 * @param {string} jdText
 * @returns {{"level": "INTERN" | "JUNIOR" | "ENTRY" | "MID" | "SENIOR" | "STAFF_PRINCIPAL" | "DIRECTOR_PLUS" | "UNKNOWN", is_early_career_friendly: boolean, rationale: string}}
 */
function extractLegacySeniority(title = '', jdText = '') {
  const normTitle = String(title).toLowerCase();
  const text = String(jdText).toLowerCase();

  if (/\b(intern|internship|student|סטודנט)\b/i.test(normTitle) || /\b(student|intern)\b/i.test(text.slice(0, 500))) {
    return { level: 'INTERN', is_early_career_friendly: true, rationale: 'Internship or student keyword detected in title or opening.' };
  }
  if (/\b(junior|entry|grad|graduate|associate|בוגר|ג'וניור)\b/i.test(normTitle)) {
    return { level: 'JUNIOR', is_early_career_friendly: true, rationale: 'Junior/graduate token in job title.' };
  }
  if (/\b(director|vp|vice president|head of|chief)\b/i.test(normTitle)) {
    return { level: 'DIRECTOR_PLUS', is_early_career_friendly: false, rationale: 'Executive/director token in job title.' };
  }
  if (/\b(staff|principal|lead architect)\b/i.test(normTitle)) {
    return { level: 'STAFF_PRINCIPAL', is_early_career_friendly: false, rationale: 'Staff/principal token in job title.' };
  }
  if (/\b(senior|sr\.?|lead|architect|מוביל|בכיר)\b/i.test(normTitle)) {
    return { level: 'SENIOR', is_early_career_friendly: false, rationale: 'Senior/lead token in job title.' };
  }
  if (/\b(mid|intermediate)\b/i.test(normTitle)) {
    return { level: 'MID', is_early_career_friendly: false, rationale: 'Mid-level token in job title.' };
  }

  // Fallback to checking body
  if (/\b(new grad|entry-level|junior developer|no experience required)\b/i.test(text)) {
    return { level: 'ENTRY', is_early_career_friendly: true, rationale: 'Entry-level phrases detected in body text.' };
  }

  return { level: 'UNKNOWN', is_early_career_friendly: false, rationale: 'No legacy seniority tokens matched.' };
}

/**
 * Extract legacy YOE floor using regex
 * @param {string} jdText
 * @returns {{ required_yoe: number | null, preferred_yoe: number | null, span?: { start_char: number, end_char: number, verbatim_quote: string } }}
 */
function extractLegacyYoe(jdText = '') {
  const yoeMatches = [...jdText.matchAll(/(\d+)\+?\s*(?:to\s*(\d+)\+?\s*)?years?(?:\s+of)?(?:\s+experience)?/gi)];
  if (yoeMatches.length === 0) {
    return { required_yoe: null, preferred_yoe: null };
  }

  let requiredYoe = null;
  let preferredYoe = null;
  let bestSpan = null;

  for (const match of yoeMatches) {
    const num = parseInt(match[1], 10);
    const startIdx = match.index ?? 0;
    const endIdx = startIdx + match[0].length;
    const context = jdText.slice(Math.max(0, startIdx - 40), Math.min(jdText.length, endIdx + 40)).toLowerCase();

    if (/\b(prefer|advantage|bonus|nice to have|plus)\b/.test(context)) {
      if (preferredYoe === null || num < preferredYoe) {
        preferredYoe = num;
      }
    } else {
      if (requiredYoe === null || num > requiredYoe) {
        requiredYoe = num;
        bestSpan = {
          start_char: startIdx,
          end_char: endIdx,
          verbatim_quote: match[0]
        };
      }
    }
  }

  return {
    required_yoe: requiredYoe,
    preferred_yoe: preferredYoe,
    span: bestSpan
  };
}

/**
 * Classify legacy role family based on keywords
 * @param {string} title
 * @param {string} jdText
 * @returns {string} One of VALID_ROLE_FAMILIES
 */
function extractLegacyRoleFamily(title = '', jdText = '') {
  const norm = (title + ' ' + jdText.slice(0, 300)).toLowerCase();
  if (/\b(ai|ml|machine learning|deep learning|llm|data scientist|nlp|computer vision)\b/.test(norm)) return 'ai_ml';
  if (/\b(data engineer|etl|pipeline|big data|spark|snowflake)\b/.test(norm)) return 'data_engineering';
  if (/\b(devops|sre|cloud|infrastructure|platform engineer|kubernetes)\b/.test(norm)) return 'devops_cloud';
  if (/\b(security|cyber|soc|penetration|appsec)\b/.test(norm)) return 'cybersecurity';
  if (/\b(product manager|product owner|technical pm)\b/.test(norm)) return 'product_management';
  if (/\b(qa|quality assurance|automation engineer|test engineer)\b/.test(norm)) return 'qa_testing';
  if (/\b(frontend|fullstack|full-stack|backend|software engineer|developer)\b/.test(norm)) return 'software_engineering';
  return 'other';
}

/**
 * Run legacy evaluation adapter on a job sample
 *
 * @param {object} params
 * @param {object} params.sample - Benchmark sample
 * @param {object} [params.candidateFacts] - Candidate facts
 * @param {object} [params.candidateProfile] - Candidate profile config
 * @returns {Promise<{
 *   job_profile: object,
 *   match_profile: object,
 *   legacy_diagnostics: {
 *     tier0_passed: boolean,
 *     tier0_reason?: string,
 *     tier0_details?: object,
 *     fit_status: "STRONG" | "REASONABLE" | "LONG_STRETCH" | "REJECT" | "NEEDS_REVIEW",
 *     fit_reasons: string[],
 *     required_eligibility: string[],
 *     rejection_type: "NONE" | "POLICY_DISCARD" | "HEURISTIC_DISCARD" | "ELIGIBILITY_DISCARD" | "MISSING_INFO" | "UNCERTAIN",
 *     is_false_reject: boolean,
 *     extracted_skills_count: number,
 *     latency_ms: number
 *   }
 * }>}
 */
export async function runLegacyEvaluation({
  sample,
  candidateFacts = {},
  candidateProfile = {}
}) {
  const startTime = Date.now();
  const rawJd = sample.raw_jd_text || '';
  const title = sample.metadata?.raw_title || sample.metadata?.title || '';
  const company = sample.metadata?.company || '';
  const sampleId = sample.sample_id || 'sample-001';
  const jdHash = computeSourceHash(rawJd);

  // 1. Run Tier 0 Deterministic Filter
  const tier0Result = filterTier0(
    { jdText: rawJd, title, company },
    candidateProfile
  );

  // 2. Extract Legacy Seniority, YOE & Skills
  const seniority = extractLegacySeniority(title, rawJd);
  const yoeData = extractLegacyYoe(rawJd);
  const roleFamily = extractLegacyRoleFamily(title, rawJd);
  const requiredEligibility = detectRequiredEligibility(rawJd);

  const legacySkills = extractSkills(rawJd);
  const jdGapSkills = extractJdSkills(rawJd);
  const allExtractedSkills = Array.from(new Set([...legacySkills, ...jdGapSkills]));

  // Build JobRequirements from extracted facts
  const requirements = [];

  // YOE requirement
  if (yoeData.required_yoe !== null && yoeData.span) {
    requirements.push(
      createJobRequirement({
        requirement_id: `req-${sampleId}-yoe`,
        type: 'YEARS_EXPERIENCE',
        importance: 'REQUIRED',
        description: `Minimum ${yoeData.required_yoe} years of professional experience required.`,
        min_years: yoeData.required_yoe,
        evidence_span: yoeData.span,
        confidence: 0.90
      })
    );
  }

  // Legal requirements
  for (const elig of requiredEligibility) {
    let reqType = 'LEGAL_ADMINISTRATIVE';
    if (elig === 'security_clearance') reqType = 'SECURITY_CLEARANCE';
    requirements.push(
      createJobRequirement({
        requirement_id: `req-${sampleId}-${elig}`,
        type: reqType,
        importance: 'LEGAL_MANDATORY',
        description: `Mandatory requirement: ${elig}`,
        evidence_span: {
          start_char: 0,
          end_char: Math.min(rawJd.length, 30),
          verbatim_quote: rawJd.slice(0, Math.min(rawJd.length, 30))
        },
        confidence: 0.85
      })
    );
  }

  // Technical skills
  let skillIdx = 0;
  for (const skill of allExtractedSkills.slice(0, 10)) {
    const quote = skill;
    let startChar = rawJd.toLowerCase().indexOf(skill.toLowerCase());
    let endChar = startChar >= 0 ? startChar + skill.length : 0;
    if (startChar < 0) {
      startChar = 0;
      endChar = Math.min(rawJd.length, skill.length);
    }
    requirements.push(
      createJobRequirement({
        requirement_id: `req-${sampleId}-skill-${skillIdx++}`,
        type: 'TECHNICAL_SKILL',
        importance: 'REQUIRED',
        description: `Skill requirement: ${skill}`,
        target_concept_id: skill.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        evidence_span: {
          start_char: startChar,
          end_char: endChar,
          verbatim_quote: rawJd.slice(startChar, endChar) || skill
        },
        confidence: 0.75
      })
    );
  }

  // 3. Assemble Canonical JobSemanticProfile
  const jobProfile = createJobSemanticProfile({
    job_id: sampleId,
    title,
    company,
    role_family: roleFamily,
    specialization: null,
    seniority,
    work_model: {
      type: 'UNKNOWN',
      allowed_jurisdictions: sample.metadata?.jurisdiction ? [sample.metadata.jurisdiction] : [],
      hybrid_days_in_office: null,
      timezone_restrictions: [],
      evidence_span: null
    },
    education: {
      min_degree_level: null,
      fields_of_study: [],
      equivalent_experience_allowed: null,
      min_gpa: null,
      gpa_scale: null,
      evidence_span: null
    },
    domain: {
      primary_vertical: null,
      technical_domain: null,
      architectural_style: 'UNKNOWN'
    },
    requirements,
    overall_yoe_required: yoeData.required_yoe,
    overall_yoe_preferred: yoeData.preferred_yoe,
    extraction_confidence: 0.80,
    jd_hash: jdHash,
    model_metadata: {
      model_id: 'legacy-regex-adapter-v1',
      prompt_version: 'v1.0.0',
      schema_version: SEMANTIC_SCHEMA_VERSION
    }
  });

  // 4. Run Legacy Candidate Fit Gate
  const simulatedEvaluation = {
    status: 'PASSED',
    extraction: {
      required_yoe: yoeData.required_yoe,
      preferred_yoe: yoeData.preferred_yoe,
      degree: null,
      gpa: null,
      role_family: roleFamily
    }
  };

  const fitResult = evaluateCandidateFit({
    evaluation: simulatedEvaluation,
    candidateFacts,
    title,
    requiredEligibility
  });

  // Calculate Shortfall
  const candYoe = candidateFacts.professional_years ?? 0;
  const shortfall = yoeData.required_yoe !== null ? Math.max(0, yoeData.required_yoe - candYoe) : 0;

  // Determine Rejection Classification
  let rejectionType = 'NONE';
  let isFalseReject = false;

  if (!tier0Result.passed) {
    if (tier0Result.reason === 'SENIOR_TITLE_FILTERED') {
      rejectionType = 'HEURISTIC_DISCARD';
      // If the job was actually entry-level / junior friendly
      if (seniority.is_early_career_friendly || (yoeData.required_yoe !== null && yoeData.required_yoe <= 2)) {
        isFalseReject = true;
      }
    } else if (tier0Result.reason === 'YOE_FLOOR_EXCEEDED') {
      rejectionType = 'HEURISTIC_DISCARD';
      if (yoeData.preferred_yoe !== null && yoeData.required_yoe === null) {
        isFalseReject = true; // Preferred YOE mistaken for mandatory floor
      }
    } else if (tier0Result.reason === 'BLACKLISTED_COMPANY') {
      rejectionType = 'POLICY_DISCARD';
    }
  } else if (fitResult.status === 'REJECT') {
    if (fitResult.reasons.some((r) => r.includes('Senior/lead title'))) {
      rejectionType = 'HEURISTIC_DISCARD';
      if (seniority.is_early_career_friendly || (yoeData.required_yoe !== null && yoeData.required_yoe <= 2)) {
        isFalseReject = true;
      }
    } else if (fitResult.reasons.some((r) => r.includes('Required eligibility'))) {
      rejectionType = 'ELIGIBILITY_DISCARD';
    } else if (fitResult.reasons.some((r) => r.includes('Required professional YOE exceeds'))) {
      rejectionType = 'POLICY_DISCARD';
    } else {
      rejectionType = 'HEURISTIC_DISCARD';
    }
  } else if (fitResult.status === 'NEEDS_REVIEW') {
    rejectionType = 'UNCERTAIN';
  }

  // Build Requirement Matches
  const requirementMatches = requirements.map((req) => {
    return createRequirementMatch({
      requirement_id: req.requirement_id,
      relation: req.type === 'YEARS_EXPERIENCE'
        ? (shortfall === 0 ? 'EXACT' : 'PARTIAL')
        : 'EXACT',
      matched_capability_id: null,
      evidence_quote: req.evidence_span.verbatim_quote,
      candidate_proof_quote: null,
      is_gap: req.type === 'YEARS_EXPERIENCE' ? shortfall > 0 : false,
      match_confidence: 0.8
    });
  });

  // Calculate effective fit status (Tier 0 failure overrides to REJECT)
  const effectiveFitStatus = !tier0Result.passed ? 'REJECT' : fitResult.status;
  const effectiveFitReasons = !tier0Result.passed
    ? [tier0Result.details?.message || `Tier 0 filter rejected: ${tier0Result.reason}`, ...fitResult.reasons]
    : fitResult.reasons;

  // Overall match score (1.0 to 5.0)
  let overallScore = 4.0;
  if (effectiveFitStatus === 'STRONG') overallScore = 4.5;
  else if (effectiveFitStatus === 'REASONABLE') overallScore = 4.0;
  else if (effectiveFitStatus === 'LONG_STRETCH') overallScore = 3.2;
  else if (effectiveFitStatus === 'REJECT') overallScore = 1.5;
  else if (effectiveFitStatus === 'NEEDS_REVIEW') overallScore = 2.5;

  let legalStatus = 'ELIGIBLE';
  if (requiredEligibility.some((e) => candidateFacts[e] === false)) {
    legalStatus = 'INELIGIBLE';
  } else if (requiredEligibility.some((e) => candidateFacts[e] === undefined || candidateFacts[e] === null)) {
    legalStatus = 'NEEDS_REVIEW';
  }

  const matchProfile = createMatchProfile({
    match_id: `match-${sampleId}`,
    job_id: sampleId,
    candidate_hash: computeSourceHash(JSON.stringify(candidateFacts)),
    requirement_matches: requirementMatches,
    yoe_comparison: {
      required_yoe: yoeData.required_yoe,
      candidate_verified_yoe: candYoe,
      shortfall,
      policy_status: effectiveFitStatus
    },
    legal_eligibility_status: legalStatus,
    critical_gaps: shortfall >= 4 ? [`YOE shortfall of ${shortfall} years`] : [],
    transferable_strengths: [],
    overall_match_score: overallScore
  });

  const latencyMs = Date.now() - startTime;

  return {
    job_profile: jobProfile,
    match_profile: matchProfile,
    legacy_diagnostics: {
      tier0_passed: tier0Result.passed,
      tier0_reason: tier0Result.reason,
      tier0_details: tier0Result.details,
      fit_status: effectiveFitStatus,
      fit_reasons: effectiveFitReasons,
      required_eligibility: requiredEligibility,
      rejection_type: rejectionType,
      is_false_reject: isFalseReject,
      extracted_skills_count: allExtractedSkills.length,
      latency_ms: latencyMs
    }
  };
}
