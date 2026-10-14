// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recordRun, readReceipt, listReceipts, getSummary, redactObject } from '../lib/run-reporter.mjs';

function withTempDataRoot(fn) {
  const tempDir = mkdtempSync(join(tmpdir(), 'career-ops-reporter-test-'));
  const origRoot = process.env.CAREER_OPS_ROOT;
  process.env.CAREER_OPS_ROOT = tempDir;
  try {
    fn(tempDir);
  } finally {
    if (origRoot !== undefined) process.env.CAREER_OPS_ROOT = origRoot;
    else delete process.env.CAREER_OPS_ROOT;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

test('redactObject masks sensitive PII and bearer tokens', () => {
  const sample = {
    email: 'candidate@example.com',
    auth: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token',
    public_id: 'job-123'
  };
  const redacted = redactObject(sample);
  assert.equal(redacted.email, '[redacted]');
  assert.equal(redacted.public_id, 'job-123');
  assert.match(redacted.auth, /\[redacted\]/);
});

test('recordRun honors explicit dataRoot independently of the process root', () => {
  const processRoot = mkdtempSync(join(tmpdir(), 'career-ops-reporter-process-root-'));
  const explicitRoot = mkdtempSync(join(tmpdir(), 'career-ops-reporter-explicit-root-'));
  const previousRoot = process.env.CAREER_OPS_ROOT;
  process.env.CAREER_OPS_ROOT = processRoot;
  try {
    recordRun({ run_id: 'explicit-root-run', dataRoot: explicitRoot, jobs_fetched: 1 });
    assert.equal(existsSync(join(explicitRoot, 'data', 'runs', 'explicit-root-run.json')), true);
    assert.equal(existsSync(join(processRoot, 'data', 'runs', 'explicit-root-run.json')), false);
  } finally {
    if (previousRoot === undefined) delete process.env.CAREER_OPS_ROOT; else process.env.CAREER_OPS_ROOT = previousRoot;
    rmSync(processRoot, { recursive: true, force: true });
    rmSync(explicitRoot, { recursive: true, force: true });
  }
});

test('recordRun and readReceipt persist and retrieve valid receipt', () => {
  withTempDataRoot(() => {
    const runData = {
      run_id: 'test-run-001',
      started_at: '2026-10-13T08:30:00.000Z',
      finished_at: '2026-10-13T08:33:00.000Z',
      jobs_fetched: 150,
      new_jobs: 12,
      shortlisted: 3,
      quota_observable: false,
      quota_known: false,
      quota_remaining: 'UNKNOWN',
      quota_status: 'UNKNOWN',
      provider_call_status: 'SUCCESS',
      provider_usable: 'YES',
      provider_availability_overrides: [{ provider: 'antigravity', unavailable_until: '2026-10-21T06:14:32.000Z', reason: 'quota_exhausted', source: 'user_confirmed', status: 'active' }],
      models_used: [{ application_id: 'app-safe', tier: 'system1', model_id: 'antigravity/gemini-3.8-flash', cost_status: 'VERIFIED_ZERO_COST', exact_inventory_match: true, incremental_cost: 0, quota_remaining: 'UNKNOWN' }],
      pending_jobs_before: 20,
      pending_jobs_after: 10,
      pending_jobs_processed: 10,
      blocked_jobs: 1,
      errors: []
    };

    const savedRunId = recordRun(runData);
    assert.equal(savedRunId, 'test-run-001');

    const read = readReceipt('test-run-001');
    assert.ok(read);
    assert.equal(read.jobs_fetched, 150);
    assert.equal(read.shortlisted, 3);
    assert.equal(read.quota_observable, false);
    assert.equal(read.quota_known, false);
    assert.equal(read.quota_remaining, 'UNKNOWN');
    assert.equal(read.quota_status, 'UNKNOWN');
    assert.equal(read.provider_call_status, 'SUCCESS');
    assert.equal(read.provider_usable, 'YES');
    assert.deepEqual(read.provider_availability_overrides, runData.provider_availability_overrides);
    assert.deepEqual(read.models_used[0], runData.models_used[0]);
    assert.equal(read.pending_jobs_before, 20);
    assert.equal(read.pending_jobs_after, 10);
    assert.equal(read.pending_jobs_processed, 10);
    assert.equal(read.blocked_jobs, 1);

    const receipts = listReceipts();
    assert.ok(receipts.some(r => r.run_id === 'test-run-001'));

    const summary = getSummary('test-run-001');
    assert.match(summary, /Run ID: test-run-001/);
    assert.match(summary, /Jobs fetched: 150/);
  });
});
