// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  semanticDecisionPolicyMode,
  isSemanticDecisionPolicyEnabled,
  buildDecisionPolicyShadowTelemetry,
  runDecisionPolicyShadow
} from '../../../src/agent/domain/semantic/decision-policy-shadow.mjs';

test('decision policy feature flag defaults to off and recognizes shadow', () => {
  assert.equal(semanticDecisionPolicyMode(), 'off');
  assert.equal(semanticDecisionPolicyMode({}), 'off');
  assert.equal(semanticDecisionPolicyMode({ features: {} }), 'off');
  assert.equal(semanticDecisionPolicyMode({ features: { semantic_decision_policy: false } }), 'off');

  assert.equal(semanticDecisionPolicyMode({ features: { semantic_decision_policy: 'shadow' } }), 'shadow');
  assert.equal(semanticDecisionPolicyMode({ features: { semantic_decision_policy: true } }), 'shadow');

  assert.equal(isSemanticDecisionPolicyEnabled({ features: { semantic_decision_policy: 'shadow' } }), true);
  assert.equal(isSemanticDecisionPolicyEnabled({ features: { semantic_decision_policy: false } }), false);
});

test('shadow OFF returns legacy decision only and does not execute shadow policy', async () => {
  const jobProfile = { job_id: 'job-101', requirements: [] };
  const candidateProfile = { candidate_id: 'cand-101' };
  const matchProfile = { match_profile_id: 'cmp-101', requirement_matches: [] };
  const legacyDecision = { fit_decision: 'STRONG', fit_score: 4.5 };

  const result = await runDecisionPolicyShadow({
    jobProfile,
    candidateProfile,
    matchProfile,
    legacyDecisionResult: legacyDecision,
    config: { features: { semantic_decision_policy: false } }
  });

  assert.equal(result.shadowExecuted, false);
  assert.deepEqual(result.authoritativeResult, legacyDecision);
  assert.equal(result.policyAssessment, null);
  assert.equal(result.telemetry, null);
});

test('shadow ON executes policy assessment while preserving legacy authority', async () => {
  const jobProfile = {
    job_id: 'job-101',
    requirements: [
      { requirement_id: 'req-01', type: 'TECHNICAL_SKILL', importance: 'REQUIRED', description: 'Python' }
    ]
  };
  const candidateProfile = { candidate_id: 'cand-101' };
  const matchProfile = {
    match_profile_id: 'cmp-101',
    requirement_matches: [
      { requirement_match_id: 'rmatch-01', requirement_id: 'req-01', relation: 'SATISFIES', candidate_evidence_ids: ['ev-01'] }
    ]
  };
  const legacyDecision = { fit_decision: 'STRONG', fit_score: 4.5 };

  const result = await runDecisionPolicyShadow({
    jobProfile,
    candidateProfile,
    matchProfile,
    legacyDecisionResult: legacyDecision,
    config: { features: { semantic_decision_policy: 'shadow' } }
  });

  assert.equal(result.shadowExecuted, true);
  assert.deepEqual(result.authoritativeResult, legacyDecision, 'Legacy decision authority must remain untouched');
  assert.ok(result.policyAssessment);
  assert.equal(result.policyAssessment.priority_band, 'HIGH_PRIORITY');
  assert.ok(result.telemetry);
  assert.equal(result.telemetry.component, 'semantic_decision_policy_shadow');
});

test('telemetry carries no candidate PII, raw CV text, or raw JD text', () => {
  const telemetry = buildDecisionPolicyShadowTelemetry({
    jobId: 'job-sec-01',
    candidateId: 'cand-sec-01',
    assessment: {
      policy_version: 'phase5-v1.0',
      normalized_score: 80,
      priority_band: 'HIGH_PRIORITY',
      hard_gate_triggered: false,
      telemetry: {
        requirements_evaluated: 2,
        unknown_required_count: 0,
        contradiction_count: 0
      }
    },
    latencyMs: 15
  });

  const serialized = JSON.stringify(telemetry);
  assert.equal(serialized.includes('John Doe'), false);
  assert.equal(serialized.includes('john@example.com'), false);
  assert.equal(serialized.includes('cv_text'), false);
  assert.equal(serialized.includes('jd_text'), false);
  assert.equal(telemetry.metrics.normalized_score, 80);
  assert.equal(telemetry.metrics.priority_band, 'HIGH_PRIORITY');
});
