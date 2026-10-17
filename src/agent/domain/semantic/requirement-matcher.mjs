// @ts-check
/**
 * requirement-matcher.mjs — Phase 4 Evidence-Aware Requirement Matching Engine
 *
 * Implements requirement-level semantic matching connecting:
 * JobRequirement <--> CandidateEvidence / CandidateSemanticProfile
 *
 * ARCHITECTURE CONTRACT:
 * - "MODELS UNDERSTAND. CODE DECIDES."
 * - System-1 owns natural language requirement interpretation, semantic equivalence,
 *   qualifiers, and proposed match relations.
 * - Deterministic code owns schema validation, reference integrity, mandatory dimension
 *   enforcement, and fail-closed policy invariants.
 * - ZERO runtime regex parsing of requirement text.
 * - Model failure fails closed to UNKNOWN; never uses heuristic semantic fallback.
 */

import {
  createRequirementMatchResult,
  createCandidateMatchProfile,
  assertValidRequirementInterpretation,
  REQUIREMENT_MATCH_RELATIONS,
  SUPPORT_DIMENSION_STATUSES,
  SEMANTIC_ORIGINS
} from './semantic-entities.mjs';
import { retrieveCandidateEvidenceForRequirement } from './candidate-evidence-retriever.mjs';

export const REQUIREMENT_MATCHING_TASK_VERSION = 'v1.4.0-phase4';
export const REQUIREMENT_MATCHING_PROMPT_VERSION = 'v1.4.0-phase4';

/**
 * System-1 Requirement Matching Prompt
 * System-1 must explicitly interpret requirement semantics and propose the match relation.
 */
export const REQUIREMENT_MATCHING_PROMPT = `
You are a strict semantic requirement evaluator in Career-Ops v1.4.
Your responsibility is twofold:
1. Interpret the canonical meaning, logical composition, and qualifiers of the given JobRequirement.
2. Evaluate the bounded candidate evidence bundle against the interpreted requirement.

CORE INVARIANTS:
1. Candidate evidence is ground truth. Do not invent missing facts.
2. Semantic relatedness is NOT requirement satisfaction.
3. Project experience does NOT satisfy professional employment requirements.
4. Test/local deployment does NOT satisfy production deployment requirements.
5. Studying/coursework does NOT satisfy official certification requirements.
6. In-progress degree does NOT satisfy completed degree requirements unless requirement explicitly allows pursuing.
7. Familiarity/usage does NOT satisfy design, architecture, or team leadership requirements.
8. Do NOT infer or fabricate years of experience.
9. Do NOT rank candidate or recommend apply/reject.

Return strict JSON conforming to this structure:
{
  "requirement_interpretation": {
    "requirement_id": "string",
    "logical_structure": {
      "operator": "SINGLE" | "AND" | "OR" | "UNKNOWN",
      "branches": [
        {
          "branch_id": "string",
          "type": "SKILL" | "EDUCATION" | "EQUIVALENT_EXPERIENCE" | "DOMAIN" | "CERTIFICATION" | "CAPABILITY" | "OTHER",
          "concept_id": "string | null",
          "degree_level": "string | null",
          "field": "string | null",
          "completion_required": true | false | null,
          "description": "string | null"
        }
      ]
    },
    "mandatory_dimensions": [
      {
        "dimension": "SKILL" | "EXPERIENCE_CONTEXT" | "ENVIRONMENT" | "DURATION" | "EDUCATION" | "CERTIFICATION" | "CAPABILITY" | "DOMAIN",
        "expected": "string",
        "expected_concept_ids": ["string"],
        "minimum_years": null | number
      }
    ],
    "optional_dimensions": [],
    "semantic_constraints": {
      "education_completion_required": true | false | null,
      "certification_required": true | false | null,
      "equivalent_experience_allowed": true | false | null,
      "equivalent_experience_domain": "string | null",
      "responsibility_required": "MENTIONED" | "USED" | "IMPLEMENTED" | "DESIGNED" | "DEPLOYED" | "OWNED" | "LED" | null,
      "environment_required": "PRODUCTION" | "STAGING" | "TEST_LOCAL" | "ACADEMIC_STUDY" | null
    },
    "ambiguity": ["string"],
    "requirement_provenance": {
      "requirement_id": "string",
      "verbatim_quote": "string"
    }
  },
  "match_proposal": {
    "relation": "SATISFIES" | "PARTIALLY_SUPPORTS" | "RELATED_BUT_INSUFFICIENT" | "CONTRADICTS" | "NO_EVIDENCE" | "UNKNOWN",
    "candidate_evidence_ids": ["string"],
    "candidate_skill_evidence_ids": ["string"],
    "candidate_capability_ids": ["string"],
    "candidate_experience_ids": ["string"],
    "candidate_education_ids": ["string"],
    "candidate_certification_ids": ["string"],
    "support_dimensions": {
      "skill_support": "SUPPORTED" | "PARTIALLY_SUPPORTED" | "UNSUPPORTED" | "NOT_APPLICABLE" | "UNKNOWN",
      "capability_support": "SUPPORTED" | "PARTIALLY_SUPPORTED" | "UNSUPPORTED" | "NOT_APPLICABLE" | "UNKNOWN",
      "experience_context_support": "SUPPORTED" | "PARTIALLY_SUPPORTED" | "UNSUPPORTED" | "NOT_APPLICABLE" | "UNKNOWN",
      "duration_support": "SUPPORTED" | "PARTIALLY_SUPPORTED" | "UNSUPPORTED" | "NOT_APPLICABLE" | "UNKNOWN",
      "education_support": "SUPPORTED" | "PARTIALLY_SUPPORTED" | "UNSUPPORTED" | "NOT_APPLICABLE" | "UNKNOWN",
      "certification_support": "SUPPORTED" | "PARTIALLY_SUPPORTED" | "UNSUPPORTED" | "NOT_APPLICABLE" | "UNKNOWN",
      "environment_support": "SUPPORTED" | "PARTIALLY_SUPPORTED" | "UNSUPPORTED" | "NOT_APPLICABLE" | "UNKNOWN",
      "domain_support": "SUPPORTED" | "PARTIALLY_SUPPORTED" | "UNSUPPORTED" | "NOT_APPLICABLE" | "UNKNOWN"
    },
    "unresolved_dimensions": ["string"],
    "rationale": {
      "supported": ["string"],
      "unsupported": ["string"]
    }
  }
}
`.trim();

