// @ts-check
//
// Phase-2 skill metrics.
//
// False merge rate is a first-class safety metric, so it gets its own direct
// test rather than only being exercised through the benchmark CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSkillIntelligenceMetrics,
  conceptIdStability,
  safeDivide,
  wilsonScoreInterval
} from '../../../src/agent/domain/semantic/evaluation-metrics.mjs';

function mention(surface, normalized, conceptId, { start = 0, quote = null, state = 'RESOLVED', jd = null } = {}) {
  const q = quote ?? surface;
  return {
    mention_id: `m-${surface}`,
    surface_form: surface,
    normalized_surface: normalized,
    category: 'LANGUAGE',
    requirement_id: null,
    requirement_importance: null,
    evidence_span: { start_char: start, end_char: start + q.length, verbatim_quote: q },
    resolution: {
      state,
      concept_id: conceptId,
      canonical_name: conceptId,
      method: state === 'RESOLVED' ? 'EXACT_CANONICAL' : 'NONE',
      confidence: 1
    },
    confidence: 0.9
  };
}

function prediction({ jd, mentions, concepts, telemetry = {} }) {
  return {
    skill_intelligence: {
      job_id: 'j1',
      jd_hash: 'a'.repeat(64),
      mentions,
      concepts,
      unresolved_surfaces: mentions.filter((m) => !m.resolution.concept_id).map((m) => m.surface_form),
      diagnostics: { rejected_mentions: [] },
      model_metadata: { model_id: 'mock', prompt_version: 'p', task_version: 't', schema_version: 'v1.2.0' },
      telemetry: {
        extraction_ms: 1,
        normalization_ms: 2,
        model_calls: 1,
        normalization_model_calls: 0,
        retries: 0,
        cache_hits: 0,
        cache_misses: 0,
        ...telemetry
      }
    }
  };
}

test('empty results produce a structurally valid, explicitly provisional report', () => {
  const report = computeSkillIntelligenceMetrics([]);
  assert.equal(report.metadata.total_samples, 0);
  assert.equal(report.provisional.PROVISIONAL, true);
  assert.equal(report.provisional.SUFFICIENT_FOR_PRODUCTION_PROMOTION, false);
});

test('a correct prediction scores 1.0 precision, recall, provenance and canonicalization', () => {
  const jd = 'Java and JavaScript.';
  const report = computeSkillIntelligenceMetrics([{
    sample: {
      id: 'x',
      jd_text: jd,
      expected: {
        mentions: [{ surface_form: 'Java' }, { surface_form: 'JavaScript' }],
        concept_map: { Java: 'java', JavaScript: 'javascript' },
        distinct_pairs: [['Java', 'JavaScript']],
        equivalence_groups: []
      }
    },
    prediction: prediction({
      jd,
      mentions: [mention('Java', 'java', 'java'), mention('JavaScript', 'javascript', 'javascript', { start: 9 })],
      concepts: [{ concept_id: 'java', canonical_name: 'Java' }, { concept_id: 'javascript', canonical_name: 'JavaScript' }]
    })
  }]);

  assert.equal(report.extraction_metrics.mention_precision, 1);
  assert.equal(report.extraction_metrics.mention_recall, 1);
  assert.equal(report.extraction_metrics.provenance_validity_rate, 1);
  assert.equal(report.normalization_metrics.canonicalization_accuracy, 1);
  assert.equal(report.normalization_metrics.false_merge_rate, 0);
  assert.equal(report.normalization_metrics.false_merge_comparable, 1);
});

test('the forbidden merge is detected and counted as a false merge', () => {
  const jd = 'Java and JavaScript.';
  const report = computeSkillIntelligenceMetrics([{
    sample: {
      id: 'x',
      jd_text: jd,
      expected: {
        mentions: [{ surface_form: 'Java' }, { surface_form: 'JavaScript' }],
        concept_map: { Java: 'java', JavaScript: 'javascript' },
        distinct_pairs: [['Java', 'JavaScript']],
        equivalence_groups: []
      }
    },
    prediction: prediction({
      jd,
      mentions: [mention('Java', 'java', 'java'), mention('JavaScript', 'javascript', 'java', { start: 9 })],
      concepts: [{ concept_id: 'java', canonical_name: 'Java' }]
    })
  }]);

  assert.equal(report.normalization_metrics.false_merge_count, 1);
  assert.equal(report.normalization_metrics.false_merge_rate, 1);
  assert.equal(report.normalization_metrics.canonicalization_accuracy, 0.5);
});

test('a false split of an equivalence group is detected and counted', () => {
  const jd = 'JS and JavaScript.';
  const report = computeSkillIntelligenceMetrics([{
    sample: {
      id: 'x',
      jd_text: jd,
      expected: {
        mentions: [{ surface_form: 'JS' }, { surface_form: 'JavaScript' }],
        concept_map: { JS: 'javascript', JavaScript: 'javascript' },
        equivalence_groups: [['JS', 'JavaScript']],
        distinct_pairs: []
      }
    },
    prediction: prediction({
      jd,
      mentions: [mention('JS', 'js', 'js'), mention('JavaScript', 'javascript', 'javascript', { start: 7 })],
      concepts: [{ concept_id: 'js', canonical_name: 'JS' }, { concept_id: 'javascript', canonical_name: 'JavaScript' }]
    })
  }]);

  assert.equal(report.normalization_metrics.false_split_count, 1);
  assert.equal(report.normalization_metrics.false_split_rate, 1);
});

