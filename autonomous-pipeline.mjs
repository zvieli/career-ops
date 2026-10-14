// @ts-check
/**
 * Legacy discovery -> exact JD -> verified zero-cost evaluation pipeline.
 * No posting is submitted or form interacted with. The legacy path stops after
 * CV_VALIDATED; ATS preparation requires explicit authorization in LangGraph.
 */
import { execFileSync } from 'node:child_process';
import { isMainModule } from './lib/is-main-module.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { acquirePipelineLock } from './pipeline-lock.mjs';
import { acknowledgeAutonomousPendingJob, blockAutonomousPendingJob, getAutonomousPendingQueueStats, mergeAutonomousPendingJobs, readAutonomousPendingJobs } from './lib/autonomous-pending-queue.mjs';
import { evaluateJob } from './lib/job-evaluator.mjs';
import { createZeroCostProviderRunner } from './lib/llm/provider-runner.mjs';
import { isZeroCostModel } from './lib/zero-cost-router.mjs';
import { detectRequiredEligibility, evaluateCandidateFit, FIT_POLICY_VERSION } from './lib/candidate-fit-gate.mjs';
import { extractExplicitGpaScale } from './lib/gpa-scale.mjs';
import { resolveApplicationIdentity } from './lib/application-identity.mjs';
import { generateTailoringPatch } from './lib/cv-tailoring-engine.mjs';
import { applyLatexPatch } from './lib/latex-patcher.mjs';
import { validatePdf } from './lib/pdf-validator.mjs';
import { transitionState, getState, hashReviewEvidence, resumeReviewWithChangedEvidence } from './lib/application-state-machine.mjs';
import { isSupportedAtsApplicationUrl } from './lib/autofill-engine.mjs';
import { recordRun } from './lib/run-reporter.mjs';
import { ApplicationLedger, createApplicationEventEmitter, recordJobDiscoveryEvent, semanticFitEventType } from './lib/application-ledger.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { checkLivenessViaApi } from './liveness-api.mjs';
import { isAggregatorUrl, normalizeUrl } from './url-key.mjs';
import * as yaml from 'js-yaml';

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));

/** Lock target for one complete autonomous run; distinct from scan.mjs's pipeline write lock. */
export function getAutonomousRunLockTarget(root) {
  return join(root, 'data', 'autonomous-v1');
}

export function isRecoverableApplicationState(state) {
  return ['DISCOVERED', 'NORMALIZED', 'DEDUPED'].includes(state);
}

export function isQueueTerminalState(state, metadata = {}) {
  if (state === 'NEEDS_REVIEW') return !isRetryableEvaluationReview(metadata.NEEDS_REVIEW || {});
  return ['REJECTED_BY_POLICY', 'LONG_STRETCH', 'NEEDS_USER_FACT', 'BLOCKED_CAPTCHA',
    'FORM_PREFILLED_RESUME_PENDING', 'READY_FOR_HUMAN', 'CANDIDATE_SUBMITTED'].includes(state);
}

export function recordModelAttempt(runStats, applicationId, { modelId, tier, attempt }) {
  const tierName = tier === 1 || tier === 'system1' ? 'system1' : tier === 2 || tier === 'system2' ? 'system2' : `tier-${tier ?? 'unknown'}`;
  const exactInventoryMatch = isZeroCostModel(modelId);
  if (tierName === 'system1') runStats.system1_calls++;
  if (tierName === 'system2') runStats.system2_calls++;
  runStats.models_used.push({ application_id: applicationId, tier: tierName, model_id: modelId,
    cost_status: exactInventoryMatch ? 'VERIFIED_ZERO_COST' : 'UNVERIFIED', exact_inventory_match: exactInventoryMatch,
    incremental_cost: exactInventoryMatch ? 0 : null, quota_remaining: 'UNKNOWN', attempt, call_status: 'STARTED' });
}

export function recordModelResult(runStats, applicationId, result) {
  const record = [...runStats.models_used].reverse().find((item) => item.application_id === applicationId
    && item.model_id === result.modelId && item.attempt === result.attempt && item.call_status === 'STARTED');
  if (!record) throw new Error(`Model result had no matching attempt receipt for ${applicationId}/${result.modelId}.`);
  record.call_status = 'SUCCESS';
  record.latency_ms = result.latency_ms;
  record.exact_inventory_match = result.exact_inventory_match === true && isZeroCostModel(result.modelId);
  record.incremental_cost = record.exact_inventory_match ? 0 : null;
  runStats.provider_call_status = 'SUCCESS';
  runStats.provider_usable = 'YES';
}

