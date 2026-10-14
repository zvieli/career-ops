import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquirePipelineLock, LockTimeoutError } from '../pipeline-lock.mjs';
import { candidateFactsFromSources, createSingleFormPreparationGate, getAutonomousRunLockTarget, getPipelineReadinessState, hydrateDirectJobFromHistory, hydrateScannedJobFromHistory, isQueueTerminalState, isQueuedLivenessFresh, MAX_QUEUED_LIVENESS_AGE_MS, recordModelAttempt, recordModelFailure, recordModelResult, isRecoverableApplicationState, isRetryableEvaluationReview, isVerifiedEmployerPosting, MAX_AUTONOMOUS_JOBS_PER_RUN, selectPendingJobsForRun, selectQueuedJobByUrl, parsePipelineArgs, parseScanReceipt, parseFetchedJd } from '../autonomous-pipeline.mjs';

test('candidate GPA is read only from a primary profile or CV source', () => {
  const facts = candidateFactsFromSources({}, '## Education\nGPA: 85 · Graduated: 2026');
  assert.equal(facts.gpa, 85);
  assert.equal(facts.gpa_source, 'cv.md');
  assert.equal(facts.gpa_scale, null);
  assert.equal(candidateFactsFromSources({}, '## Education\nGPA: 85/100').gpa_scale, '100-point');
  const educationFacts = candidateFactsFromSources({}, '## Education\n**B.Sc. in Computer Science** — HIT');
  assert.deepEqual(educationFacts.degrees, ['B.Sc. in Computer Science']);
  assert.equal(educationFacts.degrees_source, 'cv.md');
  assert.equal(candidateFactsFromSources({}, 'No GPA').gpa, undefined);
  const profiledGpa = candidateFactsFromSources({ candidate: { gpa_value: 85, gpa_scale: 'GPA_SCALE_UNKNOWN' } }, '## Education\nGPA: 85');
  assert.equal(profiledGpa.gpa, 85);
  assert.equal(profiledGpa.gpa_source, 'config/profile.yml');
  assert.equal(profiledGpa.gpa_scale, 'GPA_SCALE_UNKNOWN');
});

test('canonical profile distinguishes verified zero professional YOE and unknown GPA scale', () => {
  const facts = candidateFactsFromSources({ candidate: {
    professional_yoe_years: 0,
    professional_yoe_verified: true,
    gpa_scale: 'GPA_SCALE_UNKNOWN'
  } }, '## Experience\n### Industry Project\nMarch 2026 – September 2026\n## Education\nGPA: 85');
  assert.equal(facts.professional_years, 0);
  assert.equal(facts.professional_years_source, 'config/profile.yml');
  assert.equal(facts.professional_yoe_verified, true);
  assert.equal(facts.gpa, 85);
  assert.equal(facts.gpa_scale, 'GPA_SCALE_UNKNOWN');
  assert.equal(candidateFactsFromSources({}, '## Experience\n### Industry Project\n## Education\nGPA: 85').professional_years, undefined);
});

test('candidate-fit review cannot be mistaken for a transient provider failure', () => {
  assert.equal(isRetryableEvaluationReview({ reviewType: 'candidate_fit', reason: 'ALL_ZERO_COST_MODELS_UNAVAILABLE' }), false);
  assert.equal(isRetryableEvaluationReview({ reviewType: 'evaluation_failure', reason: 'temporary failure' }), true);
  assert.equal(isRetryableEvaluationReview({ reason: 'INVALID_MODEL_OUTPUT' }), true);
});

test('scheduled invocation defaults to scan discovery', () => {
  assert.deepEqual(parsePipelineArgs([]), { jobUrl: null, queueOnly: false, queueUrl: null, evaluateOnly: false });
});

test('--queue-only drains existing work without invoking discovery', () => {
  assert.deepEqual(parsePipelineArgs(['--queue-only']), { jobUrl: null, queueOnly: true, queueUrl: null, evaluateOnly: false });
});

