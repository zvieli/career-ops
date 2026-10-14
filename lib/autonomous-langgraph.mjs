import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { Annotation, Command, END, interrupt, START, StateGraph } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { acknowledgeAutonomousPendingJob } from './autonomous-pending-queue.mjs';
import { resolveApplicationIdentity } from './application-identity.mjs';
import { ApplicationLedger, createApplicationEventEmitter, semanticFitEventType } from './application-ledger.mjs';
import { detectRequiredEligibility, evaluateCandidateFit, FIT_POLICY_VERSION } from './candidate-fit-gate.mjs';
import { evaluateJob } from './job-evaluator.mjs';
import { NotificationRouter } from './notification-router.mjs';
import { readExistingState, resumeReviewWithChangedEvidence, transitionState, hashReviewEvidence } from './application-state-machine.mjs';

const CHECKPOINT_DIRECTORY_MODE = 0o700;
const CHECKPOINT_FILE_MODE = 0o600;
export const AUTONOMOUS_GRAPH_NODE_NAMES = Object.freeze([
  'admit', 'hydrate', 'prepare_state', 'evaluate', 'assess_fit', 'persist_fit',
  'candidate_fit_review', 'notify', 'pre_submit_review', 'acknowledge_queue'
]);
const TERMINAL_FIT_STATES = new Set(['REJECTED_BY_POLICY', 'LONG_STRETCH']);
const replace = (fallback = null) => Annotation({ reducer: (_left, right) => right, default: () => fallback });
const appendUnique = () => Annotation({
  reducer: (left, right) => [...new Set([...(left || []), ...(right || [])])],
  default: () => []
});

const GraphState = Annotation.Root({
  input_job: replace(), job: replace(), identity: replace(), application_id: replace(),
  jd_hash: replace(), evaluation: replace(), evaluation_hash: replace(), fit: replace(),
  review_evidence: replace(), review_evidence_hash: replace(), route: replace(''),
  status: replace(''), canonical_state: replace(''), last_event: replace(),
  event_ids: appendUnique(), notification_results: replace([]), queue_acknowledged: replace(false),
  provider_attempts: replace([]), evaluation_attempt: replace(1), requested_tier: replace('SYSTEM1'), human_decision: replace('')
});

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

export function stableEvaluationThreadId(applicationId) {
  if (typeof applicationId !== 'string' || !/^app-[a-z0-9][a-z0-9-]{0,80}$/i.test(applicationId)) {
    throw new Error('A valid application ID is required for graph thread identity.');
  }
  return `careerops-evaluation-v1:${applicationId}`;
}

export function openLangGraphCheckpointStore({ dataRoot = getCareerOpsRoot() } = {}) {
  const root = resolve(dataRoot);
  const directory = join(root, 'data', 'langgraph');
  const dbPath = join(directory, 'checkpoints.sqlite');
  mkdirSync(directory, { recursive: true, mode: CHECKPOINT_DIRECTORY_MODE });
  chmodSync(directory, CHECKPOINT_DIRECTORY_MODE);

  let db;
  try {
    db = new Database(dbPath, { timeout: 5000 });
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('busy_timeout = 5000');
    const checkpointer = new SqliteSaver(db);
    // SqliteSaver exposes setup at runtime, although its declaration marks it protected.
    checkpointer.setup();
    chmodSync(dbPath, CHECKPOINT_FILE_MODE);
    for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(sidecar)) chmodSync(sidecar, CHECKPOINT_FILE_MODE);
    }
    return { checkpointer, db, dbPath, close: () => db.close() };
  } catch (error) {
    try { db?.close(); } catch {}
    throw new Error(`Unable to open local LangGraph SQLite checkpoint store at ${dbPath}.`, { cause: error });
  }
}

const SAFE_ADMISSION_FIELDS = Object.freeze([
  'url', 'title', 'company', 'location', 'provider', 'requisitionId', 'requisition_id', 'externalId', 'external_id',
  'postedAt', 'verification_status', 'liveness_verified_at', 'queue_key', 'queue_status', 'queued_at'
]);

function sanitizeGraphInput(input) {
  if (input === null || input === undefined) return input;
  if (input instanceof Command) {
    if (input.graph !== undefined || input.update !== undefined || (input.goto !== undefined && input.goto.length > 0)) {
      throw new Error('Only resume-only graph commands are supported.');
    }
    const resume = input.resume;
    if (!resume || typeof resume !== 'object' || Array.isArray(resume)) {
      throw new Error('Graph command requires a supported resume decision.');
    }
    const keys = Object.keys(resume);
    if (keys.length === 1 && resume.action === 'evidence_updated') {
      return new Command({ resume: { action: 'evidence_updated' } });
    }
    if (keys.length === 1 && resume.action === 'provider_failure_retry') {
      return new Command({ goto: 'retry_provider_failure' });
    }
    if (keys.length === 1 && ['STOP', 'CONTINUE_MANUALLY'].includes(resume.decision)) {
      return new Command({ resume: { decision: resume.decision } });
    }
    throw new Error('Graph command contains an unsupported resume decision.');
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Graph input must be one existing queue item or a supported resume command.');
  }
  const inputKeys = Object.keys(input);
  if (inputKeys.length !== 1 || inputKeys[0] !== 'input_job') {
    throw new Error('Graph admission accepts only the input_job envelope.');
  }
  const job = input.input_job;
  if (!job || typeof job !== 'object' || typeof job.url !== 'string' || !job.url.trim()) {
    throw new Error('Graph admission requires one URL-addressable existing queue item.');
  }
  const inputJob = {};
  for (const field of SAFE_ADMISSION_FIELDS) {
    if (typeof job[field] === 'string') inputJob[field] = job[field];
  }
  return { input_job: inputJob };
}

