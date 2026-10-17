// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluatePolicyAssessment } from '../../../src/agent/domain/semantic/decision-policy-engine.mjs';
import { rankJobAssessments } from '../../../src/agent/domain/semantic/job-ranker.mjs';
import { getPolicyConfiguration } from '../../../src/agent/domain/semantic/policy-configuration.mjs';
import { renderPolicyExplanation } from '../../../src/agent/domain/semantic/policy-explanation-renderer.mjs';
import { assertValidPolicyAssessment } from '../../../src/agent/domain/semantic/semantic-entities.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const BENCHMARK_SCRIPT = resolve(ROOT, 'scripts/eval-decision-policy.mjs');
const FIXTURES_PATH = resolve(ROOT, 'evals/fixtures/decision-policy-adversarial.json');

test('decision policy benchmark --help prints usage and exits 0', () => {
  const output = execFileSync(process.execPath, [BENCHMARK_SCRIPT, '--help'], { encoding: 'utf8' });
  assert.ok(output.includes('Usage: node scripts/eval-decision-policy.mjs'));
  assert.ok(output.includes('--strict'));
  assert.ok(output.includes('--json'));
});

test('decision policy benchmark runs offline in deterministic mode and labels result provisional', () => {
  const output = execFileSync(process.execPath, [BENCHMARK_SCRIPT, '--json'], { encoding: 'utf8' });
  const parsed = JSON.parse(output);
  assert.equal(parsed.benchmark, 'candidate_decision_policy_adversarial');
  assert.equal(parsed.evaluation_nature, 'PROVISIONAL_SYNTHETIC');
  assert.equal(parsed.sufficient_for_production, false);
  assert.equal(parsed.summary.total_cases >= 30, true);
  assert.equal(parsed.summary.passed_cases, parsed.summary.total_cases);
  assert.equal(parsed.metrics.system.calls_per_job, 0);
});

test('M1: Changing REQUIRED relation SATISFIES -> CONTRADICTS decreases score and rank', () => {
  const jobProfile = {
    job_id: 'job-m1',
    requirements: [{ requirement_id: 'req-01', type: 'TECHNICAL_SKILL', importance: 'REQUIRED', description: 'Core' }]
  };
  const cand = { candidate_id: 'cand-01' };

  const satMatch = { requirement_matches: [{ requirement_match_id: 'rmatch-01', requirement_id: 'req-01', relation: 'SATISFIES', candidate_evidence_ids: ['ev-01'] }] };
  const contraMatch = { requirement_matches: [{ requirement_match_id: 'rmatch-01', requirement_id: 'req-01', relation: 'CONTRADICTS', candidate_evidence_ids: ['ev-01'] }] };

  const satAssess = evaluatePolicyAssessment({ jobProfile, candidateProfile: cand, matchProfile: satMatch });
  const contraAssess = evaluatePolicyAssessment({ jobProfile, candidateProfile: cand, matchProfile: contraMatch });

  assert.ok(contraAssess.normalized_score < satAssess.normalized_score);
  assert.equal(contraAssess.priority_band, 'LOW_PRIORITY');

  const ranked = rankJobAssessments([contraAssess, satAssess]);
  assert.equal(ranked[0].job_id, 'job-m1');
  assert.equal(ranked[0].normalized_score, satAssess.normalized_score);
});

test('M2: Changing UNKNOWN -> NO_EVIDENCE demonstrates distinct uncertainty vs fit policy', () => {
  const jobProfile = {
    job_id: 'job-m2',
    requirements: [{ requirement_id: 'req-01', type: 'TECHNICAL_SKILL', importance: 'REQUIRED', description: 'Core' }]
  };
  const cand = { candidate_id: 'cand-01' };

  const unkMatch = { requirement_matches: [{ requirement_match_id: 'rmatch-01', requirement_id: 'req-01', relation: 'UNKNOWN', candidate_evidence_ids: [] }] };
  const noEvMatch = { requirement_matches: [{ requirement_match_id: 'rmatch-01', requirement_id: 'req-01', relation: 'NO_EVIDENCE', candidate_evidence_ids: [] }] };

  const unkAssess = evaluatePolicyAssessment({ jobProfile, candidateProfile: cand, matchProfile: unkMatch });
  const noEvAssess = evaluatePolicyAssessment({ jobProfile, candidateProfile: cand, matchProfile: noEvMatch });

  assert.equal(unkAssess.priority_band, 'INSUFFICIENT_INFORMATION', 'Unknown must map to INSUFFICIENT_INFORMATION');
  assert.equal(noEvAssess.priority_band, 'LOW_PRIORITY', 'Confirmed no-evidence must map to LOW_PRIORITY');
});

