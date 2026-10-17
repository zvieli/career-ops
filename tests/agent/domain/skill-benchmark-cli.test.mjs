// @ts-check
//
// Phase-2 offline benchmark CLI contract.
//
// The suite is expected to be runnable on a fresh clone with only Node, and it
// must never make a live model call. Both properties are asserted here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = resolve(ROOT, 'scripts/eval-semantic-skills.mjs');

function runCli(args) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: ROOT });
  assert.equal(proc.status, 0, `CLI exited ${proc.status}: ${proc.stderr}`);
  return proc.stdout;
}

test('skill benchmark --help prints usage and exits 0', () => {
  const proc = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(proc.status, 0);
  assert.ok(proc.stdout.includes('Usage:'));
  assert.ok(proc.stdout.includes('--semantic'));
});

test('skill benchmark runs offline in deterministic mode and labels the result provisional', () => {
  const stdout = runCli(['--strict']);
  assert.ok(stdout.includes('Phase-2 Skill Intelligence Benchmark'));
  assert.ok(stdout.includes('EXTRACTION METRICS'));
  assert.ok(stdout.includes('NORMALIZATION METRICS'));
  assert.ok(stdout.includes('OPERATIONAL METRICS'));
  assert.ok(stdout.includes('DETERMINISM'));
  assert.ok(stdout.includes('PROVISIONAL / SYNTHETIC - NOT SUFFICIENT FOR PRODUCTION PROMOTION'));
  assert.ok(stdout.includes('false merge count        : 0'));
  assert.ok(stdout.includes('false split count        : 0'));
});

test('skill benchmark exercises the simulated semantic stage without a live call', () => {
  const stdout = runCli(['--semantic', '--strict']);
  assert.ok(stdout.includes('deterministic+simulated-semantic'));
  assert.ok(stdout.includes('false merge count        : 0'));
});

test('skill benchmark JSON report is machine readable, honest and self-consistent', () => {
  const stdout = runCli(['--json']);
  const report = JSON.parse(stdout);

  assert.equal(report.benchmark, 'phase2-skill-intelligence');
  assert.equal(report.live_model_calls, 0);
  assert.equal(report.all_concept_ids_stable, true);
  assert.equal(report.assertion_failures, 0);
  assert.equal(report.metrics.provisional.PROVISIONAL, true);
  assert.equal(report.metrics.provisional.SYNTHETIC, true);
  assert.equal(report.metrics.provisional.SUFFICIENT_FOR_PRODUCTION_PROMOTION, false);
  assert.ok(report.registry_version);
  assert.ok(report.normalization_version);
  assert.ok(report.cases.length >= 20);

  // Reachable only by a deliberate, labelled fixture.
  assert.ok(report.simulated_model_error_cases.includes('SI-21'));
  assert.equal(report.clean_metrics.normalization_metrics.false_merge_count, 0);
  assert.equal(report.clean_metrics.normalization_metrics.false_split_count, 0);
  assert.equal(report.clean_metrics.extraction_metrics.false_skill_count, 0);
  assert.equal(report.clean_metrics.extraction_metrics.provenance_validity_rate, 1);
  assert.equal(report.clean_metrics.normalization_metrics.canonicalization_accuracy, 1);
  assert.equal(report.clean_metrics.extraction_metrics.mention_precision, 1);
  assert.equal(report.clean_metrics.extraction_metrics.mention_recall, 1);

  // Injected skills are rejected at extraction time by prompt safety
  assert.equal(report.metrics.extraction_metrics.false_skill_count, 0);
  assert.ok(report.cases.some((c) => c.id === 'SI-21' && c.simulated_model_error === true));
  assert.ok(report.cases.find((c) => c.id === 'SI-21').rejected_mentions.some((r) => r.reason === 'PROMPT_INJECTION_REJECTED'));

  // Every case keeps identity stable and every mention keeps exact provenance.
  assert.ok(report.cases.every((c) => c.concept_id_stable));
  assert.ok(report.cases.every((c) => c.assertion_problems.length === 0));
});

test('skill benchmark --output writes the report to disk', () => {
  const out = resolve(ROOT, 'evals/fixtures/test-tmp-skill-report.json');
  try {
    runCli(['--json', '--output', out]);
    assert.equal(existsSync(out), true);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(report.live_model_calls, 0);
    assert.equal(report.benchmark, 'phase2-skill-intelligence');
  } finally {
    if (existsSync(out)) unlinkSync(out);
  }
});

test('the adversarial fixture set covers the required ambiguity classes', () => {
  const fixturePath = resolve(ROOT, 'evals/fixtures/skill-intelligence-adversarial.json');
  const cases = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const tags = new Set(cases.flatMap((c) => c.tags || []));
  for (const required of [
    'alias', 'casing', 'punctuation', 'abbreviation',
    'false_merge_guard', 'abstraction_levels', 'ambiguity',
    'no_inference', 'no_hallucination', 'ecosystem',
    'alternatives', 'cloud', 'containers', 'parallel_transport',
    'unknown', 'new_concept', 'hebrew', 'emoji', 'utf16',
    'prompt_injection', 'requirement_lineage', 'duplicates'
  ]) {
    assert.ok(tags.has(required), `fixture set is missing a ${required} case`);
  }

  // Every fixture's verbatim quote must genuinely appear in its JD, or the
  // fixture is testing nothing.
  for (const c of cases) {
    for (const skill of c.mock_extraction?.skills || []) {
      assert.ok(c.jd_text.includes(skill.verbatim_quote), `${c.id}: ${skill.surface_form} quote not in JD`);
    }
    for (const r of c.requirements || []) {
      assert.ok(c.jd_text.includes(r.verbatim_quote), `${c.id}: requirement quote not in JD`);
    }
  }
});