test('targeted queued replay selects exactly one existing URL and never scans', () => {
  const jobs = [{ url: 'https://boards.greenhouse.io/acme/jobs/1' }, { url: 'https://boards.greenhouse.io/acme/jobs/2' }];
  assert.deepEqual(selectQueuedJobByUrl(jobs, jobs[1].url), [jobs[1]]);
  assert.deepEqual(parsePipelineArgs(['--queue-url', jobs[1].url, '--evaluate-only']), {
    jobUrl: null, queueOnly: true, queueUrl: jobs[1].url, evaluateOnly: true
  });
  assert.throws(() => selectQueuedJobByUrl(jobs, 'https://boards.greenhouse.io/acme/jobs/missing'), /not present in the existing queue/);
});

test('--job-url is parsed without creating a separate evaluation path', () => {
  assert.deepEqual(parsePipelineArgs(['--job-url', 'https://example.com/jobs/1']), { jobUrl: 'https://example.com/jobs/1', queueOnly: false, queueUrl: null, evaluateOnly: false });
});

test('controlled URL restores exact scan metadata without marking old liveness as current', async () => {
  await withLockFixture(async (root) => {
    fs.mkdirSync(join(root, 'data'), { recursive: true });
    const url = 'https://careers.example.test/jobs/1?gh_jid=1';
    fs.writeFileSync(join(root, 'data', 'scan-history.tsv'), [
      'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\trequisition_id\tlisting_key',
      `${url}\t2026-10-13\tgreenhouse api\tBackend Engineer\tExampleCo\tadded\tREQ-1\tjob-1`
    ].join('\n') + '\n');
    const job = hydrateDirectJobFromHistory(root, url);
    assert.equal(job.company, 'ExampleCo');
    assert.equal(job.title, 'Backend Engineer');
    assert.equal(job.requisitionId, 'REQ-1');
    assert.equal(job.externalId, undefined);
    assert.equal(job.verification_status, undefined);
  });
});

test('controlled URL preserves the company scope of its persisted identity alias', async () => {
  await withLockFixture(async (root) => {
    fs.mkdirSync(join(root, 'data'), { recursive: true });
    const url = 'https://careers.example.test/jobs/1?gh_jid=1';
    fs.writeFileSync(join(root, 'data', 'scan-history.tsv'), [
      'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\trequisition_id\tnormalized_company',
      `${url}\t2026-10-13\tgreenhouse api\tBackend Engineer\tExampleCo\tadded\tREQ-1\texampleco`
    ].join('\n') + '\n');
    fs.writeFileSync(join(root, 'data', 'application-identities.json'), JSON.stringify({ application_aliases: {
      'app-existing': [{ kind: 'url', company: '', value: url }]
    } }));
    const job = hydrateDirectJobFromHistory(root, url);
    assert.equal(job.company, '');
    assert.equal(job.requisitionId, undefined);
    const queued = hydrateScannedJobFromHistory(root, {
      url, company: 'ExampleCo', title: 'Backend Engineer', provider: 'greenhouse-api',
      requisitionId: 'REQ-1', externalId: 'provider-1', verification_status: 'active'
    });
    assert.equal(queued.company, '');
    assert.equal(queued.requisitionId, undefined);
    assert.equal(queued.externalId, 'provider-1');
  });
});

test('controlled URL refuses conflicting persisted and current employer scopes', async () => {
  await withLockFixture(async (root) => {
    fs.mkdirSync(join(root, 'data'), { recursive: true });
    const url = 'https://careers.example.test/jobs/1?gh_jid=1';
    fs.writeFileSync(join(root, 'data', 'scan-history.tsv'), [
      'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\trequisition_id\tnormalized_company',
      `${url}\t2026-10-13\tgreenhouse api\tEngineer\tBeta\tadded\tREQ-2\tbeta`
    ].join('\n') + '\n');
    fs.writeFileSync(join(root, 'data', 'application-identities.json'), JSON.stringify({ application_aliases: {
      'app-existing': [{ kind: 'url', company: 'acme', value: url }]
    } }));
    const job = hydrateDirectJobFromHistory(root, url);
    assert.equal(job.identityConflict, true);
    assert.equal(job.company, 'Beta');
    assert.equal(job.requisitionId, 'REQ-2');
  });
});