test('a mention whose span does not re-slice lowers provenance validity', () => {
  const jd = 'Python is required.';
  const bad = mention('Python', 'python', 'python', { quote: 'Rust' });
  const report = computeSkillIntelligenceMetrics([{
    sample: { id: 'x', jd_text: jd, expected: { mentions: [{ surface_form: 'Python' }], concept_map: {}, distinct_pairs: [], equivalence_groups: [] } },
    prediction: prediction({ jd, mentions: [bad], concepts: [{ concept_id: 'python', canonical_name: 'Python' }] })
  }]);

  assert.equal(report.extraction_metrics.provenance_validity_rate, 0);
  assert.equal(report.extraction_metrics.provenance_checked, 1);
});

test('a case that expects nothing and produces nothing scores a perfect extraction', () => {
  const jd = 'Experience with modern frontend frameworks.';
  const report = computeSkillIntelligenceMetrics([{
    sample: { id: 'x', jd_text: jd, expected: { mentions: [], concept_map: {}, distinct_pairs: [], equivalence_groups: [] } },
    prediction: prediction({ jd, mentions: [], concepts: [] })
  }]);

  assert.equal(report.extraction_metrics.mention_precision, 1);
  assert.equal(report.extraction_metrics.mention_recall, 1);
  assert.equal(report.extraction_metrics.false_skill_count, 0);
});

test('a hallucinated skill is counted as a false skill', () => {
  const jd = 'Experience with modern frontend frameworks.';
  const report = computeSkillIntelligenceMetrics([{
    sample: {
      id: 'x',
      jd_text: jd,
      expected: { mentions: [], concept_map: {}, distinct_pairs: [], equivalence_groups: [], forbidden_surfaces: ['React', 'Vue'] }
    },
    prediction: prediction({
      jd,
      mentions: [mention('React', 'react', 'react'), mention('Vue', 'vue', 'vue')],
      concepts: [{ concept_id: 'react', canonical_name: 'React' }, { concept_id: 'vue', canonical_name: 'Vue' }]
    })
  }]);

  assert.equal(report.extraction_metrics.false_skill_count, 2);
  assert.equal(report.extraction_metrics.false_skill_rate, 1);
});

test('operational telemetry is folded from per-run telemetry', () => {
  const jd = 'Python.';
  const report = computeSkillIntelligenceMetrics([{
    sample: { id: 'x', jd_text: jd, expected: { mentions: [{ surface_form: 'Python' }], concept_map: {}, distinct_pairs: [], equivalence_groups: [] } },
    prediction: prediction({
      jd,
      mentions: [mention('Python', 'python', 'python')],
      concepts: [{ concept_id: 'python', canonical_name: 'Python' }],
      telemetry: { model_calls: 2, normalization_model_calls: 1, retries: 1, cache_hits: 3, cache_misses: 1 }
    })
  }]);

  assert.equal(report.operational_telemetry.calls_per_job, 2);
  assert.equal(report.operational_telemetry.normalization_calls_per_job, 1);
  assert.equal(report.operational_telemetry.retries_per_job, 1);
  assert.equal(report.operational_telemetry.cache_hit_rate, 0.75);
  assert.equal(report.operational_telemetry.failures_per_job, 0);
});

test('a failed sample is counted, not silently treated as a perfect run', () => {
  const report = computeSkillIntelligenceMetrics([{
    sample: { id: 'x', jd_text: 'Python.', expected: { mentions: [], concept_map: {}, distinct_pairs: [], equivalence_groups: [] } },
    prediction: { skill_intelligence: null, error: 'MODEL_TIMEOUT' }
  }]);
  assert.equal(report.metadata.failed_samples, 1);
  assert.equal(report.operational_telemetry.failures_per_job, 1);
});

test('every report is labelled provisional and not sufficient for promotion', () => {
  const report = computeSkillIntelligenceMetrics([{
    sample: { id: 'x', jd_text: 'Python.', expected: { mentions: [], concept_map: {}, distinct_pairs: [], equivalence_groups: [] } },
    prediction: prediction({ jd: 'Python.', mentions: [], concepts: [] })
  }]);
  assert.equal(report.provisional.PROVISIONAL, true);
  assert.equal(report.provisional.SYNTHETIC, true);
  assert.equal(report.provisional.SUFFICIENT_FOR_PRODUCTION_PROMOTION, false);
  assert.match(report.provisional.note, /NOT sufficient for production promotion/);
});

test('conceptIdStability is a strict digest comparison', () => {
  assert.deepEqual(conceptIdStability('abc', 'abc'), { stable: true });
  assert.deepEqual(conceptIdStability('abc', 'abd'), { stable: false });
  assert.deepEqual(conceptIdStability(undefined, 'abc'), { stable: false });
});

test('the shared zero-denominator and Wilson helpers stay well defined', () => {
  assert.equal(safeDivide(1, 0), 0);
  assert.equal(safeDivide(0, 1), 0);
  assert.deepEqual(wilsonScoreInterval(0, 0), { lower: 0, upper: 0, center: 0 });
  const ci = wilsonScoreInterval(9, 10);
  assert.ok(ci.lower < 0.9 && ci.upper <= 1 && ci.center === 0.9);
});