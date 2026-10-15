import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustedShadowExecutorForTest } from '../../../src/agent/runtime/testing/shadow-executor-test-seam.mjs';
import { runScheduledOnceWithExecutorForTest } from '../../../src/agent/runtime/testing/scheduler-test-seam.mjs';
import { runScheduledOnce } from '../../../src/agent/runtime/scheduler.mjs';
import { HumanReviewTaskStore } from '../../../src/agent/infrastructure/persistence/human-review-task-store.mjs';
import { listShadowActionReceipts } from '../../../src/agent/infrastructure/persistence/shadow-action-store.mjs';
import { readExistingState } from '../../../src/agent/domain/applications/application-state-machine.mjs';
import { getRun } from '../../../src/agent/infrastructure/persistence/agent-run-store.mjs';

const portalYaml = `tracked_companies:\n  - name: Fixture Co\n    enabled: true\n    provider: greenhouse\n    careers_url: https://job-boards.greenhouse.io/fixture\njob_boards: []\n`;

function fixtureJob(url) {
  return {
    title: 'Data Engineer', company: 'Fixture Co', provider: 'greenhouse', externalId: 'fixture-posting-1',
    listingIdentity: { ats_provider: 'greenhouse', board_slug: 'fixture', posting_id: 'fixture-posting-1' },
    url, location: 'Remote', description: 'Build reliable data pipelines and maintain production data systems. '.repeat(8)
  };
}