export function recordModelFailure(runStats, applicationId, failure) {
  const record = [...runStats.models_used].reverse().find((item) => item.application_id === applicationId
    && item.model_id === failure.modelId && item.attempt === failure.attempt && item.call_status === 'STARTED');
  if (record) {
    record.call_status = 'FAILED';
    record.error_code = String(failure.error_code || 'PROVIDER_EXECUTION_FAILED').slice(0, 80);
  }
  if (runStats.provider_call_status !== 'SUCCESS') {
    runStats.provider_call_status = 'FAILED';
    runStats.provider_usable = 'NO';
  }
}

function findPersistedUrlAlias(root, normalizedUrl) {
  const registryPath = join(root, 'data', 'application-identities.json');
  if (!existsSync(registryPath)) return null;
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  for (const [applicationId, aliases] of Object.entries(registry.application_aliases || {})) {
    const alias = aliases.find((item) => item.kind === 'url' && item.value === normalizedUrl);
    if (alias) return { applicationId, company: alias.company || '' };
  }
  return null;
}

/** Reattach exact company/ATS identity metadata to a controlled URL from prior scan evidence. */
export function hydrateDirectJobFromHistory(root, url) {
  const fallback = { url, company: '', title: '', provider: 'direct-url', identityScopePreserved: false };
  const historyPath = join(root, 'data', 'scan-history.tsv');
  if (!existsSync(historyPath)) return fallback;
  const lines = readFileSync(historyPath, 'utf8').trimEnd().split(/\r?\n/);
  if (lines.length < 2) return fallback;
  const headers = lines[0].split('\t');
  const urlIndex = headers.indexOf('url');
  if (urlIndex < 0) return fallback;
  const normalizedTarget = normalizeUrl(url);
  for (const line of lines.slice(1)) {
    const values = line.split('\t');
    if (normalizeUrl(values[urlIndex] || '') !== normalizedTarget) continue;
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
    const persistedAlias = findPersistedUrlAlias(root, normalizedTarget);
    const normalizedCompany = row.normalized_company || '';
    const identityConflict = Boolean(persistedAlias?.company && normalizedCompany && persistedAlias.company !== normalizedCompany);
    if (identityConflict) {
      return {
        ...fallback, company: row.company, title: row.title, provider: row.portal || fallback.provider,
        requisitionId: row.requisition_id || undefined, identityConflict: true, identityScopePreserved: true
      };
    }
    const company = persistedAlias ? (persistedAlias.company ? row.company : '') : row.company;
    const identityMetadataMatches = !persistedAlias || (persistedAlias.company && persistedAlias.company === normalizedCompany);
    return {
      ...fallback,
      company,
      title: row.title,
      provider: row.portal || fallback.provider,
      requisitionId: identityMetadataMatches ? (row.requisition_id || undefined) : undefined,
      identityScopePreserved: Boolean(persistedAlias)
    };
  }
  return fallback;
}

export function hydrateScannedJobFromHistory(root, job) {
  const history = hydrateDirectJobFromHistory(root, job.url);
  if (history.identityConflict) return { ...job, identityConflict: true };
  const usePersistedScope = history.identityScopePreserved;
  return {
    ...job,
    company: usePersistedScope ? history.company : (job.company || history.company),
    title: job.title || history.title,
    provider: job.provider || history.provider,
    requisitionId: usePersistedScope ? history.requisitionId : (job.requisitionId || history.requisitionId)
  };
}

export function getPipelineReadinessState(readyForHuman, quotaRemaining, providerUsable = 'UNKNOWN') {
  if (Number.isFinite(quotaRemaining) && quotaRemaining <= 0) return 'NEEDS_REVIEW';
  if (providerUsable === 'NO') return 'NEEDS_REVIEW';
  return readyForHuman ? 'READY_FOR_HUMAN' : 'NOT_READY';
}

export function parsePipelineArgs(args) {
  if (args.length === 1 && args[0] === '--queue-only') return { jobUrl: null, queueOnly: true, queueUrl: null, evaluateOnly: false };
  const queueUrlIndex = args.indexOf('--queue-url');
  if (queueUrlIndex !== -1) {
    const queueUrl = args[queueUrlIndex + 1];
    const remaining = args.filter((_, index) => index !== queueUrlIndex && index !== queueUrlIndex + 1);
    if (queueUrlIndex !== 0 || !/^https?:\/\//i.test(queueUrl || '') || remaining.some((arg) => arg !== '--evaluate-only')) {
      throw new Error('Usage: node autonomous-pipeline.mjs --queue-url <http(s) URL> [--evaluate-only]');
    }
    return { jobUrl: null, queueOnly: true, queueUrl, evaluateOnly: remaining.includes('--evaluate-only') };
  }
  const jobUrlIndex = args.indexOf('--job-url');
  if (jobUrlIndex === -1) {
    if (args.length) throw new Error(`Unsupported argument: ${args[0]}`);
    return { jobUrl: null, queueOnly: false, queueUrl: null, evaluateOnly: false };
  }
  if (args.length !== 2 || jobUrlIndex !== 0 || !/^https?:\/\//i.test(args[1])) {
    throw new Error('Usage: node autonomous-pipeline.mjs [--queue-only | --queue-url <URL> [--evaluate-only] | --job-url <http(s) URL>]');
  }
  return { jobUrl: args[1], queueOnly: false, queueUrl: null, evaluateOnly: false };
}

