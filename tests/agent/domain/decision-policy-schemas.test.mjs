// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRequirementPolicyResult,
  assertValidRequirementPolicyResult,
  createRequirementPolicyResult,
  validatePolicyConfiguration,
  assertValidPolicyConfiguration,
  createPolicyConfiguration,
  validatePolicyAssessment,
  assertValidPolicyAssessment,
  createPolicyAssessment,
  PRIORITY_BANDS,
  POLICY_STATUSES,
  EXPLANATION_FACT_TYPES
} from '../../../src/agent/domain/semantic/semantic-entities.mjs';

test('RequirementPolicyResult valid creation and strict validation', () => {
  const result = createRequirementPolicyResult({
    requirement_id: 'req-01',
    requirement_match_id: 'rmatch-req-01',
    importance: 'REQUIRED',
    relation: 'SATISFIES',
    policy_value: 1.0,
    importance_weight: 1.0,
    contribution: 1.0,
    hard_gate_triggered: false,
    reason_codes: ['REQUIRED_SATISFIED'],
    source_reference_ids: ['ev-01']
  });

  const validation = validateRequirementPolicyResult(result);
  assert.equal(validation.valid, true, `Validation errors: ${JSON.stringify(validation.errors)}`);
});

test('RequirementPolicyResult rejects invalid relation or missing field', () => {
  assert.throws(() => {
    createRequirementPolicyResult({
      requirement_id: 'req-01',
      requirement_match_id: 'rmatch-01',
      // @ts-ignore
      importance: 'REQUIRED',
      // @ts-ignore
      relation: 'INVALID_RELATION',
      policy_value: 1.0,
      importance_weight: 1.0,
      contribution: 1.0
    });
  });
});

test('PolicyConfiguration valid creation and strict validation', () => {
  const config = createPolicyConfiguration({
    policy_version: 'phase5-v1.0',
    policy_status: 'POLICY_INITIAL',
    relation_values: {
      SATISFIES: 1.0,
      PARTIALLY_SUPPORTS: 0.5,
      RELATED_BUT_INSUFFICIENT: 0.1,
      NO_EVIDENCE: 0.0,
      UNKNOWN: 0.0,
      CONTRADICTS: -1.5
    },
    importance_weights: {
      LEGAL_MANDATORY: 1.0,
      REQUIRED: 1.0,
      PREFERRED: 0.4,
      OPTIONAL: 0.1,
      RESPONSIBILITY: 0.2,
      CONTEXT: 0.1
    },
    score_component_scales: {
      required_max: 70,
      preferred_max: 20,
      optional_max: 5,
      evidence_quality_max: 5,
      contradiction_penalty_per_item: 25,
      uncertainty_penalty_per_item: 5
    },
    priority_band_thresholds: {
      high_priority_floor: 75,
      medium_priority_floor: 50,
      max_tolerated_unknown_required_ratio: 0.5
    },
    hard_gates: [
      {
        gate_id: 'gate-legal-auth',
        trigger_source: 'UNRESOLVED_DIMENSION',
        trigger_value: 'requires_sponsorship_contradiction',
        action: 'BLOCK_OPPORTUNITY',
        reason_code: 'HARD_GATE_LEGAL_CONTRADICTION'
      }
    ]
  });

  const validation = validatePolicyConfiguration(config);
  assert.equal(validation.valid, true, `Validation errors: ${JSON.stringify(validation.errors)}`);
});

test('PolicyAssessment valid creation and strict validation', () => {
  const assessment = createPolicyAssessment({
    policy_assessment_id: 'passess-job-01-cand-01',
    job_id: 'job-01',
    candidate_id: 'cand-01',
    match_profile_id: 'cmp-job-01-cand-01',
    policy_version: 'phase5-v1.0',
    requirement_policy_results: [
      {
        requirement_id: 'req-01',
        requirement_match_id: 'rmatch-01',
        importance: 'REQUIRED',
        relation: 'SATISFIES',
        policy_value: 1.0,
        importance_weight: 1.0,
        contribution: 1.0,
        hard_gate_triggered: false,
        reason_codes: ['REQUIRED_SATISFIED'],
        support_references: {
          evidence_ids: ['ev-01'],
          skill_evidence_ids: [],
          capability_ids: [],
          experience_ids: [],
          education_ids: [],
          certification_ids: []
        },
        source_reference_ids: ['ev-01']
      }
    ],
    aggregate_components: {
      required_coverage: 70,
      preferred_coverage: 15,
      optional_bonus: 5,
      contradiction_penalty: 0,
      uncertainty_penalty: 0,
      evidence_quality_component: 5
    },
    raw_score: 90,
    normalized_score: 90,
    priority_band: 'HIGH_PRIORITY',
    hard_gate_triggered: false,
    blocker_reasons: [],
    risk_reasons: [],
    positive_reasons: ['Satisfies core technical requirements'],
    explanation_facts: [
      {
        requirement_id: 'req-01',
        type: 'POSITIVE',
        reason_code: 'REQUIRED_SATISFIED',
        evidence_ids: ['ev-01'],
        statement: 'Python requirement satisfied by professional experience'
      }
    ],
    score_breakdown: [
      {
        component: 'REQUIRED_COVERAGE',
        input_ids: ['req-01'],
        raw_value: 1.0,
        weight: 70,
        contribution: 70,
        reason_code: 'REQUIRED_SATISFIED'
      }
    ],
    telemetry: {
      requirements_evaluated: 1,
      unknown_required_count: 0,
      contradiction_count: 0,
      latency_ms: 1.5
    }
  });

  const validation = validatePolicyAssessment(assessment);
  assert.equal(validation.valid, true, `Validation errors: ${JSON.stringify(validation.errors)}`);
});

test('PolicyAssessment rejects invalid score bounds and unauthorized properties', () => {
  const base = {
    policy_assessment_id: 'passess-01',
    job_id: 'job-01',
    candidate_id: 'cand-01',
    match_profile_id: 'cmp-01',
    policy_version: 'phase5-v1.0',
    requirement_policy_results: [],
    aggregate_components: {
      required_coverage: 0,
      preferred_coverage: 0,
      optional_bonus: 0,
      contradiction_penalty: 0,
      uncertainty_penalty: 0,
      evidence_quality_component: 0
    },
    raw_score: 150,
    normalized_score: 150, // OUT OF BOUNDS (> 100)
    priority_band: 'HIGH_PRIORITY',
    hard_gate_triggered: false,
    blocker_reasons: [],
    risk_reasons: [],
    positive_reasons: [],
    explanation_facts: [],
    score_breakdown: [],
    telemetry: {
      requirements_evaluated: 0,
      unknown_required_count: 0,
      contradiction_count: 0,
      latency_ms: 0
    }
  };

  const validation = validatePolicyAssessment(base);
  assert.equal(validation.valid, false, 'Score > 100 must fail schema validation');
});
