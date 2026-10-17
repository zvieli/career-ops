// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRequirementMatchResult,
  assertValidRequirementMatchResult,
  createRequirementMatchResult,
  validateCandidateMatchProfile,
  assertValidCandidateMatchProfile,
  createCandidateMatchProfile,
  validateMatchProfile,
  createMatchProfile,
  validateRequirementInterpretation,
  assertValidRequirementInterpretation,
  createRequirementInterpretation,
  REQUIREMENT_MATCH_RELATIONS,
  SUPPORT_DIMENSION_STATUSES
} from '../../../src/agent/domain/semantic/semantic-entities.mjs';

test('RequirementMatchResult valid creation and strict validation', () => {
  const result = createRequirementMatchResult({
    requirement_match_id: 'rmatch-001',
    requirement_id: 'req-python-01',
    relation: 'SATISFIES',
    candidate_evidence_ids: ['ev-001'],
    candidate_skill_evidence_ids: ['csk-python-01'],
    candidate_capability_ids: ['cap-001'],
    candidate_experience_ids: ['exp-001'],
    candidate_education_ids: [],
    candidate_certification_ids: [],
    support_dimensions: {
      skill_support: 'SUPPORTED',
      capability_support: 'SUPPORTED',
      experience_context_support: 'SUPPORTED'
    },
    unresolved_dimensions: [],
    rationale: {
      supported: ['Python skill evidenced in backend engineering role'],
      unsupported: []
    },
    model_metadata: {
      model_id: 'test-model',
      prompt_version: 'v1.4.0-phase4',
      task_version: 'v1.4.0-phase4',
      schema_version: 'v1.4.0'
    },
    provenance: {
      requirement_id: 'req-python-01',
      requirement_quote: 'Python experience',
      candidate_evidence_quotes: [
        {
          evidence_id: 'ev-001',
          verbatim_quote: 'Built microservices using Python',
          source_file: 'cv.md'
        }
      ]
    }
  });

  const validation = validateRequirementMatchResult(result);
  assert.equal(validation.valid, true, `Validation errors: ${JSON.stringify(validation.errors)}`);
});

test('RequirementMatchResult rejects invalid relations and extra properties', () => {
  const base = {
    requirement_match_id: 'rmatch-001',
    requirement_id: 'req-python-01',
    relation: 'INVALID_RELATION',
    candidate_evidence_ids: [],
    candidate_skill_evidence_ids: [],
    candidate_capability_ids: [],
    candidate_experience_ids: [],
    candidate_education_ids: [],
    candidate_certification_ids: [],
    support_dimensions: {},
    unresolved_dimensions: [],
    rationale: { supported: [], unsupported: [] },
    model_metadata: {
      model_id: 'test-model',
      prompt_version: 'v1.4.0-phase4',
      task_version: 'v1.4.0-phase4',
      schema_version: 'v1.4.0'
    },
    provenance: { requirement_id: 'req-python-01' }
  };

  const invalidRelation = validateRequirementMatchResult(base);
  assert.equal(invalidRelation.valid, false);

  const extraProp = {
    ...base,
    relation: 'SATISFIES',
    hallucinated_score: 95
  };
  const invalidExtra = validateRequirementMatchResult(extraProp);
  assert.equal(invalidExtra.valid, false);
});

