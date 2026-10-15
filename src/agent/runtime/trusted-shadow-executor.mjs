// @ts-check
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import greenhouse from '../../../providers/greenhouse.mjs';
import lever from '../../../providers/lever.mjs';
import { makeHttpCtx } from '../../../providers/_http.mjs';
import { normalizeUrl } from '../../../url-key.mjs';
import { buildTitleFilter } from '../../../title-keywords.mjs';
import { buildLocationFilter } from '../../../lib/location-filter.mjs';
import { parseBlacklist, findBlacklistEntry } from '../../../lib/blacklist.mjs';
import { resolveAtsApi, checkLivenessViaApi } from '../../../liveness-api.mjs';
import { getCareerOpsRoot } from '../../../path-resolver.mjs';
import { withPipelineLock } from '../../../pipeline-lock.mjs';
import { ApplicationLedger, createApplicationEventEmitter } from '../infrastructure/persistence/application-ledger.mjs';
import { resolveApplicationIdentity } from '../domain/applications/application-identity.mjs';
import { getState, readExistingState, transitionState } from '../domain/applications/application-state-machine.mjs';
import { HumanReviewTaskStore, hashHumanReviewEvidence } from '../infrastructure/persistence/human-review-task-store.mjs';
import { executeProviderBounded, mapWithConcurrency, RunBudget, createOperationalLimits } from './operational-budgets.mjs';
import { decideOperation, OPERATION_CLASSES, SHADOW_MODE } from './shadow-policy.mjs';
import { recordShadowActionReceipt } from '../infrastructure/persistence/shadow-action-store.mjs';
import { createStageRecorder } from '../infrastructure/persistence/stage-metrics.mjs';
import { runShadowCareerPipeline } from './shadow-career-pipeline.mjs';

const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const APPROVED_PROVIDERS = Object.freeze({ greenhouse, lever });
const FORBIDDEN_FILTERS = Object.freeze(['skip_tiers', 'field_filters', 'max_posting_age_days', 'salary_filter', 'content_filter', 'country_eligibility_filter', 'visa_filter', 'title_filter_overrides', 'company_aliases', 'dedup_include_location', 'dedup_include_language', 'recheck_after_days']);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_DESCRIPTION_CHARS = 120_000;

function resolvePortalsPath(dataRoot) {
  const configured = process.env.CAREER_OPS_PORTALS;
  return configured ? resolve(configured) : join(dataRoot, 'portals.yml');
}
function loadPortals(dataRoot) {
  const path = resolvePortalsPath(dataRoot);
  if (!existsSync(path)) return { config: {}, entries: [], warnings: ['PORTALS_CONFIG_MISSING'] };
  const config = yaml.load(readFileSync(path, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Scheduler portal config must be a YAML mapping.');
  const entries = [...(Array.isArray(config.tracked_companies) ? config.tracked_companies : []), ...(Array.isArray(config.job_boards) ? config.job_boards : [])]
    .filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry) && entry.enabled !== false && typeof entry.name === 'string' && entry.name.trim());
  return { config, entries, warnings: [] };
}
function assertSupportedFilterPolicy(config) {
  const unsupported = FORBIDDEN_FILTERS.filter(key => config[key] !== undefined && config[key] !== null && config[key] !== false && !(Array.isArray(config[key]) && config[key].length === 0) && !(typeof config[key] === 'object' && Object.keys(config[key]).length === 0));
  if (config.scan_history && typeof config.scan_history === 'object' && Object.keys(config.scan_history).length) unsupported.push('scan_history');
  for (const entry of [...(config.tracked_companies || []), ...(config.job_boards || [])]) {
    const filterOn = entry?.filter_on;
    if (filterOn !== undefined && !(filterOn === 'title' || (Array.isArray(filterOn) && filterOn.length === 1 && filterOn[0] === 'title'))) unsupported.push(`filter_on:${entry.name || 'unnamed'}`);
    if (entry?.aggregator === true) unsupported.push(`aggregator:${entry.name || 'unnamed'}`);
  }
  if (unsupported.length) throw Object.assign(new Error(`Scheduled shadow discovery cannot safely apply configured policies: ${unsupported.join(', ')}`), { code: 'UNSUPPORTED_FILTER_POLICY' });
}
function assertRunActive(runContext, signal) {
  if (signal?.aborted) throw signal.reason || Object.assign(new Error('Scheduled run cancelled.'), { code: 'SHADOW_CANCELLED' });
  if (runContext?.heartbeat && runContext.heartbeat() !== true) throw Object.assign(new Error('Scheduler lease ownership was lost.'), { code: 'LEASE_OWNERSHIP_LOST' });
}
function makeReadContext({ signal, budget }) {
  return makeHttpCtx({
    onRequest() {
      if (signal?.aborted) throw signal.reason || new Error('Scheduled provider request cancelled.');
      const exhausted = budget.check({ providerWork: true });
      if (exhausted) throw Object.assign(new Error('Provider request budget exhausted.'), { code: 'RUN_BUDGET_EXHAUSTED' });
      budget.providerAttempts++;
    }
  }, { signal, getOnly: true, maxResponseBytes: MAX_RESPONSE_BYTES });
}
function validateProviderJobs(providerId, jobs) {
  if (!Array.isArray(jobs)) throw Object.assign(new Error(`${providerId} returned a malformed job list.`), { code: 'MALFORMED_RESPONSE' });
  if (jobs.some(job => !job || typeof job !== 'object' || Array.isArray(job) || typeof job.title !== 'string' || !job.title.trim() || typeof job.url !== 'string' || !job.url.trim() || typeof job.company !== 'string' || !job.company.trim() || typeof job.location !== 'string' || (job.description !== undefined && typeof job.description !== 'string'))) throw Object.assign(new Error(`${providerId} returned a malformed job item.`), { code: 'MALFORMED_RESPONSE' });
}

