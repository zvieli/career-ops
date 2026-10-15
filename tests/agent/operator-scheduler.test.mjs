import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function invoke(root, ...args) {
  return JSON.parse(execFileSync(process.execPath, ['operator.mjs', ...args], {
    cwd: process.cwd(), env: { ...process.env, CAREER_OPS_ROOT: root }, encoding: 'utf8'
  }));
}

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