/**
 * Deterministic validation and policy invariant enforcement on System-1 output.
 * Does NOT inspect natural language text with regex. Operates strictly on:
 * - canonical JobRequirement identity
 * - structured RequirementInterpretation
 * - proposed match proposal
 * - canonical CandidateSemanticProfile
 *
 * @param {object} params
 * @param {object} params.requirement JobRequirement
 * @param {object} params.candidateProfile CandidateSemanticProfile
 * @param {object} params.interpretation RequirementInterpretation
 * @param {object} params.matchProposal Proposed match from System-1
 * @param {string} [params.semanticOrigin='UNKNOWN']
 * @param {object} [params.options]
 * @returns {object} Strictly validated RequirementMatchResult
 */
export function validateAndEnforceMatchInvariants({
  requirement,
  candidateProfile,
  interpretation,
  matchProposal = {},
  semanticOrigin = 'UNKNOWN',
  options = {}
}) {
  const reqId = String(requirement.requirement_id);

  // RequirementInterpretation is mandatory: cannot be bypassed
  if (!interpretation || typeof interpretation !== 'object') {
    return createRequirementMatchResult({
      requirement_match_id: `rmatch-${reqId}`,
      requirement_id: reqId,
      relation: 'UNKNOWN',
      semantic_origin: 'UNKNOWN',
      candidate_evidence_ids: [],
      candidate_skill_evidence_ids: [],
      candidate_capability_ids: [],
      candidate_experience_ids: [],
      candidate_education_ids: [],
      candidate_certification_ids: [],
      support_dimensions: {},
      unresolved_dimensions: ['MISSING_REQUIREMENT_INTERPRETATION'],
      rationale: {
        supported: [],
        unsupported: ['Requirement semantic interpretation is required']
      },
      model_metadata: {
        model_id: null,
        prompt_version: REQUIREMENT_MATCHING_PROMPT_VERSION,
        task_version: REQUIREMENT_MATCHING_TASK_VERSION,
        schema_version: 'v1.4.0'
      },
      provenance: {
        requirement_id: reqId,
        requirement_quote: requirement.evidence_span?.verbatim_quote || requirement.description,
        candidate_evidence_quotes: []
      }
    });
  }

  // Validate interpretation structure
  try {
    assertValidRequirementInterpretation(interpretation);
  } catch (err) {
    return createRequirementMatchResult({
      requirement_match_id: `rmatch-${reqId}`,
      requirement_id: reqId,
      relation: 'UNKNOWN',
      semantic_origin: 'UNKNOWN',
      candidate_evidence_ids: [],
      candidate_skill_evidence_ids: [],
      candidate_capability_ids: [],
      candidate_experience_ids: [],
      candidate_education_ids: [],
      candidate_certification_ids: [],
      support_dimensions: {},
      unresolved_dimensions: ['INVALID_REQUIREMENT_INTERPRETATION'],
      rationale: {
        supported: [],
        unsupported: [`Model interpretation schema error: ${err.message}`]
      },
      model_metadata: {
        model_id: options.modelId || null,
        prompt_version: REQUIREMENT_MATCHING_PROMPT_VERSION,
        task_version: REQUIREMENT_MATCHING_TASK_VERSION,
        schema_version: 'v1.4.0'
      },
      provenance: {
        requirement_id: reqId,
        requirement_quote: requirement.evidence_span?.verbatim_quote || requirement.description,
        candidate_evidence_quotes: []
      }
    });
  }

  // Reference Integrity: verify all referenced IDs exist across all 6 categories using stable IDs
  const validEvIds = new Set((candidateProfile.evidence || []).map((e) => e.evidence_id));
  const validSkillIds = new Set((candidateProfile.skills || []).map((s) => s.skill_evidence_id));
  const validCapIds = new Set((candidateProfile.capabilities || []).map((c) => c.capability_id));
  const validExpIds = new Set((candidateProfile.experiences || []).map((e) => e.experience_id));
  const validEduIds = new Set((candidateProfile.education || []).map((e) => e.education_id));
  const validCertIds = new Set((candidateProfile.certifications || []).map((c) => c.certification_id));

  const candidateEvidenceIds = Array.isArray(matchProposal?.candidate_evidence_ids) ? [...matchProposal.candidate_evidence_ids] : [];
  const candidateSkillIds = Array.isArray(matchProposal?.candidate_skill_evidence_ids) ? [...matchProposal.candidate_skill_evidence_ids] : [];
  const candidateCapIds = Array.isArray(matchProposal?.candidate_capability_ids) ? [...matchProposal.candidate_capability_ids] : [];
  const candidateExpIds = Array.isArray(matchProposal?.candidate_experience_ids) ? [...matchProposal.candidate_experience_ids] : [];
  const candidateEduIds = Array.isArray(matchProposal?.candidate_education_ids) ? [...matchProposal.candidate_education_ids] : [];
  const candidateCertIds = Array.isArray(matchProposal?.candidate_certification_ids) ? [...matchProposal.candidate_certification_ids] : [];

  // Check for hallucinated / invalid IDs across all six categories
  let hasDanglingId = false;
  for (const id of candidateEvidenceIds) {
    if (!validEvIds.has(id)) { hasDanglingId = true; break; }
  }
  for (const id of candidateSkillIds) {
    if (!validSkillIds.has(id)) { hasDanglingId = true; break; }
  }
  for (const id of candidateCapIds) {
    if (!validCapIds.has(id)) { hasDanglingId = true; break; }
  }
  for (const id of candidateExpIds) {
    if (!validExpIds.has(id)) { hasDanglingId = true; break; }
  }
  for (const id of candidateEduIds) {
    if (!validEduIds.has(id)) { hasDanglingId = true; break; }
  }
  for (const id of candidateCertIds) {
    if (!validCertIds.has(id)) { hasDanglingId = true; break; }
  }

  if (hasDanglingId) {
    // Fail-closed to UNKNOWN on model-invented / dangling IDs
    return createRequirementMatchResult({
      requirement_match_id: `rmatch-${reqId}`,
      requirement_id: reqId,
      relation: 'UNKNOWN',
      semantic_origin: 'UNKNOWN',
      candidate_evidence_ids: [],
      candidate_skill_evidence_ids: [],
      candidate_capability_ids: [],
      candidate_experience_ids: [],
      candidate_education_ids: [],
      candidate_certification_ids: [],
      support_dimensions: {},
      unresolved_dimensions: ['DANGLING_OR_INVALID_CANDIDATE_REFERENCE'],
      rationale: {
        supported: [],
        unsupported: ['Model output referenced unknown candidate IDs that do not exist in profile']
      },
      model_metadata: {
        model_id: options.modelId || null,
        prompt_version: REQUIREMENT_MATCHING_PROMPT_VERSION,
        task_version: REQUIREMENT_MATCHING_TASK_VERSION,
        schema_version: 'v1.4.0'
      },
      provenance: {
        requirement_id: reqId,
        requirement_quote: requirement.evidence_span?.verbatim_quote || requirement.description,
        candidate_evidence_quotes: []
      }
    });
  }

  let relation = matchProposal?.relation;
  if (!REQUIREMENT_MATCH_RELATIONS.includes(relation)) {
    relation = 'UNKNOWN';
  }

  const supportDimensions = matchProposal?.support_dimensions && typeof matchProposal.support_dimensions === 'object'
    ? { ...matchProposal.support_dimensions }
    : {};
  const unresolvedDimensions = Array.isArray(matchProposal?.unresolved_dimensions)
    ? [...matchProposal.unresolved_dimensions]
    : [];
  const rationale = {
    supported: Array.isArray(matchProposal?.rationale?.supported) ? [...matchProposal.rationale.supported] : [],
    unsupported: Array.isArray(matchProposal?.rationale?.unsupported) ? [...matchProposal.rationale.unsupported] : []
  };

  const totalSupportRefs = candidateEvidenceIds.length + candidateSkillIds.length + candidateCapIds.length +
    candidateExpIds.length + candidateEduIds.length + candidateCertIds.length;

  // INVARIANT 1: NO EVIDENCE -> NO POSITIVE REQUIREMENT RELATION
  if ((relation === 'SATISFIES' || relation === 'PARTIALLY_SUPPORTS' || relation === 'RELATED_BUT_INSUFFICIENT') && totalSupportRefs === 0) {
    relation = 'NO_EVIDENCE';
    unresolvedDimensions.push('MISSING_MANDATORY_EVIDENCE');
    rationale.unsupported.push('Cannot satisfy or partially support requirement without supporting candidate evidence references');
  }

  // INVARIANT 2: SATISFIES requires 0 unresolved mandatory dimensions
  if (relation === 'SATISFIES' && unresolvedDimensions.length > 0) {
    relation = 'PARTIALLY_SUPPORTS';
    rationale.unsupported.push(`Unresolved dimensions present: ${unresolvedDimensions.join(', ')}`);
  }

  // INVARIANT 3: Mandatory Dimensions Policy Enforcement
  // Operates generically over interpretation.mandatory_dimensions
  if (relation === 'SATISFIES') {
    for (const dim of interpretation.mandatory_dimensions || []) {
      switch (dim.dimension) {
        case 'SKILL':
          if (supportDimensions.skill_support === 'UNSUPPORTED' || candidateSkillIds.length === 0) {
            relation = 'PARTIALLY_SUPPORTS';
            unresolvedDimensions.push('SKILL_UNSUPPORTED');
            rationale.unsupported.push('Mandatory skill dimension is unsupported');
          }
          break;

        case 'EXPERIENCE_CONTEXT':
          if (dim.expected === 'PROFESSIONAL_EMPLOYMENT' || dim.expected === 'EMPLOYMENT') {
            const referencedExps = (candidateProfile.experiences || []).filter((e) => candidateExpIds.includes(e.experience_id));
            const hasEmployment = referencedExps.some((e) => e.experience_type === 'EMPLOYMENT');
            if (!hasEmployment || supportDimensions.experience_context_support === 'UNSUPPORTED') {
              relation = 'PARTIALLY_SUPPORTS';
              supportDimensions.experience_context_support = 'UNSUPPORTED';
              unresolvedDimensions.push('PROJECT_EMPLOYMENT_CONFUSION');
              rationale.unsupported.push('Personal project cannot satisfy professional employment requirement');
            }
          }
          break;

        case 'ENVIRONMENT':
          if (dim.expected === 'PRODUCTION' || interpretation.semantic_constraints?.environment_required === 'PRODUCTION') {
            const referencedCaps = (candidateProfile.capabilities || []).filter((c) => candidateCapIds.includes(c.capability_id));
            const hasProduction = referencedCaps.some((c) => c.environment_type === 'PRODUCTION');
            if (!hasProduction || supportDimensions.environment_support === 'UNSUPPORTED') {
              relation = 'PARTIALLY_SUPPORTS';
              supportDimensions.environment_support = 'UNSUPPORTED';
              unresolvedDimensions.push('TEST_PRODUCTION_CONFUSION');
              rationale.unsupported.push('Test/local deployment cannot satisfy production deployment requirement');
            }
          }
          break;

        case 'DURATION': {
          const minYears = dim.minimum_years ?? requirement.min_years;
          if (minYears && minYears > 0) {
            const verifiedYoe = candidateProfile.verified_yoe;
            if (verifiedYoe === null || verifiedYoe === undefined) {
              relation = 'PARTIALLY_SUPPORTS';
              supportDimensions.duration_support = 'UNKNOWN';
              unresolvedDimensions.push('DURATION_UNVERIFIED');
              rationale.unsupported.push(`Requirement demands ${minYears}+ years, but candidate verified professional duration is unknown`);
            } else if (verifiedYoe < minYears) {
              relation = 'PARTIALLY_SUPPORTS';
              supportDimensions.duration_support = 'UNSUPPORTED';
              unresolvedDimensions.push('DURATION_SHORTFALL');
              rationale.unsupported.push(`Candidate verified YOE (${verifiedYoe}) is less than required (${minYears})`);
            }
          }
          break;
        }

        case 'EDUCATION': {
          const requiresCompleted = interpretation.semantic_constraints?.education_completion_required === true;
          const allowsPursuing = interpretation.semantic_constraints?.education_completion_required === false;
          const equivalentExperienceAllowed = interpretation.semantic_constraints?.equivalent_experience_allowed === true;

          const referencedEdus = (candidateProfile.education || []).filter((e) => candidateEduIds.includes(e.education_id));
          const hasCompleted = referencedEdus.some((e) => e.status === 'COMPLETED');

          // If equivalent experience branch was satisfied
          const referencedExps = (candidateProfile.experiences || []).filter((e) => candidateExpIds.includes(e.experience_id));
          const hasEquivalentEmployment = equivalentExperienceAllowed && referencedExps.some((e) => e.experience_type === 'EMPLOYMENT');

          if (requiresCompleted && !hasCompleted && !allowsPursuing && !hasEquivalentEmployment) {
            relation = 'PARTIALLY_SUPPORTS';
            supportDimensions.education_support = 'PARTIALLY_SUPPORTED';
            unresolvedDimensions.push('DEGREE_INCOMPLETE');
            rationale.unsupported.push('In-progress degree cannot satisfy completed degree requirement');
          }
          break;
        }

        case 'CERTIFICATION': {
          const referencedCerts = (candidateProfile.certifications || []).filter((c) => candidateCertIds.includes(c.certification_id));
          const hasCertified = referencedCerts.some((c) => c.is_certified === true);
          if (!hasCertified || supportDimensions.certification_support === 'UNSUPPORTED') {
            relation = totalSupportRefs > 0 ? 'RELATED_BUT_INSUFFICIENT' : 'NO_EVIDENCE';
            supportDimensions.certification_support = 'UNSUPPORTED';
            unresolvedDimensions.push('COURSE_CERTIFICATION_CONFUSION');
            rationale.unsupported.push('Coursework or uncertified status cannot satisfy official certification requirement');
          }
          break;
        }

        case 'CAPABILITY': {
          const requiredLevel = interpretation.semantic_constraints?.responsibility_required;
          if (requiredLevel) {
            const referencedCaps = (candidateProfile.capabilities || []).filter((c) => candidateCapIds.includes(c.capability_id));
            const meetsLevel = referencedCaps.some((c) => {
              if (c.responsibility_level === requiredLevel) return true;
              if (requiredLevel === 'LED' && c.responsibility_level === 'OWNED') return true;
              if (requiredLevel === 'DESIGNED' && c.responsibility_level === 'OWNED') return true;
              return false;
            });
            if (!meetsLevel || supportDimensions.capability_support === 'UNSUPPORTED') {
              relation = totalSupportRefs > 0 ? 'RELATED_BUT_INSUFFICIENT' : 'NO_EVIDENCE';
              supportDimensions.capability_support = 'UNSUPPORTED';
              unresolvedDimensions.push('CAPABILITY_UNSUPPORTED');
              rationale.unsupported.push(`Candidate responsibility does not satisfy required level (${requiredLevel})`);
            }
          }
          break;
        }

        default:
          break;
      }
    }
  }

  // INVARIANT 4: Logical Structure Enforcement
  if (interpretation.logical_structure?.operator === 'AND' && relation === 'SATISFIES') {
    if (unresolvedDimensions.length > 0 || supportDimensions.skill_support === 'PARTIALLY_SUPPORTED') {
      relation = 'PARTIALLY_SUPPORTS';
    }
  }

  // INVARIANT 5: CONTRADICTS requires explicit contradictory evidence
  if (relation === 'CONTRADICTS' && candidateEvidenceIds.length === 0 && candidateExpIds.length === 0) {
    relation = 'NO_EVIDENCE';
    rationale.unsupported.push('Contradiction rejected: absence of evidence is not contradictory evidence');
  }

  // Build Provenance
  const evidenceMap = new Map((candidateProfile.evidence || []).map((e) => [e.evidence_id, e]));
  const candidateEvidenceQuotes = [];
  for (const evId of candidateEvidenceIds) {
    const ev = evidenceMap.get(evId);
    if (ev) {
      candidateEvidenceQuotes.push({
        evidence_id: ev.evidence_id,
        verbatim_quote: ev.verbatim_quote,
        source_file: ev.source_file
      });
    }
  }

  return createRequirementMatchResult({
    requirement_match_id: `rmatch-${reqId}`,
    requirement_id: reqId,
    relation,
    semantic_origin: semanticOrigin,
    candidate_evidence_ids: candidateEvidenceIds,
    candidate_skill_evidence_ids: candidateSkillIds,
    candidate_capability_ids: candidateCapIds,
    candidate_experience_ids: candidateExpIds,
    candidate_education_ids: candidateEduIds,
    candidate_certification_ids: candidateCertIds,
    support_dimensions: supportDimensions,
    unresolved_dimensions: unresolvedDimensions,
    rationale,
    model_metadata: {
      model_id: options.modelId || null,
      prompt_version: REQUIREMENT_MATCHING_PROMPT_VERSION,
      task_version: REQUIREMENT_MATCHING_TASK_VERSION,
      schema_version: 'v1.4.0'
    },
    provenance: {
      requirement_id: reqId,
      requirement_quote: requirement.evidence_span?.verbatim_quote || requirement.description,
      candidate_evidence_quotes: candidateEvidenceQuotes
    }
  });
}