export function isRetryableEvaluationReview(metadata = {}) {
  if (metadata.reviewType === 'evaluation_failure') return true;
  if (metadata.reviewType) return false;
  return ['ALL_ZERO_COST_MODELS_UNAVAILABLE', 'INVALID_MODEL_OUTPUT'].includes(metadata.reason);
}

export function isVerifiedPosting(job) {
  return Boolean(job && typeof job.url === 'string' && /^https?:\/\//i.test(job.url)
    && job.verification_status === 'active');
}

export function isVerifiedEmployerPosting(job) {
  return isVerifiedPosting(job) && !isAggregatorUrl(job.url);
}

/** Allow at most one live form preparation per run, and only for an active supported ATS posting. */
export function createSingleFormPreparationGate() {
  let attempted = false;
  return (job) => {
    if (attempted || !isVerifiedEmployerPosting(job) || !isSupportedAtsApplicationUrl(job.url)) return false;
    attempted = true;
    return true;
  };
}

export function parseScanReceipt(stdout) {
  const receipt = JSON.parse(stdout);
  if (receipt.version !== 'careerops.scan.receipt@1' || !Array.isArray(receipt.added_jobs)) {
    throw new Error('scan.mjs returned an unsupported receipt; refusing to evaluate incomplete discovery output');
  }
  return receipt.added_jobs.filter(isVerifiedPosting);
}

export function parseFetchedJd(stdout) {
  const text = String(stdout || '').trim();
  const separator = text.indexOf('\n\n');
  if (separator === -1) return { title: '', jdText: text };
  return { title: text.slice(0, separator).trim(), jdText: text.slice(separator + 2).trim() };
}

function runNodeScript(script, args, timeout = 60_000) {
  return execFileSync(process.execPath, [join(REPO_ROOT, script), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true
  });
}

export const MAX_AUTONOMOUS_JOBS_PER_RUN = 10;
export const MAX_QUEUED_LIVENESS_AGE_MS = 30 * 60 * 1000;

export function isQueuedLivenessFresh(job, now = Date.now()) {
  if (job?.verification_status !== 'active') return false;
  const verifiedAt = Date.parse(job.liveness_verified_at || '');
  const age = now - verifiedAt;
  return Number.isFinite(verifiedAt) && age >= 0 && age <= MAX_QUEUED_LIVENESS_AGE_MS;
}

export function selectPendingJobsForRun(jobs, limit = MAX_AUTONOMOUS_JOBS_PER_RUN) {
  return Array.isArray(jobs) ? jobs.slice(0, Math.max(0, Math.min(MAX_AUTONOMOUS_JOBS_PER_RUN, limit))) : [];
}

export function selectQueuedJobByUrl(jobs, url) {
  const key = normalizeUrl(url);
  const match = jobs.find((job) => normalizeUrl(job.url) === key);
  if (!match) throw new Error(`Requested URL is not present in the existing queue: ${url}`);
  return [match];
}

async function discoverJobs(jobUrl, root, { queueOnly = false, queueUrl = null } = {}) {
  if (jobUrl) return { jobs: [hydrateDirectJobFromHistory(root, jobUrl)], newJobs: 1, queueFile: null, pendingBefore: 0, blockedBefore: 0 };
  const queueFile = join(root, 'data', 'autonomous-pending.json');
  let scannedJobs = [];
  if (!queueOnly) {
    const receipt = runNodeScript('scan.mjs', ['--verify', '--json', '--quiet', '--autonomous-queue'], 15 * 60_000);
    scannedJobs = parseScanReceipt(receipt).filter((job) => !isAggregatorUrl(job.url));
    if (scannedJobs.length) await mergeAutonomousPendingJobs(queueFile, scannedJobs);
  }
  const queueStats = getAutonomousPendingQueueStats(queueFile);
  let queuedJobs = readAutonomousPendingJobs(queueFile);
  if (queueUrl) queuedJobs = selectQueuedJobByUrl(queuedJobs, queueUrl);
  return {
    jobs: queuedJobs.map((job) => hydrateScannedJobFromHistory(root, job)),
    newJobs: scannedJobs.length, queueFile, pendingBefore: queueStats.pending, blockedBefore: queueStats.blocked
  };
}