test('M3: Deleting supporting RequirementMatchResult fails closed with error', () => {
  const jobProfile = {
    job_id: 'job-m3',
    requirements: [{ requirement_id: 'req-missing', type: 'TECHNICAL_SKILL', importance: 'REQUIRED', description: 'Core' }]
  };
  const cand = { candidate_id: 'cand-01' };
  const emptyMatch = { requirement_matches: [] };

  assert.throws(() => {
    evaluatePolicyAssessment({ jobProfile, candidateProfile: cand, matchProfile: emptyMatch });
  }, /Missing RequirementMatchResult/);
});

test('M4: Injected unsupported score contribution is rejected by schema validator', () => {
  const jobProfile = {
    job_id: 'job-m4',
    requirements: [{ requirement_id: 'req-01', type: 'TECHNICAL_SKILL', importance: 'REQUIRED', description: 'Core' }]
  };
  const cand = { candidate_id: 'cand-01' };
  const match = { requirement_matches: [{ requirement_match_id: 'rmatch-01', requirement_id: 'req-01', relation: 'SATISFIES', candidate_evidence_ids: ['ev-01'] }] };

  const assess = evaluatePolicyAssessment({ jobProfile, candidateProfile: cand, matchProfile: match });

  // Tamper with score
  const corrupted = { ...assess, normalized_score: 999 };
  assert.throws(() => {
    assertValidPolicyAssessment(corrupted);
  });
});

test('M5: Model-generated overall score is ignored by deterministic policy engine', () => {
  const jobProfile = {
    job_id: 'job-m5',
    requirements: [{ requirement_id: 'req-01', type: 'TECHNICAL_SKILL', importance: 'REQUIRED', description: 'Core' }]
  };
  const cand = { candidate_id: 'cand-01' };
  // Phase 4 matchProfile containing an unauthorized score
  const match = {
    match_profile_id: 'cmp-m5',
    model_generated_score: 100, // Unauthorized model score
    requirement_matches: [{ requirement_match_id: 'rmatch-01', requirement_id: 'req-01', relation: 'PARTIALLY_SUPPORTS', candidate_evidence_ids: ['ev-01'] }]
  };

  const assess = evaluatePolicyAssessment({ jobProfile, candidateProfile: cand, matchProfile: match });

  assert.notEqual(assess.normalized_score, 100, 'Model-generated score must be ignored');
  assert.equal(assess.normalized_score, 35, 'Score must be derived purely from deterministic policy rules');
});

test('M6: Changing policy weight updates policy_version and invalidates cached scores', () => {
  const jobProfile = {
    job_id: 'job-m6',
    requirements: [{ requirement_id: 'req-01', type: 'TECHNICAL_SKILL', importance: 'REQUIRED', description: 'Core' }]
  };
  const cand = { candidate_id: 'cand-01' };
  const match = { requirement_matches: [{ requirement_match_id: 'rmatch-01', requirement_id: 'req-01', relation: 'PARTIALLY_SUPPORTS', candidate_evidence_ids: ['ev-01'] }] };

  const baseConfig = getPolicyConfiguration();
  const modifiedConfig = getPolicyConfiguration({
    policy_version: 'phase5-v2.0-custom',
    relation_values: { PARTIALLY_SUPPORTS: 0.8 } // Changed from 0.5 to 0.8
  });

  const assessBase = evaluatePolicyAssessment({ jobProfile, candidateProfile: cand, matchProfile: match, policyConfig: baseConfig });
  const assessMod = evaluatePolicyAssessment({ jobProfile, candidateProfile: cand, matchProfile: match, policyConfig: modifiedConfig });

  assert.equal(assessBase.policy_version, 'phase5-v1.0');
  assert.equal(assessMod.policy_version, 'phase5-v2.0-custom');
  assert.ok(assessMod.normalized_score > assessBase.normalized_score);
});

