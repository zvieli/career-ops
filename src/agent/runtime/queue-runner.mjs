#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as yaml from 'js-yaml';
import { Command } from '@langchain/langgraph';
import { acquirePipelineLock } from '../../../pipeline-lock.mjs';
import { candidateFactsFromSources, getAutonomousRunLockTarget, isQueuedLivenessFresh, selectQueuedJobByUrl } from '../../../autonomous-pipeline.mjs';
import { blockAutonomousPendingJob, getAutonomousPendingQueueStats, mergeAutonomousPendingJobs, readAutonomousPendingJobs } from '../infrastructure/persistence/autonomous-pending-queue.mjs';
import { resolveApplicationIdentity } from '../domain/applications/application-identity.mjs';
import { isAggregatorUrl } from '../../../url-key.mjs';
import { checkLivenessViaApi } from '../../../liveness-api.mjs';
import { fetchJdViaKnownApi } from '../../../browser-extract.mjs';
import { createPiModelGateway } from '../infrastructure/model-gateway/provider-runner.mjs';
import { readProviderAvailability, writeProviderAvailabilityOverride } from '../infrastructure/model-gateway/provider-availability.mjs';
import { isZeroCostModel } from '../infrastructure/model-gateway/zero-cost-router.mjs';
import { evaluateJob } from '../domain/jobs/job-evaluator.mjs';
import { recordRun } from '../infrastructure/observability/run-reporter.mjs';
import { getCareerOpsRoot } from '../../../path-resolver.mjs';
import { readExistingState } from '../domain/applications/application-state-machine.mjs';
import { ApplicationLedger } from '../infrastructure/persistence/application-ledger.mjs';
import { assertCheckpointDomainConsistency, createAutonomousEvaluationGraph, openLangGraphCheckpointStore, stableEvaluationThreadId } from '../graph/autonomous-langgraph.mjs';
import { isMainModule } from '../../../lib/is-main-module.mjs';

export const QUEUE_RUNNER_USAGE = `Usage: node scripts/autonomous-langgraph-queue.mjs --url <pending-url> [--resume <decision> | --retry-provider-failure [availability override options]]
  --url <pending-url>          Select exactly one URL already in the pending queue.
  --resume <decision>          Resume an existing candidate-fit or pre-submit review checkpoint.
  --retry-provider-failure     Explicitly retry only a matching provider-failure review checkpoint.
  --provider-unavailable <id>  Add a local operator-confirmed provider availability override.
  --unavailable-until <ISO>    Time-bounded override expiry; maximum 30 days.
  --reason quota_exhausted     Operator-reported reason (not inferred runtime evidence).
  --source user_confirmed      Explicit override provenance.
  -h, --help                   Show this help and exit.`;