function loadProfile(root) {
  const profilePath = join(root, 'config', 'profile.yml');
  if (!existsSync(profilePath)) return {};
  return yaml.load(readFileSync(profilePath, 'utf8')) || {};
}

function loadCvMarkdown(root) {
  const cvPath = join(root, 'cv.md');
  return existsSync(cvPath) ? readFileSync(cvPath, 'utf8') : '';
}

export function candidateFactsFromSources(profile = {}, cvMarkdown = '') {
  const candidate = profile?.candidate || {};
  const educationSection = String(cvMarkdown).split(/^##\s+/m).find((section) => /^Education\b/i.test(section.trim()));
  const education = educationSection?.replace(/^Education\b[^\n]*\n?/i, '') || '';
  const cvDegreeLine = education.split(/\r?\n/).find((line) => /\b(?:B\.?\s?Sc\.?|B\.?\s?A\.?|Bachelor(?:'s)?|M\.?\s?Sc\.?|Master(?:'s)?|Ph\.?D\.?)/i.test(line));
  const cvDegree = cvDegreeLine?.match(/\*\*([^*]+)\*\*/)?.[1].trim() || cvDegreeLine?.replace(/[*_]/g, '').split(/[—–]/)[0].trim();
  const cvGpa = education.match(/\bGPA\s*:\s*([0-9]+(?:\.[0-9]+)?)/i)?.[1];
  const profileGpaKey = Number.isFinite(candidate.gpa_value) ? 'gpa_value' : Number.isFinite(candidate.gpa) ? 'gpa' : null;
  const profileGpa = profileGpaKey ? candidate[profileGpaKey] : undefined;
  const profileGpaScale = typeof candidate.gpa_scale === 'string' ? candidate.gpa_scale : undefined;
  const professionalYoeKey = Number.isFinite(candidate.professional_yoe_years) ? 'professional_yoe_years' : Number.isFinite(candidate.professional_years) ? 'professional_years' : null;
  const professionalYoe = professionalYoeKey ? candidate[professionalYoeKey] : undefined;
  const professionalYoeVerified = candidate.professional_yoe_verified === true;
  const degrees = Array.isArray(candidate.degrees) && candidate.degrees.length ? candidate.degrees : (cvDegree ? [cvDegree] : undefined);
  const fullName = typeof candidate.full_name === 'string' && candidate.full_name.trim() ? candidate.full_name.trim() : undefined;
  const explicitFirstName = typeof candidate.first_name === 'string' && candidate.first_name.trim() ? candidate.first_name.trim() : undefined;
  const explicitLastName = typeof candidate.last_name === 'string' && candidate.last_name.trim() ? candidate.last_name.trim() : undefined;
  const profileGraduationYear = Number.isInteger(candidate.graduation_year) ? candidate.graduation_year : undefined;
  const markedGraduationYears = [...education.matchAll(/\b(?:graduated|graduation year)\s*[:\-]?\s*((?:19|20|21)\d{2})\b/gi)].map((match) => Number(match[1]));
  const uniqueMarkedGraduationYears = [...new Set(markedGraduationYears)];
  const cvGraduationYear = uniqueMarkedGraduationYears.length === 1 ? uniqueMarkedGraduationYears[0] : undefined;
  const graduationYear = profileGraduationYear ?? cvGraduationYear;
  const graduationYearSource = profileGraduationYear !== undefined ? 'config/profile.yml:candidate.graduation_year' : cvGraduationYear !== undefined ? 'cv.md:Education' : undefined;
  return {
    full_name: fullName,
    full_name_source: fullName ? 'config/profile.yml:candidate.full_name' : undefined,
    first_name: explicitFirstName,
    first_name_source: explicitFirstName ? 'config/profile.yml:candidate.first_name' : undefined,
    last_name: explicitLastName,
    last_name_source: explicitLastName ? 'config/profile.yml:candidate.last_name' : undefined,
    email: typeof candidate.email === 'string' && candidate.email ? candidate.email : undefined,
    email_source: candidate.email ? 'config/profile.yml:candidate.email' : undefined,
    phone: typeof candidate.phone === 'string' && candidate.phone ? candidate.phone : undefined,
    phone_source: candidate.phone ? 'config/profile.yml:candidate.phone' : undefined,
    linkedin: typeof candidate.linkedin === 'string' && candidate.linkedin ? candidate.linkedin : undefined,
    linkedin_source: candidate.linkedin ? 'config/profile.yml:candidate.linkedin' : undefined,
    github: typeof candidate.github === 'string' && candidate.github ? candidate.github : undefined,
    github_source: candidate.github ? 'config/profile.yml:candidate.github' : undefined,
    portfolio_url: typeof candidate.portfolio_url === 'string' && candidate.portfolio_url ? candidate.portfolio_url : undefined,
    portfolio_url_source: candidate.portfolio_url ? 'config/profile.yml:candidate.portfolio_url' : undefined,
    website: typeof candidate.website === 'string' && candidate.website ? candidate.website : undefined,
    website_source: candidate.website ? 'config/profile.yml:candidate.website' : undefined,
    location: typeof candidate.location === 'string' && candidate.location ? candidate.location : undefined,
    location_source: candidate.location ? 'config/profile.yml:candidate.location' : undefined,
    professional_years: professionalYoe,
    professional_years_source: professionalYoeVerified ? `config/profile.yml:candidate.${professionalYoeKey}` : candidate.professional_years_source,
    professional_yoe_years: professionalYoe,
    professional_yoe_verified: professionalYoeVerified,
    degrees,
    degrees_source: Array.isArray(candidate.degrees) && candidate.degrees.length ? 'config/profile.yml:candidate.degrees' : (cvDegree ? 'cv.md:Education' : undefined),
    graduation_year: graduationYear,
    graduation_year_source: graduationYearSource,
    gpa: profileGpa ?? (cvGpa ? Number(cvGpa) : undefined),
    gpa_source: profileGpa !== undefined ? `config/profile.yml:candidate.${profileGpaKey}` : (cvGpa ? 'cv.md:Education' : undefined),
    gpa_scale: profileGpaScale ?? extractExplicitGpaScale(education, cvGpa),
    gpa_scale_source: profileGpaScale ? 'config/profile.yml:candidate.gpa_scale' : extractExplicitGpaScale(education, cvGpa) ? 'cv.md:Education' : undefined,
    work_authorization: candidate.work_authorization,
    work_authorization_source: candidate.work_authorization !== undefined ? 'config/profile.yml:candidate.work_authorization' : undefined
  };
}

function fetchJobDescription(url) {
  const stdout = runNodeScript('fetch-jd.mjs', [url], 30_000);
  const result = parseFetchedJd(stdout);
  if (!result.jdText.trim()) throw new Error(`No verbatim JD content returned for ${url}`);
  return result;
}

function stateFileExists(root, applicationId) {
  return existsSync(join(root, 'data', 'applications', applicationId, 'state.json'));
}

/** Run the same evaluator path for scheduled discovery and a controlled URL. */
export async function runAutonomousPipeline(options = {}) {
  const root = getCareerOpsRoot();
  const startedAt = new Date();
  const runId = `run-${randomUUID()}`;
  const lock = await acquirePipelineLock(getAutonomousRunLockTarget(root), { run_id: runId, timeoutMs: 5000 });
  const ledger = options.applicationLedger || new ApplicationLedger({ dataRoot: root });
  const emitApplicationEvent = options.emitApplicationEvent || createApplicationEventEmitter(ledger, 'legacy-autonomous');
  const runStats = {
    run_id: runId,
    started_at: startedAt,
    finished_at: startedAt,
    jobs_fetched: 0,
    new_jobs: 0,
    duplicates: 0,
    deterministic_rejects: 0,
    system1_calls: 0,
    system2_calls: 0,
    cache_hits: 0,
    shortlisted: 0,
    cv_generated: 0,
    cv_validated: 0,
    forms_filled: 0,
    ready_for_human: false,
    needs_user_fact: false,
    blocked_captcha: false,
    quota_observable: false,
    quota_known: false,
    quota_remaining: 'UNKNOWN',
    quota_status: 'UNKNOWN',
    provider_call_status: 'NOT_ATTEMPTED',
    provider_usable: 'UNKNOWN',
    models_used: [],
    pending_jobs_before: 0,
    pending_jobs_after: 0,
    pending_jobs_processed: 0,
    blocked_jobs: 0,
    errors: []
  };
  const results = [];

  try {
    const profile = loadProfile(root);
    const cvMd = loadCvMarkdown(root);
    const candidateFacts = candidateFactsFromSources(profile, cvMd);
    const cvTexPath = join(REPO_ROOT, 'cv', 'lior_zvieli_cv.tex');
    const cvTex = existsSync(cvTexPath) ? readFileSync(cvTexPath, 'utf8') : '';
    const discovery = await discoverJobs(options.jobUrl || null, root, {
      queueOnly: options.queueOnly === true,
      queueUrl: options.queueUrl || null
    });
    const jobs = discovery.jobs;
    const jobsToProcess = discovery.queueFile ? selectPendingJobsForRun(jobs) : jobs;
    runStats.new_jobs = discovery.newJobs;
    runStats.pending_jobs_before = discovery.pendingBefore;
    runStats.blocked_jobs = discovery.blockedBefore;

    if (!jobsToProcess.length) {
      runStats.finished_at = new Date();
      runStats.pending_jobs_after = discovery.pendingBefore;
      runStats.errors.push(discovery.blockedBefore ? 'No active pending jobs; blocked queue entries require review.' : 'Discovery returned no new eligible jobs.');
      recordRun(runStats);
      return { success: false, runId, state: 'NO_NEW_JOBS', jobs: [], submitClicked: false,
        pending_jobs: discovery.pendingBefore, blocked_jobs: discovery.blockedBefore };
    }

    for (const discovered of jobsToProcess) {
      let identity = null;
      try {
      runStats.jobs_fetched++;
      if (discovered.identityConflict) {
        results.push({ state: 'NEEDS_REVIEW', reason: 'Persisted URL identity conflicts with current scan employer metadata; refusing evaluation.' });
        runStats.errors.push(`Identity conflict for controlled URL: ${discovered.url}`);
        if (discovery.queueFile) await blockAutonomousPendingJob(discovery.queueFile, discovered.url, 'identity_scope_conflict');
        continue;
      }
      if (isAggregatorUrl(discovered.url)) {
        results.push({ state: 'NEEDS_REVIEW', reason: 'Aggregator listings require confirmation at the employer before evaluation.' });
        runStats.errors.push(`Unconfirmed aggregator posting: ${discovered.url}`);
        continue;
      }
      const queueLivenessFresh = discovery.queueFile && isQueuedLivenessFresh(discovered);
      if (!queueLivenessFresh) {
        const liveness = await checkLivenessViaApi(discovered.url);
        if (liveness?.result !== 'active') {
          results.push({ state: 'NEEDS_REVIEW', reason: `Employer ATS liveness is unconfirmed${liveness?.reason ? `: ${liveness.reason}` : '.'}` });
          runStats.errors.push(`Unconfirmed liveness: ${discovered.url}`);
          if (discovery.queueFile) await blockAutonomousPendingJob(discovery.queueFile, discovered.url, 'liveness_unconfirmed');
          continue;
        }
      }
      identity = resolveApplicationIdentity(discovered, { dataRoot: root });
      await recordJobDiscoveryEvent(emitApplicationEvent, identity.application_id);
      const runner = createZeroCostProviderRunner({
        onModelAttempt: (attempt) => recordModelAttempt(runStats, identity.application_id, attempt),
        onModelResult: (result) => recordModelResult(runStats, identity.application_id, result),
        onModelFailure: (failure) => recordModelFailure(runStats, identity.application_id, failure)
      });
      const existingState = stateFileExists(root, identity.application_id) ? getState(identity.application_id) : null;
      const resumeReview = existingState?.state === 'NEEDS_REVIEW';
      const recoverableState = isRecoverableApplicationState(existingState?.state);
      const reviewMetadata = existingState?.metadata?.NEEDS_REVIEW || {};
      const retryableEvaluation = resumeReview && isRetryableEvaluationReview(reviewMetadata);
      if (existingState && !resumeReview && !recoverableState) {
        runStats.duplicates++;
        results.push({ application_id: identity.application_id, state: 'DUPLICATE_SKIPPED', identity_basis: identity.identity_basis });
        continue;
      }

      const fetched = fetchJobDescription(discovered.url);
      const job = {
        ...discovered,
        title: discovered.title || fetched.title,
        verification_status: 'active',
        jdText: fetched.jdText
      };
      const reviewEvidence = { fitPolicyVersion: FIT_POLICY_VERSION, title: job.title, jdText: job.jdText, candidateFacts };
      const evidenceHash = hashReviewEvidence(reviewEvidence);
      if (resumeReview && !retryableEvaluation && reviewMetadata.evidenceHash === evidenceHash) {
        runStats.duplicates++;
        results.push({ application_id: identity.application_id, state: 'DUPLICATE_SKIPPED', reason: 'Review evidence unchanged' });
        continue;
      }
      if (!job.title) {
        results.push({ application_id: identity.application_id, state: 'NEEDS_REVIEW', reason: 'JD title missing' });
        continue;
      }

      let changedReviewResumed = false;
      if (retryableEvaluation) {
        transitionState(identity.application_id, 'DEDUPED', { retry: true, evidenceHash });
      } else if (resumeReview) {
        const resumed = resumeReviewWithChangedEvidence(identity.application_id, reviewEvidence);
        if (!resumed.resumed) {
          results.push({ application_id: identity.application_id, state: 'NEEDS_REVIEW', reason: 'Review evidence hash is missing or unchanged; refusing automatic resume.' });
          continue;
        }
        changedReviewResumed = true;
      } else if (existingState?.state === 'NORMALIZED') {
        transitionState(identity.application_id, 'DEDUPED', { identity_basis: identity.identity_basis, recovered_after_interruption: true });
      } else if (existingState?.state !== 'DEDUPED') {
        transitionState(identity.application_id, 'NORMALIZED', { identity, job: { title: job.title, company: job.company, url: job.url, provider: job.provider } });
        transitionState(identity.application_id, 'DEDUPED', { identity_basis: identity.identity_basis });
      }

      const evaluation = await evaluateJob({
        jdText: job.jdText,
        title: job.title,
        company: job.company,
        candidateProfile: { ...profile, verified_candidate_facts: candidateFacts },
        llmRunner: runner,
        dataRoot: root
      });
      if (evaluation.status === 'PASSED' && evaluation.extraction?.gpa !== null) {
        evaluation.extraction.gpa_scale = extractExplicitGpaScale(job.jdText, evaluation.extraction.gpa);
      }

      if (evaluation.status !== 'PASSED') {
        if (!resumeReview || retryableEvaluation || changedReviewResumed) {
          transitionState(identity.application_id, 'NEEDS_REVIEW', {
            evaluation,
            reviewEvidence,
            reason: evaluation.reason || evaluation.error,
            reviewType: evaluation.status === 'NEEDS_REVIEW' ? 'evaluation_failure' : 'evidence_review'
          });
        }
        results.push({ application_id: identity.application_id, state: 'NEEDS_REVIEW', reason: evaluation.reason || evaluation.error });
        runStats.errors.push(`${identity.application_id}: evaluation ${evaluation.status}`);
        continue;
      }

      runStats.cache_hits += evaluation.cached ? 1 : 0;

      const fit = evaluateCandidateFit({
        evaluation,
        candidateFacts,
        title: job.title,
        requiredEligibility: detectRequiredEligibility(job.jdText)
      });
      const fitEventType = semanticFitEventType(fit.status);
      if (fitEventType) {
        await emitApplicationEvent(identity.application_id, fitEventType, `fit:${evidenceHash}:${FIT_POLICY_VERSION}:${fit.status}`, {
          fit_status: fit.status, fit_policy_version: FIT_POLICY_VERSION, evidence_hash: evidenceHash
        });
      }
      transitionState(identity.application_id, 'FIT_EVALUATED', { evaluation, candidate_fit: fit, identity, evidenceHash });
      if (fit.status === 'REJECT') {
        transitionState(identity.application_id, 'REJECTED_BY_POLICY', { candidate_fit: fit });
        runStats.deterministic_rejects++;
        results.push({ application_id: identity.application_id, state: 'REJECTED_BY_POLICY', fit });
        continue;
      }
      if (!['STRONG', 'REASONABLE'].includes(fit.status)) {
        if (fit.status === 'NEEDS_REVIEW') {
          transitionState(identity.application_id, 'NEEDS_REVIEW', { candidate_fit: fit, reviewEvidence, reviewType: 'candidate_fit' });
          runStats.needs_user_fact = true;
        } else if (fit.status === 'LONG_STRETCH') {
          transitionState(identity.application_id, 'LONG_STRETCH', { candidate_fit: fit });
        }
        results.push({ application_id: identity.application_id, state: fit.status, fit });
        continue;
      }

      transitionState(identity.application_id, 'SHORTLISTED', { candidate_fit: fit });
      runStats.shortlisted++;
      if (options.evaluateOnly === true) {
        results.push({ application_id: identity.application_id, state: 'SHORTLISTED', fit, evaluation_only: true });
        continue;
      }
      if (!cvMd || !cvTex) {
        results.push({ application_id: identity.application_id, state: 'NEEDS_REVIEW', reason: 'Canonical CV source missing.' });
        continue;
      }

      const patch = generateTailoringPatch(cvMd, cvTex, { role: job.title, keywords: [] });
      const patchedTex = applyLatexPatch(cvTex, patch);
      transitionState(identity.application_id, 'CV_GENERATED', { patch });
      const cvArtifactHash = createHash('sha256').update(JSON.stringify(patch)).digest('hex');
      await ledger.storeArtifact({ applicationId: identity.application_id, name: 'tailored-cv.tex', content: patchedTex,
        mediaType: 'application/x-tex', producer: 'legacy-autonomous', idempotencyKey: `cv:${cvArtifactHash}` });
      await emitApplicationEvent(identity.application_id, 'CV_GENERATED', `cv:${cvArtifactHash}`, {
        fit_policy_version: FIT_POLICY_VERSION, evidence_hash: evidenceHash
      });
      runStats.cv_generated++;
      const pdfResult = await validatePdf(patchedTex, {
        outputDir: join(root, 'data', 'applications', identity.application_id),
        cvMdPath: join(root, 'cv.md')
      });
      if (!pdfResult.success) throw new Error(`PDF QA gate failed: ${pdfResult.errors.join(', ')}`);
      runStats.cv_validated++;
      const pdfArtifact = await ledger.storeArtifact({ applicationId: identity.application_id, name: 'validated-cv.pdf',
        content: readFileSync(pdfResult.pdfPath), mediaType: 'application/pdf', producer: 'legacy-autonomous', idempotencyKey: `pdf:${evidenceHash}` });
      transitionState(identity.application_id, 'CV_VALIDATED', { pdfPath: pdfResult.pdfPath, artifactId: pdfArtifact.artifact_id });
      await emitApplicationEvent(identity.application_id, 'PDF_VALIDATED', `pdf:${evidenceHash}`, {
        evidence_hash: evidenceHash, qa_status: 'PASS'
      });
      results.push({
        application_id: identity.application_id, state: 'CV_VALIDATED',
        status: 'ATS_PREPARATION_REQUIRES_EXPLICIT_REVIEW', pdfPath: pdfResult.pdfPath,
        reason: 'The legacy pipeline cannot claim an extracted ATS schema. Use the explicit LangGraph PREPARE_APPLICATION review path; no form interaction was attempted.'
      });
      } catch (jobError) {
        const message = jobError instanceof Error ? jobError.message : String(jobError);
        runStats.errors.push(`${identity?.application_id || discovered.url}: ${message}`);
        if (discovery.queueFile && /identity conflict/i.test(message)) {
          await blockAutonomousPendingJob(discovery.queueFile, discovered.url, 'identity_scope_conflict');
        }
        results.push({ application_id: identity?.application_id, state: 'JOB_FAILED', reason: message });
      } finally {
        if (discovery.queueFile) {
          runStats.pending_jobs_processed++;
          try {
            if (identity && stateFileExists(root, identity.application_id)) {
              const state = getState(identity.application_id);
              if (isQueueTerminalState(state.state, state.metadata)) {
                await acknowledgeAutonomousPendingJob(discovery.queueFile, discovered.url);
              } else if (state.state === 'CV_VALIDATED') {
                await blockAutonomousPendingJob(discovery.queueFile, discovered.url, 'ats_preparation_requires_explicit_review');
              } else if (!isRecoverableApplicationState(state.state) && state.state !== 'NEEDS_REVIEW') {
                await blockAutonomousPendingJob(discovery.queueFile, discovered.url, `recovery_required:${state.state}`);
              }
            }
          } catch (queueError) {
            runStats.errors.push(`Pending queue update failed for ${discovered.url}: ${queueError instanceof Error ? queueError.message : String(queueError)}`);
          }
        }
      }
    }

    if (discovery.queueFile) {
      const finalQueueStats = getAutonomousPendingQueueStats(discovery.queueFile);
      runStats.pending_jobs_after = finalQueueStats.pending;
      runStats.blocked_jobs = finalQueueStats.blocked;
    }
    runStats.finished_at = new Date();
    recordRun(runStats);
    const candidateReady = results.some((result) => result.state === 'READY_FOR_HUMAN');
    const state = getPipelineReadinessState(candidateReady, runStats.quota_remaining, runStats.provider_usable);
    const ready = state === 'READY_FOR_HUMAN';
    return { success: ready, runId, state, results, quota_remaining: runStats.quota_remaining, submitClicked: false };
  } catch (err) {
    runStats.finished_at = new Date();
    runStats.ready_for_human = false;
    if (!options.jobUrl) {
      try {
        const queueStats = getAutonomousPendingQueueStats(join(root, 'data', 'autonomous-pending.json'));
        runStats.pending_jobs_after = queueStats.pending;
        runStats.blocked_jobs = queueStats.blocked;
      } catch (queueError) {
        runStats.errors.push(`Pending queue status unavailable: ${queueError instanceof Error ? queueError.message : String(queueError)}`);
      }
    }
    runStats.errors.push(err instanceof Error ? err.message : String(err));
    try { recordRun(runStats); } catch (receiptError) { console.error('Failed to persist failure receipt:', receiptError); }
    throw err;
  } finally {
    await lock.release();
  }
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node autonomous-pipeline.mjs [--queue-only | --queue-url <URL> [--evaluate-only] | --job-url <http(s) URL>]');
  } else {
    let args;
    try {
      args = parsePipelineArgs(argv);
    } catch (error) {
      console.error(error.message);
      process.exit(2);
    }
    runAutonomousPipeline(args)
      .then((result) => {
        if (!result.success) {
          console.error('Autonomous pipeline stopped without verified readiness:');
          console.error(JSON.stringify(result, null, 2));
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify(result, null, 2));
      })
      .catch((error) => {
        console.error('Autonomous pipeline failed:', error.message);
        process.exitCode = 1;
      });
  }
}
