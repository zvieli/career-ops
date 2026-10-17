// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  safeDivide,
  wilsonScoreInterval,
  computeBinaryClassificationMetrics,
  computeBenchmarkMetrics
} from '../../../src/agent/domain/semantic/evaluation-metrics.mjs';

test('safeDivide handles zero and invalid denominators without throwing', () => {
  assert.equal(safeDivide(10, 2), 5);
  assert.equal(safeDivide(10, 0), 0);
  assert.equal(safeDivide(10, 0, 999), 999);
  assert.equal(safeDivide(0, 0), 0);
  assert.equal(safeDivide(NaN, 5), 0);
});

test('wilsonScoreInterval calculates bounded confidence intervals', () => {
  const ci = wilsonScoreInterval(80, 100);
  assert.equal(ci.center, 0.80);
  assert.ok(ci.lower >= 0 && ci.lower <= 0.80);
  assert.ok(ci.upper >= 0.80 && ci.upper <= 1.0);

  // Boundary: 0 total
  const zeroCi = wilsonScoreInterval(0, 0);
  assert.equal(zeroCi.lower, 0);
  assert.equal(zeroCi.upper, 0);
});

test('computeBinaryClassificationMetrics calculates precision, recall, F1 accurately', () => {
  const res = computeBinaryClassificationMetrics({ tp: 80, fp: 20, fn: 20 });
  assert.equal(res.precision, 0.80);
  assert.equal(res.recall, 0.80);
  assert.equal(res.f1, 0.80);

  // Zero predictions
  const zeroRes = computeBinaryClassificationMetrics({ tp: 0, fp: 0, fn: 10 });
  assert.equal(zeroRes.precision, 0);
  assert.equal(zeroRes.recall, 0);
  assert.equal(zeroRes.f1, 0);
});

test('computeBenchmarkMetrics distinguishes human-verified from provisional benchmarks', () => {
  const syntheticResults = [
    {
      sample: {
        sample_id: 'S1',
        metadata: { role_family: 'software_engineering' },
        annotations: {
          status: 'MODEL_PROPOSED',
          gold_profile: {
            role_family: 'software_engineering',
            seniority_level: 'JUNIOR',
            required_yoe: 1,
            is_early_career_friendly: true
          }
        }
      },
      prediction: {
        job_profile: {
          role_family: 'software_engineering',
          seniority: { level: 'JUNIOR' },
          overall_yoe_required: 1
        },
        match_profile: { yoe_comparison: { policy_status: 'STRONG' } },
        legacy_diagnostics: { latency_ms: 10, fit_status: 'STRONG', rejection_type: 'NONE' }
      }
    }
  ];

  const metrics = computeBenchmarkMetrics(syntheticResults);
  assert.equal(metrics.annotation_integrity.human_verified_count, 0);
  assert.equal(metrics.annotation_integrity.is_provisional, true);
  assert.ok(metrics.annotation_integrity.integrity_note.includes('PROVISIONAL BENCHMARK'));
  assert.equal(metrics.performance_metrics.seniority_accuracy.score, 1.0);
  assert.equal(metrics.performance_metrics.yoe_tolerance_accuracy.score, 1.0);
});