test('CandidateMatchProfile valid creation and validation under MatchProfile schema', () => {
  const reqMatch = createRequirementMatchResult({
    requirement_match_id: 'rmatch-001',
    requirement_id: 'req-python-01',
    relation: 'SATISFIES',
    candidate_evidence_ids: ['ev-001'],
    candidate_skill_evidence_ids: ['csk-001'],
    candidate_capability_ids: [],
    candidate_experience_ids: [],
    candidate_education_ids: [],
    candidate_certification_ids: [],
    support_dimensions: { skill_support: 'SUPPORTED' },
    unresolved_dimensions: [],
    rationale: { supported: ['ev-001'], unsupported: [] },
    model_metadata: {
      model_id: 'test-model',
      prompt_version: 'v1.4.0-phase4',
      task_version: 'v1.4.0-phase4',
      schema_version: 'v1.4.0'
    },
    provenance: { requirement_id: 'req-python-01' }
  });

  const profile = createCandidateMatchProfile({
    match_profile_id: 'cmp-001',
    job_id: 'job-001',
    candidate_id: 'cand-001',
    requirement_matches: [reqMatch],
    descriptive_summary: {
      requirements_total: 1,
      satisfies: 1,
      partially_supports: 0,
      related_but_insufficient: 0,
      contradicts: 0,
      no_evidence: 0,
      unknown: 0,
      required_satisfied_count: 1,
      required_partial_count: 0,
      required_no_evidence_count: 0
    },
    telemetry: {
      requirements_evaluated: 1,
      model_calls: 1,
      evidence_bundle_size: 1,
      candidate_retrieval_count: 1,
      cache_hits: 0,
      cache_misses: 1,
      latency_ms: 12.5
    },
    model_metadata: {
      model_id: 'test-model',
      prompt_version: 'v1.4.0-phase4',
      task_version: 'v1.4.0-phase4',
      schema_version: 'v1.4.0'
    }
  });

  // Direct CandidateMatchProfile validation
  const directValidation = validateCandidateMatchProfile(profile);
  assert.equal(directValidation.valid, true, `Validation errors: ${JSON.stringify(directValidation.errors)}`);

  // Unified MatchProfile validation
  const unifiedValidation = validateMatchProfile(profile);
  assert.equal(unifiedValidation.valid, true, `Unified MatchProfile errors: ${JSON.stringify(unifiedValidation.errors)}`);
});

test('CandidateMatchProfile rejects weighted match score (anti-ranking policy)', () => {
  const profileWithScore = {
    match_profile_id: 'cmp-001',
    job_id: 'job-001',
    candidate_id: 'cand-001',
    requirement_matches: [],
    descriptive_summary: {
      requirements_total: 0,
      satisfies: 0,
      partially_supports: 0,
      related_but_insufficient: 0,
      contradicts: 0,
      no_evidence: 0,
      unknown: 0
    },
    overall_match_score: 87, // FORBIDDEN IN PHASE 4
    telemetry: {
      requirements_evaluated: 0,
      model_calls: 0,
      evidence_bundle_size: 0,
      candidate_retrieval_count: 0,
      cache_hits: 0,
      cache_misses: 0
    },
    model_metadata: {
      model_id: 'test-model',
      prompt_version: 'v1.4.0-phase4',
      task_version: 'v1.4.0-phase4',
      schema_version: 'v1.4.0'
    }
  };

  const validation = validateCandidateMatchProfile(profileWithScore);
  assert.equal(validation.valid, false, 'CandidateMatchProfile must reject overall_match_score');
});

test('RequirementInterpretation valid creation and strict validation', () => {
  const interpretation = createRequirementInterpretation({
    requirement_id: 'req-001',
    logical_structure: {
      operator: 'AND',
      branches: [
        { branch_id: 'b-01', type: 'SKILL', concept_id: 'python' },
        { branch_id: 'b-02', type: 'SKILL', concept_id: 'docker' }
      ]
    },
    mandatory_dimensions: [
      { dimension: 'SKILL', expected: 'python, docker', expected_concept_ids: ['python', 'docker'] },
      { dimension: 'EXPERIENCE_CONTEXT', expected: 'PROFESSIONAL_EMPLOYMENT' },
      { dimension: 'ENVIRONMENT', expected: 'PRODUCTION' },
      { dimension: 'DURATION', minimum_years: 3 }
    ],
    semantic_constraints: {
      responsibility_required: 'IMPLEMENTED',
      environment_required: 'PRODUCTION'
    },
    ambiguity: [],
    requirement_provenance: {
      requirement_id: 'req-001',
      verbatim_quote: '3+ years professional Python and Docker in production'
    }
  });

  const validation = validateRequirementInterpretation(interpretation);
  assert.equal(validation.valid, true, `Validation errors: ${JSON.stringify(validation.errors)}`);
});

test('RequirementInterpretation rejects invalid operator and missing mandatory dimensions', () => {
  assert.throws(() => {
    createRequirementInterpretation({
      requirement_id: 'req-001',
      logical_structure: {
        // @ts-ignore
        operator: 'INVALID_OP',
        branches: []
      },
      mandatory_dimensions: []
    });
  });
});
