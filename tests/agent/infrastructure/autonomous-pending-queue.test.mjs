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

test('duplicate observations merge provenance idempotently without resetting queue identity or age', async () => {
  await withQueue(async (filePath) => {
    await mergeAutonomousPendingJobs(filePath, [job({
      url: 'https://boards.greenhouse.io/example/jobs/123',
      provider: 'geektime-insider-api', externalId: 'GT-1', discovered_via: 'geektime-insider',
      authoritative_provider: 'greenhouse', queued_at: '2026-01-01T00:00:00.000Z',
      provider_ids: [{ provider: 'geektime-insider', id: 'GT-1' }],
      source_urls: ['https://insider.geektime.co.il/job/1', 'https://boards.greenhouse.io/example/jobs/123']
    })]);
    const first = JSON.parse(readFileSync(filePath, 'utf8')).jobs[0];
    const observation = job({
      url: 'https://boards.greenhouse.io/example/jobs/123',
      provider: 'greenhouse-api', externalId: 'GH-123', discovered_via: ['geektime-insider', 'greenhouse-api'],
      authoritative_provider: 'greenhouse',
      source_urls: ['https://insider.geektime.co.il/job/1', 'https://boards.greenhouse.io/example/jobs/123'],
      provider_ids: [{ provider: 'geektime-insider', id: 'GT-1' }, { provider: 'greenhouse', id: '123' }],
      liveness_verified_at: '2026-01-01T00:00:00.000Z'
    });
    await mergeAutonomousPendingJobs(filePath, [observation]);
    await mergeAutonomousPendingJobs(filePath, [observation]);
    const merged = JSON.parse(readFileSync(filePath, 'utf8')).jobs[0];
    assert.equal(merged.queued_at, first.queued_at);
    assert.equal(merged.queue_key, first.queue_key);
    assert.deepEqual(merged.discovered_via, ['geektime-insider', 'greenhouse-api']);
    assert.equal(merged.authoritative_provider, 'greenhouse');
    assert.deepEqual(merged.source_urls, ['https://insider.geektime.co.il/job/1', 'https://boards.greenhouse.io/example/jobs/123']);
    assert.deepEqual(merged.provider_ids, observation.provider_ids);
    assert.equal(merged.queue_status, 'pending');
  });
});

test('provider-scoped ID conflict remains a hard conflict within one discovery namespace', async () => {
  await withQueue(async (filePath) => {
    const canonical = 'https://boards.greenhouse.io/example/jobs/123';
    await mergeAutonomousPendingJobs(filePath, [job({ url: canonical, authoritative_provider: 'greenhouse', externalId: '123' })]);
    const before = readFileSync(filePath, 'utf8');
    await assert.rejects(
      mergeAutonomousPendingJobs(filePath, [job({ url: canonical, authoritative_provider: 'greenhouse', externalId: '456' })]),
      /identity conflict for externalId/
    );
    assert.equal(readFileSync(filePath, 'utf8'), before);
  });
});

test('same-provider ID conflict is detected after an intervening cross-provider merge', async () => {
  await withQueue(async (filePath) => {
    const canonical = 'https://boards.greenhouse.io/example/jobs/123';
    await mergeAutonomousPendingJobs(filePath, [job({
      url: canonical, provider: 'geektime-insider-api', externalId: 'GT-1', authoritative_provider: 'greenhouse',
      provider_ids: [{ provider: 'geektime-insider', id: 'GT-1' }]
    })]);
    await mergeAutonomousPendingJobs(filePath, [job({
      url: canonical, provider: 'greenhouse-api', externalId: 'GH-123', authoritative_provider: 'greenhouse',
      provider_ids: [{ provider: 'greenhouse', id: '123' }]
    })]);
    const before = readFileSync(filePath, 'utf8');
    await assert.rejects(mergeAutonomousPendingJobs(filePath, [job({
      url: canonical, provider: 'greenhouse-api', externalId: 'GH-456', authoritative_provider: 'greenhouse',
      provider_ids: [{ provider: 'greenhouse', id: '456' }]
    })]), /identity conflict for externalId/);
    assert.equal(readFileSync(filePath, 'utf8'), before);
  });
});

test('liveness-only aggregator URLs cannot authorize cross-provider identity merging', async () => {
  await withQueue(async (filePath) => {
    for (const canonical of [
      'https://www.linkedin.com/jobs/view/123456/',
      'https://weworkremotely.com/remote-jobs/example-role'
    ]) {
      const claimedAuthority = canonical.includes('linkedin.com') ? 'linkedin' : 'weworkremotely';
      await mergeAutonomousPendingJobs(filePath, [job({
        url: canonical, provider: 'source-one', externalId: 'source-one-id', authoritative_provider: claimedAuthority,
        provider_ids: [{ provider: 'source-one', id: 'source-one-id' }]
      })]);
      assert.equal(JSON.parse(readFileSync(filePath, 'utf8')).jobs.at(-1).authoritative_provider, '', `${canonical} is liveness-only, not authoritative ATS evidence`);
      const before = readFileSync(filePath, 'utf8');
      await assert.rejects(mergeAutonomousPendingJobs(filePath, [job({
        url: canonical, provider: 'source-two', externalId: 'source-two-id', authoritative_provider: claimedAuthority,
        provider_ids: [{ provider: 'source-two', id: 'source-two-id' }]
      })]), /identity conflict for provider/);
      assert.equal(readFileSync(filePath, 'utf8'), before);
    }
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
    await assert.rejects(
      mergeAutonomousPendingJobs(filePath, [job({ provider: 'other-provider', externalId: 'other', authoritative_provider: 'greenhouse' })]),
      /identity conflict for provider/
    );
    assert.equal(readFileSync(filePath, 'utf8'), before, 'unverified authority claims cannot bypass the source identity guard');
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