test('unsupported configured filters fail closed before any fixture provider call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduled-shadow-filter-'));
  const priorRoot = process.env.CAREER_OPS_PORTALS;
  let fetches = 0;
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'scheduler-config.json'), JSON.stringify({ enabled: true, mode: 'shadow', cadenceMs: 3600000, maxRuntimeMs: 10_000, maxJobs: 2 }));
    writeFileSync(join(root, 'portals.yml'), `${portalYaml}content_filter:\n  positive: [pipeline]\n`);
    process.env.CAREER_OPS_PORTALS = join(root, 'portals.yml');
    const provider = { id: 'greenhouse', detect: () => true, fetch: async () => { fetches++; return []; } };
    const executor = createTrustedShadowExecutorForTest({ dataRoot: root, providers: { greenhouse: provider }, livenessCheck: async () => ({ result: 'active' }) });
    await assert.rejects(runScheduledOnceWithExecutorForTest({ dataRoot: root, executor }), /cannot safely apply configured policies/);
    assert.equal(fetches, 0);
  } finally {
    if (priorRoot === undefined) delete process.env.CAREER_OPS_PORTALS; else process.env.CAREER_OPS_PORTALS = priorRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test('relative profile overrides resolve from code root, not the scheduler working directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduled-shadow-profile-'));
  const previous = { cwd: process.cwd(), portals: process.env.CAREER_OPS_PORTALS, profile: process.env.CAREER_OPS_PROFILE };
  let fetches = 0;
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'scheduler-config.json'), JSON.stringify({ enabled: true, mode: 'shadow', cadenceMs: 3600000, maxRuntimeMs: 10_000, maxJobs: 2 }));
    writeFileSync(join(root, 'portals.yml'), portalYaml);
    process.env.CAREER_OPS_PORTALS = join(root, 'portals.yml');
    process.env.CAREER_OPS_PROFILE = 'tests/fixtures/scheduler-profile-cooldown.yml';
    process.chdir(root);
    const provider = { id: 'greenhouse', detect: () => true, fetch: async () => { fetches++; return []; } };
    const executor = createTrustedShadowExecutorForTest({ dataRoot: root, providers: { greenhouse: provider }, livenessCheck: async () => ({ result: 'active' }) });
    await assert.rejects(runScheduledOnceWithExecutorForTest({ dataRoot: root, executor }), /profile re_apply_windows/);
    assert.equal(fetches, 0);
  } finally {
    process.chdir(previous.cwd);
    if (previous.portals === undefined) delete process.env.CAREER_OPS_PORTALS; else process.env.CAREER_OPS_PORTALS = previous.portals;
    if (previous.profile === undefined) delete process.env.CAREER_OPS_PROFILE; else process.env.CAREER_OPS_PROFILE = previous.profile;
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider request and operation counters have distinct, exact persisted meanings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduled-shadow-http-counters-'));
  const priorRoot = process.env.CAREER_OPS_PORTALS;
  const priorFetch = globalThis.fetch;
  let requests = 0;
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'scheduler-config.json'), JSON.stringify({ enabled: true, mode: 'shadow', cadenceMs: 3600000, maxRuntimeMs: 10_000, maxJobs: 1 }));
    writeFileSync(join(root, 'portals.yml'), portalYaml);
    process.env.CAREER_OPS_PORTALS = join(root, 'portals.yml');
    globalThis.fetch = async () => { requests++; return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }); };
    const job = fixtureJob('https://job-boards.greenhouse.io/fixture/jobs/http-counter');
    job.externalId = 'http-counter'; job.listingIdentity.posting_id = 'http-counter';
    const provider = { id: 'greenhouse', detect: () => true, fetch: async (_entry, ctx) => {
      await ctx.fetchJson('https://boards-api.greenhouse.io/v1/boards/fixture/jobs');
      await ctx.fetchJson('https://boards-api.greenhouse.io/v1/boards/fixture/offices');
      return [job];
    } };
    const executor = createTrustedShadowExecutorForTest({ dataRoot: root, maxJobs: 1, providers: { greenhouse: provider }, livenessCheck: async () => ({ result: 'active' }) });
    const result = await runScheduledOnceWithExecutorForTest({ dataRoot: root, executor });
    const stored = getRun(result.runId, { dataRoot: root });
    assert.equal(requests, 2);
    assert.equal(result.result.counters.provider_attempts, 2, 'provider_attempts counts actual HTTP requests');
    assert.equal(result.result.counters.provider_operations, 1, 'provider_operations counts the bounded fetch operation');
    assert.equal(result.result.counters.provider_failures, 0);
    assert.equal(stored.counters.provider_attempts, 2);
    assert.equal(stored.counters.provider_operations, 1);
  } finally {
    globalThis.fetch = priorFetch;
    if (priorRoot === undefined) delete process.env.CAREER_OPS_PORTALS; else process.env.CAREER_OPS_PORTALS = priorRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider request exhaustion does not prevent admission of already-discovered jobs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduled-shadow-twenty-boards-'));
  const priorRoot = process.env.CAREER_OPS_PORTALS;
  const priorFetch = globalThis.fetch;
  let requests = 0;
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'scheduler-config.json'), JSON.stringify({ enabled: true, mode: 'shadow', cadenceMs: 3600000, maxRuntimeMs: 20_000, maxJobs: 20 }));
    const entries = Array.from({ length: 20 }, (_, index) => `  - name: Fixture ${index}\n    enabled: true\n    provider: greenhouse\n    careers_url: https://job-boards.greenhouse.io/fixture-${index}`).join('\n');
    writeFileSync(join(root, 'portals.yml'), `tracked_companies:\n${entries}\njob_boards: []\n`);
    process.env.CAREER_OPS_PORTALS = join(root, 'portals.yml');
    globalThis.fetch = async () => { requests++; return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }); };
    const provider = { id: 'greenhouse', detect: () => true, fetch: async (entry, ctx) => {
      const index = Number(entry.name.slice('Fixture '.length));
      const job = fixtureJob(`https://job-boards.greenhouse.io/fixture-${index}/jobs/${index + 1}`);
      job.company = entry.name; job.externalId = `posting-${index}`; job.listingIdentity = { ats_provider: 'greenhouse', board_slug: `fixture-${index}`, posting_id: `posting-${index}` };
      await ctx.fetchJson('https://boards-api.greenhouse.io/v1/boards/fixture/jobs');
      return [job];
    } };
    const executor = createTrustedShadowExecutorForTest({ dataRoot: root, maxJobs: 20, providers: { greenhouse: provider }, livenessCheck: async () => ({ result: 'active' }) });
    const result = await runScheduledOnceWithExecutorForTest({ dataRoot: root, executor });
    assert.equal(requests, 20);
    assert.equal(result.result.counters.jobs_unique, 20);
    assert.equal(result.result.counters.reviews_created, 20);
    assert.equal(result.result.counters.liveness_checks_skipped_budget, 20);
    assert.equal(result.result.status, 'DEGRADED');
    assert.equal(getRun(result.runId, { dataRoot: root }).outcome, 'DEGRADED');
  } finally {
    globalThis.fetch = priorFetch;
    if (priorRoot === undefined) delete process.env.CAREER_OPS_PORTALS; else process.env.CAREER_OPS_PORTALS = priorRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test('liveness operation failures persist a degraded outcome while preserving review candidates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduled-shadow-liveness-failure-'));
  const priorRoot = process.env.CAREER_OPS_PORTALS;
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'scheduler-config.json'), JSON.stringify({ enabled: true, mode: 'shadow', cadenceMs: 3600000, maxRuntimeMs: 10_000, maxJobs: 1 }));
    writeFileSync(join(root, 'portals.yml'), portalYaml);
    process.env.CAREER_OPS_PORTALS = join(root, 'portals.yml');
    const job = fixtureJob('https://job-boards.greenhouse.io/fixture/jobs/987654');
    job.externalId = 'liveness-failure'; job.listingIdentity.posting_id = 'liveness-failure';
    const provider = { id: 'greenhouse', detect: () => true, fetch: async () => [job] };
    const executor = createTrustedShadowExecutorForTest({ dataRoot: root, maxJobs: 1, providers: { greenhouse: provider }, livenessCheck: async () => { throw { status: 400 }; } });
    const result = await runScheduledOnceWithExecutorForTest({ dataRoot: root, executor });
    const stored = getRun(result.runId, { dataRoot: root });
    assert.equal(result.result.counters.reviews_created, 1);
    assert.equal(result.result.status, 'DEGRADED');
    assert.equal(stored.status, 'COMPLETED');
    assert.equal(stored.outcome, 'DEGRADED');
    assert.ok(stored.warnings.some(warning => warning.startsWith('LIVENESS_CHECK_FAILED:')));
  } finally {
    if (priorRoot === undefined) delete process.env.CAREER_OPS_PORTALS; else process.env.CAREER_OPS_PORTALS = priorRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test('terminal counters preserve source-budget skips and readiness reports them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduled-shadow-source-budget-'));
  const priorRoot = process.env.CAREER_OPS_PORTALS;
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'scheduler-config.json'), JSON.stringify({ enabled: true, mode: 'shadow', cadenceMs: 3600000, maxRuntimeMs: 20_000, maxJobs: 20 }));
    const entries = Array.from({ length: 21 }, (_, index) => `  - name: Source ${index}\n    enabled: true\n    provider: greenhouse\n    careers_url: https://job-boards.greenhouse.io/source-${index}`).join('\n');
    writeFileSync(join(root, 'portals.yml'), `tracked_companies:\n${entries}\njob_boards: []\n`);
    process.env.CAREER_OPS_PORTALS = join(root, 'portals.yml');
    const provider = { id: 'greenhouse', detect: () => true, fetch: async entry => {
      const index = Number(entry.name.slice('Source '.length));
      const job = fixtureJob(`https://job-boards.greenhouse.io/source-${index}/jobs/${index + 1}`);
      job.company = entry.name; job.externalId = `source-${index}`; job.listingIdentity = { ats_provider: 'greenhouse', board_slug: `source-${index}`, posting_id: `source-${index}` };
      return [job];
    } };
    const executor = createTrustedShadowExecutorForTest({ dataRoot: root, maxJobs: 20, providers: { greenhouse: provider }, livenessCheck: async () => ({ result: 'active' }) });
    const result = await runScheduledOnceWithExecutorForTest({ dataRoot: root, executor });
    const stored = getRun(result.runId, { dataRoot: root });
    assert.equal(result.result.counters.provider_sources_skipped_budget, 1);
    assert.equal(result.result.metricsFinal.counters.provider_sources_skipped_budget, 1);
    assert.equal(stored.counters.provider_sources_skipped_budget, 1);
    assert.equal(stored.stage_receipts.find(receipt => receipt.stage === 'DISCOVERY').counters.provider_sources_skipped_budget, 1);
    const readiness = JSON.parse(execFileSync(process.execPath, ['operator.mjs', 'system', 'readiness'], {
      cwd: process.cwd(), env: { ...process.env, CAREER_OPS_ROOT: root }, encoding: 'utf8'
    }));
    assert.equal(readiness.provider_sources_skipped_budget, 1);
  } finally {
    if (priorRoot === undefined) delete process.env.CAREER_OPS_PORTALS; else process.env.CAREER_OPS_PORTALS = priorRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test('oversized provider response security failures survive stage, terminal, and readiness metrics', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduled-shadow-response-limit-'));
  const priorRoot = process.env.CAREER_OPS_PORTALS;
  const priorFetch = globalThis.fetch;
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'scheduler-config.json'), JSON.stringify({ enabled: true, mode: 'shadow', cadenceMs: 3600000, maxRuntimeMs: 10_000, maxJobs: 1 }));
    writeFileSync(join(root, 'portals.yml'), portalYaml);
    process.env.CAREER_OPS_PORTALS = join(root, 'portals.yml');
    globalThis.fetch = async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { status: 200, headers: { 'content-type': 'application/json' } });
    const provider = { id: 'greenhouse', detect: () => true, fetch: async (_entry, ctx) => ctx.fetchJson('https://boards-api.greenhouse.io/v1/boards/fixture/jobs') };
    const executor = createTrustedShadowExecutorForTest({ dataRoot: root, maxJobs: 1, providers: { greenhouse: provider }, livenessCheck: async () => ({ result: 'active' }) });
    const result = await runScheduledOnceWithExecutorForTest({ dataRoot: root, executor });
    const stored = getRun(result.runId, { dataRoot: root });
    assert.equal(result.result.counters.security_failures, 1);
    assert.equal(result.result.metricsFinal.counters.security_failures, 1);
    assert.equal(stored.counters.security_failures, 1);
    assert.equal(stored.stage_receipts.find(receipt => receipt.stage === 'DISCOVERY').counters.security_failures, 1);
    const readiness = JSON.parse(execFileSync(process.execPath, ['operator.mjs', 'system', 'readiness'], {
      cwd: process.cwd(), env: { ...process.env, CAREER_OPS_ROOT: root }, encoding: 'utf8'
    }));
    assert.equal(readiness.security_failures, 1);
  } finally {
    globalThis.fetch = priorFetch;
    if (priorRoot === undefined) delete process.env.CAREER_OPS_PORTALS; else process.env.CAREER_OPS_PORTALS = priorRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test('scheduled Greenhouse office-enrichment failure fails closed before geographic filtering', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduled-shadow-greenhouse-enrichment-'));
  const priorRoot = process.env.CAREER_OPS_PORTALS;
  const priorFetch = globalThis.fetch;
  const requested = [];
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'scheduler-config.json'), JSON.stringify({ enabled: true, mode: 'shadow', cadenceMs: 3600000, maxRuntimeMs: 10_000, maxJobs: 1 }));
    writeFileSync(join(root, 'portals.yml'), `tracked_companies:\n  - name: Fixture Co\n    enabled: true\n    provider: greenhouse\n    careers_url: https://job-boards.greenhouse.io/fixture\nlocation_filter:\n  block: [Germany]\njob_boards: []\n`);
    process.env.CAREER_OPS_PORTALS = join(root, 'portals.yml');
    globalThis.fetch = async url => {
      requested.push(String(url));
      if (String(url).endsWith('/offices')) return new Response('{"error":"offices unavailable"}', { status: 404, headers: { 'content-type': 'application/json' } });
      if (String(url).includes('/jobs?content=true')) return new Response(JSON.stringify({ jobs: [{
        id: 987671, title: 'Data Engineer', absolute_url: 'https://job-boards.greenhouse.io/fixture/jobs/987671',
        first_published: '2026-01-01T00:00:00Z', location: { name: 'Remote' },
        content: '<p>Build and operate reliable data systems for global teams.</p>'
      }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ id: 987671, title: 'Data Engineer' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const run = await runScheduledOnce({ dataRoot: root });
    const stored = getRun(run.runId, { dataRoot: root });
    assert.ok(requested.some(url => url.endsWith('/offices')));
    assert.equal(run.result.status, 'DEGRADED');
    assert.equal(run.result.counters.jobs_discovered_raw, 0);
    assert.equal(run.result.counters.reviews_created || 0, 0);
    assert.equal(run.result.counters.provider_failures, 1);
    assert.equal(stored.outcome, 'DEGRADED');
    assert.ok(stored.warnings.some(warning => warning.includes('greenhouse:non_retryable')));
  } finally {
    globalThis.fetch = priorFetch;
    if (priorRoot === undefined) delete process.env.CAREER_OPS_PORTALS; else process.env.CAREER_OPS_PORTALS = priorRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test('capacity-skipped eligible postings are counted as rediscoverable, not durably deferred', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduled-shadow-capacity-'));
  const priorRoot = process.env.CAREER_OPS_PORTALS;
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'scheduler-config.json'), JSON.stringify({ enabled: true, mode: 'shadow', cadenceMs: 3600000, maxRuntimeMs: 10_000, maxJobs: 1 }));
    writeFileSync(join(root, 'portals.yml'), portalYaml);
    process.env.CAREER_OPS_PORTALS = join(root, 'portals.yml');
    const first = fixtureJob('https://job-boards.greenhouse.io/fixture/jobs/987661');
    first.externalId = 'capacity-1'; first.listingIdentity.posting_id = 'capacity-1';
    const second = fixtureJob('https://job-boards.greenhouse.io/fixture/jobs/987662');
    second.externalId = 'capacity-2'; second.listingIdentity.posting_id = 'capacity-2';
    const provider = { id: 'greenhouse', detect: () => true, fetch: async () => [first, second] };
    let livenessChecks = 0;
    const executor = createTrustedShadowExecutorForTest({ dataRoot: root, maxJobs: 1, providers: { greenhouse: provider }, livenessCheck: async () => { livenessChecks++; return { result: 'active' }; } });
    const result = await runScheduledOnceWithExecutorForTest({ dataRoot: root, executor });
    assert.equal(result.result.counters.capacity_skipped_rediscoverable, 1);
    assert.equal(result.result.counters.provider_operations, 2);
    assert.equal(result.result.counters.provider_attempts, 0);
    assert.equal(result.result.counters.provider_failures, 0);
    assert.equal('queue_deferred' in result.result.counters, false);
    assert.equal(getRun(result.runId, { dataRoot: root }).counters.capacity_skipped_rediscoverable, 1);
    assert.equal(existsSync(join(root, 'data', 'autonomous-pending.json')), false);
    assert.equal(result.result.counters.reviews_created, 1);
    assert.equal(livenessChecks, 1);
    assert.equal(result.result.status, 'DEGRADED');
    assert.ok(result.result.warnings.includes('CAPACITY_SKIPPED_REDISCOVERABLE'));
    assert.equal(getRun(result.runId, { dataRoot: root }).outcome, 'DEGRADED');
  } finally {
    if (priorRoot === undefined) delete process.env.CAREER_OPS_PORTALS; else process.env.CAREER_OPS_PORTALS = priorRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test('malformed fixture provider payload is a provider failure, not successful empty discovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduled-shadow-malformed-'));
  const priorRoot = process.env.CAREER_OPS_PORTALS;
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'scheduler-config.json'), JSON.stringify({ enabled: true, mode: 'shadow', cadenceMs: 3600000, maxRuntimeMs: 10_000, maxJobs: 2 }));
    writeFileSync(join(root, 'portals.yml'), portalYaml);
    process.env.CAREER_OPS_PORTALS = join(root, 'portals.yml');
    const malformed = { id: 'greenhouse', detect: () => true, fetch: async () => ({ jobs: [] }) };
    const executor = createTrustedShadowExecutorForTest({ dataRoot: root, providers: { greenhouse: malformed }, livenessCheck: async () => ({ result: 'active' }) });
    const result = await runScheduledOnceWithExecutorForTest({ dataRoot: root, executor });
    assert.equal(result.result.status, 'DEGRADED');
    assert.equal(result.result.counters.provider_failures, 1);
    assert.equal(result.result.counters.provider_operations, 1);
    assert.equal(result.result.counters.provider_attempts, 0);
    assert.equal(result.result.counters.jobs_discovered_raw, 0);
    assert.ok(result.result.warnings.some(value => value.includes('greenhouse:non_retryable')));
    assert.equal(result.result.reviewTasks.length, 0);
    const run = getRun(result.runId, { dataRoot: root });
    assert.equal(run.status, 'COMPLETED');
    assert.equal(run.outcome, 'DEGRADED');
  } finally {
    if (priorRoot === undefined) delete process.env.CAREER_OPS_PORTALS; else process.env.CAREER_OPS_PORTALS = priorRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test('scheduled fixture provider run persists canonical review, reuses it, and blocks FILL_APPLICATION', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduled-shadow-e2e-'));
  const priorRoot = process.env.CAREER_OPS_PORTALS;
  let providerFetches = 0; let fills = 0;
  const provider = {
    id: 'greenhouse',
    detect: () => ({ url: 'fixture://greenhouse/fixture' }),
    async fetch() {
      providerFetches++;
      return [fixtureJob('https://job-boards.greenhouse.io/fixture/jobs/987655?utm_source=one'), fixtureJob('https://job-boards.greenhouse.io/fixture/jobs/987655?utm_source=two')];
    },
    async fill() { fills++; }
  };
  const options = { dataRoot: root, maxJobs: 5, maxRunMs: 10_000, providers: { greenhouse: provider }, livenessCheck: async () => ({ result: 'active' }) };
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'scheduler-config.json'), JSON.stringify({ enabled: true, mode: 'shadow', cadenceMs: 3600000, maxRuntimeMs: 10_000, maxJobs: 5 }));
    writeFileSync(join(root, 'portals.yml'), portalYaml);
    process.env.CAREER_OPS_PORTALS = join(root, 'portals.yml');

    const first = await runScheduledOnceWithExecutorForTest({ dataRoot: root, executor: createTrustedShadowExecutorForTest(options) });
    assert.equal(first.result.status, 'COMPLETED');
    assert.equal(first.result.counters.jobs_discovered_raw, 2);
    assert.equal(first.result.counters.jobs_duplicate, 1);
    assert.equal(first.result.counters.reviews_created, 1);
    assert.equal(first.result.counters.notifications_queued, 1);
    const firstTask = first.result.reviewTasks[0];
    const canonical = readExistingState(firstTask.application_id, { dataRoot: root });
    assert.equal(canonical.state, 'NEEDS_REVIEW');
    assert.equal((new HumanReviewTaskStore({ dataRoot: root })).list({ applicationId: firstTask.application_id }).length, 1);

    const second = await runScheduledOnceWithExecutorForTest({ dataRoot: root, executor: createTrustedShadowExecutorForTest(options) });
    assert.equal(second.result.counters.reviews_reused, 1);
    assert.equal(second.result.counters.reviews_created || 0, 0);
    assert.equal((new HumanReviewTaskStore({ dataRoot: root })).list({ applicationId: firstTask.application_id }).length, 1);

    const reviewStore = new HumanReviewTaskStore({ dataRoot: root });
    const fillReview = await reviewStore.create({
      application_id: firstTask.application_id, review_type: 'ATS_PREPARATION_REVIEW', source_event: 'fixture-fill-decision',
      expected_state: canonical.state, evidence: { canonical_state: canonical.state, canonical_version: canonical.version, fixture: 'explicit human action needed' }
    });
    await reviewStore.decide(fillReview.review_task_id, { application_id: firstTask.application_id, decision: 'FILL_APPLICATION', evidence_hash: fillReview.evidence_hash, current_state: canonical.state, canonical_version: canonical.version });

    const third = await runScheduledOnceWithExecutorForTest({ dataRoot: root, executor: createTrustedShadowExecutorForTest(options) });
    assert.equal(third.result.counters.shadow_actions_blocked, 1);
    const storedRun = getRun(third.runId, { dataRoot: root });
    assert.equal(storedRun.outcome, 'COMPLETED');
    assert.equal(storedRun.counters.jobs_discovered_raw, third.result.counters.jobs_discovered_raw);
    assert.equal(storedRun.counters.jobs_normalized, third.result.counters.jobs_normalized);
    for (const key of ['provider_attempts', 'provider_operations', 'provider_successes', 'provider_failures', 'retries', 'rate_limits', 'capacity_skipped_rediscoverable']) {
      assert.equal(storedRun.counters[key] || 0, third.result.counters[key] || 0, `persisted ${key} matches pipeline counter`);
    }
    const receipts = listShadowActionReceipts({ dataRoot: root });
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].action, 'FILL_APPLICATION');
    assert.equal(receipts[0].blocked_by_shadow_mode, true);
    assert.equal(readExistingState(firstTask.application_id, { dataRoot: root }).state, 'NEEDS_REVIEW');
    assert.equal((new HumanReviewTaskStore({ dataRoot: root })).notificationOutbox.list().some(item => item.status === 'DELIVERED'), false);
    assert.equal(fills, 0);
    assert.equal(providerFetches, 3);
  } finally {
    if (priorRoot === undefined) delete process.env.CAREER_OPS_PORTALS; else process.env.CAREER_OPS_PORTALS = priorRoot;
    rmSync(root, { recursive: true, force: true });
  }
});
