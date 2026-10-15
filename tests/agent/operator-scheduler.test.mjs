import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function invoke(root, ...args) {
  return JSON.parse(execFileSync(process.execPath, ['operator.mjs', ...args], {
    cwd: process.cwd(), env: { ...process.env, CAREER_OPS_ROOT: root }, encoding: 'utf8'
  }));
}

test('readiness counts duplicate stale lease archives once per run ID', () => {
  const root = mkdtempSync(join(tmpdir(), 'operator-scheduler-'));
  try {
    const directory = join(root, 'data', 'scheduler'); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lease = { schedulerId: 'default', owner: 'local:2147483647', runId: '12345678-1234-4123-8123-123456789abc', status: 'EXPIRED', startedAt: '2026-01-01T00:00:00.000Z', heartbeatAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:01:00.000Z', expiredAt: '2026-01-01T00:01:00.000Z' };
    for (const suffix of ['first', 'second']) {
      const path = join(directory, `archived-${suffix}.expired.${suffix}.json`);
      writeFileSync(path, JSON.stringify(lease), { mode: 0o600 }); chmodSync(path, 0o600);
    }
    assert.equal(invoke(root, 'system', 'readiness').stale_run_count, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('operator scheduler commands are explicit, local-only, and expose factual readiness', () => {
  const root = mkdtempSync(join(tmpdir(), 'operator-scheduler-'));
  try {
    assert.equal(invoke(root, 'scheduler', 'status').config.enabled, false);
    const enabled = invoke(root, 'scheduler', 'enable');
    assert.equal(enabled.status, 'ENABLED_CONFIG_ONLY');
    assert.equal(enabled.scheduler_started, false);
    const run = invoke(root, 'scheduler', 'run-once');
    assert.equal(run.result.status, 'DEGRADED');
    assert.equal(run.result.work_performed, false);
    const storedRun = invoke(root, 'runs', 'show', run.runId);
    assert.equal(storedRun.status, 'COMPLETED');
    assert.equal(storedRun.outcome, 'DEGRADED');
    const readiness = invoke(root, 'system', 'readiness');
    assert.equal(readiness.submission_capability, false);
    assert.equal(readiness.live_fill_supported, false);
    assert.equal(readiness.production_readiness, false);
    assert.equal(readiness.employer_contact, false);
    assert.equal(readiness.detailed_metrics_status, 'INTEGRATED');
    assert.equal(readiness.rate_limit_count, 0);
    assert.equal(readiness.capacity_skipped_rediscoverable, 0);
    assert.equal(readiness.provider_sources_skipped_budget, 0);
    assert.equal(readiness.durable_deferred_queue, false);
    assert.equal(readiness.latest_run_outcome, 'DEGRADED');
    assert.equal(readiness.last_n_runs_success_rate, 0);
    assert.equal(readiness.run_stage_timings.total_run_ms >= 0, true);
    assert.equal(invoke(root, 'scheduler', 'disable').status, 'DISABLED');
    assert.equal(invoke(root, 'scheduler', 'status').config.enabled, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
