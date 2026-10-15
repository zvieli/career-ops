import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRunEvent, createRun, getRun, listRuns, summarizeRuns } from '../src/agent/infrastructure/persistence/agent-run-store.mjs';

function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runs-'));
  const filePath = join(dir, 'data', 'runs', 'agent-runs.jsonl');
  try { fn({ dir, filePath }); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const base = { run_id: 'run-1', trigger: 'manual', mode: 'scan', timestamp: '2026-01-01T00:00:00.000Z', started_at: '2026-01-01T00:00:00.000Z', config_fingerprint: 'a'.repeat(64) };

test('creates append-only lifecycle records and read models expose latest receipt', () => fixture(({ filePath }) => {
  createRun(base, { filePath });
  appendRunEvent('run-1', 'RUNNING', { counters: { fetched: 4 }, stages: ['fetch'] }, { filePath });
  appendRunEvent('run-1', 'COMPLETED', { counters: { fetched: 4, evaluated: 2 }, warnings: ['partial'] }, { filePath });
  const lines = readFileSync(filePath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(statSync(filePath).mode & 0o777, 0o600);
  assert.equal(getRun('run-1', { filePath }).status, 'COMPLETED');
  assert.equal(listRuns({ filePath }).length, 1);
  assert.deepEqual(summarizeRuns({ filePath }), { total: 1, statuses: { CREATED: 0, RUNNING: 0, COMPLETED: 1, FAILED: 0, CANCELLED: 0, EXPIRED: 0 }, counters: { fetched: 4, evaluated: 2 } });
}));

test('rejects duplicate runs and idempotently replays event IDs', () => fixture(({ filePath }) => {
  createRun(base, { filePath });
  assert.throws(() => createRun(base, { filePath }), /already exists/);
  const first = appendRunEvent('run-1', 'RUNNING', { event_id: 'evt-1', timestamp: base.timestamp }, { filePath });
  const replay = appendRunEvent('run-1', 'RUNNING', { event_id: 'evt-1', timestamp: base.timestamp }, { filePath });
  assert.deepEqual(replay, first);
  assert.throws(() => appendRunEvent('run-1', 'FAILED', { event_id: 'evt-1' }, { filePath }), /Conflicting duplicate/);
  assert.equal(readFileSync(filePath, 'utf8').trim().split('\n').length, 2);
}));

test('validates bounded counters and lifecycle events', () => fixture(({ filePath }) => {
  assert.throws(() => createRun({ ...base, counters: { bad: Infinity } }, { filePath }), /Invalid counters/);
  createRun(base, { filePath });
  assert.throws(() => appendRunEvent('run-1', 'NOT_A_STATUS', {}, { filePath }), /Invalid lifecycle event/);
}));

test('corrupt or incomplete JSONL fails closed without rewriting', () => fixture(({ filePath }) => {
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, '{bad}\n'); chmodSync(filePath, 0o600);
  assert.throws(() => listRuns({ filePath }), /line 1 is malformed/);
  writeFileSync(filePath, '{"run_id":"truncated"}'); chmodSync(filePath, 0o600);
  assert.throws(() => listRuns({ filePath }), /incomplete trailing record/);
}));

test('rejects dangling ledger symlinks and symlinked ledger directories without writing through them', () => fixture(({ filePath, dir }) => {
  mkdirSync(join(filePath, '..'), { recursive: true }); chmodSync(join(filePath, '..'), 0o700);
  const external = join(dir, 'external-target');
  symlinkSync(external, filePath);
  assert.throws(() => createRun(base, { filePath }), /private regular file|regular file/);
  assert.equal(statSync(dir).isDirectory(), true);
  assert.throws(() => statSync(external));
  rmSync(filePath);
  rmSync(join(dir, 'data', 'runs'), { recursive: true });
  symlinkSync(dir, join(dir, 'data', 'runs'), 'dir');
  assert.throws(() => createRun(base, { filePath }), /directory must be private and not a symlink/);
}));

test('creates private ledger directory', () => fixture(({ filePath, dir }) => {
  createRun(base, { filePath });
  assert.equal(statSync(join(dir, 'data', 'runs')).mode & 0o777, 0o700);
}));
