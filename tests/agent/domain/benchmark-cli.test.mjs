// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';

const SCRIPT_PATH = resolve(process.cwd(), 'scripts/eval-semantic-benchmark.mjs');

test('CLI --help prints usage and exits 0', () => {
  const proc = spawnSync(process.execPath, [SCRIPT_PATH, '--help'], { encoding: 'utf8' });
  assert.equal(proc.status, 0);
  assert.ok(proc.stdout.includes('Usage:'));
  assert.ok(proc.stdout.includes('--engine'));
});

test('CLI --engine legacy executes offline benchmark and exits 0', () => {
  const proc = spawnSync(
    process.execPath,
    [SCRIPT_PATH, '--engine', 'legacy', '--limit', '3'],
    { encoding: 'utf8' }
  );
  assert.equal(proc.status, 0, `Process failed: ${proc.stderr}`);
  assert.ok(proc.stdout.includes('SAMPLE EXECUTION SUMMARY'));
  assert.ok(proc.stdout.includes('AGGREGATE EVALUATION METRICS'));
  assert.ok(proc.stdout.includes('ANNOTATION INTEGRITY REPORT'));
});

test('CLI --engine semantic executes with mock response offline and exits 0', () => {
  const mockPath = resolve(process.cwd(), 'evals/fixtures/mock-profiler-response.json');
  const proc = spawnSync(
    process.execPath,
    [SCRIPT_PATH, '--engine', 'semantic', '--limit', '2', '--mock-response', mockPath],
    { encoding: 'utf8' }
  );
  assert.equal(proc.status, 0, `Process failed: ${proc.stderr}`);
  assert.ok(proc.stdout.includes('SAMPLE EXECUTION SUMMARY'));
  assert.ok(proc.stdout.includes('AGGREGATE EVALUATION METRICS'));
});

test('CLI --compare executes head-to-head comparison and prints comparison matrix', () => {
  const mockPath = resolve(process.cwd(), 'evals/fixtures/mock-profiler-response.json');
  const proc = spawnSync(
    process.execPath,
    [SCRIPT_PATH, '--compare', '--limit', '2', '--mock-response', mockPath],
    { encoding: 'utf8' }
  );
  assert.equal(proc.status, 0, `Process failed: ${proc.stderr}`);
  assert.ok(proc.stdout.includes('HEAD-TO-HEAD BENCHMARK COMPARISON'));
  assert.ok(proc.stdout.includes('PROVISIONAL BENCHMARK NOTICE'));
});

test('CLI --strict --output generates machine-readable JSON report', () => {
  const tmpReport = resolve(process.cwd(), 'evals/fixtures/test-tmp-report.json');
  try {
    const proc = spawnSync(
      process.execPath,
      [SCRIPT_PATH, '--engine', 'legacy', '--limit', '2', '--strict', '--output', tmpReport],
      { encoding: 'utf8' }
    );
    assert.equal(proc.status, 0, `Process failed: ${proc.stderr}`);
    assert.equal(existsSync(tmpReport), true);

    const report = JSON.parse(readFileSync(tmpReport, 'utf8'));
    assert.equal(report.engine, 'legacy');
    assert.ok(report.metrics);
    assert.equal(report.predictions.length, 2);
  } finally {
    if (existsSync(tmpReport)) {
      unlinkSync(tmpReport);
    }
  }
});
