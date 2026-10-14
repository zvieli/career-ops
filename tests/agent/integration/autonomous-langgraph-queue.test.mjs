// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAutonomousPendingQueueStats, mergeAutonomousPendingJobs, readAutonomousPendingJobs } from '../../../lib/autonomous-pending-queue.mjs';
import { ApplicationLedger } from '../../../lib/application-ledger.mjs';
import { readExistingState } from '../../../lib/application-state-machine.mjs';
import { createAutonomousEvaluationGraph, openLangGraphCheckpointStore, stableEvaluationThreadId } from '../../../lib/autonomous-langgraph.mjs';
import { NotificationRouter } from '../../../lib/notification-router.mjs';
import { readReceipt } from '../../../lib/run-reporter.mjs';
import { parseQueueRunnerArgs, runOneQueuedEvaluation } from '../../../scripts/autonomous-langgraph-queue.mjs';

async function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-langgraph-queue-test-'));
  const previousRoot = process.env.CAREER_OPS_ROOT;
  process.env.CAREER_OPS_ROOT = root;
  try { await fn(root); } finally {
    if (previousRoot === undefined) delete process.env.CAREER_OPS_ROOT;
    else process.env.CAREER_OPS_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
}

const job = (url, company) => ({ url, company, title: 'Software Engineer', provider: 'greenhouse', verification_status: 'active', liveness_verified_at: new Date().toISOString() });
const APP_ID = 'app-555555555555555555555555';

async function withDistinctRoots(fn) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-langgraph-data-root-'));
  const processRoot = mkdtempSync(join(tmpdir(), 'career-ops-langgraph-process-root-'));
  const previousRoot = process.env.CAREER_OPS_ROOT;
  process.env.CAREER_OPS_ROOT = processRoot;
  try { await fn(dataRoot, processRoot); } finally {
    if (previousRoot === undefined) delete process.env.CAREER_OPS_ROOT; else process.env.CAREER_OPS_ROOT = previousRoot;
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(processRoot, { recursive: true, force: true });
  }
}

test('queue graph CLI prints help and exits before reading profile or queue data', () => {
  const script = fileURLToPath(new URL('../../../scripts/autonomous-langgraph-queue.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--help'],  { encoding: 'utf8', env: { ...process.env, CAREER_OPS_ROOT: tmpdir() } });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage:/m);
  assert.equal(result.stderr, '');
});

test('queue graph CLI requires one explicit URL and restricts resume decisions', () => {
  assert.throws(() => parseQueueRunnerArgs([]), /--url/);
  assert.deepEqual(parseQueueRunnerArgs(['--url', 'https://example.test/1']), { url: 'https://example.test/1', resume: null });
  assert.deepEqual(parseQueueRunnerArgs(['--url', 'https://example.test/1', '--resume', 'evidence-updated']), { url: 'https://example.test/1', resume: { action: 'evidence_updated' } });
  assert.throws(() => parseQueueRunnerArgs(['--url', 'https://example.test/1', '--resume', 'submit']), /unsupported resume action/);
  const retry = parseQueueRunnerArgs([
    '--url', 'https://example.test/1', '--retry-provider-failure',
    '--provider-unavailable', 'antigravity', '--unavailable-until', '2026-10-21T06:14:32.000Z',
    '--reason', 'quota_exhausted', '--source', 'user_confirmed'
  ]);
  assert.deepEqual(retry, {
    url: 'https://example.test/1', resume: null, retryProviderFailure: true,
    providerOverride: { provider: 'antigravity', unavailableUntil: '2026-10-21T06:14:32.000Z', reason: 'quota_exhausted', source: 'user_confirmed' }
  });
  assert.throws(() => parseQueueRunnerArgs([
    '--url', 'https://example.test/1', '--provider-unavailable', 'antigravity',
    '--unavailable-until', '2026-10-21T06:14:32.000Z', '--reason', 'quota_exhausted', '--source', 'user_confirmed'
  ]), /requires --retry-provider-failure/);
  assert.throws(() => parseQueueRunnerArgs(['--url', 'https://example.test/1', '--retry-provider-failure', '--resume', 'stop']), /cannot be combined/);
});

