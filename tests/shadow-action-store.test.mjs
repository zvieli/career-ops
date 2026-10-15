import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordShadowActionReceipt, listShadowActionReceipts } from '../src/agent/infrastructure/persistence/shadow-action-store.mjs';
import { withPipelineLock } from '../pipeline-lock.mjs';

async function fixture(fn) { const root = mkdtempSync(join(tmpdir(), 'shadow-actions-')); try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); } }

test('cancelled blocked-action persistence does not write after waiting for its lock', async () => fixture(async root => {
  const input = { dataRoot: root, run_id: '12345678-1234-4123-8123-123456789abc', application_id: 'app-1234567890abcdef12345678', action: 'FILL_APPLICATION' };
  const path = join(root, 'data', 'runs', 'shadow-actions.jsonl');
  mkdirSync(join(root, 'data', 'runs'), { recursive: true, mode: 0o700 });
  let release;
  const held = withPipelineLock(path, () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const controller = new AbortController();
  const pending = recordShadowActionReceipt(input, { signal: controller.signal });
  controller.abort(Object.assign(new Error('Scheduled run cancelled.'), { code: 'SHADOW_CANCELLED' }));
  release();
  await held;
  await assert.rejects(pending, error => error.code === 'SHADOW_CANCELLED');
  assert.equal(listShadowActionReceipts({ dataRoot: root }).length, 0);
}));

test('blocked action receipt is durable and idempotent by run/application/action', async () => fixture(async root => {
  const input = { dataRoot: root, run_id: '12345678-1234-4123-8123-123456789abc', application_id: 'app-1234567890abcdef12345678', action: 'FILL_APPLICATION', reason: 'BLOCKED_BY_SHADOW_MODE', created_at: '2026-01-01T00:00:00.000Z' };
  const first = await recordShadowActionReceipt(input);
  const replay = await recordShadowActionReceipt(input);
  assert.equal(first.blocked_by_shadow_mode, true);
  assert.deepEqual(replay, first);
  assert.equal(listShadowActionReceipts({ dataRoot: root }).length, 1);
  assert.equal(readFileSync(join(root, 'data', 'runs', 'shadow-actions.jsonl'), 'utf8').trim().split('\n').length, 1);
}));

test('rejects unsupported blocked action inputs and dangling symlink destination', async () => fixture(async root => {
  const base = { dataRoot: root, run_id: '12345678-1234-4123-8123-123456789abc', application_id: 'app-1234567890abcdef12345678', action: 'FILL_APPLICATION', reason: 'BLOCKED_BY_SHADOW_MODE' };
  await assert.rejects(() => recordShadowActionReceipt({ ...base, action: 'RUN_GRAPH' }), /action/);
  const path = join(root, 'data', 'runs', 'shadow-actions.jsonl');
  mkdirSync(join(root, 'data', 'runs'), { recursive: true, mode: 0o700 });
  // The store must not follow a pre-existing dangling destination symlink.
  symlinkSync(join(root, 'absent-target'), path);
  await assert.rejects(() => recordShadowActionReceipt(base), /symlink|regular file/);
  assert.throws(() => readFileSync(join(root, 'absent-target')));
}));