test('only pre-evaluation interrupted states are automatically recoverable', () => {
  assert.equal(isRecoverableApplicationState('DISCOVERED'), true);
  assert.equal(isRecoverableApplicationState('NORMALIZED'), true);
  assert.equal(isRecoverableApplicationState('DEDUPED'), true);
  assert.equal(isRecoverableApplicationState('FIT_EVALUATED'), false);
  assert.equal(isRecoverableApplicationState('READY_FOR_HUMAN'), false);
});

test('provider usability and quota knowledge are independent in exact-inventory call receipts', async () => {
  const { createZeroCostProviderRunner } = await import('../lib/llm/provider-runner.mjs');
  const runStats = { quota_observable: false, quota_known: false, quota_remaining: 'UNKNOWN', quota_status: 'UNKNOWN', provider_call_status: 'NOT_ATTEMPTED', provider_usable: 'UNKNOWN', system1_calls: 0, system2_calls: 0, models_used: [] };
  const runner = createZeroCostProviderRunner({
    retries: 0,
    execute: async () => '{"ok":true}',
    onModelAttempt: (attempt) => recordModelAttempt(runStats, 'app-test', attempt),
    onModelResult: (result) => recordModelResult(runStats, 'app-test', result),
    onModelFailure: (failure) => recordModelFailure(runStats, 'app-test', failure)
  });
  const call = await runner({ modelId: 'ollama/qwen2.5-coder:3b', tier: 'system1', systemPrompt: '', userMessage: '' });
  assert.equal(call.exact_inventory_match, true);
  assert.equal(call.incremental_cost, 0);
  assert.equal(runStats.quota_known, false);
  assert.equal(runStats.quota_remaining, 'UNKNOWN');
  assert.equal(runStats.provider_call_status, 'SUCCESS');
  assert.equal(runStats.provider_usable, 'YES');
  assert.equal(runStats.models_used[0].exact_inventory_match, true);
  assert.equal(runStats.models_used[0].incremental_cost, 0);
  assert.equal(getPipelineReadinessState(true, runStats.quota_remaining, runStats.provider_usable), 'READY_FOR_HUMAN');
});

test('all exact-inventory providers unavailable require review, while unknown quota alone does not', () => {
  assert.equal(getPipelineReadinessState(true, 'UNKNOWN', 'YES'), 'READY_FOR_HUMAN');
  assert.equal(getPipelineReadinessState(true, 0, 'YES'), 'NEEDS_REVIEW');
  assert.equal(getPipelineReadinessState(true, 4, 'YES'), 'READY_FOR_HUMAN');
  assert.equal(getPipelineReadinessState(true, 'UNKNOWN', 'NO'), 'NEEDS_REVIEW');
  assert.equal(getPipelineReadinessState(false, 'UNKNOWN', 'NO'), 'NEEDS_REVIEW');
  assert.equal(getPipelineReadinessState(false, 'UNKNOWN', 'UNKNOWN'), 'NOT_READY');
});