test('graph runner selects exactly one existing pending URL without discovery and acknowledges only its terminal result', async () => {
  await withTempRoot(async (root) => {
    const queueFile = join(root, 'data', 'autonomous-pending.json');
    const selected = job('https://jobs.example.test/selected', 'Selected Co');
    const untouched = job('https://jobs.example.test/untouched', 'Untouched Co');
    await mergeAutonomousPendingJobs(queueFile, [selected, untouched]);
    let livenessCalls = 0;
    let jdFetches = 0;
    let discoveryCalls = 0;
    let evaluations = 0;
    const result = await runOneQueuedEvaluation({ url: selected.url, dataRoot: root, dependencies: {
      discoverJobs: async () => { discoveryCalls++; throw new Error('scanner discovery must not run'); },
      checkLiveness: async () => { livenessCalls++; return { result: 'active' }; },
      fetchJdViaKnownApi: async () => { jdFetches++; return { title: selected.title, text: 'Requires 5 years of professional experience.' }; },
      loadCandidateContext: async () => ({ profile: {}, cvMarkdown: '', facts: { professional_years: 0, professional_yoe_verified: true, professional_years_source: 'config/profile.yml' } }),
      evaluate: async () => {
        evaluations++;
        return { status: 'PASSED', tier: 1, extraction: { required_yoe: 5, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } };
      },
      resolveIdentity: () => ({ application_id: 'app-222222222222222222222222', identity_basis: 'canonical_url', mergeable: true })
    } });
    assert.equal(discoveryCalls, 0);
    assert.equal(livenessCalls, 0, 'fresh liveness evidence is reused');
    assert.equal(jdFetches, 1);
    assert.equal(evaluations, 1);
    assert.equal(result.application_id, 'app-222222222222222222222222');
    assert.equal(result.canonical_state, 'REJECTED_BY_POLICY');
    assert.equal(result.quota_known, false);
    assert.equal(result.quota_remaining, 'UNKNOWN');
    assert.deepEqual(readAutonomousPendingJobs(queueFile).map((item) => item.url), [untouched.url]);
    assert.deepEqual(getAutonomousPendingQueueStats(queueFile), { pending: 1, blocked: 0 });
    const receipt = readReceipt(result.run_id);
    assert.equal(receipt.provider_call_status, 'NOT_ATTEMPTED');
    assert.equal(receipt.provider_usable, 'UNKNOWN');
  });
});

test('explicit runner dataRoot owns state, queue, checkpoints, ledger, and run receipt even when process root differs', async () => {
  await withDistinctRoots(async (dataRoot, processRoot) => {
    const url = 'https://jobs.example.test/explicit-root';
    const queueFile = join(dataRoot, 'data', 'autonomous-pending.json');
    await mergeAutonomousPendingJobs(queueFile, [job(url, 'Root Co')]);
    const result = await runOneQueuedEvaluation({ url, dataRoot, dependencies: {
      resolveIdentity: () => ({ application_id: APP_ID, identity_basis: 'canonical_url', mergeable: true }),
      hydrateJob: async (item) => ({ ...item, jdText: 'Requires 5 years of professional software engineering experience.' }),
      loadCandidateContext: async () => ({ profile: {}, cvMarkdown: '', facts: { professional_years: 0, professional_yoe_verified: true, professional_years_source: 'config/profile.yml' } }),
      evaluate: async () => ({ status: 'PASSED', tier: 1, extraction: { required_yoe: 5, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } })
    } });
    assert.equal(result.canonical_state, 'REJECTED_BY_POLICY');
    assert.equal(readExistingState(APP_ID, { dataRoot }).state, 'REJECTED_BY_POLICY');
    assert.equal(readExistingState(APP_ID, { dataRoot: processRoot }), null);
    assert.equal(existsSync(join(dataRoot, 'data', 'langgraph', 'checkpoints.sqlite')), true);
    assert.equal(existsSync(join(processRoot, 'data', 'applications', APP_ID, 'state.json')), false);
    const receipts = readdirSync(join(dataRoot, 'data', 'runs'));
    assert.equal(receipts.length, 1);
    const processReceipts = join(processRoot, 'data', 'runs');
    assert.equal(existsSync(processReceipts) ? readdirSync(processReceipts).length : 0, 0);
    const receipt = JSON.parse(readFileSync(join(dataRoot, 'data', 'runs', receipts[0]), 'utf8'));
    assert.equal(receipt.application_id, undefined);
  });
});

