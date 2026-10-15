import { appendRunEvent, getRun } from './agent-run-store.mjs';

export const SHADOW_STAGES = Object.freeze([
  'DISCOVERY', 'NORMALIZATION', 'DEDUP', 'HYDRATION', 'LIVENESS', 'FIT_EVALUATION',
  'REVIEW_MATERIALIZATION', 'LOCAL_REVIEW_RECONCILIATION'
]);
export const SHADOW_COUNTERS = Object.freeze([
  'jobs_discovered_raw', 'jobs_normalized', 'jobs_duplicate', 'jobs_filtered', 'jobs_unique', 'jobs_hydrated',
  'jobs_liveness_checked', 'jobs_liveness_uncertain', 'jobs_expired', 'jobs_hydration_incomplete', 'jobs_fit_evaluated', 'jobs_shortlisted', 'reviews_created', 'reviews_reused',
  'notifications_queued', 'provider_attempts', 'provider_operations', 'provider_successes', 'provider_failures', 'retries',
  'rate_limits', 'capacity_skipped_rediscoverable', 'provider_sources_skipped_budget', 'liveness_checks_skipped_budget',
  'jobs_hydration_skipped_rediscoverable', 'shadow_actions_blocked', 'security_failures'
]);
export const SHADOW_TIMINGS = Object.freeze([
  'discovery_ms', 'hydration_ms', 'evaluation_ms', 'reconciliation_ms', 'total_run_ms'
]);
const STAGE_SET = new Set(SHADOW_STAGES);
const COUNTER_SET = new Set(SHADOW_COUNTERS);
const TIMING_SET = new Set(SHADOW_TIMINGS);
const OUTCOMES = new Set(['COMPLETED', 'FAILED', 'SKIPPED', 'DEFERRED']);
const MAX_RECEIPTS = SHADOW_STAGES.length;

function boundedMetrics(values, allowed, label) {
  if (values === undefined) return {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new TypeError(`${label} must be an object.`);
  const output = {};
  for (const [key, value] of Object.entries(values)) {
    if (!allowed.has(key)) throw new Error(`Unknown metric: ${key}`);
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${key} must be a non-negative safe integer.`);
    output[key] = value;
  }
  return output;
}

/** Append cumulative, truthful stage evidence to the existing append-only run ledger. */
export function createStageRecorder({ runId, dataRoot, filePath, clock = () => new Date() } = {}) {
  if (typeof runId !== 'string' || !runId) throw new TypeError('runId is required.');
  const stages = new Set();
  let sequence = 0;
  let counters = {};
  let timings = {};
  let receipts = [];
  const options = { dataRoot, filePath };
  function persist(eventId, timestamp) {
    appendRunEvent(runId, 'RUNNING', {
      event_id: eventId,
      timestamp,
      stages: [...stages],
      counters,
      timings,
      stage_receipts: receipts
    }, options);
  }
  return Object.freeze({
    record({ stage, outcome, counters: observedCounters, timings: observedTimings, warnings = [] } = {}) {
      if (!STAGE_SET.has(stage)) throw new Error(`Unknown stage: ${String(stage)}`);
      if (!OUTCOMES.has(outcome)) throw new Error(`Unknown stage outcome: ${String(outcome)}`);
      if (stages.has(stage)) throw new Error(`Stage already recorded: ${stage}`);
      if (!Array.isArray(warnings) || warnings.length > 20 || warnings.some(value => typeof value !== 'string' || value.length > 160 || /[\r\n\u0000-\u001f]/.test(value))) throw new Error('Stage warnings must be bounded single-line strings.');
      const stageCounters = boundedMetrics(observedCounters, COUNTER_SET, 'counters');
      const stageTimings = boundedMetrics(observedTimings, TIMING_SET, 'timings');
      stages.add(stage); sequence++;
      counters = Object.fromEntries([...Object.entries(counters), ...Object.entries(stageCounters)].reduce((map, [key, value]) => map.set(key, (map.get(key) || 0) + value), new Map()));
      timings = { ...timings, ...stageTimings };
      receipts = [...receipts, { stage, outcome, counters: stageCounters, timings: stageTimings, warnings: [...warnings], timestamp: clock().toISOString() }];
      if (receipts.length > MAX_RECEIPTS) throw new Error('Too many stage receipts.');
      const latest = getRun(runId, options);
      const at = clock();
      const time = at instanceof Date ? at.toISOString() : new Date(at).toISOString();
      if (Date.parse(time) < Date.parse(latest.timestamp)) throw new Error('Stage timestamp precedes the latest run receipt.');
      persist(`STAGE-${sequence}-${stage}`, time);
      return receipts.at(-1);
    },
    finalize({ totalRunMs, counters: finalCounters, timings: finalTimings = {}, warnings = [] } = {}) {
      if (!Number.isSafeInteger(totalRunMs) || totalRunMs < 0) throw new RangeError('totalRunMs must be a non-negative safe integer.');
      if (TIMING_SET.has('total_run_ms') && timings.total_run_ms !== undefined) throw new Error('Run summary already finalized.');
      const safeCounters = boundedMetrics(finalCounters, COUNTER_SET, 'counters');
      const safeTimings = boundedMetrics(finalTimings, TIMING_SET, 'timings');
      if (finalCounters !== undefined) counters = safeCounters;
      timings = { ...timings, ...safeTimings, total_run_ms: totalRunMs };
      const event = `RUN-SUMMARY-${sequence + 1}`;
      if (!OUTCOMES.has('COMPLETED')) throw new Error('Invalid completion outcome.');
      const latest = getRun(runId, options);
      const at = clock();
      const time = at instanceof Date ? at.toISOString() : new Date(at).toISOString();
      if (Date.parse(time) < Date.parse(latest.timestamp)) throw new Error('Run summary timestamp precedes the latest run receipt.');
      appendRunEvent(runId, 'RUNNING', { event_id: event, timestamp: time, stages: [...stages], counters, timings, stage_receipts: receipts, warnings }, options);
      return { stages: [...stages], counters: { ...counters }, timings: { ...timings }, stage_receipts: [...receipts] };
    }
  });
}
