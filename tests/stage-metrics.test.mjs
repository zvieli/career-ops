import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRun, getRun, appendRunEvent } from '../src/agent/infrastructure/persistence/agent-run-store.mjs';
import { createStageRecorder, SHADOW_STAGES } from '../src/agent/infrastructure/persistence/stage-metrics.mjs';

const base = { run_id: 'run-metrics-1', trigger: 'scheduler', mode: 'SHADOW_SCHEDULED', timestamp: '2026-01-01T00:00:00.000Z', started_at: '2026-01-01T00:00:00.000Z', config_fingerprint: 'a'.repeat(64) };
function fixture(fn) { const root = mkdtempSync(join(tmpdir(), 'stage-metrics-')); try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); } }

test('stage contract names local review reconciliation without implying graph interrupt recovery', () => {
  assert.ok(SHADOW_STAGES.includes('LOCAL_REVIEW_RECONCILIATION'));
  assert.equal(SHADOW_STAGES.includes('SAFE_RECONCILIATION'), false);
});

test('appends truthful stage receipts and aggregate metrics while preserving old run records', () => fixture(root => {
  const filePath = join(root, 'data', 'runs', 'agent-runs.jsonl');
  createRun({ ...base, run_id: 'run-old' }, { dataRoot: root });
  appendRunEvent('run-old', 'RUNNING', { timestamp: base.timestamp }, { dataRoot: root });
  createRun(base, { dataRoot: root });
  appendRunEvent(base.run_id, 'RUNNING', { timestamp: base.timestamp }, { dataRoot: root });
  const recorder = createStageRecorder({ runId: base.run_id, dataRoot: root, filePath, clock: () => new Date('2026-01-01T00:00:02.000Z') });
  recorder.record({ stage: 'DISCOVERY', outcome: 'COMPLETED', counters: { jobs_discovered_raw: 3, provider_attempts: 1 }, timings: { discovery_ms: 250 } });
  recorder.record({ stage: 'HYDRATION', outcome: 'DEFERRED', counters: { jobs_hydrated: 1, capacity_skipped_rediscoverable: 2 }, warnings: ['BUDGET_EXHAUSTED'] });
  const run = getRun(base.run_id, { dataRoot: root, filePath });
  assert.deepEqual(run.stages, ['DISCOVERY', 'HYDRATION']);
  assert.deepEqual(run.counters, { jobs_discovered_raw: 3, provider_attempts: 1, jobs_hydrated: 1, capacity_skipped_rediscoverable: 2 });
  assert.deepEqual(run.stage_receipts.map(row => row.outcome), ['COMPLETED', 'DEFERRED']);
  assert.equal(run.timings.discovery_ms, 250);
  assert.equal(run.timings.hydration_ms, undefined);
  const old = getRun('run-old', { dataRoot: root, filePath });
  assert.deepEqual(old.stages, []);
  assert.deepEqual(old.counters, {});
  assert.equal(old.stage_receipts, undefined);
}));

test('omitted stages have no fabricated counters, failed stages retain measured work', () => fixture(root => {
  const filePath = join(root, 'data', 'runs', 'agent-runs.jsonl');
  createRun(base, { dataRoot: root }); appendRunEvent(base.run_id, 'RUNNING', { timestamp: base.timestamp }, { dataRoot: root });
  const recorder = createStageRecorder({ runId: base.run_id, dataRoot: root, filePath });
  recorder.record({ stage: 'DISCOVERY', outcome: 'FAILED', counters: { provider_failures: 1 }, timings: { discovery_ms: 17 } });
  const run = getRun(base.run_id, { dataRoot: root, filePath });
  assert.deepEqual(run.stages, ['DISCOVERY']);
  assert.equal(run.counters.provider_failures, 1);
  assert.equal(run.counters.jobs_hydrated, undefined);
  assert.equal(run.timings.hydration_ms, undefined);
  assert.equal(run.stage_receipts[0].outcome, 'FAILED');
}));

test('rejects unknown stages, counter injection, negative metrics, and unbounded receipts', () => fixture(root => {
  const filePath = join(root, 'data', 'runs', 'agent-runs.jsonl');
  createRun(base, { dataRoot: root }); appendRunEvent(base.run_id, 'RUNNING', { timestamp: base.timestamp }, { dataRoot: root });
  const recorder = createStageRecorder({ runId: base.run_id, dataRoot: root, filePath });
  assert.throws(() => recorder.record({ stage: 'CUSTOM', outcome: 'COMPLETED' }), /Unknown stage/);
  assert.throws(() => recorder.record({ stage: 'DISCOVERY', outcome: 'COMPLETED', counters: { secret: 1 } }), /Unknown metric/);
  assert.throws(() => recorder.record({ stage: 'DISCOVERY', outcome: 'COMPLETED', counters: { jobs_discovered_raw: -1 } }), /non-negative/);
}));