function validateJob(job) {
  if (!job || typeof job !== 'object' || typeof job.url !== 'string' || !job.url.trim()) {
    throw new Error('Graph admission requires one URL-addressable existing queue item.');
  }
}

function compactJob(job, identity) {
  return {
    url: job.url,
    title: job.title || '',
    company: job.company || '',
    provider: job.provider || '',
    requisitionId: job.requisitionId || job.requisition_id || null,
    externalId: job.externalId || job.external_id || null,
    verification_status: job.verification_status || 'active',
    liveness_verified_at: job.liveness_verified_at || null,
    jdHash: job.jdHash,
    jdArtifactRef: job.jdArtifactRef,
    identity
  };
}

function expectedCanonicalFitState(fitStatus) {
  if (fitStatus === 'REJECT') return 'REJECTED_BY_POLICY';
  if (fitStatus === 'LONG_STRETCH') return 'LONG_STRETCH';
  if (fitStatus === 'STRONG' || fitStatus === 'REASONABLE') return 'SHORTLISTED';
  return null;
}

export function assertCheckpointDomainConsistency({ values = {}, expectedApplicationId, expectedUrl, canonicalState, ledgerEvents = [], allowProviderFailureRetry = false } = {}) {
  if (values.application_id && values.application_id !== expectedApplicationId) throw new Error('Checkpoint application ID conflicts with the selected queue identity.');
  if (values.job?.url && values.job.url !== expectedUrl) throw new Error('Checkpoint URL conflicts with the selected pending queue item.');
  if (values.input_job) {
    const unknownFields = Object.keys(values.input_job).filter((field) => !SAFE_ADMISSION_FIELDS.includes(field));
    if (unknownFields.length) throw new Error('Checkpoint contains unsupported admission fields; refusing to resume unsafe state.');
  }
  const savedState = values.canonical_state || null;
  const currentState = canonicalState?.state || null;
  if (!currentState) {
    if (savedState && savedState !== 'DISCOVERED') throw new Error('Checkpoint has canonical progress but its domain state is missing.');
    return true;
  }
  if (savedState === currentState) {
    const review = canonicalState.metadata?.NEEDS_REVIEW || {};
    const retryFailureEventExists = ledgerEvents.some((event) => event.type === 'JOB_EVALUATED'
      && event.payload?.jd_hash === values.jd_hash
      && event.payload?.evaluation_status === 'NEEDS_REVIEW'
      && event.payload?.reason === 'PROVIDER_FAILURE_NON_RETRYABLE');
    const explicitProviderRetryEligible = allowProviderFailureRetry && currentState === 'NEEDS_REVIEW'
      && values.status === 'NEEDS_REVIEW' && values.route === 'evaluation_review'
      && values.evaluation?.status === 'NEEDS_REVIEW'
      && values.evaluation?.reason === 'PROVIDER_FAILURE_NON_RETRYABLE'
      && values.job?.jdHash === values.jd_hash && values.job?.url === expectedUrl
      && review.reason === 'PROVIDER_FAILURE_NON_RETRYABLE'
      && review.reviewType === 'evaluation_failure'
      && (review.jdHash === undefined || review.jdHash === values.jd_hash)
      && retryFailureEventExists;
    if (values.jd_hash && ['DEDUPED', 'FIT_EVALUATED', 'SHORTLISTED', 'NEEDS_REVIEW', 'REJECTED_BY_POLICY', 'LONG_STRETCH'].includes(currentState)
      && canonicalState.metadata?.[currentState]?.jdHash !== values.jd_hash && !explicitProviderRetryEligible) {
      throw new Error('Checkpoint JD hash conflicts with canonical application state.');
    }
    if (TERMINAL_FIT_STATES.has(currentState)) {
      const fitStatus = currentState === 'REJECTED_BY_POLICY' ? 'REJECT' : 'LONG_STRETCH';
      if (!ledgerEvents.some((event) => event.type === 'FIT_REJECTED' && event.payload?.fit_status === fitStatus)) {
        throw new Error('Checkpoint terminal state has no matching terminal fit ledger event.');
      }
    }
    if (currentState === 'NEEDS_REVIEW' && values.review_evidence_hash
      && canonicalState.metadata?.NEEDS_REVIEW?.evidenceHash !== values.review_evidence_hash) {
      throw new Error('Checkpoint review evidence conflicts with canonical review state.');
    }
    if (currentState === 'NEEDS_REVIEW' && allowProviderFailureRetry && !explicitProviderRetryEligible) {
      throw new Error('Checkpoint is not an eligible provider-failure review for explicit retry.');
    }
    return true;
  }

  const expectedFitState = expectedCanonicalFitState(values.fit?.status);
  const validJdReference = Boolean(values.job?.jdHash && values.jd_hash === values.job.jdHash);
  if (['DISCOVERED', 'NORMALIZED', 'DEDUPED'].includes(savedState)
    && ['NORMALIZED', 'DEDUPED'].includes(currentState) && validJdReference
    && (currentState !== 'DEDUPED' || canonicalState.metadata?.DEDUPED?.jdHash === values.jd_hash)) return true;
  if (savedState === 'DEDUPED' && currentState === 'FIT_EVALUATED' && expectedFitState
    && values.evaluation?.status === 'PASSED' && validJdReference
    && canonicalState.metadata?.FIT_EVALUATED?.jdHash === values.jd_hash) return true;
  if (['DEDUPED', 'FIT_EVALUATED'].includes(savedState) && expectedFitState === currentState
    && values.evaluation?.status === 'PASSED' && validJdReference
    && canonicalState.metadata?.[currentState]?.jdHash === values.jd_hash
    && canonicalState.metadata?.[currentState]?.fitStatus === values.fit?.status) return true;
  if (['DEDUPED', 'FIT_EVALUATED'].includes(savedState) && currentState === 'NEEDS_REVIEW'
    && values.fit?.status === 'NEEDS_REVIEW'
    && canonicalState.metadata?.NEEDS_REVIEW?.evidenceHash === values.review_evidence_hash
    && canonicalState.metadata?.NEEDS_REVIEW?.jdHash === values.jd_hash) return true;
  if (savedState === 'NEEDS_REVIEW' && currentState === 'DEDUPED') {
    const deduped = canonicalState.metadata?.DEDUPED || {};
    const newEvidenceHash = deduped.reviewEvidenceHash;
    if (canonicalState.metadata?.DEDUPED?.jdHash === values.jd_hash
      && ledgerEvents.some((event) => event.type === 'CANDIDATE_REVIEW_RESUMED'
        && event.payload?.previous_evidence_hash === values.review_evidence_hash
        && event.payload?.new_evidence_hash === newEvidenceHash)) return true;
    if (deduped.jdHash === values.jd_hash && deduped.providerRetryReason === 'PROVIDER_FAILURE_NON_RETRYABLE'
      && Number.isSafeInteger(deduped.providerRetryAttempt)
      && ledgerEvents.some((event) => event.type === 'EVALUATION_RETRY_AUTHORIZED'
        && event.payload?.jd_hash === values.jd_hash
        && event.payload?.evaluation_attempt === deduped.providerRetryAttempt)) return true;
  }
  throw new Error(`Checkpoint/domain state mismatch: checkpoint ${savedState || 'MISSING'}, canonical ${currentState}.`);
}

