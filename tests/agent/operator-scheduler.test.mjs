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
    assert.equal(run.result.status, 'SHADOW_KERNEL_ONLY');
    assert.equal(run.result.external_actions, 0);
    assert.equal(invoke(root, 'runs', 'show', run.runId).status, 'COMPLETED');
    const readiness = invoke(root, 'system', 'readiness');
    assert.equal(readiness.submission_capability, false);
    assert.equal(readiness.live_fill_supported, false);
    assert.equal(readiness.production_readiness, false);
    assert.equal(readiness.detailed_metrics_status, 'NOT_INTEGRATED');
    assert.equal(invoke(root, 'scheduler', 'disable').status, 'DISABLED');
    assert.equal(invoke(root, 'scheduler', 'status').config.enabled, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
