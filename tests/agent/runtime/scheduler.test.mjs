import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { acquireRunLease, heartbeatRunLease, completeRunLease, listRunLeases } from '../../../src/agent/infrastructure/persistence/run-lease-store.mjs';
import { validateSchedulerConfig, runScheduledOnce } from '../../../src/agent/runtime/scheduler.mjs';
import { appendRunEvent, createRun, getRun } from '../../../src/agent/infrastructure/persistence/agent-run-store.mjs';

 test('scheduler lease serializes acquisitions and expires only after deadline', () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduler-'));
  try {
    const a = acquireRunLease({ dataRoot: root, schedulerId: 'x', owner: 'one', now: new Date(1000), leaseMs: 1000 });
    assert.equal(a.acquired, true);
    assert.equal(acquireRunLease({ dataRoot: root, schedulerId: 'x', owner: 'two', now: new Date(1500), leaseMs: 1000 }).acquired, false);
    assert.equal(heartbeatRunLease({ dataRoot: root, runId: a.lease.runId, now: new Date(1600), leaseMs: 2000 }), true);
    assert.equal(acquireRunLease({ dataRoot: root, schedulerId: 'x', owner: 'two', now: new Date(2000), leaseMs: 1000 }).acquired, false);
    assert.equal(completeRunLease({ dataRoot: root, runId: a.lease.runId, status: 'COMPLETED', now: new Date(2100) }), true);
    assert.equal(acquireRunLease({ dataRoot: root, schedulerId: 'x', owner: 'two', now: new Date(2200), leaseMs: 1000 }).acquired, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('config defaults disabled and run-once does not execute when disabled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduler-'));
  try {
    assert.deepEqual(validateSchedulerConfig({ enabled: false }), { enabled: false });
    let ran = false;
    assert.equal((await runScheduledOnce({ dataRoot: root, dependencies: { runSafe: () => { ran = true; } } })).status, 'SCHEDULER_DISABLED');
    assert.equal(ran, false);
    mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'data', 'scheduler-config.json'), JSON.stringify({ enabled: true, mode: 'shadow', cadenceMs: 3600000, maxRuntimeMs: 1000, maxJobs: 2 }));
    const outcome = await runScheduledOnce({ dataRoot: root, dependencies: { runSafe: async () => 'ok' }, clock: () => new Date(5000) });
    assert.equal(outcome.result, 'ok');
    assert.equal(outcome.started, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stale expired lease is archived and reclaimed only when its local owner is gone', () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduler-'));
  try {
    const first = acquireRunLease({ dataRoot: root, schedulerId: 'stale', owner: 'local:2147483647', now: new Date(10_000), leaseMs: 1000 });
    const next = acquireRunLease({ dataRoot: root, schedulerId: 'stale', owner: 'local:2147483646', now: new Date(11_000), leaseMs: 1000 });
    assert.equal(next.acquired, true);
    assert.ok(listRunLeases({ dataRoot: root }).some(lease => lease.runId === first.lease.runId && lease.status === 'EXPIRED'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lease cannot be stolen after expiry from a live process and clock rollback cannot heartbeat', () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduler-'));
  try {
    const lease = acquireRunLease({ dataRoot: root, schedulerId: 'clock', owner: `local:${process.pid}`, now: new Date(20_000), leaseMs: 1000 });
    assert.equal(acquireRunLease({ dataRoot: root, schedulerId: 'clock', owner: 'local:2147483646', now: new Date(21_000), leaseMs: 1000 }).acquired, false);
    assert.equal(heartbeatRunLease({ dataRoot: root, runId: lease.lease.runId, now: new Date(19_000), leaseMs: 1000 }), false);
    assert.equal(completeRunLease({ dataRoot: root, runId: lease.lease.runId, status: 'COMPLETED', now: new Date(20_500) }), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('two processes cannot acquire the same scheduler lease', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduler-'));
  try {
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src/agent/infrastructure/persistence/run-lease-store.mjs')).href;
    const source = `import {acquireRunLease} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(acquireRunLease({dataRoot:process.argv[1],schedulerId:'race',owner:'local:'+process.pid,now:new Date(),leaseMs:30000})));`;
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source, root], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
      child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
    });
    const results = await Promise.all([run(), run()]);
    assert.equal(results.filter(result => result.acquired).length, 1);
    assert.equal(results.filter(result => result.status === 'RUN_SKIPPED_ALREADY_ACTIVE').length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('clock rollback is clamped in terminal receipts and recorded as a warning', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduler-'));
  try {
    mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'data', 'scheduler-config.json'), JSON.stringify({ enabled: true, mode: 'shadow', cadenceMs: 3600000, maxRuntimeMs: 1000, maxJobs: 2 }));
    const times = [new Date(5000), new Date(4000)];
    const result = await runScheduledOnce({ dataRoot: root, dependencies: { runSafe: async () => 'ok' }, clock: () => times.shift() || new Date(4000) });
    assert.equal(getRun(result.runId, { dataRoot: root }).status, 'COMPLETED');
    assert.ok(getRun(result.runId, { dataRoot: root }).warnings.includes('CLOCK_ROLLBACK_CLAMPED'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('expired crashed run receipt is reconciled before a replacement run starts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduler-'));
  try {
    mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'data', 'scheduler-config.json'), JSON.stringify({ enabled: true, mode: 'shadow', cadenceMs: 3600000, maxRuntimeMs: 1000, maxJobs: 2 }));
    const stale = acquireRunLease({ dataRoot: root, schedulerId: 'default', owner: 'local:2147483647', now: new Date(1000), leaseMs: 1000 });
    createRun({ run_id: stale.lease.runId, trigger: 'scheduled', mode: 'SHADOW_SCHEDULED', timestamp: new Date(1000).toISOString(), started_at: new Date(1000).toISOString(), config_fingerprint: 'a'.repeat(64) }, { dataRoot: root });
    appendRunEvent(stale.lease.runId, 'RUNNING', { timestamp: new Date(1000).toISOString() }, { dataRoot: root });
    acquireRunLease({ dataRoot: root, schedulerId: 'default', owner: 'local:2147483646', now: new Date(2000), leaseMs: 1000 });
    const result = await runScheduledOnce({ dataRoot: root, dependencies: { runSafe: async () => 'new' }, clock: () => new Date(3000) });
    assert.equal(getRun(stale.lease.runId, { dataRoot: root }).status, 'EXPIRED');
    assert.equal(result.result, 'new');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scheduler module has no timers or unsafe execution imports', () => {
  const source = readFileSync(join(process.cwd(), 'src/agent/runtime/scheduler.mjs'), 'utf8');
  assert.doesNotMatch(source, /setInterval|setTimeout|child_process|queue-runner|controlled-fill|autonomous-langgraph/);
});