test('operator availability override retries only the same provider-failure checkpoint and audits the skip', async () => {
  await withTempRoot(async (root) => {
    const url = 'https://jobs.example.test/operator-confirmed-provider-retry';
    const queueFile = join(root, 'data', 'autonomous-pending.json');
    await mergeAutonomousPendingJobs(queueFile, [job(url, 'Override Co')]);
    const evaluations = [];
    const dependencies = {
      resolveIdentity: () => ({ application_id: APP_ID, identity_basis: 'canonical_url', mergeable: true }),
      hydrateJob: async (item) => ({ ...item, jdText: 'Requires 5 years of professional software engineering experience.' }),
      loadCandidateContext: async () => ({ profile: {}, cvMarkdown: '', facts: { professional_years: 0, professional_yoe_verified: true, professional_years_source: 'config/profile.yml' } }),
      evaluate: async ({ unavailableProviders }) => {
        evaluations.push(unavailableProviders);
        if (evaluations.length === 1) return { status: 'NEEDS_REVIEW', reason: 'PROVIDER_FAILURE_NON_RETRYABLE', provider_attempts: [
          { provider: 'antigravity', requested_model_id: 'antigravity/gemini-3.8-flash', attempt: 1 }
        ] };
        return { status: 'PASSED', tier: 1, extraction: { required_yoe: 5, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } };
      }
    };
    const first = await runOneQueuedEvaluation({ url, dataRoot: root, dependencies });
    assert.equal(first.status, 'NEEDS_REVIEW');
    const unavailableUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await assert.rejects(runOneQueuedEvaluation({ url, dataRoot: root, retryProviderFailure: true, providerOverride: {
      provider: 'antigravity', unavailableUntil, reason: 'quota_exhausted', source: 'user_confirmed'
    }, dependencies: { ...dependencies, onNodeBoundary: (name) => {
      if (name === 'provider-retry-state-transitioned') throw new Error('fixture crash after canonical retry transition');
    } } }), /fixture crash after canonical retry transition/);
    const stateAfterCrash = readExistingState(APP_ID, { dataRoot: root });
    assert.equal(stateAfterCrash.state, 'DEDUPED');
    assert.equal(stateAfterCrash.metadata.DEDUPED.providerRetryAttempt, 2);
    const second = await runOneQueuedEvaluation({ url, dataRoot: root, dependencies });
    assert.equal(second.status, 'REJECTED_BY_POLICY');
    assert.deepEqual(evaluations, [[], ['antigravity']]);
    assert.equal(second.provider_availability_overrides[0].source, 'user_confirmed');
    assert.equal(second.provider_availability_overrides[0].reason, 'quota_exhausted');
    assert.equal(second.provider_availability_overrides[0].unavailable_until, unavailableUntil);
    assert.equal(readAutonomousPendingJobs(queueFile).length, 0);
    const receipt = readReceipt(second.run_id);
    assert.deepEqual(receipt.provider_availability_overrides, second.provider_availability_overrides);
    assert.equal(receipt.quota_known, false);
    assert.equal(receipt.quota_remaining, 'UNKNOWN');
    const events = new ApplicationLedger({ dataRoot: root }).timeline(APP_ID);
    assert.equal(events.filter((event) => event.type === 'EVALUATION_RETRY_AUTHORIZED').length, 1);
    assert.equal(events.filter((event) => event.type === 'JOB_EVALUATED').length, 2);
  });
});

