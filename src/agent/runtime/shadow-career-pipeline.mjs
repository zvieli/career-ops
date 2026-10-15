// @ts-check
import { normalizeUrl } from '../../../url-key.mjs';
import { detectRequiredEligibility, evaluateCandidateFit } from '../domain/candidate/candidate-fit-gate.mjs';
import { mapWithConcurrency } from './operational-budgets.mjs';

const ACTIVE = new Set(['active', 'ACTIVE']);
const STAGES = Object.freeze(['DISCOVERY', 'NORMALIZATION', 'DEDUP', 'HYDRATION', 'LIVENESS', 'FIT_EVALUATION', 'REVIEW_MATERIALIZATION', 'LOCAL_REVIEW_RECONCILIATION']);
const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
const BUDGET_METRICS = Object.freeze({ providerAttempts: 'provider_attempts', providerOperations: 'provider_operations', providerSuccesses: 'provider_successes', providerFailures: 'provider_failures', retries: 'retries', rateLimits: 'rate_limits', providerSourcesSkippedBudget: 'provider_sources_skipped_budget', securityFailures: 'security_failures' });
const safeWarnings = values => values.filter(value => typeof value === 'string').map(value => value.replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ').slice(0, 160)).slice(0, 20);
function identity(job) {
  const listing = job.listingIdentity;
  if (listing && typeof listing.ats_provider === 'string' && typeof listing.board_slug === 'string' && typeof listing.posting_id === 'string'
    && listing.ats_provider && listing.board_slug && listing.posting_id) return `listing:${listing.ats_provider}:${listing.board_slug}:${listing.posting_id}`;
  return `url:${normalizeUrl(job.url)}`;
}
function ensureActive(signal, heartbeat) {
  if (signal?.aborted) throw signal.reason || Object.assign(new Error('Shadow run cancelled.'), { code: 'SHADOW_CANCELLED' });
  if (heartbeat && heartbeat() !== true) throw Object.assign(new Error('Scheduler lease ownership was lost.'), { code: 'LEASE_OWNERSHIP_LOST' });
}

/** One bounded scheduled shadow pass. Production services are assembled only by trusted-shadow-executor.mjs. */
export async function runShadowCareerPipeline({ runContext, budgets, services, signal = runContext?.signal, onStage } = {}) {
  if (!runContext || !budgets || !services || typeof services.discover !== 'function' || typeof services.hydrate !== 'function'
    || typeof services.checkLiveness !== 'function' || typeof services.evaluate !== 'function'
    || typeof services.materialize !== 'function' || typeof services.reconcile !== 'function') {
    throw new Error('Shadow pipeline requires the trusted stage services and run context.');
  }
  const maxJobs = budgets.maxJobs ?? budgets.runBudget?.limits?.maxJobs;
  const concurrency = budgets.maxConcurrency ?? budgets.runBudget?.limits?.maxConcurrency ?? 1;
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 100 || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 10) throw new Error('Invalid shadow run budgets.');
  const counters = {};
  const timings = {};
  const stageReceipts = [];
  const warnings = [];
  const candidates = [];
  const reviewTasks = [];
  const heartbeat = runContext.heartbeat;
  const mark = (key, amount = 1) => { counters[key] = (counters[key] || 0) + amount; };
  async function stage(name, fn, timing = null) {
    ensureActive(signal, heartbeat);
    const start = nowMs();
    const countersAtStart = { ...counters };
    const budgetAtStart = Object.fromEntries(Object.keys(BUDGET_METRICS).map(key => [key, budgets.runBudget?.[key] || 0]));
    const stageCounters = () => {
      const delta = {};
      for (const [key, value] of Object.entries(counters)) {
        const amount = value - (countersAtStart[key] || 0);
        if (amount > 0) delta[key] = amount;
      }
      for (const [budgetKey, metricKey] of Object.entries(BUDGET_METRICS)) {
        const amount = (budgets.runBudget?.[budgetKey] || 0) - budgetAtStart[budgetKey];
        if (amount > 0) delta[metricKey] = (delta[metricKey] || 0) + amount;
      }
      return delta;
    };
    let outcome = 'COMPLETED'; let detail = {};
    try { detail = await fn() || {}; }
    catch (error) {
      outcome = error?.code === 'SHADOW_CANCELLED' || signal?.aborted ? 'DEFERRED' : 'FAILED';
      stageReceipts.push({ stage: name, outcome, elapsed_ms: Math.max(0, Math.round(nowMs() - start)), warnings: [String(error?.code || error?.name || 'STAGE_FAILURE').slice(0, 80)] });
      if (timing) timings[timing] = Math.max(0, Math.round(nowMs() - start));
      await onStage?.({ stage: name, outcome, counters: stageCounters(), timings: { ...timings }, warnings: safeWarnings(warnings) });
      throw error;
    }
    if (timing) timings[timing] = Math.max(0, Math.round(nowMs() - start));
    const receipt = { stage: name, outcome, elapsed_ms: Math.max(0, Math.round(nowMs() - start)), ...detail };
    stageReceipts.push(receipt);
    await onStage?.({ stage: name, outcome, counters: stageCounters(), timings: { ...timings }, warnings: safeWarnings(warnings) });
    return detail;
  }

  let rawJobs = [];
  await stage('DISCOVERY', async () => {
    const discovery = await services.discover({ runContext, limit: maxJobs, signal, budgets });
    if (Array.isArray(discovery)) rawJobs = discovery;
    else if (discovery && Array.isArray(discovery.jobs)) {
      rawJobs = discovery.jobs;
      for (const [key, value] of Object.entries(discovery.counters || {})) if (Number.isSafeInteger(value) && value >= 0) mark(key, value);
      if (Number.isSafeInteger(discovery.jobs_discovered_raw) && discovery.jobs_discovered_raw >= 0) mark('jobs_discovered_raw', discovery.jobs_discovered_raw);
      if (Number.isSafeInteger(discovery.jobs_duplicate) && discovery.jobs_duplicate >= 0) mark('jobs_duplicate', discovery.jobs_duplicate);
      if (Number.isSafeInteger(discovery.capacity_skipped_rediscoverable) && discovery.capacity_skipped_rediscoverable >= 0) mark('capacity_skipped_rediscoverable', discovery.capacity_skipped_rediscoverable);
      if (Array.isArray(discovery.warnings)) warnings.push(...discovery.warnings.filter(value => typeof value === 'string'));
    } else throw Object.assign(new Error('Discovery returned a malformed response.'), { code: 'MALFORMED_RESPONSE' });
    if (!Number.isSafeInteger(counters.jobs_discovered_raw)) mark('jobs_discovered_raw', rawJobs.length);
    return { observed: counters.jobs_discovered_raw || rawJobs.length };
  }, 'discovery_ms');

  const unique = new Map();
  let admitted = [];
  await stage('NORMALIZATION', async () => {
    for (const job of rawJobs) {
      ensureActive(signal, heartbeat);
      if (!job || typeof job.title !== 'string' || !job.title.trim() || typeof job.url !== 'string') { mark('security_failures'); continue; }
      const normalizedUrl = normalizeUrl(job.url);
      if (!normalizedUrl) { mark('security_failures'); continue; }
      const normalized = { ...job, url: normalizedUrl };
      mark('jobs_normalized');
      let key;
      try { key = identity(normalized); } catch { mark('security_failures'); continue; }
      if (unique.has(key)) { mark('jobs_duplicate'); continue; }
      unique.set(key, normalized);
    }
    mark('jobs_unique', unique.size);
    return { observed: unique.size };
  });
  await stage('DEDUP', async () => {
    const selected = [...unique.values()].slice(0, maxJobs);
    const excess = unique.size - selected.length;
    if (excess > 0) { mark('capacity_skipped_rediscoverable', excess); warnings.push('MAX_JOBS_REACHED'); }
    for (const job of selected) {
      const decision = budgets.runBudget?.admitJob?.() || { admitted: true };
      if (!decision.admitted) { mark('capacity_skipped_rediscoverable'); warnings.push(decision.code || 'RUN_BUDGET_EXHAUSTED'); continue; }
      admitted.push(job);
    }
    return { observed: unique.size };
  });

  let hydrated = [];
  await stage('HYDRATION', async () => {
    const results = await mapWithConcurrency(admitted, concurrency, async job => {
      ensureActive(signal, heartbeat);
      const value = await services.hydrate(job, { signal, runContext });
      if (!value || typeof value.jdText !== 'string') return null;
      if (value.hydration_status === 'FULL') mark('jobs_hydrated');
      else mark('jobs_hydration_incomplete');
      return { ...value, job: value.job || job };
    });
    hydrated = results.filter(Boolean);
    mark('jobs_hydration_skipped_rediscoverable', admitted.length - hydrated.length);
    return { observed: hydrated.length };
  }, 'hydration_ms');

  let liveJobs = [];
  await stage('LIVENESS', async () => {
    const results = await mapWithConcurrency(hydrated, concurrency, async item => {
      ensureActive(signal, heartbeat);
      mark('jobs_liveness_checked');
      const status = await services.checkLiveness(item, { signal, runContext });
      if (status?.reason === 'RUN_BUDGET_EXHAUSTED') mark('liveness_checks_skipped_budget');
      const verdict = status?.result || status;
      if (verdict === 'expired' || verdict === 'EXPIRED') { mark('jobs_expired'); return null; }
      if (!ACTIVE.has(verdict)) mark('jobs_liveness_uncertain');
      return { ...item, liveness: typeof status === 'string' ? { result: status } : (status || { result: 'uncertain' }), livenessUncertain: !ACTIVE.has(verdict) };
    });
    liveJobs = results.filter(Boolean);
    // Expired jobs are excluded, not queued for deferred work.
    return { observed: liveJobs.length };
  });

  await stage('FIT_EVALUATION', async () => {
    const results = await mapWithConcurrency(liveJobs, concurrency, async item => {
      ensureActive(signal, heartbeat);
      const evaluation = await services.evaluate(item, { runContext, signal });
      const fit = evaluation?.fit || evaluateCandidateFit({
        evaluation, candidateFacts: runContext.candidateFacts || {}, title: item.job.title,
        requiredEligibility: detectRequiredEligibility(item.jdText)
      });
      mark('jobs_fit_evaluated');
      if (['STRONG', 'REASONABLE'].includes(fit.status)) mark('jobs_shortlisted');
      return { ...item, evaluation, fit };
    });
    candidates.push(...results);
    return { observed: candidates.length };
  }, 'evaluation_ms');

  await stage('REVIEW_MATERIALIZATION', async () => {
    for (const candidate of candidates) {
      ensureActive(signal, heartbeat);
      try {
        const result = await services.materialize(candidate, { runContext, signal });
        if (result?.blockedAction) mark('shadow_actions_blocked');
        if (result?.reviewTask) {
          reviewTasks.push(result.reviewTask);
          mark(result.reused ? 'reviews_reused' : 'reviews_created');
        }
        if (result?.notificationQueued) mark('notifications_queued');
        if (result?.securityFailure) mark('security_failures');
      } catch (error) {
        if (signal?.aborted || ['LEASE_OWNERSHIP_LOST', 'SHADOW_CANCELLED'].includes(error?.code)) throw error;
        mark('security_failures'); warnings.push(`MATERIALIZATION_FAILED:${String(error?.code || error?.name || 'ERROR').slice(0, 60)}`);
      }
    }
    return { observed: reviewTasks.length };
  });

  let reconciliation = null;
  await stage('LOCAL_REVIEW_RECONCILIATION', async () => {
    ensureActive(signal, heartbeat);
    reconciliation = await services.reconcile({ runContext, candidates, reviewTasks, signal });
    return { observed: reconciliation?.reconciled ?? 0 };
  }, 'reconciliation_ms');
  const failedStages = stageReceipts.some(receipt => receipt.outcome === 'FAILED');
  warnings.push(...(Array.isArray(runContext.warnings) ? runContext.warnings : []));
  const safeFinalWarnings = [...new Set(warnings.filter(value => typeof value === 'string').map(value => value.replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ').slice(0, 160)))].slice(0, 100);
  return {
    status: failedStages || warnings.length ? 'DEGRADED' : 'COMPLETED', work_performed: rawJobs.length > 0,
    discovered: rawJobs.length, normalized: counters.jobs_normalized || 0, evaluated: candidates.length,
    counters, timings, stages: stageReceipts.map(receipt => receipt.stage), stage_receipts: stageReceipts,
    warnings: safeFinalWarnings, candidates, reviewTasks, reconciliation
  };
}

export const SHADOW_PIPELINE_STAGES = STAGES;