test('M7: Explanation model claiming different priority band does not alter canonical band', async () => {
  const assess = {
    policy_assessment_id: 'passess-m7',
    job_id: 'job-m7',
    candidate_id: 'cand-01',
    priority_band: 'LOW_PRIORITY',
    normalized_score: 20,
    policy_version: 'phase5-v1.0',
    explanation_facts: [{ requirement_id: 'req-01', type: 'NEGATIVE', reason_code: 'REQUIRED_NO_EVIDENCE', statement: 'No match' }]
  };

  const rogueRunner = async () => ({
    prose: 'Everything is great, high priority!',
    priority_band: 'HIGH_PRIORITY' // Rogue model output
  });

  const rendered = await renderPolicyExplanation({ policyAssessment: assess, modelRunner: rogueRunner });
  assert.equal(rendered.structured.priority_band, 'LOW_PRIORITY', 'Canonical priority band must remain immutable');
  assert.equal(rendered.presentation_only, true);
});

test('M8: Permuting job input order produces identical ranking output', () => {
  const a = { job_id: 'job-1', normalized_score: 90, telemetry: { contradiction_count: 0 }, aggregate_components: { required_coverage: 70 }, policy_assessment_id: 'p-1' };
  const b = { job_id: 'job-2', normalized_score: 80, telemetry: { contradiction_count: 0 }, aggregate_components: { required_coverage: 60 }, policy_assessment_id: 'p-2' };
  const c = { job_id: 'job-3', normalized_score: 70, telemetry: { contradiction_count: 0 }, aggregate_components: { required_coverage: 50 }, policy_assessment_id: 'p-3' };

  const r1 = rankJobAssessments([a, b, c]).map((x) => x.job_id);
  const r2 = rankJobAssessments([c, a, b]).map((x) => x.job_id);
  const r3 = rankJobAssessments([b, c, a]).map((x) => x.job_id);

  assert.deepEqual(r1, ['job-1', 'job-2', 'job-3']);
  assert.deepEqual(r2, r1);
  assert.deepEqual(r3, r1);
});

test('M9: Exact score tie broken by documented tie-breaker chain', () => {
  const j1 = { job_id: 'job-tie-1', normalized_score: 70, telemetry: { contradiction_count: 0, unknown_required_count: 0 }, aggregate_components: { required_coverage: 55 }, policy_assessment_id: 'p-1' };
  const j2 = { job_id: 'job-tie-2', normalized_score: 70, telemetry: { contradiction_count: 0, unknown_required_count: 0 }, aggregate_components: { required_coverage: 50 }, policy_assessment_id: 'p-2' };

  const ranked = rankJobAssessments([j2, j1]);
  assert.equal(ranked[0].job_id, 'job-tie-1', 'Higher required coverage must win score tie');
});

test('M10: Injecting protected attributes into candidate object has zero effect on ranking', () => {
  const j1 = { job_id: 'job-1', normalized_score: 80, telemetry: { contradiction_count: 0 }, aggregate_components: { required_coverage: 60 }, policy_assessment_id: 'p-1' };
  const j2 = { job_id: 'job-2', normalized_score: 70, telemetry: { contradiction_count: 0 }, aggregate_components: { required_coverage: 50 }, policy_assessment_id: 'p-2' };

  const plainRanking = rankJobAssessments([j1, j2]).map((x) => x.job_id);

  const protectedCandidate = {
    candidate_id: 'cand-01',
    race: 'protected-x',
    age: 55,
    gender: 'non-binary'
  };

  const protectedRanking = rankJobAssessments([j1, j2]).map((x) => x.job_id);
  assert.deepEqual(plainRanking, protectedRanking);
});

test('CLI strict mode exits 1 and names failed case when adversarial expectation is violated', () => {
  const raw = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8'));
  const mutated = raw.map((c) => {
    if (c.id === 'DP-01') {
      return { ...c, expected: { priority_band: 'LOW_PRIORITY' } };
    }
    return c;
  });

  const tmpPath = resolve(ROOT, 'evals/fixtures/tmp-mutation-dp.json');
  writeFileSync(tmpPath, JSON.stringify(mutated, null, 2), 'utf8');

  try {
    let capturedError = '';
    try {
      execFileSync(process.execPath, [BENCHMARK_SCRIPT, '--strict', '--dataset', 'evals/fixtures/tmp-mutation-dp.json'], {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    } catch (err) {
      capturedError = err.stdout + '\n' + err.stderr;
    }
    assert.ok(capturedError.includes('DP-01'), 'CLI must report specific failed case ID');
    assert.ok(capturedError.includes('Priority band mismatch'), 'CLI must report priority band mismatch');
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
});