test('provider retry refuses conflicting canonical JD hashes without authorization or reevaluation', async () => {
  await withTempRoot(async (root) => {
    const url = 'https://jobs.example.test/conflicting-retry-jd-hash';
    const queueFile = join(root, 'data', 'autonomous-pending.json');
    await mergeAutonomousPendingJobs(queueFile, [job(url, 'Conflict Co')]);
    let evaluations = 0;
    const dependencies = {
      resolveIdentity: () => ({ application_id: APP_ID, identity_basis: 'canonical_url', mergeable: true }),
      hydrateJob: async (item) => ({ ...item, jdText: 'Requires 5 years of software engineering experience.' }),
      loadCandidateContext: async () => ({ profile: {}, cvMarkdown: '', facts: { professional_years: 0, professional_yoe_verified: true, professional_years_source: 'config/profile.yml' } }),
      evaluate: async () => {
        evaluations++;
        return { status: 'NEEDS_REVIEW', reason: 'PROVIDER_FAILURE_NON_RETRYABLE', provider_attempts: [
          { provider: 'antigravity', requested_model_id: 'antigravity/gemini-3.8-flash', attempt: 1 }
        ] };
      }
    };
    const first = await runOneQueuedEvaluation({ url, dataRoot: root, dependencies });
    assert.equal(first.status, 'NEEDS_REVIEW');
    const statePath = join(root, 'data', 'applications', APP_ID, 'state.json');
    const canonical = JSON.parse(readFileSync(statePath, 'utf8'));
    canonical.metadata.NEEDS_REVIEW.jdHash = 'b'.repeat(64);
    writeFileSync(statePath, JSON.stringify(canonical));
    const eventsBefore = new ApplicationLedger({ dataRoot: root }).timeline(APP_ID);
    const unavailableUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await assert.rejects(runOneQueuedEvaluation({ url, dataRoot: root, retryProviderFailure: true, providerOverride: {
      provider: 'antigravity', unavailableUntil, reason: 'quota_exhausted', source: 'user_confirmed'
    }, dependencies }), /Checkpoint JD hash conflicts with canonical application state/);
    assert.equal(evaluations, 1);
    assert.deepEqual(new ApplicationLedger({ dataRoot: root }).timeline(APP_ID), eventsBefore);
    const stateAfter = readExistingState(APP_ID, { dataRoot: root });
    assert.equal(stateAfter.state, 'NEEDS_REVIEW');
    assert.equal(stateAfter.metadata.NEEDS_REVIEW.jdHash, 'b'.repeat(64));
    assert.equal(readAutonomousPendingJobs(queueFile).length, 1);
  });
});

test('runner resumes a canonical terminal transition that preceded its graph checkpoint without reevaluating', async () => {
  await withTempRoot(async (root) => {
    const url = 'https://jobs.example.test/terminal-ahead-of-checkpoint';
    const queueFile = join(root, 'data', 'autonomous-pending.json');
    await mergeAutonomousPendingJobs(queueFile, [job(url, 'Checkpoint Co')]);
    const store = openLangGraphCheckpointStore({ dataRoot: root });
    const ledger = new ApplicationLedger({ dataRoot: root });
    const graph = createAutonomousEvaluationGraph({ checkpointer: store.checkpointer, dataRoot: root, dependencies: {
      queueFile, ledger,
      resolveIdentity: () => ({ application_id: APP_ID, identity_basis: 'canonical_url', mergeable: true }),
      hydrateJob: async (item) => ({ ...item, jdText: 'Requires 5 years of software engineering experience.' }),
      loadCandidateFacts: async () => ({ professional_years: 0, professional_yoe_verified: true, professional_years_source: 'config/profile.yml' }),
      evaluate: async () => ({ status: 'PASSED', tier: 1, extraction: { required_yoe: 5, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } }),
      onNodeBoundary: (name) => { if (name === 'fit-events-appended') throw new Error('fixture process interruption'); }
    } });
    const config = { configurable: { thread_id: stableEvaluationThreadId(APP_ID) }, durability: 'sync' };
    try { await assert.rejects(graph.invoke({ input_job: job(url, 'Checkpoint Co') }, config), /fixture process interruption/); }
    finally { store.close(); }

    const result = await runOneQueuedEvaluation({ url, dataRoot: root, dependencies: {
      resolveIdentity: () => ({ application_id: APP_ID, identity_basis: 'canonical_url', mergeable: true }),
      loadCandidateContext: async () => ({ profile: {}, cvMarkdown: '', facts: { professional_years: 0, professional_yoe_verified: true, professional_years_source: 'config/profile.yml' } }),
      evaluate: async () => { throw new Error('evaluation node must not replay'); }
    } });
    assert.equal(result.canonical_state, 'REJECTED_BY_POLICY');
    assert.equal(result.queue_acknowledged, true);
    assert.equal(readAutonomousPendingJobs(queueFile).length, 0);
    assert.equal(new ApplicationLedger({ dataRoot: root }).timeline(APP_ID).filter((event) => event.type === 'FIT_REJECTED').length, 1);
  });
});