function readValidatedJobText(job, applicationId, dataRoot) {
  const reference = job.jdArtifactRef;
  if (typeof reference !== 'string' || !reference.startsWith(`${applicationId}/`) || reference.split(/[\\/]/).some((part) => part === '..')) {
    throw new Error('Checkpoint is missing a valid archived JD work reference.');
  }
  const artifactRoot = resolve(dataRoot, 'data', 'application-artifacts');
  const artifactPath = resolve(artifactRoot, reference);
  if (!artifactPath.startsWith(`${artifactRoot}/`)) throw new Error('JD artifact reference escapes the application artifact store.');
  const jdText = readFileSync(artifactPath, 'utf8');
  if (sha256(jdText) !== job.jdHash) throw new Error('Archived JD artifact hash does not match the checkpoint.');
  return jdText;
}

function buildReviewEvidence(job, candidateFacts, fitPolicyVersion) {
  return {
    fitPolicyVersion,
    title: job.title,
    jdHash: job.jdHash,
    candidateFactsHash: hashReviewEvidence(candidateFacts)
  };
}

function assertGraphEventResult(event, expectedApplicationId) {
  if (!event || event.application_id !== expectedApplicationId || typeof event.event_id !== 'string') {
    throw new Error('Application ledger returned an invalid event receipt.');
  }
  return event;
}

