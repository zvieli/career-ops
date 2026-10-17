// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = resolve(ROOT, 'scripts/eval-candidate-semantic.mjs');

function runCli(args) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: ROOT });
  assert.equal(proc.status, 0, `CLI exited ${proc.status}: ${proc.stderr}`);
  return proc.stdout;
}

test('candidate benchmark --help prints usage and exits 0', () => {
  const proc = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(proc.status, 0);
  assert.ok(proc.stdout.includes('Usage:'));
});

test('candidate benchmark runs offline in deterministic mode and labels result provisional', () => {
  const stdout = runCli(['--strict']);
  assert.ok(stdout.includes('Phase-3 Candidate Semantic Intelligence Benchmark'));
  assert.ok(stdout.includes('PROVISIONAL / SYNTHETIC - NOT SUFFICIENT FOR PRODUCTION CUTOVER'));
  assert.ok(stdout.includes('Cases         : 25'));
  assert.ok(stdout.includes('Failures      : 0'));
  assert.ok(stdout.includes('Live Calls    : 0'));
});

test('candidate benchmark JSON report is machine readable, honest and self-consistent', () => {
  const stdout = runCli(['--json']);
  const report = JSON.parse(stdout);

  assert.equal(report.benchmark, 'phase3-candidate-semantic-intelligence');
  assert.equal(report.live_model_calls, 0);
  assert.equal(report.assertion_failures, 0);
  assert.equal(report.total_cases, 25);
  assert.equal(report.provisional.PROVISIONAL, true);
  assert.equal(report.provisional.SYNTHETIC, true);
  assert.equal(report.provisional.SUFFICIENT_FOR_PRODUCTION_CUTOVER, false);
  assert.equal(report.metrics.project_to_employment_false_promotions, 0);
  assert.equal(report.metrics.internship_to_employment_false_promotions, 0);
  assert.equal(report.metrics.course_to_certification_false_promotions, 0);
  assert.equal(report.metrics.false_education_completion_cases, 0);
  assert.equal(report.metrics.fabricated_yoe_cases, 0);
  assert.equal(report.metrics.unsupported_capability_cases, 0);
  assert.equal(report.metrics.responsibility_overstatement_cases, 0);
  assert.equal(report.metrics.unsupported_skill_inference_cases, 0);
  assert.equal(report.metrics.prompt_injection_admitted_cases, 0);
  assert.equal(report.metrics.provenance_exactness_rate, 1.0);
});

test('candidate benchmark --output writes the report to disk', () => {
  const outPath = resolve(ROOT, 'evals/fixtures/.tmp-candidate-benchmark-output.json');
  try {
    runCli(['--output', outPath]);
    assert.ok(existsSync(outPath));
    const content = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(content.benchmark, 'phase3-candidate-semantic-intelligence');
    assert.equal(content.total_cases, 25);
  } finally {
    if (existsSync(outPath)) unlinkSync(outPath);
  }
});

test('P1-6 BENCHMARK HONESTY: metrics actively change and strict mode fails on injected mutations', () => {
  const origFixturePath = resolve(ROOT, 'evals/fixtures/candidate-semantic-adversarial.json');
  const dataset = JSON.parse(readFileSync(origFixturePath, 'utf8'));

  // Mutate CA-03: falsely promote university RAG project to EMPLOYMENT
  const mutated = JSON.parse(JSON.stringify(dataset));
  const ca03 = mutated.find((c) => c.id === 'CA-03');
  ca03.mock_extraction.experiences[0].experience_type = 'EMPLOYMENT';

  // Mutate CA-06: falsely mark in-progress B.Sc. as COMPLETED
  const ca06 = mutated.find((c) => c.id === 'CA-06');
  ca06.mock_extraction.education[0].status = 'COMPLETED';

  // Mutate CA-07: falsely mark course as is_certified: true
  const ca07 = mutated.find((c) => c.id === 'CA-07');
  ca07.mock_extraction.certifications[0].is_certified = true;

  const tmpPath = resolve(ROOT, 'evals/fixtures/.tmp-mutated-dataset.json');
  try {
    writeFileSync(tmpPath, JSON.stringify(mutated, null, 2));

    // Run without strict to capture JSON report
    const procJson = spawnSync(process.execPath, [SCRIPT, '--json', '--dataset', 'evals/fixtures/.tmp-mutated-dataset.json'], { encoding: 'utf8', cwd: ROOT });
    assert.equal(procJson.status, 0);
    const report = JSON.parse(procJson.stdout);

    // Assert that metrics actively computed the failures:
    assert.equal(report.metrics.project_to_employment_false_promotions, 1, 'must detect project to employment false promotion');
    assert.equal(report.metrics.false_education_completion_cases, 1, 'must detect false education completion');
    assert.equal(report.metrics.course_to_certification_false_promotions, 1, 'must detect course to certification false promotion');
    assert.ok(report.assertion_failures >= 3, 'must report at least 3 assertion failures');

    // Run with --strict: MUST exit 1
    const procStrict = spawnSync(process.execPath, [SCRIPT, '--strict', '--dataset', 'evals/fixtures/.tmp-mutated-dataset.json'], { encoding: 'utf8', cwd: ROOT });
    assert.equal(procStrict.status, 1, 'strict mode must exit 1 on benchmark failures');
    assert.ok(procStrict.stderr.includes('Benchmark failed'));
  } finally {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  }
});