/**
 * Match a JobRequirement against a CandidateSemanticProfile.
 * System-1 interprets the requirement; deterministic code validates the result.
 *
 * @param {object} params
 * @param {object} params.requirement JobRequirement
 * @param {object} params.candidateProfile CandidateSemanticProfile
 * @param {Function} [params.modelRunner] System-1 model runner function
 * @param {object} [params.options]
 * @returns {Promise<object>} Evaluated and validated RequirementMatchResult
 */
export async function matchRequirement({
  requirement,
  candidateProfile,
  modelRunner,
  options = {}
}) {
  const reqId = String(requirement.requirement_id);

  // 1. High-recall candidate evidence retrieval
  const bundle = retrieveCandidateEvidenceForRequirement({
    requirement,
    candidateProfile,
    options
  });

  // 2. Resolve model runner
  let runner = modelRunner;
  let semanticOrigin = options.semanticOrigin || runner?.semanticOrigin || (typeof runner === 'function' ? 'MODEL_PROPOSED' : 'UNKNOWN');

  if (typeof runner !== 'function' && options.allowTestFake && typeof options.testFakeRunner === 'function') {
    runner = options.testFakeRunner;
    semanticOrigin = options.semanticOrigin || runner?.semanticOrigin || 'TEST_FAKE';
  }

  // If no model runner is available, fail closed. NEVER use heuristic fallback!
  if (typeof runner !== 'function') {
    const unavailMatch = createRequirementMatchResult({
      requirement_match_id: `rmatch-${reqId}`,
      requirement_id: reqId,
      relation: 'UNKNOWN',
      semantic_origin: 'UNKNOWN',
      candidate_evidence_ids: [],
      candidate_skill_evidence_ids: [],
      candidate_capability_ids: [],
      candidate_experience_ids: [],
      candidate_education_ids: [],
      candidate_certification_ids: [],
      support_dimensions: {},
      unresolved_dimensions: ['MODEL_EXECUTION_UNAVAILABLE'],
      rationale: {
        supported: [],
        unsupported: ['System-1 semantic model execution is unavailable']
      },
      model_metadata: {
        model_id: null,
        prompt_version: REQUIREMENT_MATCHING_PROMPT_VERSION,
        task_version: REQUIREMENT_MATCHING_TASK_VERSION,
        schema_version: 'v1.4.0'
      },
      provenance: {
        requirement_id: reqId,
        requirement_quote: requirement.evidence_span?.verbatim_quote || requirement.description,
        candidate_evidence_quotes: []
      }
    });

    Object.defineProperty(unavailMatch, '_retrieval_metadata', {
      value: bundle.retrieval_metadata,
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(unavailMatch, '_is_live_call', {
      value: false,
      enumerable: false,
      configurable: true
    });

    return unavailMatch;
  }

  // 3. System-1 Semantic Execution
  let rawOutput;
  let isLiveCall = semanticOrigin === 'MODEL_PROPOSED';

  try {
    rawOutput = await runner({
      prompt: REQUIREMENT_MATCHING_PROMPT,
      requirement: bundle.requirement,
      candidateBundle: bundle.candidate_bundle
    });
  } catch (err) {
    // Model execution failed -> Fail closed to UNKNOWN
    const errMatch = createRequirementMatchResult({
      requirement_match_id: `rmatch-${reqId}`,
      requirement_id: reqId,
      relation: 'UNKNOWN',
      semantic_origin: 'UNKNOWN',
      candidate_evidence_ids: [],
      candidate_skill_evidence_ids: [],
      candidate_capability_ids: [],
      candidate_experience_ids: [],
      candidate_education_ids: [],
      candidate_certification_ids: [],
      support_dimensions: {},
      unresolved_dimensions: ['MODEL_EXECUTION_FAILED'],
      rationale: {
        supported: [],
        unsupported: [`Model invocation failed: ${err.message}`]
      },
      model_metadata: {
        model_id: options.modelId || null,
        prompt_version: REQUIREMENT_MATCHING_PROMPT_VERSION,
        task_version: REQUIREMENT_MATCHING_TASK_VERSION,
        schema_version: 'v1.4.0'
      },
      provenance: {
        requirement_id: reqId,
        requirement_quote: requirement.evidence_span?.verbatim_quote || requirement.description,
        candidate_evidence_quotes: []
      }
    });

    Object.defineProperty(errMatch, '_retrieval_metadata', {
      value: bundle.retrieval_metadata,
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(errMatch, '_is_live_call', {
      value: isLiveCall,
      enumerable: false,
      configurable: true
    });

    return errMatch;
  }

  const interpretation = rawOutput?.requirement_interpretation;
  const matchProposal = rawOutput?.match_proposal;

  // 4. Deterministic Validation & Invariants
  const validatedMatch = validateAndEnforceMatchInvariants({
    requirement,
    candidateProfile,
    interpretation,
    matchProposal,
    semanticOrigin,
    options
  });

  Object.defineProperty(validatedMatch, '_retrieval_metadata', {
    value: bundle.retrieval_metadata,
    enumerable: false,
    configurable: true
  });
  Object.defineProperty(validatedMatch, '_is_live_call', {
    value: isLiveCall,
    enumerable: false,
    configurable: true
  });

  return validatedMatch;
}

/**
 * Perform evidence-aware matching across all requirements of a JobSemanticProfile.
 * Produces a canonical CandidateMatchProfile with descriptive summary and telemetry.
 *
 * @param {object} params
 * @param {object} params.jobProfile JobSemanticProfile
 * @param {object} params.candidateProfile CandidateSemanticProfile
 * @param {Function} [params.modelRunner] Optional custom model runner
 * @param {object} [params.options]
 * @returns {Promise<object>} CandidateMatchProfile
 */
export async function profileCandidateRequirementMatches({
  jobProfile,
  candidateProfile,
  modelRunner,
  options = {}
}) {
  if (!jobProfile || typeof jobProfile !== 'object') {
    throw new TypeError('jobProfile must be a valid object');
  }
  if (!candidateProfile || typeof candidateProfile !== 'object') {
    throw new TypeError('candidateProfile must be a valid object');
  }

  const startTime = Date.now();
  const requirements = Array.isArray(jobProfile.requirements) ? jobProfile.requirements : [];

  let modelCalls = 0;
  let totalEvidenceBundleSize = 0;
  let totalCandidateRetrievalCount = 0;

  const requirementMatches = [];

  for (const req of requirements) {
    const match = await matchRequirement({
      requirement: req,
      candidateProfile,
      modelRunner,
      options
    });
    if (match._is_live_call) {
      modelCalls++;
    }
    totalEvidenceBundleSize += match._retrieval_metadata?.total_bundle_items || 0;
    totalCandidateRetrievalCount += match._retrieval_metadata?.retrieved_evidence_count || 0;
    requirementMatches.push(match);
  }

  // Compute descriptive summary mechanically from requirement matches
  let satisfiesCount = 0;
  let partialCount = 0;
  let relatedCount = 0;
  let contradictsCount = 0;
  let noEvidenceCount = 0;
  let unknownCount = 0;

  let requiredSatisfiedCount = 0;
  let requiredPartialCount = 0;
  let requiredNoEvidenceCount = 0;

  const reqMap = new Map(requirements.map((r) => [r.requirement_id, r]));

  for (const m of requirementMatches) {
    const req = reqMap.get(m.requirement_id);
    const isRequired = req && (req.importance === 'REQUIRED' || req.importance === 'LEGAL_MANDATORY');

    switch (m.relation) {
      case 'SATISFIES':
        satisfiesCount++;
        if (isRequired) requiredSatisfiedCount++;
        break;
      case 'PARTIALLY_SUPPORTS':
        partialCount++;
        if (isRequired) requiredPartialCount++;
        break;
      case 'RELATED_BUT_INSUFFICIENT':
        relatedCount++;
        break;
      case 'CONTRADICTS':
        contradictsCount++;
        break;
      case 'NO_EVIDENCE':
        noEvidenceCount++;
        if (isRequired) requiredNoEvidenceCount++;
        break;
      case 'UNKNOWN':
      default:
        unknownCount++;
        break;
    }
  }

  const descriptiveSummary = {
    requirements_total: requirementMatches.length,
    satisfies: satisfiesCount,
    partially_supports: partialCount,
    related_but_insufficient: relatedCount,
    contradicts: contradictsCount,
    no_evidence: noEvidenceCount,
    unknown: unknownCount,
    required_satisfied_count: requiredSatisfiedCount,
    required_partial_count: requiredPartialCount,
    required_no_evidence_count: requiredNoEvidenceCount
  };

  const latencyMs = Date.now() - startTime;

  return createCandidateMatchProfile({
    match_profile_id: `cmp-${jobProfile.job_id}-${candidateProfile.candidate_id}`,
    job_id: String(jobProfile.job_id),
    candidate_id: String(candidateProfile.candidate_id),
    requirement_matches: requirementMatches,
    descriptive_summary: descriptiveSummary,
    telemetry: {
      requirements_evaluated: requirementMatches.length,
      model_calls: modelCalls,
      evidence_bundle_size: totalEvidenceBundleSize,
      candidate_retrieval_count: totalCandidateRetrievalCount,
      cache_hits: 0,
      cache_misses: modelCalls,
      latency_ms: latencyMs
    },
    model_metadata: {
      model_id: options.modelId || (modelCalls > 0 ? 'model-runner' : 'deterministic-matcher'),
      prompt_version: REQUIREMENT_MATCHING_PROMPT_VERSION,
      task_version: REQUIREMENT_MATCHING_TASK_VERSION,
      schema_version: 'v1.4.0'
    }
  });
}