test('queued liveness evidence expires and invalid timestamps fail closed', () => {
  const now = Date.parse('2026-10-13T12:00:00.000Z');
  assert.equal(isQueuedLivenessFresh({ verification_status: 'active', liveness_verified_at: new Date(now - MAX_QUEUED_LIVENESS_AGE_MS).toISOString(), queued_at: new Date(now).toISOString() }, now), true);
  assert.equal(isQueuedLivenessFresh({ verification_status: 'active', liveness_verified_at: new Date(now - MAX_QUEUED_LIVENESS_AGE_MS - 1).toISOString(), queued_at: new Date(now).toISOString() }, now), false);
  assert.equal(isQueuedLivenessFresh({ verification_status: 'active', liveness_verified_at: 'not-a-date', queued_at: new Date(now).toISOString() }, now), false);
  assert.equal(isQueuedLivenessFresh({ verification_status: 'active', queued_at: new Date(now).toISOString() }, now), false, 'queue insertion time is not proof of verification time');
  assert.equal(isQueuedLivenessFresh({ verification_status: 'uncertain', queued_at: new Date(now).toISOString() }, now), false);
});

test('scheduled queue processing is bounded and leaves remaining work durable', () => {
  const jobs = Array.from({ length: 25 }, (_, index) => ({ url: `https://jobs.example.test/${index}` }));
  const selected = selectPendingJobsForRun(jobs);
  assert.equal(MAX_AUTONOMOUS_JOBS_PER_RUN, 10);
  assert.equal(selected.length, 10);
  assert.equal(selected[0], jobs[0]);
  assert.equal(jobs.slice(selected.length).length, 15);
  assert.equal(selectPendingJobsForRun(jobs, 100).length, 10);
});

test('queue terminal states do not consume scheduled capacity, transient review stays pending', () => {
  assert.equal(isQueueTerminalState('REJECTED_BY_POLICY'), true);
  assert.equal(isQueueTerminalState('NEEDS_REVIEW', { NEEDS_REVIEW: { reviewType: 'candidate_fit' } }), true);
  assert.equal(isQueueTerminalState('NEEDS_REVIEW', { NEEDS_REVIEW: { reviewType: 'evaluation_failure' } }), false);
  assert.equal(isQueueTerminalState('DEDUPED'), false);
});

test('unknown quota observability does not block a successful provider call', () => {
  assert.equal(getPipelineReadinessState(true, 'UNKNOWN'), 'READY_FOR_HUMAN');
  assert.equal(getPipelineReadinessState(true, 0), 'NEEDS_REVIEW');
  assert.equal(getPipelineReadinessState(true, 4), 'READY_FOR_HUMAN');
  assert.equal(getPipelineReadinessState(false, 4), 'NOT_READY');
});

test('ONE_LIVE_FORM_PREPARATION_PER_RUN', () => {
  const gate = createSingleFormPreparationGate();
  const supported = { url: 'https://boards.greenhouse.io/acme/jobs/123', verification_status: 'active' };
  assert.equal(gate(supported), true);
  assert.equal(gate({ ...supported, url: 'https://jobs.lever.co/acme/456' }), false);
  assert.equal(createSingleFormPreparationGate()({ url: 'https://example.com/job/1', verification_status: 'active' }), false);
  assert.equal(createSingleFormPreparationGate()({ ...supported, verification_status: 'uncertain' }), false);
});

test('scan receipt yields normalized added jobs only', () => {
  const jobs = parseScanReceipt(JSON.stringify({ version: 'careerops.scan.receipt@1', added_jobs: [{ title: 'Engineer', company: 'A', url: 'https://a.test/1', verification_status: 'active' }] }));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'Engineer');
  const unverified = parseScanReceipt(JSON.stringify({ version: 'careerops.scan.receipt@1', added_jobs: [{ url: 'https://a.test/2', verification_status: 'uncertain' }, { url: 'https://a.test/3' }] }));
  assert.deepEqual(unverified, []);
  const aggregator = parseScanReceipt(JSON.stringify({ version: 'careerops.scan.receipt@1', added_jobs: [{ url: 'https://www.linkedin.com/jobs/view/123', verification_status: 'active' }] }));
  assert.equal(aggregator.length, 1);
  assert.equal(isVerifiedEmployerPosting(aggregator[0]), false);
});