export function parseQueueRunnerArgs(argv) {
  const args = [...argv];
  let url = null;
  let resume = null;
  let retryProviderFailure = false;
  let unavailableProvider = null;
  let unavailableUntil = null;
  let overrideReason = null;
  let overrideSource = null;
  while (args.length) {
    const token = args.shift();
    if (token === '--url') {
      if (url || !args[0] || args[0].startsWith('--')) throw new Error('--url requires one exact pending queue URL.');
      url = args.shift();
    } else if (token === '--resume') {
      if (resume || !args[0] || args[0].startsWith('--')) throw new Error('--resume requires evidence-updated, stop, or continue-manually.');
      const action = args.shift();
      if (action === 'evidence-updated') resume = { action: 'evidence_updated' };
      else if (action === 'stop') resume = { decision: 'STOP' };
      else if (action === 'continue-manually') resume = { decision: 'CONTINUE_MANUALLY' };
      else throw new Error(`unsupported resume action: ${action}`);
    } else if (token === '--retry-provider-failure') {
      if (retryProviderFailure) throw new Error('--retry-provider-failure may be specified only once.');
      retryProviderFailure = true;
    } else if (token === '--provider-unavailable') {
      if (unavailableProvider || !args[0] || args[0].startsWith('--')) throw new Error('--provider-unavailable requires one provider ID.');
      unavailableProvider = args.shift();
    } else if (token === '--unavailable-until') {
      if (unavailableUntil || !args[0] || args[0].startsWith('--')) throw new Error('--unavailable-until requires an ISO timestamp.');
      unavailableUntil = args.shift();
    } else if (token === '--reason') {
      if (overrideReason || !args[0] || args[0].startsWith('--')) throw new Error('--reason requires quota_exhausted.');
      overrideReason = args.shift();
    } else if (token === '--source') {
      if (overrideSource || !args[0] || args[0].startsWith('--')) throw new Error('--source requires user_confirmed.');
      overrideSource = args.shift();
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  if (!url) throw new Error('Queue graph runner requires --url <exact existing pending URL>; discovery is never invoked.');
  if (resume && retryProviderFailure) throw new Error('--resume cannot be combined with --retry-provider-failure.');
  const overrideParts = [unavailableProvider, unavailableUntil, overrideReason, overrideSource];
  const hasOverride = overrideParts.some((value) => value !== null);
  if (hasOverride && (!retryProviderFailure || overrideParts.some((value) => value === null))) {
    throw new Error('Provider override requires --retry-provider-failure plus provider, expiry, reason, and source.');
  }
  const parsed = { url, resume };
  if (retryProviderFailure) parsed.retryProviderFailure = true;
  if (hasOverride) parsed.providerOverride = {
    provider: unavailableProvider, unavailableUntil, reason: overrideReason, source: overrideSource
  };
  return parsed;
}

function readCandidateContext(root) {
  const profile = yaml.load(readFileSync(join(root, 'config', 'profile.yml'), 'utf8')) || {};
  const cvMarkdown = readFileSync(join(root, 'cv.md'), 'utf8');
  return { profile, cvMarkdown, facts: candidateFactsFromSources(profile, cvMarkdown) };
}

function createRunStats(runId, startedAt, pendingBefore) {
  return {
    run_id: runId, started_at: startedAt, finished_at: startedAt,
    jobs_fetched: 0, new_jobs: 0, duplicates: 0, deterministic_rejects: 0,
    system1_calls: 0, system2_calls: 0, cache_hits: 0, shortlisted: 0,
    cv_generated: 0, cv_validated: 0, forms_filled: 0,
    ready_for_human: false, needs_user_fact: false, blocked_captcha: false,
    quota_observable: false, quota_known: false, quota_remaining: 'UNKNOWN', quota_status: 'UNKNOWN',
    provider_call_status: 'NOT_ATTEMPTED', provider_usable: 'UNKNOWN', provider_availability_overrides: [], models_used: [],
    pending_jobs_before: pendingBefore, pending_jobs_after: pendingBefore,
    pending_jobs_processed: 0, blocked_jobs: 0, errors: []
  };
}

function pushModelAttempt(runStats, attempt) {
  const tier = attempt.tier === 1 || attempt.tier === 'system1' ? 'system1'
    : attempt.tier === 2 || attempt.tier === 'system2' ? 'system2' : String(attempt.tier || 'unknown');
  if (tier === 'system1') runStats.system1_calls++;
  if (tier === 'system2') runStats.system2_calls++;
  runStats.models_used.push({
    application_id: attempt.applicationId,
    requested_tier: tier,
    provider: attempt.provider,
    model_id: attempt.modelId,
    exact_inventory_match: isZeroCostModel(attempt.modelId),
    cost_status: isZeroCostModel(attempt.modelId) ? 'VERIFIED_ZERO_COST' : 'UNVERIFIED',
    incremental_cost: isZeroCostModel(attempt.modelId) ? 0 : null,
    quota_remaining: 'UNKNOWN', attempt: attempt.attempt, call_status: 'STARTED'
  });
}

function finishModelCall(runStats, applicationId, modelId, attempt, status, details = {}) {
  const record = [...runStats.models_used].reverse().find((item) => item.application_id === applicationId
    && item.model_id === modelId && item.attempt === attempt && item.call_status === 'STARTED');
  if (record) Object.assign(record, { call_status: status, ...details });
  if (status === 'SUCCESS') {
    runStats.provider_call_status = 'SUCCESS';
    runStats.provider_usable = 'YES';
  } else if (runStats.provider_call_status !== 'SUCCESS') {
    runStats.provider_call_status = 'FAILED';
    runStats.provider_usable = 'NO';
  }
}

export async function runOneQueuedEvaluation({ url, dataRoot = getCareerOpsRoot(), resume = null, retryProviderFailure = false, providerOverride = null, dependencies = {} } = {}) {
  if (typeof url !== 'string' || !url.trim()) throw new Error('An exact pending queue URL is required.');
  if (typeof retryProviderFailure !== 'boolean') throw new Error('retryProviderFailure must be a boolean operator decision.');
  if (resume && retryProviderFailure) throw new Error('Candidate review resume cannot be combined with provider-failure retry.');
  if (providerOverride && !retryProviderFailure) throw new Error('Provider availability override requires an explicit provider-failure retry.');
  const root = resolve(dataRoot);
  const queueFile = join(root, 'data', 'autonomous-pending.json');
  const lock = await acquirePipelineLock(getAutonomousRunLockTarget(root), { run_id: `langgraph-${randomUUID()}`, timeoutMs: 5000 });
  const runId = `run-${randomUUID()}`;
  const startedAt = new Date();
  const before = getAutonomousPendingQueueStats(queueFile);
  const runStats = createRunStats(runId, startedAt, before.pending);
  const persistRun = () => recordRun({ ...runStats, dataRoot: root });
  let store;
  try {
    const pending = readAutonomousPendingJobs(queueFile);
    const selected = selectQueuedJobByUrl(pending, url)[0];
    if (!selected) throw new Error('The exact URL is not present in the existing pending queue; no discovery fallback is available.');
    if (isAggregatorUrl(selected.url)) {
      await blockAutonomousPendingJob(queueFile, selected.url, 'aggregator_requires_employer_confirmation');
      runStats.errors.push('Selected pending URL is an aggregator; employer confirmation is required.');
      return { success: false, status: 'BLOCKED_AGGREGATOR', run_id: runId };
    }

    let queueItem = selected;
    if (!isQueuedLivenessFresh(queueItem)) {
      const checkLiveness = dependencies.checkLiveness || checkLivenessViaApi;
      const liveness = await checkLiveness(queueItem.url);
      if (liveness?.result !== 'active') {
        await blockAutonomousPendingJob(queueFile, queueItem.url, 'targeted_ats_liveness_unconfirmed');
        runStats.errors.push('Selected queue item liveness was not confirmed by its ATS API; no browser/search fallback was attempted.');
        runStats.blocked_jobs = getAutonomousPendingQueueStats(queueFile).blocked;
        runStats.pending_jobs_after = getAutonomousPendingQueueStats(queueFile).pending;
        runStats.finished_at = new Date();
        persistRun();
        return { success: false, status: 'BLOCKED_LIVENESS', run_id: runId, url: queueItem.url };
      }
      queueItem = { ...queueItem, liveness_verified_at: new Date().toISOString(), verification_status: 'active' };
      await mergeAutonomousPendingJobs(queueFile, [queueItem]);
    }

    if (providerOverride) {
      writeProviderAvailabilityOverride({ dataRoot: root, ...providerOverride });
    }
    const providerAvailability = readProviderAvailability({ dataRoot: root });
    runStats.provider_availability_overrides = providerAvailability.overrides;

    const context = dependencies.loadCandidateContext
      ? await dependencies.loadCandidateContext(root)
      : readCandidateContext(root);
    const attempts = [];
    const applicationIdRef = { value: null };
    const runner = (dependencies.createProviderRunner || createPiModelGateway)({
      onModelAttempt: (attempt) => {
        const enriched = { ...attempt, applicationId: applicationIdRef.value };
        attempts.push(enriched);
        pushModelAttempt(runStats, enriched);
      },
      onModelResult: (result) => finishModelCall(runStats, applicationIdRef.value, result.modelId, result.attempt, 'SUCCESS', {
        latency_ms: result.latency_ms, exact_inventory_match: result.exact_inventory_match === true,
        incremental_cost: result.incremental_cost
      }),
      onModelFailure: (failure) => finishModelCall(runStats, applicationIdRef.value, failure.modelId, failure.attempt, 'FAILED', {
        error_code: String(failure.error_code || 'PROVIDER_EXECUTION_FAILED').slice(0, 80)
      })
    });

    const resolvedIdentity = dependencies.resolveIdentity
      ? await dependencies.resolveIdentity(queueItem, { dataRoot: root })
      : resolveApplicationIdentity(queueItem, { dataRoot: root });
    const graphThreadId = stableEvaluationThreadId(resolvedIdentity.application_id);
    store = openLangGraphCheckpointStore({ dataRoot: root });
    const graph = createAutonomousEvaluationGraph({
      checkpointer: store.checkpointer,
      dataRoot: root,
      dependencies: {
        queueFile,
        providerAvailabilityOverrides: providerAvailability.overrides.filter((entry) => entry.status === 'active'),
        onNodeBoundary: dependencies.onNodeBoundary,
        resolveIdentity: () => resolvedIdentity,
        readExistingState: dependencies.readExistingState,
        hydrateJob: async (job) => {
          if (dependencies.hydrateJob) return dependencies.hydrateJob(job);
          const fetched = await (dependencies.fetchJdViaKnownApi || fetchJdViaKnownApi)(job.url);
          if (!fetched?.text) throw new Error('Known ATS API returned no substantive JD; no browser, WebFetch, or search fallback was attempted.');
          return { ...job, title: job.title || fetched.title || '', jdText: fetched.text };
        },
        loadCandidateFacts: async () => context.facts,
        evaluate: async ({ job, applicationId, candidateFacts }) => {
          applicationIdRef.value = applicationId;
          const evaluation = dependencies.evaluate
            ? await dependencies.evaluate({ job, applicationId, candidateFacts, dataRoot: root, unavailableProviders: providerAvailability.unavailableProviders })
            : await evaluateJob({
              jdText: job.jdText, title: job.title, company: job.company,
              candidateProfile: { ...context.profile, verified_candidate_facts: candidateFacts },
              llmRunner: runner, dataRoot: root, bypassCache: true,
              unavailableProviders: providerAvailability.unavailableProviders
            });
          return { ...evaluation, provider_attempts: evaluation.provider_attempts || attempts.map((item) => ({
            requested_tier: item.tier, provider: item.provider, requested_model_id: item.modelId,
            attempt: item.attempt, exact_inventory_match: isZeroCostModel(item.modelId),
            incremental_cost: isZeroCostModel(item.modelId) ? 0 : null
          })) };
        }
      }
    });

    const config = { configurable: { thread_id: graphThreadId }, durability: 'sync' };
    const existingCheckpoint = await store.checkpointer.getTuple({ configurable: { thread_id: graphThreadId } });
    if ((resume || retryProviderFailure) && !existingCheckpoint) throw new Error('Cannot resume: no durable graph checkpoint exists for this application.');
    if (retryProviderFailure && !providerAvailability.unavailableProviders.length) {
      throw new Error('Provider-failure retry requires at least one active user-confirmed provider availability override.');
    }
    let graphInput;
    if (resume) graphInput = new Command({ resume });
    else if (retryProviderFailure) graphInput = new Command({ resume: { action: 'provider_failure_retry' } });
    else if (existingCheckpoint) graphInput = null;
    else graphInput = { input_job: queueItem };
    if (existingCheckpoint) {
      const saved = await graph.getState(config);
      const canonical = (dependencies.readExistingState || readExistingState)(resolvedIdentity.application_id, { dataRoot: root });
      const ledgerEvents = new ApplicationLedger({ dataRoot: root }).eventStore.list(resolvedIdentity.application_id);
      if (retryProviderFailure) {
        const previousProviders = [...new Set((saved.values?.evaluation?.provider_attempts || []).map((attempt) => attempt.provider).filter(Boolean))];
        if (!previousProviders.length || previousProviders.some((provider) => !providerAvailability.unavailableProviders.includes(provider))) {
          throw new Error('Provider-failure retry override must cover every provider in the saved failed attempt.');
        }
      }
      assertCheckpointDomainConsistency({
        values: saved.values, expectedApplicationId: resolvedIdentity.application_id,
        expectedUrl: queueItem.url, canonicalState: canonical, ledgerEvents,
        allowProviderFailureRetry: retryProviderFailure, dataRoot: root
      });
    }
    const result = await graph.invoke(graphInput, config);
    const canonical = result.application_id ? (dependencies.readExistingState || readExistingState)(result.application_id, { dataRoot: root }) : null;
    runStats.jobs_fetched = 1;
    runStats.shortlisted = ['SHORTLISTED', 'CV_GENERATED', 'CV_VALIDATED'].includes(canonical?.state) ? 1 : 0;
    runStats.cv_generated = ['CV_GENERATED', 'CV_VALIDATED'].includes(canonical?.state) ? 1 : 0;
    runStats.cv_validated = canonical?.state === 'CV_VALIDATED' ? 1 : 0;
    runStats.pending_jobs_after = getAutonomousPendingQueueStats(queueFile).pending;
    runStats.blocked_jobs = getAutonomousPendingQueueStats(queueFile).blocked;
    runStats.pending_jobs_processed = result.queue_acknowledged === true ? 1 : 0;
    runStats.finished_at = new Date();
    persistRun();
    return {
      success: !String(result.status || '').startsWith('BLOCKED'), run_id: runId,
      application_id: result.application_id || canonical?.application_id || null,
      thread_id: graphThreadId, status: result.status || 'INTERRUPTED',
      canonical_state: canonical?.state || result.canonical_state || null,
      jd_hash: result.jd_hash || result.job?.jdHash || null,
      evaluation_status: result.evaluation?.status || null,
      fit_status: result.fit?.status || null,
      interrupted_at: result.__interrupt__?.[0]?.value?.type || null,
      queue_acknowledged: result.queue_acknowledged === true,
      quota_known: false, quota_remaining: 'UNKNOWN',
      provider_call_status: runStats.provider_call_status,
      provider_usable: runStats.provider_usable,
      provider_availability_overrides: runStats.provider_availability_overrides,
      models_used: runStats.models_used.map(({ application_id, requested_tier, provider, model_id, exact_inventory_match, incremental_cost, attempt, call_status, error_code }) => ({
        application_id, requested_tier, provider, requested_model_id: model_id,
        exact_inventory_match, incremental_cost, attempt, call_status, error_code
      })),
      pending_jobs_before: before.pending, pending_jobs_after: runStats.pending_jobs_after
    };
  } catch (error) {
    runStats.finished_at = new Date();
    runStats.errors.push(error?.code ? `Graph run failed (${String(error.code).slice(0, 80)}).` : 'Graph run failed; details withheld from the durable receipt.');
    runStats.pending_jobs_after = getAutonomousPendingQueueStats(queueFile).pending;
    runStats.blocked_jobs = getAutonomousPendingQueueStats(queueFile).blocked;
    try { persistRun(); } catch {}
    throw error;
  } finally {
    try { store?.close(); } finally { lock.release(); }
  }
}

export async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${QUEUE_RUNNER_USAGE}\n`);
    return;
  }
  const args = parseQueueRunnerArgs(argv);
  const result = await runOneQueuedEvaluation(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'LangGraph queue run failed.');
    process.exitCode = 1;
  });
}