export function createAutonomousEvaluationGraph({
  checkpointer,
  dataRoot = getCareerOpsRoot(),
  dependencies = {}
} = {}) {
  if (!checkpointer) throw new Error('A durable local LangGraph checkpointer is required.');
  const root = resolve(dataRoot);
  const queueFile = dependencies.queueFile || join(root, 'data', 'autonomous-pending.json');
  const ledger = dependencies.ledger || new ApplicationLedger({ dataRoot: root });
  const eventStore = ledger.eventStore || ledger;
  const emit = dependencies.emitApplicationEvent || createApplicationEventEmitter(ledger, 'langgraph-autonomous');
  const notificationRouter = dependencies.notificationRouter || new NotificationRouter({
    dataRoot: root,
    adapters: [{ id: 'telegram', isConfigured: () => false, async send() { return { status: 'BLOCKED_BY_CONFIGURATION' }; } }]
  });
  const resolveIdentity = dependencies.resolveIdentity || ((job) => resolveApplicationIdentity(job, { dataRoot: root }));
  const resolveState = (applicationId) => (dependencies.readExistingState || readExistingState)(applicationId, { dataRoot: root });
  const changeReview = (applicationId, evidence) => (dependencies.resumeReviewWithChangedEvidence || resumeReviewWithChangedEvidence)(applicationId, evidence, { dataRoot: root });
  const transition = (applicationId, targetState, inputData, options = {}) =>
    (dependencies.transitionState || transitionState)(applicationId, targetState, inputData, { ...options, dataRoot: root });
  const hydrateJob = dependencies.hydrateJob || (async (job) => {
    if (typeof job.jdText === 'string' && job.jdText.trim()) return job;
    const { fetchJdViaKnownApi } = await import('../browser-extract.mjs');
    const fetched = await fetchJdViaKnownApi(job.url);
    if (!fetched?.text) throw new Error('Known ATS API did not return a substantive job description; no browser or web-search fallback was attempted.');
    return { ...job, title: job.title || fetched.title || '', jdText: fetched.text };
  });
  const loadCandidateFacts = dependencies.loadCandidateFacts || (() => {
    throw new Error('Graph requires candidate facts loaded from the authorized primary profile sources.');
  });
  const evaluate = dependencies.evaluate || (({ job, candidateFacts }) => evaluateJob({
    jdText: job.jdText,
    title: job.title,
    company: job.company,
    candidateProfile: { verified_candidate_facts: candidateFacts },
    dataRoot: root
  }));
  const fitEvaluation = dependencies.evaluateFit || (({ evaluation, candidateFacts, job }) => evaluateCandidateFit({
    evaluation,
    candidateFacts,
    title: job.title,
    requiredEligibility: detectRequiredEligibility(job.jdText)
  }));
  const acknowledgeQueue = dependencies.acknowledgeQueue || ((url) => acknowledgeAutonomousPendingJob(queueFile, url));
  const fitPolicyVersion = dependencies.fitPolicyVersion || FIT_POLICY_VERSION;
  const checkpointEvent = dependencies.onNodeBoundary || (() => {});

  const addEvent = async (state, type, idempotencyKey, payload) => {
    const event = assertGraphEventResult(await emit(state.application_id, type, idempotencyKey, payload), state.application_id);
    return { last_event: event, event_ids: [...new Set([...(state.event_ids || []), event.event_id])] };
  };
  const addEvaluationEvent = (state, evaluationStatus, reason) => {
    const attempt = Number.isSafeInteger(state.evaluation_attempt) && state.evaluation_attempt > 1 ? state.evaluation_attempt : 1;
    const payload = { jd_hash: state.jd_hash, evaluation_status: evaluationStatus };
    if (reason) payload.reason = reason;
    if (attempt > 1) payload.evaluation_attempt = attempt;
    return addEvent(state, 'JOB_EVALUATED', attempt > 1
      ? `evaluation:${state.jd_hash}:attempt:${attempt}` : `evaluation:${state.jd_hash}`, payload);
  };

  const graph = new StateGraph(GraphState)
    .addNode('admit', async (state) => {
      validateJob(state.input_job);
      const identity = await resolveIdentity(state.input_job, { dataRoot: root });
      if (!identity?.application_id || identity.mergeable === false) {
        return { identity, application_id: identity?.application_id || '', status: 'IDENTITY_REVIEW', route: 'stop' };
      }
      const existing = resolveState(identity.application_id);
      if (existing && TERMINAL_FIT_STATES.has(existing.state)) {
        const expectedFit = existing.state === 'REJECTED_BY_POLICY' ? 'REJECT' : 'LONG_STRETCH';
        const terminalEvent = eventStore.list(identity.application_id).find((event) => event.type === 'FIT_REJECTED' && event.payload?.fit_status === expectedFit);
        if (!terminalEvent) return { identity, application_id: identity.application_id, canonical_state: existing.state, status: 'CANONICAL_TERMINAL_EVENT_MISSING', route: 'stop' };
        return { input_job: state.input_job, job: compactJob(state.input_job, identity), identity, application_id: identity.application_id,
          canonical_state: existing.state, status: 'DUPLICATE_SKIPPED', route: 'ack_terminal' };
      }
      if (existing && existing.state === 'NEEDS_REVIEW') {
        return { identity, application_id: identity.application_id, canonical_state: existing.state, status: 'CANONICAL_REVIEW_REQUIRES_CHECKPOINT', route: 'stop' };
      }
      if (existing && !['DISCOVERED', 'NORMALIZED', 'DEDUPED'].includes(existing.state)) {
        return { identity, application_id: identity.application_id, canonical_state: existing.state, status: 'CANONICAL_STATE_REQUIRES_REVIEW', route: 'stop' };
      }
      return { identity, application_id: identity.application_id, canonical_state: existing?.state || 'DISCOVERED', status: 'ADMITTED', route: 'hydrate' };
    }, { ends: ['retry_provider_failure'] })
    .addNode('retry_provider_failure', async (state) => {
      const retryReason = 'PROVIDER_FAILURE_NON_RETRYABLE';
      const previous = state.evaluation;
      if (state.status !== 'NEEDS_REVIEW' || state.route !== 'evaluation_review'
        || previous?.status !== 'NEEDS_REVIEW' || previous?.reason !== retryReason
        || state.job?.url !== state.input_job?.url || state.job?.jdHash !== state.jd_hash) {
        throw new Error('Explicit provider retry requires the matching checkpointed non-retryable provider failure.');
      }
      readValidatedJobText(state.job, state.application_id, root);
      const attemptedProviders = [...new Set((previous.provider_attempts || []).map((attempt) => attempt.provider).filter(Boolean))];
      const activeOverrides = dependencies.providerAvailabilityOverrides || [];
      const activeProviders = new Set(activeOverrides.filter((entry) => entry.status === 'active').map((entry) => entry.provider));
      if (!attemptedProviders.length || attemptedProviders.some((provider) => !activeProviders.has(provider))) {
        throw new Error('Explicit provider retry requires an active user-confirmed availability override for every failed provider.');
      }
      const attempt = (Number.isSafeInteger(state.evaluation_attempt) && state.evaluation_attempt > 0 ? state.evaluation_attempt : 1) + 1;
      const retryEvent = eventStore.list(state.application_id).find((event) => event.type === 'EVALUATION_RETRY_AUTHORIZED'
        && event.payload?.jd_hash === state.jd_hash && event.payload?.evaluation_attempt === attempt);
      let retryEventResult = retryEvent
        ? { last_event: retryEvent, event_ids: [...new Set([...(state.event_ids || []), retryEvent.event_id])] }
        : null;
      let canonical = resolveState(state.application_id);
      if (canonical?.state === 'NEEDS_REVIEW') {
        const review = canonical.metadata?.NEEDS_REVIEW || {};
        const priorFailure = eventStore.list(state.application_id).some((event) => event.type === 'JOB_EVALUATED'
          && event.payload?.jd_hash === state.jd_hash && event.payload?.evaluation_status === 'NEEDS_REVIEW'
          && event.payload?.reason === retryReason);
        if (review.reason !== retryReason || review.reviewType !== 'evaluation_failure' || !priorFailure) {
          throw new Error('Canonical review state is not the matching provider-failure review.');
        }
        if (review.jdHash !== undefined && review.jdHash !== state.jd_hash) {
          throw new Error('Canonical review JD hash conflicts with checkpoint.');
        }
        retryEventResult = await addEvent(state, 'EVALUATION_RETRY_AUTHORIZED', `provider-retry:${state.jd_hash}:${attempt}`, {
          jd_hash: state.jd_hash, evaluation_attempt: attempt, reason: retryReason,
          provider_overrides: activeOverrides.map(({ provider, unavailable_until, reason, source }) => ({ provider, unavailable_until, reason, source }))
        });
        transition(state.application_id, 'DEDUPED', {
          retry: true, jdHash: state.jd_hash,
          providerRetryAttempt: attempt, providerRetryReason: retryReason
        });
        canonical = resolveState(state.application_id);
        await checkpointEvent('provider-retry-state-transitioned', { applicationId: state.application_id, evaluationAttempt: attempt });
      } else if (canonical?.state !== 'DEDUPED'
        || canonical.metadata?.DEDUPED?.providerRetryAttempt !== attempt
        || canonical.metadata?.DEDUPED?.providerRetryReason !== retryReason
        || !retryEvent) {
        throw new Error('Explicit provider retry found conflicting canonical retry state.');
      }
      return {
        ...(retryEventResult || {}),
        evaluation: null, evaluation_hash: null, evaluation_result_hash: null,
        evaluation_attempt: attempt, provider_attempts: [], fit: null,
        review_evidence: null, review_evidence_hash: null,
        canonical_state: 'DEDUPED', status: 'PROVIDER_RETRY_AUTHORIZED', route: 'evaluate'
      };
    })
    .addNode('hydrate', async (state) => {
      const hydrated = await hydrateJob(state.input_job, { dataRoot: root, identity: state.identity });
      if (typeof hydrated?.jdText !== 'string' || !hydrated.jdText.trim()) throw new Error('Hydration requires substantive JD text.');
      if (typeof hydrated.title !== 'string' || !hydrated.title.trim()) throw new Error('Hydration requires the posting title.');
      const jdHash = sha256(hydrated.jdText);
      if (hydrated.jdHash && hydrated.jdHash !== jdHash) throw new Error('Hydrated JD hash does not match the supplied text.');
      const jdArtifact = await ledger.storeArtifact({
        applicationId: state.application_id, name: `job-description-${jdHash}.txt`,
        content: hydrated.jdText, mediaType: 'text/plain', producer: 'langgraph-evaluation',
        idempotencyKey: `job-description:${jdHash}`
      });
      const job = compactJob({ ...state.input_job, ...hydrated, jdHash, jdArtifactRef: jdArtifact.relative_path }, state.identity);
      const discovered = await addEvent({ ...state, job }, 'JOB_DISCOVERED', `posting:${state.application_id}`, {
        identity_basis: state.identity.identity_basis,
        url_hash: sha256(job.url)
      });
      const hydratedEvent = assertGraphEventResult(await emit(state.application_id, 'JOB_HYDRATED', `jd:${jdHash}`, {
        jd_hash: jdHash, title: job.title, company: job.company
      }), state.application_id);
      await checkpointEvent('hydrated', { applicationId: state.application_id, jdHash });
      return { job, jd_hash: jdHash, event_ids: [...discovered.event_ids, hydratedEvent.event_id], last_event: hydratedEvent };
    })
    .addNode('prepare_state', async (state) => {
      let current = resolveState(state.application_id);
      if (!current) {
        transition(state.application_id, 'NORMALIZED', { identity: state.identity, job: { title: state.job.title, company: state.job.company, url: state.job.url } });
        current = resolveState(state.application_id);
      }
      if (current?.state === 'DISCOVERED') {
        transition(state.application_id, 'NORMALIZED', { identity: state.identity, job: { title: state.job.title, company: state.job.company, url: state.job.url } });
        current = resolveState(state.application_id);
      }
      if (current?.state === 'NORMALIZED') {
        transition(state.application_id, 'DEDUPED', { identity_basis: state.identity.identity_basis, jdHash: state.jd_hash });
        current = resolveState(state.application_id);
      }
      if (current?.state !== 'DEDUPED') throw new Error(`Cannot start graph evaluation from canonical state ${current?.state || 'MISSING'}.`);
      await checkpointEvent('deduped', { applicationId: state.application_id });
      return { canonical_state: current.state, status: 'EVALUATION_READY' };
    })
    .addNode('evaluate', async (state) => {
      if (state.evaluation && state.evaluation_hash === state.jd_hash) return { status: 'EVALUATION_REUSED' };
      const candidateFacts = await loadCandidateFacts({ dataRoot: root });
      const job = { ...state.job, jdText: readValidatedJobText(state.job, state.application_id, root) };
      const evaluated = await evaluate({ job, applicationId: state.application_id, candidateFacts, dataRoot: root });
      if (!evaluated || typeof evaluated !== 'object' || typeof evaluated.status !== 'string') throw new Error('Evaluator returned an invalid result.');
      const evaluationHash = hashReviewEvidence(evaluated);
      await checkpointEvent('evaluated', { applicationId: state.application_id, jdHash: state.jd_hash, status: evaluated.status });
      return { evaluation: evaluated, evaluation_hash: state.jd_hash, requested_tier: evaluated.tier === 2 ? 'SYSTEM2' : 'SYSTEM1', status: 'EVALUATED', evaluation_attempt: state.evaluation_attempt || 1, provider_attempts: evaluated.provider_attempts || state.provider_attempts, evaluation_result_hash: evaluationHash };
    })
    .addNode('assess_fit', async (state) => {
      const candidateFacts = await loadCandidateFacts({ dataRoot: root });
      const job = { ...state.job, jdText: readValidatedJobText(state.job, state.application_id, root) };
      const fit = await fitEvaluation({ evaluation: state.evaluation, candidateFacts, job, dataRoot: root });
      if (!fit || typeof fit.status !== 'string') throw new Error('Candidate-fit gate returned an invalid result.');
      const evidence = buildReviewEvidence(state.job, candidateFacts, fitPolicyVersion);
      const evidenceHash = hashReviewEvidence(evidence);
      return { fit, review_evidence: evidence, review_evidence_hash: evidenceHash, route: 'persist_fit' };
    })
    .addNode('persist_fit', async (state) => {
      const current = resolveState(state.application_id);
      if (state.evaluation.status !== 'PASSED') {
        if (current?.state !== 'NEEDS_REVIEW') {
          transition(state.application_id, 'NEEDS_REVIEW', {
            evaluation: state.evaluation,
            jdHash: state.jd_hash,
            reviewEvidence: state.review_evidence,
            reason: state.evaluation.reason || 'EVALUATION_NOT_PASSED',
            reviewType: 'evaluation_failure'
          });
          await checkpointEvent('canonical-evaluation-review-transitioned', { applicationId: state.application_id });
        }
        const eventResult = await addEvaluationEvent(state, state.evaluation.status,
          state.evaluation.reason || 'EVALUATION_NOT_PASSED');
        await checkpointEvent('evaluation-review-persisted', { applicationId: state.application_id });
        return { ...eventResult, canonical_state: 'NEEDS_REVIEW', status: 'NEEDS_REVIEW', route: 'evaluation_review' };
      }

      const fitEventType = semanticFitEventType(state.fit.status);
      if (!fitEventType) throw new Error(`Unsupported candidate-fit status: ${state.fit.status}`);
      let canonical = resolveState(state.application_id);
      if (state.fit.status === 'NEEDS_REVIEW') {
        if (canonical?.state !== 'NEEDS_REVIEW' || canonical.metadata?.NEEDS_REVIEW?.evidenceHash !== state.review_evidence_hash) {
          if (canonical?.state !== 'DEDUPED') throw new Error(`Candidate-fit review cannot transition from ${canonical?.state || 'MISSING'}.`);
          transition(state.application_id, 'NEEDS_REVIEW', {
            candidate_fit: state.fit,
            jdHash: state.jd_hash,
            reviewEvidence: state.review_evidence,
            reason: state.fit.reasons?.[0] || 'CANDIDATE_FIT_REQUIRES_REVIEW',
            reviewType: 'candidate_fit'
          });
          await checkpointEvent('canonical-candidate-review-transitioned', { applicationId: state.application_id });
          canonical = resolveState(state.application_id);
        }
        await addEvaluationEvent(state, state.evaluation.status);
        const reviewEvent = await addEvent(state, fitEventType, `candidate-review:${state.review_evidence_hash}`, {
          fit_status: state.fit.status, evidence_hash: state.review_evidence_hash,
          fit_policy_version: fitPolicyVersion
        });
        const pauseEvent = await addEvent({ ...state, event_ids: reviewEvent.event_ids }, 'CANDIDATE_REVIEW_PAUSED',
          `candidate-review-pause:${state.review_evidence_hash}`, {
            fit_status: state.fit.status, evidence_hash: state.review_evidence_hash,
            reason_code: 'CANDIDATE_FACTS_REQUIRE_REVIEW'
          });
        await checkpointEvent('candidate-review-persisted', { applicationId: state.application_id, evidenceHash: state.review_evidence_hash });
        return { ...pauseEvent, canonical_state: canonical.state, status: 'NEEDS_REVIEW', route: 'candidate_review' };
      }

      const targetState = state.fit.status === 'REJECT' ? 'REJECTED_BY_POLICY'
        : state.fit.status === 'LONG_STRETCH' ? 'LONG_STRETCH' : 'SHORTLISTED';
      if (canonical?.state === 'DEDUPED') {
        transition(state.application_id, 'FIT_EVALUATED', { qualified: !['REJECT', 'LONG_STRETCH'].includes(state.fit.status), fitStatus: state.fit.status, jdHash: state.jd_hash, reasons: state.fit.reasons });
        canonical = resolveState(state.application_id);
      }
      if (canonical?.state === 'FIT_EVALUATED') {
        if (targetState === 'SHORTLISTED') transition(state.application_id, 'SHORTLISTED', { fitScore: state.fit.score, fitStatus: state.fit.status, jdHash: state.jd_hash });
        else transition(state.application_id, targetState, { fit: state.fit, fitStatus: state.fit.status, jdHash: state.jd_hash });
        canonical = resolveState(state.application_id);
      }
      if (TERMINAL_FIT_STATES.has(canonical?.state)) {
        await checkpointEvent('canonical-fit-terminal', { applicationId: state.application_id, canonicalState: canonical.state });
      }
      if (canonical?.state !== targetState) throw new Error(`Candidate-fit result conflicts with canonical state ${canonical?.state || 'MISSING'}.`);
      const eventResult = await addEvaluationEvent(state, state.evaluation.status);
      const fitEvent = await addEvent(state, fitEventType, `fit:${state.review_evidence_hash}:${state.fit.status}`, {
        fit_status: state.fit.status, fit_policy_version: fitPolicyVersion,
        evidence_hash: state.review_evidence_hash, reasons: state.fit.reasons || []
      });
      await checkpointEvent('fit-events-appended', { applicationId: state.application_id, canonicalState: canonical.state });
      await checkpointEvent('fit-persisted', { applicationId: state.application_id, canonicalState: canonical.state });
      return {
        ...fitEvent, event_ids: [...eventResult.event_ids, ...fitEvent.event_ids], canonical_state: canonical.state,
        status: targetState, route: targetState === 'SHORTLISTED' ? 'pre_submit' : 'terminal'
      };
    })
    .addNode('candidate_fit_review', async (state) => {
      const response = interrupt({
        type: 'CANDIDATE_FIT_REVIEW',
        application_id: state.application_id,
        fit_status: 'NEEDS_REVIEW',
        reasons: state.fit.reasons || [],
        evidence_hash: state.review_evidence_hash,
        required_action: 'Update the primary candidate evidence, then resume with { action: "evidence_updated" }. No application is submitted.'
      });
      if (response?.action !== 'evidence_updated') throw new Error('Candidate-fit resume requires an explicit evidence-updated confirmation.');
      const candidateFacts = await loadCandidateFacts({ dataRoot: root });
      const newEvidence = buildReviewEvidence(state.job, candidateFacts, fitPolicyVersion);
      const newEvidenceHash = hashReviewEvidence(newEvidence);
      if (newEvidenceHash === state.review_evidence_hash) throw new Error('Candidate-fit resume refused: evidence hash did not change.');
      const canonical = resolveState(state.application_id);
      const alreadyResumed = canonical?.state === 'DEDUPED'
        && canonical.metadata?.DEDUPED?.reviewEvidenceHash === newEvidenceHash;
      if (!alreadyResumed) {
        if (canonical?.state !== 'NEEDS_REVIEW' || canonical.metadata?.NEEDS_REVIEW?.evidenceHash !== state.review_evidence_hash) {
          throw new Error('Candidate-fit resume canonical state/evidence does not match the checkpoint.');
        }
        const resumed = changeReview(state.application_id, newEvidence);
        if (!resumed.resumed) throw new Error('Candidate-fit resume could not verify changed evidence.');
      }
      await checkpointEvent('canonical-review-resumed', { applicationId: state.application_id, evidenceHash: newEvidenceHash });
      const resumedEvent = await addEvent({ ...state, review_evidence_hash: newEvidenceHash }, 'CANDIDATE_REVIEW_RESUMED',
        `candidate-review-resume:${state.review_evidence_hash}:${newEvidenceHash}`, {
          previous_evidence_hash: state.review_evidence_hash, new_evidence_hash: newEvidenceHash
        });
      await checkpointEvent('candidate-review-resumed', { applicationId: state.application_id, evidenceHash: newEvidenceHash });
      return { review_evidence: newEvidence, review_evidence_hash: newEvidenceHash, ...resumedEvent, canonical_state: 'DEDUPED', status: 'REVIEW_RESUMED' };
    })
    .addNode('notify', async (state) => {
      if (!state.last_event) return { notification_results: [] };
      const results = await notificationRouter.route(state.last_event);
      await checkpointEvent('notifications-routed', { applicationId: state.application_id, count: results.length });
      return { notification_results: results };
    })
    .addNode('pre_submit_review', async (state) => {
      const response = interrupt({
        type: 'PRE_SUBMIT_REVIEW',
        application_id: state.application_id,
        canonical_state: state.canonical_state,
        submission_performed: false,
        submit_capability: false,
        required_action: 'Human review only; this graph has no submit node or submission capability.'
      });
      if (!['STOP', 'CONTINUE_MANUALLY'].includes(response?.decision)) throw new Error('Pre-submit review accepts only STOP or CONTINUE_MANUALLY; it never submits.');
      return { status: 'PRE_SUBMIT_REVIEW_RECORDED', human_decision: response.decision };
    })
    .addNode('acknowledge_queue', async (state) => {
      if (!TERMINAL_FIT_STATES.has(state.canonical_state)) throw new Error('Only canonical terminal fit states may acknowledge the pending queue item.');
      const canonical = resolveState(state.application_id);
      if (!canonical || canonical.state !== state.canonical_state) throw new Error('Queue acknowledgement refused: canonical state is missing or conflicts with the graph checkpoint.');
      const expectedFit = canonical.state === 'REJECTED_BY_POLICY' ? 'REJECT' : 'LONG_STRETCH';
      const terminalEvent = eventStore.list(state.application_id).find((event) => event.type === 'FIT_REJECTED' && event.payload?.fit_status === expectedFit);
      if (!terminalEvent) throw new Error('Queue acknowledgement refused: matching terminal fit ledger evidence is missing.');
      const remaining = await acknowledgeQueue(state.job.url);
      await checkpointEvent('queue-acknowledged', { applicationId: state.application_id });
      return { queue_acknowledged: true, status: state.status === 'DUPLICATE_SKIPPED' ? 'DUPLICATE_SKIPPED' : state.canonical_state, queue_remaining: remaining };
    })
    .addEdge(START, 'admit')
    .addConditionalEdges('admit', (state) => state.route, { hydrate: 'hydrate', ack_terminal: 'acknowledge_queue', stop: END })
    .addEdge('retry_provider_failure', 'evaluate')
    .addEdge('hydrate', 'prepare_state')
    .addEdge('prepare_state', 'evaluate')
    .addEdge('evaluate', 'assess_fit')
    .addEdge('assess_fit', 'persist_fit')
    .addConditionalEdges('persist_fit', (state) => state.route, {
      candidate_review: 'candidate_fit_review', evaluation_review: END,
      pre_submit: 'notify', terminal: 'notify'
    })
    .addEdge('candidate_fit_review', 'assess_fit')
    .addConditionalEdges('notify', (state) => state.route, { pre_submit: 'pre_submit_review', terminal: 'acknowledge_queue' })
    .addEdge('pre_submit_review', END)
    .addEdge('acknowledge_queue', END)
    .compile({ checkpointer });

  return Object.freeze({
    invoke: (input, ...args) => graph.invoke(sanitizeGraphInput(input), ...args),
    stream: (input, ...args) => graph.stream(sanitizeGraphInput(input), ...args),
    streamEvents: (input, ...args) => graph.streamEvents(sanitizeGraphInput(input), ...args),
    batch: (inputs, ...args) => graph.batch(inputs.map(sanitizeGraphInput), ...args),
    getState: (...args) => graph.getState(...args),
    getStateHistory: (...args) => graph.getStateHistory(...args)
  });
}