/** Trusted production dependency construction. No caller-supplied providers or callbacks. */
function buildTrustedShadowExecutor({ dataRoot = getCareerOpsRoot(), maxJobs = 100, maxRunMs = 30 * 60_000, providerRegistry = APPROVED_PROVIDERS, livenessCheck = checkLivenessViaApi } = {}) {
  const root = resolve(dataRoot);
  const limits = createOperationalLimits({ maxJobs, maxRunMs });
  const budget = new RunBudget({ limits });
  const circuits = new Map();
  const reviewStore = new HumanReviewTaskStore({ dataRoot: root });
  const ledger = new ApplicationLedger({ dataRoot: root });
  const emit = createApplicationEventEmitter(ledger, 'scheduled-shadow-v09');
  let config;
  let entries;
  let blacklist;

  async function initializeDiscovery(runContext) {
    if (config) return;
    const loaded = loadPortals(root); config = loaded.config; entries = loaded.entries;
    runContext.warnings.push(...loaded.warnings);
    assertSupportedFilterPolicy(config);
    const profilePath = process.env.CAREER_OPS_PROFILE ? resolve(CODE_ROOT, process.env.CAREER_OPS_PROFILE) : join(root, 'config', 'profile.yml');
    if (existsSync(profilePath)) {
      const profile = yaml.load(readFileSync(profilePath, 'utf8')) || {};
      if (profile.re_apply_windows && Object.keys(profile.re_apply_windows).length) throw Object.assign(new Error('Scheduled shadow discovery cannot safely apply profile re_apply_windows.'), { code: 'UNSUPPORTED_FILTER_POLICY' });
    }
    const blacklistPath = join(root, 'data', 'blacklist.md');
    blacklist = existsSync(blacklistPath) ? parseBlacklist(readFileSync(blacklistPath, 'utf8')) : new Map();
  }

  const services = {
    async discover({ runContext, limit, signal }) {
      await initializeDiscovery(runContext);
      const titleFilter = buildTitleFilter(config.title_filter);
      const locationFilter = buildLocationFilter(config.location_filter);
      const providers = [];
      for (const entry of entries) {
        const providerId = typeof entry.provider === 'string' ? entry.provider.toLowerCase() : null;
        if (providerId && !Object.hasOwn(providerRegistry, providerId)) { runContext.warnings.push(`PROVIDER_NOT_ALLOWLISTED:${providerId}`); continue; }
        const provider = providerId ? providerRegistry[providerId] : Object.values(providerRegistry).find(candidate => candidate.detect?.(entry));
        if (!provider || !provider.detect?.(entry)) { runContext.warnings.push(`PROVIDER_UNAVAILABLE:${entry.name}`); continue; }
        providers.push({ entry, provider });
      }
      const admitted = providers.slice(0, budget.limits.maxProviderAttempts);
      if (providers.length > admitted.length) { budget.providerSourcesSkippedBudget += providers.length - admitted.length; runContext.warnings.push('PROVIDER_ATTEMPT_BUDGET_EXHAUSTED'); }
      const raw = []; const seen = new Set(); let rawCount = 0; let duplicateCount = 0; let filteredCount = 0; let capacitySkipped = 0;
      await mapWithConcurrency(admitted, budget.limits.maxConcurrency, async ({ entry, provider }) => {
        if (signal?.aborted) return;
        const auth = decideOperation({ mode: SHADOW_MODE, operation: OPERATION_CLASSES.EXTERNAL_READ, action: 'FETCH_PUBLIC_JOB', reason: 'Allowlisted public ATS discovery GET', runId: runContext.runId, provider: provider.id, method: 'GET' });
        if (!auth.allowed) { budget.securityFailures++; runContext.warnings.push(`EXTERNAL_READ_BLOCKED:${provider.id}`); return; }
        const result = await executeProviderBounded(provider.id, async ({ signal: requestSignal }) => {
          const ctx = makeReadContext({ signal: requestSignal, budget });
          const jobs = await provider.fetch(entry, ctx);
          validateProviderJobs(provider.id, jobs);
          return jobs;
        }, { budget, circuits, signal, countAttempt: false });
        if (result.status !== 'SUCCESS') {
          if (result.code === 'RUN_BUDGET_EXHAUSTED') { budget.providerSourcesSkippedBudget++; return; }
          if (result.error_code === 'SHADOW_METHOD_BLOCKED' || result.error_code === 'RESPONSE_TOO_LARGE') budget.securityFailures++;
          runContext.warnings.push(`${provider.id}:${result.failure || result.code || result.status}`);
          return;
        }
        for (const sourceJob of result.value) {
          rawCount++;
          const job = { ...sourceJob, company: sourceJob.company || entry.name, provider: provider.id, source_provenance: { provider: provider.id, board: entry.name } };
          const canonicalUrl = normalizeUrl(job.url);
          if (!canonicalUrl || typeof job.title !== 'string' || !job.title.trim()) { budget.securityFailures++; continue; }
          if (!titleFilter(job.title) || !locationFilter(job.location, canonicalUrl, job.title) || findBlacklistEntry(blacklist, job.company, canonicalUrl)) { filteredCount++; continue; }
          const listing = job.listingIdentity;
          const key = listing && typeof listing.ats_provider === 'string' && typeof listing.board_slug === 'string' && typeof listing.posting_id === 'string'
            ? `listing:${listing.ats_provider}:${listing.board_slug}:${listing.posting_id}` : `url:${canonicalUrl}`;
          if (seen.has(key)) { duplicateCount++; continue; }
          seen.add(key);
          if (raw.length >= limit) { capacitySkipped++; continue; }
          raw.push({ ...job, url: canonicalUrl });
        }
      });
      return { jobs: raw, jobs_discovered_raw: rawCount, jobs_duplicate: duplicateCount, counters: { jobs_filtered: filteredCount }, capacity_skipped_rediscoverable: capacitySkipped };
    },
    async hydrate(job) {
      const text = typeof job.description === 'string' ? job.description.replace(/\s+/g, ' ').trim() : '';
      const jdText = text.slice(0, MAX_DESCRIPTION_CHARS);
      const providerLimit = job.provider === 'greenhouse' ? 4_000 : MAX_DESCRIPTION_CHARS;
      const complete = text.length > 0 && text.length < providerLimit && text.length <= MAX_DESCRIPTION_CHARS;
      return { job, jdText, hydration_status: !text ? 'MISSING' : complete ? 'FULL' : 'PARTIAL', hydration_source: `${job.provider}_listing_api`, content_hash: createHash('sha256').update(text).digest('hex'), hydrated_at: new Date().toISOString() };
    },
    async checkLiveness(item, { signal, runContext }) {
      const resolved = resolveAtsApi(item.job.url);
      if (!resolved || !['greenhouse', 'lever'].includes(resolved.ats)) return { result: 'uncertain', reason: 'ATS_LIVENESS_UNSUPPORTED' };
      const auth = decideOperation({ mode: SHADOW_MODE, operation: OPERATION_CLASSES.EXTERNAL_READ, action: 'CHECK_PUBLIC_JOB_LIVENESS', reason: 'Allowlisted public ATS liveness GET', runId: runContext.runId, provider: resolved.ats, method: 'GET' });
      if (!auth.allowed) { budget.securityFailures++; return { result: 'uncertain', reason: 'EXTERNAL_READ_BLOCKED' }; }
      const result = await executeProviderBounded(resolved.ats, async ({ signal: requestSignal }) => {
        const transport = makeReadContext({ signal: requestSignal, budget });
        const verdict = await livenessCheck(item.job.url, { signal: requestSignal, throwErrors: true, transport });
        return verdict || { result: 'uncertain', reason: 'LIVENESS_UNCONFIRMED' };
      }, { budget, circuits, signal, countAttempt: false });
      if (result.status !== 'SUCCESS') {
        if (result.code === 'RUN_BUDGET_EXHAUSTED') budget.livenessChecksSkippedBudget++;
        if (result.error_code === 'SHADOW_METHOD_BLOCKED' || result.error_code === 'RESPONSE_TOO_LARGE') budget.securityFailures++;
        return { result: 'uncertain', reason: result.code || result.failure || result.status };
      }
      return result.value;
    },
    async evaluate(item, { runContext }) {
      // Model extraction has no caller cancellation and can invoke an unrestricted gateway.
      // The scheduled path therefore uses the conservative deterministic gate only.
      const policy = item.livenessUncertain ? 'LIVENESS_UNCONFIRMED' : item.hydration_status !== 'FULL' ? 'JD_CONTENT_INCOMPLETE' : 'CONSERVATIVE_NO_MODEL_EXTRACTION';
      const evaluation = { status: 'NEEDS_REVIEW', extraction: null, policy };
      const { evaluateCandidateFit, detectRequiredEligibility } = await import('../domain/candidate/candidate-fit-gate.mjs');
      return { ...evaluation, fit: evaluateCandidateFit({ evaluation, candidateFacts: runContext.candidateFacts || {}, title: item.job.title, requiredEligibility: detectRequiredEligibility(item.jdText) }) };
    },
    async materialize(candidate, { runContext, signal }) {
      const job = candidate.job;
      const guard = () => assertRunActive(runContext, signal);
      const identityPath = join(root, 'data', 'application-identities.json');
      const identity = await withPipelineLock(identityPath, () => {
        assertRunActive(runContext, signal);
        return resolveApplicationIdentity({
          provider: job.provider, company: job.company, externalId: job.externalId || job.listingIdentity?.posting_id || job.id, requisitionId: job.requisitionId || job.reqId, url: job.url
        }, { dataRoot: root });
      });
      assertRunActive(runContext, signal);
      if (!identity.mergeable || !/^app-[a-f0-9]{24}$/i.test(identity.application_id)) { budget.securityFailures++; return { securityFailure: true }; }
      const decisions = reviewStore.list({ applicationId: identity.application_id }).filter(task => task.status === 'DECIDED');
      const blocked = decisions.map(task => task.decision).filter(decision => ['FILL_APPLICATION', 'CONTINUE_MANUALLY', 'PREPARE_APPLICATION', 'SUBMIT_APPLICATION', 'SEND_RECRUITER', 'SUPPLY_FACT', 'ACCEPT_CALENDAR_INVITE', 'CONFIRM_MANUAL_SUBMISSION', 'EDIT_REQUIRED', 'REFILL_REQUIRED'].includes(decision));
      if (blocked.length) {
        for (const action of blocked) {
          assertRunActive(runContext, signal);
          await recordShadowActionReceipt({ dataRoot: root, run_id: runContext.runId, application_id: identity.application_id, action, reason: 'BLOCKED_BY_SHADOW_MODE', created_at: new Date().toISOString() }, { signal, guard });
        }
        return { blockedAction: true };
      }
      const statePath = join(root, 'data', 'applications', identity.application_id, 'state.json');
      return withPipelineLock(statePath, async () => {
        assertRunActive(runContext, signal);
        let state = readExistingState(identity.application_id, { dataRoot: root });
        if (!state) state = getState(identity.application_id, { dataRoot: root });
        if (!state || !['DISCOVERED', 'NORMALIZED', 'DEDUPED', 'NEEDS_REVIEW'].includes(state.state)) return {};
        const listingHash = createHash('sha256').update(JSON.stringify([job.url, job.title, candidate.content_hash])).digest('hex');
        assertRunActive(runContext, signal);
        await emit(identity.application_id, 'JOB_DISCOVERED', `shadow:${identity.application_id}:discovered:${listingHash}`, { url: job.url, title: job.title, company: job.company || '' }, undefined, { signal, guard });
        assertRunActive(runContext, signal);
        if (state.state === 'DISCOVERED') state = transitionState(identity.application_id, 'NORMALIZED', { title: job.title, company: job.company || '', url: job.url }, { dataRoot: root });
        if (state.state === 'NORMALIZED') { assertRunActive(runContext, signal); state = transitionState(identity.application_id, 'DEDUPED', { dedupKey: identity.identity_basis, url: job.url }, { dataRoot: root }); }
        const hydrationHash = createHash('sha256').update(JSON.stringify([job.url, job.provider, candidate.hydration_status, candidate.content_hash])).digest('hex');
        assertRunActive(runContext, signal);
        await emit(identity.application_id, 'JOB_HYDRATED', `shadow:${identity.application_id}:hydrated:${hydrationHash}`, { url: job.url, provider: job.provider, hydration_status: candidate.hydration_status, content_hash: candidate.content_hash }, undefined, { signal, guard });
        const fit = candidate.fit;
        if (state.state === 'DEDUPED') {
          assertRunActive(runContext, signal);
          if (fit.status === 'STRONG' || fit.status === 'REASONABLE') {
            state = transitionState(identity.application_id, 'FIT_EVALUATED', { fitStatus: fit.status, jdHash: candidate.content_hash, reasons: fit.reasons || [] }, { dataRoot: root });
            state = transitionState(identity.application_id, 'SHORTLISTED', { fitStatus: fit.status, jdHash: candidate.content_hash, reasons: fit.reasons || [] }, { dataRoot: root });
          } else {
            state = transitionState(identity.application_id, 'NEEDS_REVIEW', { reviewType: 'candidate_fit', reason: candidate.evaluation?.policy || 'FIT_EVIDENCE_UNAVAILABLE', reviewEvidence: { jdHash: candidate.content_hash, fitStatus: fit.status }, jdHash: candidate.content_hash }, { dataRoot: root });
          }
        }
        const evaluationHash = createHash('sha256').update(JSON.stringify({ content_hash: candidate.content_hash, fit_status: fit.status, reasons: fit.reasons || [], extraction_status: candidate.evaluation?.status || 'UNKNOWN', policy: candidate.evaluation?.policy || null })).digest('hex');
        assertRunActive(runContext, signal);
        await emit(identity.application_id, 'JOB_EVALUATED', `shadow:${identity.application_id}:fit:${evaluationHash}`, { fit_status: fit.status, reasons: fit.reasons || [], extraction_status: candidate.evaluation?.status || 'UNKNOWN' }, undefined, { signal, guard });
        if (!['NEEDS_REVIEW', 'SHORTLISTED'].includes(state.state)) return {};
        const evidence = { canonical_state: state.state, canonical_version: state.version, posting_url: job.url, provider: job.provider, title: job.title, company: job.company || '', jd_hash: candidate.content_hash, hydration_status: candidate.hydration_status, liveness: candidate.liveness?.result || 'active', fit_status: fit.status, fit_reasons: fit.reasons || [], evaluation_status: candidate.evaluation?.status || 'UNKNOWN' };
        const sourceEvent = `shadow:${identity.application_id}:${candidate.content_hash}:candidate-fit`;
        const evidenceHash = hashHumanReviewEvidence(evidence);
        const priorTask = reviewStore.list({ applicationId: identity.application_id }).find(task => task.review_type === 'CANDIDATE_FIT_REVIEW' && task.source_event === sourceEvent && task.evidence_hash === evidenceHash && ['OPEN', 'CLAIMED', 'DECIDED'].includes(task.status));
        const priorNotification = reviewStore.notificationOutbox.list().some(item => item.review_task_id === priorTask?.review_task_id);
        assertRunActive(runContext, signal);
        const task = await reviewStore.create({ application_id: identity.application_id, review_type: 'CANDIDATE_FIT_REVIEW', source_event: sourceEvent, expected_state: state.state, evidence, reason: (fit.reasons || ['Conservative scheduled assessment requires human review.']).join(' '), company: job.company || '', role: job.title }, { signal, guard });
        return { reviewTask: task, reused: Boolean(priorTask), notificationQueued: !priorNotification };
      });
    },
    async reconcile({ runContext, reviewTasks, signal }) {
      let reviews = 0;
      const guard = () => assertRunActive(runContext, signal);
      for (const task of reviewTasks.slice(0, limits.maxJobs)) {
        assertRunActive(runContext, signal);
        if (task.review_type !== 'CANDIDATE_FIT_REVIEW' || task.graph_thread_id) continue;
        await reviewStore.create({ application_id: task.application_id, review_type: task.review_type, source_event: task.source_event, expected_state: task.expected_state, evidence: task.evidence, allowed_decisions: task.allowed_decisions, reason: task.reason, company: task.company, role: task.role }, { signal, guard });
        reviews++;
      }
      return { reconciled: reviews, reviews_reconciled: reviews, notification_intents_reconciled: reviews };
    }
  };

  return async function execute(runContext) {
    budget.startedAt = Date.now(); budget.jobs = 0; budget.providerAttempts = 0; budget.providerOperations = 0; budget.providerFailures = 0; budget.retries = 0; budget.rateLimits = 0; budget.providerSuccesses = 0; budget.providerSourcesSkippedBudget = 0; budget.livenessChecksSkippedBudget = 0; budget.securityFailures = 0;
    runContext.warnings ||= [];
    const recorder = createStageRecorder({ runId: runContext.runId, dataRoot: root });
    const recordedCounters = {};
    const recordStage = receipt => {
      const saved = recorder.record(receipt);
      for (const [key, value] of Object.entries(receipt.counters || {})) recordedCounters[key] = (recordedCounters[key] || 0) + value;
      return saved;
    };
    try {
      const result = await runShadowCareerPipeline({ runContext, budgets: { runBudget: budget, maxJobs: runContext.maxJobs ?? limits.maxJobs, maxConcurrency: limits.maxConcurrency }, services, signal: runContext.signal, onStage: recordStage });
      result.counters.retries = budget.retries;
      result.counters.rate_limits = budget.rateLimits;
      result.counters.provider_successes = budget.providerSuccesses;
      result.counters.provider_operations = budget.providerOperations;
      result.counters.provider_failures = budget.providerFailures;
      result.counters.provider_attempts = budget.providerAttempts;
      const metricsFinal = recorder.finalize({ totalRunMs: Math.max(0, Date.now() - budget.startedAt), counters: result.counters, warnings: result.warnings.slice(0, 100) });
      return { ...result, metricsFinal };
    } catch (error) {
      recorder.finalize({ totalRunMs: Math.max(0, Date.now() - budget.startedAt), counters: recordedCounters, warnings: [String(error?.code || error?.name || 'RUN_FAILURE').slice(0, 160)] });
      throw error;
    }
  };
}