test('P2-1 & P2-2 BENCHMARK INTEGRITY: missing expected entities and unsupported capabilities fail strict benchmark', () => {
  const origFixturePath = resolve(ROOT, 'evals/fixtures/candidate-semantic-adversarial.json');
  const dataset = JSON.parse(readFileSync(origFixturePath, 'utf8'));

  // Test 1: Inject unsupported capability
  const mutatedCap = JSON.parse(JSON.stringify(dataset));
  const ca12 = mutatedCap.find((c) => c.id === 'CA-12');
  ca12.expected.forbidden_capabilities = [{ activity: 'architected', object: 'global payment platform' }];
  ca12.mock_extraction.capabilities.push({
    activity: 'architected',
    object: 'global payment platform',
    responsibility_level: 'DESIGNED',
    environment_type: 'PRODUCTION',
    verbatim_quote: 'Maintained backend APIs for customer portal.',
    evidence_role: 'CANDIDATE_FACT'
  });

  // Test 2: Mutation A — remove expected experience entirely (empty array)
  const ca02 = mutatedCap.find((c) => c.id === 'CA-02');
  ca02.mock_extraction.experiences = []; // Zero experiences extracted when PERSONAL_PROJECT expected!

  // Test 3: Mutation B — remove expected education entirely (empty array)
  const ca05 = mutatedCap.find((c) => c.id === 'CA-05');
  ca05.mock_extraction.education = []; // Zero education extracted when COMPLETED expected!

  // Test 4: Mutation C — remove expected skill entirely
  const ca01 = mutatedCap.find((c) => c.id === 'CA-01');
  ca01.mock_extraction.skills = []; // Zero skills extracted when Python expected!

  // Test 5: Mutation D — remove expected certification entirely
  const ca08 = mutatedCap.find((c) => c.id === 'CA-08');
  ca08.mock_extraction.certifications = []; // Zero certifications extracted when is_certified expected!

  const tmpPath = resolve(ROOT, 'evals/fixtures/.tmp-mutated-integrity.json');
  try {
    writeFileSync(tmpPath, JSON.stringify(mutatedCap, null, 2));

    const procJson = spawnSync(process.execPath, [SCRIPT, '--json', '--dataset', 'evals/fixtures/.tmp-mutated-integrity.json'], { encoding: 'utf8', cwd: ROOT });
    assert.equal(procJson.status, 0);
    const report = JSON.parse(procJson.stdout);

    // Unsupported capability metric incremented!
    assert.equal(report.metrics.unsupported_capability_cases, 1, 'unsupported capability must increment metric');

    // Missing entities detected!
    const repCa02 = report.cases.find((c) => c.id === 'CA-02');
    assert.ok(repCa02.assertion_problems.some((p) => p.includes('expected experience_type "PERSONAL_PROJECT" not found')), 'must fail when experience missing');

    const repCa05 = report.cases.find((c) => c.id === 'CA-05');
    assert.ok(repCa05.assertion_problems.some((p) => p.includes('expected education status "COMPLETED" not found')), 'must fail when education missing');

    const repCa01 = report.cases.find((c) => c.id === 'CA-01');
    assert.ok(repCa01.assertion_problems.some((p) => p.includes('expected skill "Python" was not extracted')), 'must fail when skill missing');

    const repCa08 = report.cases.find((c) => c.id === 'CA-08');
    assert.ok(repCa08.assertion_problems.some((p) => p.includes('expected certification was not marked is_certified: true')), 'must fail when certification missing');

    // Strict mode MUST fail
    const procStrict = spawnSync(process.execPath, [SCRIPT, '--strict', '--dataset', 'evals/fixtures/.tmp-mutated-integrity.json'], { encoding: 'utf8', cwd: ROOT });
    assert.equal(procStrict.status, 1, 'strict mode must exit 1 on missing expected entities or unsupported capabilities');
  } finally {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  }
});
