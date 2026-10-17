// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateStructuredExplanation,
  formatDeterministicProse,
  renderPolicyExplanation
} from '../../../src/agent/domain/semantic/policy-explanation-renderer.mjs';

test('generateStructuredExplanation organizes facts into positives, negatives, uncertainties, blockers', () => {
  const assessment = {
    policy_assessment_id: 'passess-01',
    job_id: 'job-01',
    candidate_id: 'cand-01',
    priority_band: 'HIGH_PRIORITY',
    normalized_score: 85,
    policy_version: 'phase5-v1.0',
    telemetry: { requirements_evaluated: 4 },
    explanation_facts: [
      { requirement_id: 'req-01', type: 'POSITIVE', reason_code: 'REQUIRED_SATISFIED', evidence_ids: ['ev-01'], statement: 'Python satisfied' },
      { requirement_id: 'req-02', type: 'POSITIVE', reason_code: 'REQUIRED_SATISFIED', evidence_ids: ['ev-02'], statement: 'Docker satisfied' },
      { requirement_id: 'req-03', type: 'NEGATIVE', reason_code: 'PREFERRED_PARTIAL', evidence_ids: ['ev-03'], statement: 'Kubernetes partial' },
      { requirement_id: 'req-04', type: 'UNCERTAINTY', reason_code: 'PREFERRED_UNKNOWN', evidence_ids: [], statement: 'AWS unknown' }
    ],
    aggregate_components: { required_coverage: 70, preferred_coverage: 10 }
  };

  const exp = generateStructuredExplanation(assessment);

  assert.equal(exp.summary.total_requirements, 4);
  assert.equal(exp.summary.positive_count, 2);
  assert.equal(exp.summary.negative_count, 1);
  assert.equal(exp.summary.uncertainty_count, 1);
  assert.equal(exp.summary.blocker_count, 0);

  assert.equal(exp.top_positive_reasons[0].evidence_ids.includes('ev-01'), true);
  assert.equal(exp.top_negative_reasons[0].requirement_id, 'req-03');
  assert.equal(exp.uncertainty_reasons[0].requirement_id, 'req-04');
});

test('formatDeterministicProse formats grounded facts without model invocation', () => {
  const structured = {
    priority_band: 'HIGH_PRIORITY',
    normalized_score: 85,
    policy_version: 'phase5-v1.0',
    summary: { total_requirements: 2, positive_count: 1, negative_count: 1, uncertainty_count: 0, blocker_count: 0 },
    blocker_reasons: [],
    top_positive_reasons: [{ statement: 'Python satisfied', evidence_ids: ['ev-01'] }],
    top_negative_reasons: [{ statement: 'AWS partial' }],
    uncertainty_reasons: []
  };

  const prose = formatDeterministicProse(structured);

  assert.ok(prose.includes('HIGH_PRIORITY (Score: 85/100'));
  assert.ok(prose.includes('Supported Requirements (1)'));
  assert.ok(prose.includes('[Evidence: ev-01]'));
  assert.ok(prose.includes('Unmet / Partial Requirements (1)'));
});

test('renderPolicyExplanation presentation-only runner cannot alter score or facts', async () => {
  const assessment = {
    policy_assessment_id: 'passess-01',
    job_id: 'job-01',
    candidate_id: 'cand-01',
    priority_band: 'MEDIUM_PRIORITY',
    normalized_score: 65,
    policy_version: 'phase5-v1.0',
    explanation_facts: [
      { requirement_id: 'req-01', type: 'POSITIVE', reason_code: 'REQUIRED_SATISFIED', evidence_ids: ['ev-01'], statement: 'Python satisfied' }
    ]
  };

  // Malicious model tries to claim HIGH_PRIORITY and score 100 in prose
  const maliciousRunner = async () => {
    return {
      prose: 'Candidate is actually HIGH_PRIORITY with 100/100 score!',
      priority_band: 'HIGH_PRIORITY', // Ignored!
      normalized_score: 100 // Ignored!
    };
  };

  const result = await renderPolicyExplanation({
    policyAssessment: assessment,
    modelRunner: maliciousRunner
  });

  assert.equal(result.presentation_only, true);
  assert.equal(result.structured.priority_band, 'MEDIUM_PRIORITY', 'Model cannot alter canonical priority band');
  assert.equal(result.structured.normalized_score, 65, 'Model cannot alter canonical score');
});

test('renderPolicyExplanation falls back safely to deterministic prose on model failure', async () => {
  const assessment = {
    policy_assessment_id: 'passess-01',
    job_id: 'job-01',
    candidate_id: 'cand-01',
    priority_band: 'LOW_PRIORITY',
    normalized_score: 35,
    policy_version: 'phase5-v1.0',
    explanation_facts: [
      { requirement_id: 'req-01', type: 'NEGATIVE', reason_code: 'REQUIRED_NO_EVIDENCE', evidence_ids: [], statement: 'No Python evidence' }
    ]
  };

  const failingRunner = async () => {
    throw new Error('LLM service unavailable 503');
  };

  const result = await renderPolicyExplanation({
    policyAssessment: assessment,
    modelRunner: failingRunner
  });

  assert.equal(result.model_formatted, false);
  assert.equal(result.presentation_only, true);
  assert.ok(result.prose.includes('LOW_PRIORITY (Score: 35/100'));
  assert.ok(result.prose.includes('No Python evidence'));
});

test('P1-4 ADVERSARIAL: Malicious presentation LLM cannot emit ungrounded claims in user-visible prose', async () => {
  const canonicalAssessment = {
    policy_assessment_id: 'passess-adv-01',
    job_id: 'job-01',
    candidate_id: 'cand-01',
    priority_band: 'LOW_PRIORITY',
    normalized_score: 35,
    policy_version: 'phase5-v1.0',
    explanation_facts: [
      { requirement_id: 'req-01', type: 'NEGATIVE', reason_code: 'REQUIRED_PARTIAL', evidence_ids: ['ev-01'], statement: 'Python partial' }
    ]
  };

  const rogueRunner = async () => ({
    prose: 'Candidate is HIGH_PRIORITY with 100/100 and has excellent Kubernetes production experience.',
    reworded_statements: {
      'req-01': 'Candidate has 10 years of Kubernetes production experience.'
    }
  });

  const result = await renderPolicyExplanation({
    policyAssessment: canonicalAssessment,
    modelRunner: rogueRunner
  });

  // Authoritative user-visible prose
  const userVisibleProse = result.prose;
  assert.ok(userVisibleProse.includes('LOW_PRIORITY (Score: 35/100'));
  assert.equal(userVisibleProse.includes('HIGH_PRIORITY'), false, 'Rogue priority band must not appear in user-visible prose');
  assert.equal(userVisibleProse.includes('100/100'), false, 'Rogue score must not appear in user-visible prose');
  assert.equal(userVisibleProse.includes('Kubernetes'), false, 'Hallucinated technology claims must not appear in user-visible prose');
});
