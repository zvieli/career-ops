import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acknowledgeAutonomousPendingJob,
  blockAutonomousPendingJob,
  getAutonomousPendingQueueStats,
  mergeAutonomousPendingJobs,
  readAutonomousPendingJobs
} from '../../../lib/autonomous-pending-queue.mjs';

function withQueue(fn) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-pending-queue-'));
  const filePath = join(root, 'data', 'autonomous-pending.json');
  mkdirSync(join(root, 'data'), { recursive: true });
  return Promise.resolve(fn(filePath, root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

const job = (overrides = {}) => ({
  company: 'ExampleCo', title: 'Backend Engineer', url: 'https://jobs.example.test/123?utm_source=scan',
  provider: 'greenhouse-api', requisitionId: 'REQ-123', externalId: '123', verification_status: 'active', ...overrides
});

test('pending queue persists confirmed postings atomically and deduplicates normalized URLs', async () => {
  await withQueue(async (filePath, root) => {
    await mergeAutonomousPendingJobs(filePath, [job()]);
    const jobs = await mergeAutonomousPendingJobs(filePath, [job({ url: 'https://jobs.example.test/123' })]);
    assert.equal(jobs.length, 1);
    assert.equal(readAutonomousPendingJobs(filePath).length, 1);
    assert.deepEqual(getAutonomousPendingQueueStats(filePath), { pending: 1, blocked: 0 });
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
    assert.equal(readdirSync(join(root, 'data')).some((name) => name.includes('.tmp-')), false);
  });
});

test('a fresh liveness timestamp updates a duplicate without resetting its queue age', async () => {
  await withQueue(async (filePath) => {
    await mergeAutonomousPendingJobs(filePath, [job({ liveness_verified_at: '2026-10-13T10:00:00.000Z' })]);
    const first = JSON.parse(readFileSync(filePath, 'utf8')).jobs[0];
    await mergeAutonomousPendingJobs(filePath, [job({ liveness_verified_at: '2026-10-13T11:00:00.000Z' })]);
    const refreshed = JSON.parse(readFileSync(filePath, 'utf8')).jobs[0];
    assert.equal(refreshed.queued_at, first.queued_at);
    assert.equal(refreshed.liveness_verified_at, '2026-10-13T11:00:00.000Z');
  });
});

test('identity conflict refuses to overwrite a persisted pending posting', async () => {
  await withQueue(async (filePath) => {
    await mergeAutonomousPendingJobs(filePath, [job()]);
    const before = readFileSync(filePath, 'utf8');
    await assert.rejects(
      mergeAutonomousPendingJobs(filePath, [job({ company: 'OtherCo', url: 'https://jobs.example.test/123' })]),
      /identity conflict for company/
    );
    assert.equal(readFileSync(filePath, 'utf8'), before);
  });
});

test('blocked work stays durable but leaves the active queue; terminal work is acknowledged', async () => {
  await withQueue(async (filePath) => {
    const posting = job();
    await mergeAutonomousPendingJobs(filePath, [posting]);
    assert.equal(await blockAutonomousPendingJob(filePath, posting.url, 'interrupted at unsupported state'), true);
    assert.deepEqual(getAutonomousPendingQueueStats(filePath), { pending: 0, blocked: 1 });
    assert.equal(readAutonomousPendingJobs(filePath).length, 0);
    assert.equal(await acknowledgeAutonomousPendingJob(filePath, posting.url), 0);
    assert.equal(existsSync(filePath), true);
  });
});