/** Project-owned production executor. Provider and liveness capabilities are fixed here. */
export function createTrustedShadowExecutor(options = {}) {
  return buildTrustedShadowExecutor({ dataRoot: options.dataRoot ?? getCareerOpsRoot(), maxJobs: options.maxJobs ?? 100, maxRunMs: options.maxRunMs ?? 30 * 60_000 });
}

/** Explicit test seam; re-exported only by runtime/testing/shadow-executor-test-seam.mjs. */
export function createTrustedShadowExecutorForTest({ dataRoot, maxJobs = 100, maxRunMs = 30 * 60_000, providers, livenessCheck } = {}) {
  if (!providers || typeof providers !== 'object' || Array.isArray(providers) || Object.keys(providers).some(id => !['greenhouse', 'lever'].includes(id))
    || Object.entries(providers).some(([id, provider]) => provider?.id !== id || typeof provider.fetch !== 'function' || typeof provider.detect !== 'function')
    || typeof livenessCheck !== 'function') throw new TypeError('Test executor requires fixture-only Greenhouse/Lever provider adapters and a liveness stub.');
  return buildTrustedShadowExecutor({ dataRoot: dataRoot ?? getCareerOpsRoot(), maxJobs, maxRunMs, providerRegistry: Object.freeze({ ...providers }), livenessCheck });
}