test('fetch-jd output separates actual title from verbatim JD text', () => {
  assert.deepEqual(parseFetchedJd('Backend Engineer\n\nRequirements: Python'), { title: 'Backend Engineer', jdText: 'Requirements: Python' });
});

async function withLockFixture(fn) {
  const root = fs.mkdtempSync(join(tmpdir(), 'career-ops-autonomous-lock-'));
  try { await fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('AUTONOMOUS_SCAN_NO_SELF_DEADLOCK', async () => {
  await withLockFixture(async (root) => {
    const autonomous = await acquirePipelineLock(getAutonomousRunLockTarget(root), { timeoutMs: 300, retryMs: 10 });
    try {
      const scan = await acquirePipelineLock(join(root, 'data', 'pipeline.md'), { timeoutMs: 300, retryMs: 10 });
      await scan.release();
    } finally { await autonomous.release(); }
  });
});

test('PARALLEL_AUTONOMOUS_RUN_BLOCKED', async () => {
  await withLockFixture(async (root) => {
    const target = getAutonomousRunLockTarget(root);
    const first = await acquirePipelineLock(target, { timeoutMs: 300, retryMs: 10 });
    try {
      await assert.rejects(
        acquirePipelineLock(target, { timeoutMs: 100, retryMs: 10, maxWaitMs: 200 }),
        (error) => error instanceof LockTimeoutError
      );
    } finally { await first.release(); }
  });
});

test('EXTERNAL_SCAN_CONTENTION_FAILS_SAFE', async () => {
  await withLockFixture(async (root) => {
    const autonomous = await acquirePipelineLock(getAutonomousRunLockTarget(root), { timeoutMs: 300, retryMs: 10 });
    const pipelineTarget = join(root, 'data', 'pipeline.md');
    const externalScan = await acquirePipelineLock(pipelineTarget, { timeoutMs: 300, retryMs: 10 });
    try {
      await assert.rejects(
        acquirePipelineLock(pipelineTarget, { timeoutMs: 100, retryMs: 10, maxWaitMs: 200 }),
        (error) => error instanceof LockTimeoutError
      );
      assert.equal(fs.existsSync(`${getAutonomousRunLockTarget(root)}.lock`), true);
      assert.equal(fs.existsSync(`${pipelineTarget}.lock`), true);
    } finally {
      await externalScan.release();
      await autonomous.release();
    }
  });
});

test('STALE_AUTONOMY_LOCK_RECOVERS', async () => {
  await withLockFixture(async (root) => {
    const target = getAutonomousRunLockTarget(root);
    const lockDir = `${target}.lock`;
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, token: 'crashed', started_at: new Date(0).toISOString() }));
    const lock = await acquirePipelineLock(target, { timeoutMs: 500, retryMs: 10, staleMs: 1 });
    await lock.release();
  });
});

test('LIVE_OWNER_NEVER_REMOVED', async () => {
  await withLockFixture(async (root) => {
    const target = getAutonomousRunLockTarget(root);
    const lock = await acquirePipelineLock(target, { timeoutMs: 300, retryMs: 10 });
    try {
      const lockDir = `${target}.lock`;
      fs.utimesSync(lockDir, new Date(0), new Date(0));
      await assert.rejects(
        acquirePipelineLock(target, { timeoutMs: 100, retryMs: 10, maxWaitMs: 200 }),
        (error) => error instanceof LockTimeoutError
      );
      const owner = JSON.parse(fs.readFileSync(join(lockDir, 'owner.json'), 'utf8'));
      assert.equal(owner.pid, process.pid);
      assert.equal(fs.existsSync(lockDir), true);
    } finally { await lock.release(); }
  });
});

test('hard-coded demo identity and embedded JD are absent from production entrypoint', () => {
  const source = fs.readFileSync(new URL('../autonomous-pipeline.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /app-next-backend-demo|7979131003|Minimum GPA of 85/);
});