test('runner blocks checkpoint resume when canonical state is missing, corrupt, or conflicting', async () => {
  for (const tamper of ['missing', 'corrupt', 'conflicting']) {
    await withTempRoot(async (root) => {
      const url = `https://jobs.example.test/checkpoint-${tamper}`;
      const queueFile = join(root, 'data', 'autonomous-pending.json');
      await mergeAutonomousPendingJobs(queueFile, [job(url, 'Checkpoint Co')]);
      const store = openLangGraphCheckpointStore({ dataRoot: root });
      const ledger = new ApplicationLedger({ dataRoot: root });
      const graph = createAutonomousEvaluationGraph({ checkpointer: store.checkpointer, dataRoot: root, dependencies: {
        queueFile, ledger,
        resolveIdentity: () => ({ application_id: APP_ID, identity_basis: 'canonical_url', mergeable: true }),
        notificationRouter: new NotificationRouter({ dataRoot: root, adapters: [] }),
        hydrateJob: async (item) => ({ ...item, jdText: 'Requires 5 years of software engineering experience.' }),
        loadCandidateFacts: async () => ({ professional_years: 0, professional_yoe_verified: true, professional_years_source: 'config/profile.yml' }),
        evaluate: async () => ({ status: 'PASSED', tier: 1, extraction: { required_yoe: 5, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } }),
        onNodeBoundary: (name) => { if (name === 'fit-events-appended') throw new Error('fixture process interruption'); }
      } });
      const config = { configurable: { thread_id: stableEvaluationThreadId(APP_ID) }, durability: 'sync' };
      try { await assert.rejects(graph.invoke({ input_job: job(url, 'Checkpoint Co') }, config), /fixture process interruption/); }
      finally { store.close(); }

      const statePath = join(root, 'data', 'applications', APP_ID, 'state.json');
      if (tamper === 'missing') unlinkSync(statePath);
      if (tamper === 'corrupt') writeFileSync(statePath, '{corrupt');
      if (tamper === 'conflicting') {
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        state.state = 'NEEDS_REVIEW';
        writeFileSync(statePath, JSON.stringify(state));
      }
      await assert.rejects(runOneQueuedEvaluation({ url, dataRoot: root, dependencies: {
        resolveIdentity: () => ({ application_id: APP_ID, identity_basis: 'canonical_url', mergeable: true }),
        loadCandidateContext: async () => ({ profile: {}, cvMarkdown: '', facts: { professional_years: 0, professional_yoe_verified: true, professional_years_source: 'config/profile.yml' } })
      } }), /checkpoint|canonical|state|corrupt/i, tamper);
      assert.equal(readAutonomousPendingJobs(queueFile).length, 1);
    });
  }
});

test('stale selected queue item receives one targeted liveness check, never a discovery scan', async () => {
  await withTempRoot(async (root) => {
    const queueFile = join(root, 'data', 'autonomous-pending.json');
    const stale = { ...job('https://jobs.example.test/stale', 'Stale Co'), liveness_verified_at: '2020-01-01T00:00:00.000Z' };
    await mergeAutonomousPendingJobs(queueFile, [stale]);
    let livenessCalls = 0;
    let jdFetches = 0;
    const result = await runOneQueuedEvaluation({ url: stale.url, dataRoot: root, dependencies: {
      checkLiveness: async (url) => { livenessCalls++; assert.equal(url, stale.url); return { result: 'uncertain' }; },
      fetchJdViaKnownApi: async () => { jdFetches++; return null; }
    } });
    assert.equal(result.status, 'BLOCKED_LIVENESS');
    assert.equal(livenessCalls, 1);
    assert.equal(jdFetches, 0);
    assert.equal(getAutonomousPendingQueueStats(queueFile).blocked, 1);
    assert.equal(getAutonomousPendingQueueStats(queueFile).pending, 0);
  });
});
