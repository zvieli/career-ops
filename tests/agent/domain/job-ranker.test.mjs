// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankJobAssessments, compareAssessments } from '../../../src/agent/domain/semantic/job-ranker.mjs';

test('job ranking orders assessments by normalized_score descending', () => {
  const assess1 = { job_id: 'job-01', normalized_score: 85, priority_band: 'HIGH_PRIORITY', policy_assessment_id: 'p-01', aggregate_components: { required_coverage: 60 } };
  const assess2 = { job_id: 'job-02', normalized_score: 95, priority_band: 'HIGH_PRIORITY', policy_assessment_id: 'p-02', aggregate_components: { required_coverage: 70 } };
  const assess3 = { job_id: 'job-03', normalized_score: 40, priority_band: 'LOW_PRIORITY', policy_assessment_id: 'p-03', aggregate_components: { required_coverage: 25 } };

  const ranked = rankJobAssessments([assess1, assess2, assess3]);

  assert.equal(ranked.length, 3);
  assert.equal(ranked[0].job_id, 'job-02');
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[1].job_id, 'job-01');
  assert.equal(ranked[1].rank, 2);
  assert.equal(ranked[2].job_id, 'job-03');
  assert.equal(ranked[2].rank, 3);
});

test('job ranking is input-order independent (permutation invariant)', () => {
  const assess1 = { job_id: 'job-A', normalized_score: 80, priority_band: 'HIGH_PRIORITY', policy_assessment_id: 'p-A', aggregate_components: { required_coverage: 60 } };
  const assess2 = { job_id: 'job-B', normalized_score: 65, priority_band: 'MEDIUM_PRIORITY', policy_assessment_id: 'p-B', aggregate_components: { required_coverage: 45 } };
  const assess3 = { job_id: 'job-C', normalized_score: 90, priority_band: 'HIGH_PRIORITY', policy_assessment_id: 'p-C', aggregate_components: { required_coverage: 70 } };

  // All 6 permutations of 3 items
  const p1 = [assess1, assess2, assess3];
  const p2 = [assess1, assess3, assess2];
  const p3 = [assess2, assess1, assess3];
  const p4 = [assess2, assess3, assess1];
  const p5 = [assess3, assess1, assess2];
  const p6 = [assess3, assess2, assess1];

  const r1 = rankJobAssessments(p1).map((r) => r.job_id);
  const r2 = rankJobAssessments(p2).map((r) => r.job_id);
  const r3 = rankJobAssessments(p3).map((r) => r.job_id);
  const r4 = rankJobAssessments(p4).map((r) => r.job_id);
  const r5 = rankJobAssessments(p5).map((r) => r.job_id);
  const r6 = rankJobAssessments(p6).map((r) => r.job_id);

  const expectedOrder = ['job-C', 'job-A', 'job-B'];

  assert.deepEqual(r1, expectedOrder);
  assert.deepEqual(r2, expectedOrder);
  assert.deepEqual(r3, expectedOrder);
  assert.deepEqual(r4, expectedOrder);
  assert.deepEqual(r5, expectedOrder);
  assert.deepEqual(r6, expectedOrder);
});

test('tie-breaking 1: equal score broken by fewer contradictions', () => {
  const assessClean = {
    job_id: 'job-clean',
    normalized_score: 70,
    telemetry: { contradiction_count: 0 },
    aggregate_components: { required_coverage: 50 },
    policy_assessment_id: 'p-clean'
  };
  const assessContradict = {
    job_id: 'job-contra',
    normalized_score: 70,
    telemetry: { contradiction_count: 1 },
    aggregate_components: { required_coverage: 50 },
    policy_assessment_id: 'p-contra'
  };

  const ranked = rankJobAssessments([assessContradict, assessClean]);
  assert.equal(ranked[0].job_id, 'job-clean', 'Fewer contradictions must rank ahead on equal score');
  assert.equal(ranked[1].job_id, 'job-contra');
});

test('tie-breaking 2: equal score and contradictions broken by greater required coverage', () => {
  const assessHighReq = {
    job_id: 'job-high-req',
    normalized_score: 60,
    telemetry: { contradiction_count: 0 },
    aggregate_components: { required_coverage: 55 },
    policy_assessment_id: 'p-req'
  };
  const assessLowReq = {
    job_id: 'job-low-req',
    normalized_score: 60,
    telemetry: { contradiction_count: 0 },
    aggregate_components: { required_coverage: 40 },
    policy_assessment_id: 'p-low'
  };

  const ranked = rankJobAssessments([assessLowReq, assessHighReq]);
  assert.equal(ranked[0].job_id, 'job-high-req', 'Higher required coverage must rank ahead on tie');
  assert.equal(ranked[1].job_id, 'job-low-req');
});

test('tie-breaking 3: equal score, contradictions, and required coverage broken by fewer unknown required', () => {
  const assessKnown = {
    job_id: 'job-known',
    normalized_score: 60,
    telemetry: { contradiction_count: 0, unknown_required_count: 0 },
    aggregate_components: { required_coverage: 50 },
    policy_assessment_id: 'p-known'
  };
  const assessUnk = {
    job_id: 'job-unk',
    normalized_score: 60,
    telemetry: { contradiction_count: 0, unknown_required_count: 2 },
    aggregate_components: { required_coverage: 50 },
    policy_assessment_id: 'p-unk'
  };

  const ranked = rankJobAssessments([assessUnk, assessKnown]);
  assert.equal(ranked[0].job_id, 'job-known', 'Fewer unknowns must rank ahead on tie');
  assert.equal(ranked[1].job_id, 'job-unk');
});

test('tie-breaking 4: fully identical metrics broken by stable job_id lexicographical order', () => {
  const assessAlpha = {
    job_id: 'job-100-alpha',
    normalized_score: 75,
    telemetry: { contradiction_count: 0, unknown_required_count: 0 },
    aggregate_components: { required_coverage: 60 },
    policy_assessment_id: 'p-alpha'
  };
  const assessBeta = {
    job_id: 'job-200-beta',
    normalized_score: 75,
    telemetry: { contradiction_count: 0, unknown_required_count: 0 },
    aggregate_components: { required_coverage: 60 },
    policy_assessment_id: 'p-beta'
  };

  // Input beta before alpha
  const ranked = rankJobAssessments([assessBeta, assessAlpha]);
  assert.equal(ranked[0].job_id, 'job-100-alpha', 'Stable job_id order must break identical tie');
  assert.equal(ranked[1].job_id, 'job-200-beta');
});
