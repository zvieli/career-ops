import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { Annotation, Command, END, interrupt, START, StateGraph } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { getCareerOpsRoot } from '../../../path-resolver.mjs';
import { JD_TEXT_API_ATS, resolveAtsApi } from '../../../liveness-api.mjs';
import { acknowledgeAutonomousPendingJob } from '../infrastructure/persistence/autonomous-pending-queue.mjs';
import { resolveApplicationIdentity } from '../domain/applications/application-identity.mjs';
import { ApplicationLedger, createApplicationEventEmitter, recordJobDiscoveryEvent, semanticFitEventType } from '../infrastructure/persistence/application-ledger.mjs';
import { detectRequiredEligibility, evaluateCandidateFit, FIT_POLICY_VERSION } from '../domain/candidate/candidate-fit-gate.mjs';
import { evaluateJob } from '../domain/jobs/job-evaluator.mjs';
import { NotificationRouter } from '../infrastructure/communications/notification-router.mjs';
import { readExistingState, resumeReviewWithChangedEvidence, transitionState, hashReviewEvidence } from '../domain/applications/application-state-machine.mjs';
import { createCvPdfPipeline } from './cv-pdf-pipeline.mjs';
import { hasCanonicalPdfQuality } from '../infrastructure/documents/pdf-validator.mjs';
import { detectAtsProvider, getAtsProviderCapability, extractApplicationFormSchema, mapApplicationFields, createPreparationReceipt } from '../domain/applications/ats-preparation.mjs';
import { executeControlledFill } from '../domain/applications/controlled-fill.mjs';

const CHECKPOINT_DIRECTORY_MODE = 0o700;
const CHECKPOINT_FILE_MODE = 0o600;
export const AUTONOMOUS_GRAPH_NODE_NAMES = Object.freeze([
  'admit', 'hydrate', 'prepare_state', 'evaluate', 'assess_fit', 'persist_fit',
  'candidate_fit_review', 'notify', 'generate_cv', 'validate_pdf', 'cv_validated_review',
  'ats_detect', 'form_schema_extract', 'field_map', 'application_prepared', 'ats_preparation_review', 'controlled_application_fill', 'final_human_review', 'acknowledge_queue'
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
  provider_attempts: replace([]), evaluation_attempt: replace(1), requested_tier: replace('SYSTEM1'), human_decision: replace(''),
  cv_fingerprint: replace(null), cv_manifest_ref: replace(null), cv_artifact_ref: replace(null), cv_artifact_sha256: replace(null),
  pdf_artifact_ref: replace(null), pdf_artifact_sha256: replace(null), pdf_validation: replace(null),
  ats_provider: replace(null), ats_status: replace(null), ats_detection: replace(null), ats_capability: replace(null), form_schema: replace(null), form_schema_ref: replace(null),
  field_mappings: replace([]), preparation_receipt: replace(null), preparation_receipt_ref: replace(null),
  application_filled_receipt: replace(null), application_filled_receipt_ref: replace(null)
});

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function redactMappingsForCheckpoint(mappings) {
  return mappings.map((mapping) => ({ ...mapping, proposed_value_hash: mapping.proposed_value === null ? null : sha256(String(mapping.proposed_value)), proposed_value: null }));
}

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
  'postedAt', 'verification_status', 'liveness_verified_at', 'queue_key', 'queue_status', 'queued_at',
  'discovered_via', 'authoritative_provider', 'source_urls', 'provider_ids', 'hydration_status'
]);
const VALIDATED_PROVENANCE_FIELDS = new Set(['discovered_via', 'source_urls', 'provider_ids']);
const MAX_PROVIDER_IDENTITIES = 20;
const MAX_PROVIDER_NAME_LENGTH = 100;
const MAX_PROVIDER_ID_LENGTH = 200;

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
    if (keys.length === 1 && ['STOP', 'CONTINUE_MANUALLY', 'PREPARE_APPLICATION', 'FILL_APPLICATION', 'EDIT_REQUIRED', 'REFILL_REQUIRED'].includes(resume.decision)) {
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
    if (VALIDATED_PROVENANCE_FIELDS.has(field)) continue;
    if (typeof job[field] === 'string') inputJob[field] = job[field];
  }
  // Admission is discovery-only. Ignore caller-claimed destination authority and
  // hydration metadata; derive authority from the URL and begin at NOT_ATTEMPTED.
  const resolvedAts = resolveAtsApi(job.url)?.ats;
  inputJob.authoritative_provider = JD_TEXT_API_ATS.has(resolvedAts) && resolvedAts !== 'greenhouse-embedded' ? resolvedAts : '';
  inputJob.hydration_status = 'NOT_ATTEMPTED';
  if (Array.isArray(job.discovered_via) && job.discovered_via.length <= 20 && job.discovered_via.every((source) => typeof source === 'string' && source.length <= 100)) {
    inputJob.discovered_via = [...new Set(job.discovered_via.map((source) => source.trim()).filter(Boolean))];
  } else if (typeof job.discovered_via === 'string' && job.discovered_via.trim() && job.discovered_via.length <= 100) {
    inputJob.discovered_via = [job.discovered_via.trim()];
  }
  if (Array.isArray(job.source_urls) && job.source_urls.length <= 20) {
    inputJob.source_urls = [...new Set(job.source_urls.filter((raw) => {
      if (typeof raw !== 'string' || raw.length > 2048) return false;
      try {
        const url = new URL(raw);
        return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password;
      } catch { return false; }
    }))];
  }
  if (Array.isArray(job.provider_ids)) {
    if (job.provider_ids.length > MAX_PROVIDER_IDENTITIES) {
      throw new Error(`Graph admission provider-scoped identity limit exceeded (${MAX_PROVIDER_IDENTITIES}).`);
    }
    if (!job.provider_ids.every((item) => item && typeof item.provider === 'string' && typeof item.id === 'string'
      && item.provider.length <= MAX_PROVIDER_NAME_LENGTH && item.id.length <= MAX_PROVIDER_ID_LENGTH)) {
      throw new Error(`Graph admission provider-scoped identity limit exceeded (${MAX_PROVIDER_IDENTITIES}) or contains malformed evidence.`);
    }
    inputJob.provider_ids = job.provider_ids.map(({ provider, id }) => ({ provider, id }));
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
    discovered_via: Array.isArray(job.discovered_via)
      ? [...new Set(job.discovered_via)].slice(0, 20)
      : (job.discovered_via ? [job.discovered_via] : job.provider ? [job.provider] : []),
    authoritative_provider: job.authoritative_provider || '',
    source_urls: Array.isArray(job.source_urls) ? [...new Set(job.source_urls)].slice(0, 20) : [],
    provider_ids: Array.isArray(job.provider_ids) ? job.provider_ids.slice(0, 20) : [],
    hydration_status: ['NOT_ATTEMPTED', 'FULL', 'PARTIAL', 'FAILED', 'UNSUPPORTED', 'BLOCKED'].includes(job.hydration_status)
      ? job.hydration_status : 'NOT_ATTEMPTED',
    hydration_source: typeof job.hydration_source === 'string' ? job.hydration_source : '',
    hydrated_at: typeof job.hydrated_at === 'string' ? job.hydrated_at : '',
    content_hash: typeof job.content_hash === 'string' ? job.content_hash : '',
    content_completeness: typeof job.content_completeness === 'string' ? job.content_completeness : '',
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

function assertCvSourceHashes(sourceHashes, dataRoot) {
  const sourcePaths = { markdown: join(dataRoot, 'cv.md'), latex: join(dataRoot, 'cv', 'lior_zvieli_cv.tex'), article: join(dataRoot, 'article-digest.md'), factConfig: join(dataRoot, 'config', 'cv-facts.json') };
  if (!sourceHashes || Object.keys(sourceHashes).sort().join(',') !== 'article,factConfig,latex,markdown') {
    throw new Error('CV manifest does not contain the complete canonical source fingerprint.');
  }
  for (const [key, sourcePath] of Object.entries(sourcePaths)) {
    const expectedHash = sourceHashes[key];
    const actualHash = existsSync(sourcePath) ? sha256(readFileSync(sourcePath)) : null;
    if (actualHash !== expectedHash) throw new Error(`Canonical CV source changed after generation (${key}); refusing stale PDF validation.`);
  }
  return true;
}

function assertCvArtifactReceipts({ applicationId, jdHash, metadata, ledgerEvents, dataRoot, requirePdfEvent = false }) {
  const generated = metadata?.CV_GENERATED || {};
  const validated = metadata?.CV_VALIDATED || {};
  if (generated.jdHash !== jdHash || !/^[a-f0-9]{64}$/.test(generated.inputFingerprint || '')) {
    throw new Error('Canonical CV generation metadata is missing or conflicts with the checkpoint.');
  }
  const stored = (reference) => ledgerEvents.find((event) => event.type === 'ARTIFACT_STORED' && event.payload?.relative_path === reference);
  const texEvent = stored(generated.texArtifactRef);
  const manifestEvent = stored(generated.manifestArtifactRef);
  if (!texEvent || texEvent.payload.sha256 !== generated.texSha256 || !manifestEvent) {
    throw new Error('Canonical CV generation is missing its immutable artifact ledger receipts.');
  }
  readApplicationArtifact(generated.texArtifactRef, applicationId, dataRoot, generated.texSha256);
  const manifestArtifact = readApplicationArtifact(generated.manifestArtifactRef, applicationId, dataRoot, manifestEvent.payload.sha256);
  const manifest = JSON.parse(manifestArtifact.bytes.toString('utf8'));
  if (manifest.application_id !== applicationId || manifest.jd_hash !== jdHash
    || manifest.input_fingerprint !== generated.inputFingerprint || manifest.tex_sha256 !== generated.texSha256
    || manifest.tex_artifact_ref !== generated.texArtifactRef) {
    throw new Error('CV manifest does not match canonical milestone metadata.');
  }
  assertCvSourceHashes(manifest.source_hashes, dataRoot);
  if (validated.inputFingerprint !== undefined) {
    if (validated.inputFingerprint !== generated.inputFingerprint || validated.jdHash !== jdHash
      || !/^[a-f0-9]{64}$/.test(validated.pdfSha256 || '')) throw new Error('Canonical PDF validation metadata conflicts with the generated CV.');
    const validation = validated.validation || {};
    if (!hasCanonicalPdfQuality(validated.pageCount, validated.textCharCount)
      || !hasCanonicalPdfQuality(validation.pageCount, validation.textCharCount)
      || validated.pageCount !== validation.pageCount || validated.textCharCount !== validation.textCharCount) {
      throw new Error('Canonical PDF quality receipt does not meet the one-page and >1000-text policy.');
    }
    const pdfEvent = stored(validated.pdfArtifactRef);
    if (!pdfEvent || pdfEvent.payload.sha256 !== validated.pdfSha256) throw new Error('Canonical PDF validation is missing its immutable artifact ledger receipt.');
    readApplicationArtifact(validated.pdfArtifactRef, applicationId, dataRoot, validated.pdfSha256);
    const pdfValidationEvent = ledgerEvents.find((event) => event.type === 'PDF_VALIDATED'
      && event.payload?.input_fingerprint === generated.inputFingerprint
      && event.payload?.pdf_sha256 === validated.pdfSha256);
    if (pdfValidationEvent && (!hasCanonicalPdfQuality(pdfValidationEvent.payload?.page_count, pdfValidationEvent.payload?.text_char_count)
      || pdfValidationEvent.payload.page_count !== validated.pageCount
      || pdfValidationEvent.payload.text_char_count !== validated.textCharCount)) {
      throw new Error('PDF validation ledger receipt conflicts with canonical quality metadata.');
    }
    if (requirePdfEvent && !pdfValidationEvent) throw new Error('Canonical PDF validation event is missing.');
  } else if (requirePdfEvent) throw new Error('Canonical CV_VALIDATED milestone metadata is missing.');
  return true;
}

export function assertCheckpointDomainConsistency({ values = {}, expectedApplicationId, expectedUrl, canonicalState, ledgerEvents = [], allowProviderFailureRetry = false, dataRoot = getCareerOpsRoot() } = {}) {
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
  if (savedState === 'CV_VALIDATED' && currentState === 'READY_TO_FILL') {
    const prepared = canonicalState.metadata?.READY_TO_FILL || {};
    if (!prepared.preparationReceiptHash || prepared.jdHash !== values.jd_hash
      || !ledgerEvents.some((event) => event.type === 'ARTIFACT_STORED' && event.payload?.relative_path === prepared.preparationReceiptRef)) {
      throw new Error('READY_TO_FILL recovery requires the matching durable ATS preparation receipt.');
    }
    assertCvArtifactReceipts({ applicationId: expectedApplicationId, jdHash: values.jd_hash,
      metadata: canonicalState.metadata, ledgerEvents, dataRoot, requirePdfEvent: true });
    assertPreparationEvidence({ applicationId: expectedApplicationId, jdHash: values.jd_hash, canonicalState, ledgerEvents, dataRoot });
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
    if (values.jd_hash && ['DEDUPED', 'FIT_EVALUATED', 'SHORTLISTED', 'NEEDS_REVIEW', 'REJECTED_BY_POLICY', 'LONG_STRETCH', 'CV_GENERATED', 'CV_VALIDATED'].includes(currentState)
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
    if (currentState === 'READY_TO_FILL') {
      const prepared = canonicalState.metadata?.READY_TO_FILL || {};
      if (!prepared.preparationReceiptHash || prepared.jdHash !== values.jd_hash) throw new Error('READY_TO_FILL state has no matching preparation receipt metadata.');
      const receiptEvent = ledgerEvents.find((event) => event.type === 'ARTIFACT_STORED' && event.payload?.relative_path === prepared.preparationReceiptRef);
      if (!receiptEvent || receiptEvent.payload.sha256 !== prepared.preparationReceiptHash) throw new Error('READY_TO_FILL state is missing its immutable preparation receipt.');
      assertCvArtifactReceipts({ applicationId: expectedApplicationId, jdHash: values.jd_hash, metadata: canonicalState.metadata, ledgerEvents, dataRoot, requirePdfEvent: true });
      assertPreparationEvidence({ applicationId: expectedApplicationId, jdHash: values.jd_hash, canonicalState, ledgerEvents, dataRoot, requirePreparedEvent: true });
    }
    if (currentState === 'CV_GENERATED' || currentState === 'CV_VALIDATED') {
      if (values.cv_fingerprint && values.cv_fingerprint !== canonicalState.metadata?.CV_GENERATED?.inputFingerprint) {
        throw new Error('Checkpoint CV fingerprint conflicts with canonical state.');
      }
      assertCvArtifactReceipts({ applicationId: expectedApplicationId, jdHash: values.jd_hash,
        metadata: canonicalState.metadata, ledgerEvents, dataRoot, requirePdfEvent: currentState === 'CV_VALIDATED' });
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
  if (savedState === 'SHORTLISTED' && currentState === 'CV_GENERATED'
    && canonicalState.metadata?.SHORTLISTED?.jdHash === values.jd_hash
    && values.job?.jdHash === values.jd_hash) {
    assertCvArtifactReceipts({ applicationId: expectedApplicationId, jdHash: values.jd_hash,
      metadata: canonicalState.metadata, ledgerEvents, dataRoot });
    return true;
  }
  if (savedState === 'CV_GENERATED' && currentState === 'CV_VALIDATED'
    && canonicalState.metadata?.CV_GENERATED?.inputFingerprint === values.cv_fingerprint
    && canonicalState.metadata?.CV_GENERATED?.jdHash === values.jd_hash) {
    assertCvArtifactReceipts({ applicationId: expectedApplicationId, jdHash: values.jd_hash,
      metadata: canonicalState.metadata, ledgerEvents, dataRoot });
    return true;
  }
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

function resolveApplicationArtifactPath(reference, applicationId, dataRoot) {
  const parts = typeof reference === 'string' ? reference.split(/[\\/]/) : [];
  if (parts.length !== 2 || parts[0] !== applicationId || !parts[1] || parts.some((part) => part === '..')) {
    throw new Error('Checkpoint is missing a valid application-scoped artifact reference.');
  }
  const artifactRoot = resolve(dataRoot, 'data', 'application-artifacts');
  const artifactPath = resolve(artifactRoot, ...parts);
  const relativePath = relative(artifactRoot, artifactPath);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('Application artifact reference escapes the artifact store.');
  }
  const realRoot = realpathSync(artifactRoot);
  const realArtifact = realpathSync(artifactPath);
  const realRelative = relative(realRoot, realArtifact);
  if (!realRelative || realRelative.startsWith('..') || isAbsolute(realRelative)) throw new Error('Application artifact symlink escapes the artifact store.');
  return realArtifact;
}

function readValidatedJobText(job, applicationId, dataRoot) {
  const reference = job.jdArtifactRef;
  const artifactPath = resolveApplicationArtifactPath(reference, applicationId, dataRoot);
  const jdText = readFileSync(artifactPath, 'utf8');
  if (sha256(jdText) !== job.jdHash) throw new Error('Archived JD artifact hash does not match the checkpoint.');
  return jdText;
}

function readApplicationArtifact(reference, applicationId, dataRoot, expectedHash) {
  const artifactPath = resolveApplicationArtifactPath(reference, applicationId, dataRoot);
  const bytes = readFileSync(artifactPath);
  if (expectedHash && sha256(bytes) !== expectedHash) throw new Error('Application artifact hash does not match its durable receipt.');
  return { artifactPath, bytes, sha256: sha256(bytes) };
}

function assertPreparationEvidence({ applicationId, jdHash, canonicalState, ledgerEvents, dataRoot, requirePreparedEvent = false }) {
  const metadata = canonicalState?.metadata?.READY_TO_FILL || {};
  if (metadata.jdHash !== jdHash || !metadata.preparationReceiptRef || !metadata.schemaArtifactRef
    || !/^[a-f0-9]{64}$/.test(metadata.preparationReceiptHash || '') || !/^[a-f0-9]{64}$/.test(metadata.schemaArtifactHash || '')) {
    throw new Error('READY_TO_FILL recovery lacks complete immutable ATS receipt references.');
  }
  const receiptArtifactEvent = ledgerEvents.find((event) => event.type === 'ARTIFACT_STORED' && event.payload?.relative_path === metadata.preparationReceiptRef);
  const schemaArtifactEvent = ledgerEvents.find((event) => event.type === 'ARTIFACT_STORED' && event.payload?.relative_path === metadata.schemaArtifactRef);
  if (!receiptArtifactEvent || receiptArtifactEvent.payload.sha256 !== metadata.preparationReceiptHash
    || !schemaArtifactEvent || schemaArtifactEvent.payload.sha256 !== metadata.schemaArtifactHash) {
    throw new Error('ATS preparation artifact references do not match durable artifact ledger hashes.');
  }
  const receiptArtifact = readApplicationArtifact(metadata.preparationReceiptRef, applicationId, dataRoot, metadata.preparationReceiptHash);
  const schemaArtifact = readApplicationArtifact(metadata.schemaArtifactRef, applicationId, dataRoot, metadata.schemaArtifactHash);
  let receipt; let schema;
  try {
    receipt = JSON.parse(receiptArtifact.bytes.toString('utf8'));
    schema = JSON.parse(schemaArtifact.bytes.toString('utf8'));
  } catch { throw new Error('ATS preparation receipt or schema artifact is not valid JSON.'); }
  const { receipt_hash: receiptHash, ...receiptBody } = receipt;
  if (receipt.application_id !== applicationId || receipt.jd_hash !== jdHash
    || receipt.extraction_status !== 'EXTRACTED' || schema.extraction_status !== 'EXTRACTED'
    || metadata.schemaExtractionStatus !== 'EXTRACTED'
    || receipt.form_schema_hash !== metadata.schemaHash || receipt.form_schema_hash !== schema.schema_hash
    || receipt.form_schema_artifact_ref !== metadata.schemaArtifactRef
    || receipt.form_schema_artifact_sha256 !== metadata.schemaArtifactHash
    || receipt.cv_pdf_hash !== canonicalState.metadata?.CV_VALIDATED?.pdfSha256
    || receipt.cv_fingerprint !== canonicalState.metadata?.CV_VALIDATED?.inputFingerprint
    || receiptHash !== sha256(JSON.stringify(receiptBody))) {
    throw new Error('ATS receipt binding to application, JD, CV, or form schema is invalid.');
  }
  if (requirePreparedEvent && !ledgerEvents.some((event) => event.type === 'APPLICATION_PREPARED'
    && event.payload?.receipt_hash === receiptHash && event.payload?.receipt_artifact_ref === metadata.preparationReceiptRef
    && event.payload?.form_schema_hash === schema.schema_hash)) {
    throw new Error('READY_TO_FILL state lacks its matching APPLICATION_PREPARED ledger event.');
  }
  return { receipt, schema };
}

function findStoredArtifact(ledger, applicationId, name) {
  const artifact = ledger.artifactStore?.list(applicationId)?.find((entry) => entry.name === name);
  if (!artifact) return null;
  const stored = readApplicationArtifact(artifact.relative_path, applicationId, ledger.artifactStore.dataRoot, artifact.sha256);
  return { ...artifact, ...stored };
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
    const { fetchJdViaKnownApi } = await import('../../../browser-extract.mjs');
    const fetched = await fetchJdViaKnownApi(job.url);
    if (!fetched?.text) throw new Error('Known ATS API did not return a substantive job description; no browser or web-search fallback was attempted.');
    return { ...job, ...fetched, title: job.title || fetched.title || '', jdText: fetched.text };
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
  const cvPipeline = dependencies.cvPipeline || createCvPdfPipeline({ dataRoot: root });
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
      if (hydrated.content_hash && hydrated.content_hash !== jdHash) throw new Error('Hydration content hash does not match the supplied JD text.');
      if (hydrated.hydration_status && !['NOT_ATTEMPTED', 'FULL', 'PARTIAL', 'FAILED', 'UNSUPPORTED', 'BLOCKED'].includes(hydrated.hydration_status)) {
        throw new Error('Hydration status is not a supported contract value.');
      }
      const jdArtifact = await ledger.storeArtifact({
        applicationId: state.application_id, name: `job-description-${jdHash}.txt`,
        content: hydrated.jdText, mediaType: 'text/plain', producer: 'langgraph-evaluation',
        idempotencyKey: `job-description:${jdHash}`
      });
      const job = compactJob({ ...state.input_job, ...hydrated, jdHash, jdArtifactRef: jdArtifact.relative_path }, state.identity);
      const discoveryEvent = assertGraphEventResult(await recordJobDiscoveryEvent(emit, state.application_id), state.application_id);
      const discoveredEventIds = [...new Set([...(state.event_ids || []), discoveryEvent.event_id])];
      const hydratedEvent = assertGraphEventResult(await emit(state.application_id, 'JOB_HYDRATED', `jd:${jdHash}`, {
        jd_hash: jdHash, title: job.title, company: job.company
      }), state.application_id);
      await checkpointEvent('hydrated', { applicationId: state.application_id, jdHash });
      return { job, jd_hash: jdHash, event_ids: [...new Set([...discoveredEventIds, hydratedEvent.event_id])], last_event: hydratedEvent };
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
    .addNode('generate_cv', async (state) => {
      const canonicalBefore = resolveState(state.application_id);
      if (!['SHORTLISTED', 'CV_GENERATED', 'CV_VALIDATED'].includes(canonicalBefore?.state)) {
        throw new Error(`CV generation requires a shortlisted application; found ${canonicalBefore?.state || 'MISSING'}.`);
      }
      const jdText = readValidatedJobText(state.job, state.application_id, root);
      const generated = await cvPipeline.generate({ applicationId: state.application_id, job: state.job, jdText, evaluation: state.evaluation, fit: state.fit, dataRoot: root });
      if (!generated || typeof generated.tex !== 'string' || !/^[a-f0-9]{64}$/.test(generated.fingerprint || '')) {
        throw new Error('CV pipeline returned an invalid immutable artifact receipt.');
      }
      const texSha256 = sha256(generated.tex);
      const manifestName = `cv-manifest-${generated.fingerprint}.json`;
      const texName = `tailored-cv-${generated.fingerprint}.tex`;
      const texArtifact = await ledger.storeArtifact({ applicationId: state.application_id, name: texName,
        content: generated.tex, mediaType: 'application/x-tex', producer: 'langgraph-cv-pdf',
        idempotencyKey: `tailored-cv:${generated.fingerprint}` });
      const manifest = {
        schema_version: 1, application_id: state.application_id, jd_hash: state.jd_hash,
        input_fingerprint: generated.fingerprint, policy_version: generated.policyVersion,
        source_hashes: generated.sourceHashes, tex_sha256: texSha256, tex_artifact_ref: texArtifact.relative_path
      };
      const manifestArtifact = await ledger.storeArtifact({ applicationId: state.application_id, name: manifestName,
        content: JSON.stringify(manifest), mediaType: 'application/json', producer: 'langgraph-cv-pdf',
        idempotencyKey: `cv-manifest:${generated.fingerprint}` });

      let canonical = resolveState(state.application_id);
      if (canonical.state === 'SHORTLISTED') {
        transition(state.application_id, 'CV_GENERATED', {
          cvVersion: 1, jdHash: state.jd_hash, inputFingerprint: generated.fingerprint,
          texSha256, texArtifactRef: texArtifact.relative_path, manifestArtifactRef: manifestArtifact.relative_path
        });
        canonical = resolveState(state.application_id);
        await checkpointEvent('canonical-cv-generated-transitioned', { applicationId: state.application_id, fingerprint: generated.fingerprint });
      } else if (canonical.metadata?.CV_GENERATED?.inputFingerprint !== generated.fingerprint
        || canonical.metadata?.CV_GENERATED?.jdHash !== state.jd_hash) {
        throw new Error('Existing canonical CV generation does not match the current immutable sources.');
      }
      const event = await addEvent(state, 'CV_GENERATED', `cv-generated:${generated.fingerprint}`, {
        jd_hash: state.jd_hash, input_fingerprint: generated.fingerprint,
        tex_sha256: texSha256, tex_artifact_ref: texArtifact.relative_path,
        manifest_artifact_ref: manifestArtifact.relative_path, policy_version: generated.policyVersion
      });
      await checkpointEvent('cv-generated-receipt-persisted', { applicationId: state.application_id, fingerprint: generated.fingerprint });
      return { ...event, cv_fingerprint: generated.fingerprint, cv_manifest_ref: manifestArtifact.relative_path,
        cv_artifact_ref: texArtifact.relative_path, cv_artifact_sha256: texSha256,
        canonical_state: canonical.state, status: 'CV_GENERATED', route: 'pre_submit' };
    })
    .addNode('validate_pdf', async (state) => {
      const canonicalBefore = resolveState(state.application_id);
      const fingerprint = state.cv_fingerprint || canonicalBefore?.metadata?.CV_GENERATED?.inputFingerprint;
      if (!fingerprint || !['CV_GENERATED', 'CV_VALIDATED'].includes(canonicalBefore?.state)) {
        throw new Error('PDF validation requires a durably generated CV artifact.');
      }
      if (canonicalBefore.metadata?.CV_GENERATED?.jdHash !== state.jd_hash) throw new Error('PDF validation JD does not match the generated CV receipt.');
      const generatedMeta = canonicalBefore.metadata.CV_GENERATED;
      const texReceipt = readApplicationArtifact(generatedMeta.texArtifactRef, state.application_id, root, generatedMeta.texSha256);
      const manifestEvent = eventStore.list(state.application_id).find((event) => event.type === 'ARTIFACT_STORED'
        && event.payload?.relative_path === generatedMeta.manifestArtifactRef);
      if (!manifestEvent) throw new Error('CV source fingerprint manifest has no immutable ledger receipt.');
      const manifestReceipt = readApplicationArtifact(generatedMeta.manifestArtifactRef, state.application_id, root, manifestEvent.payload.sha256);
      const manifest = JSON.parse(manifestReceipt.bytes.toString('utf8'));
      if (manifest.application_id !== state.application_id || manifest.jd_hash !== state.jd_hash
        || manifest.input_fingerprint !== fingerprint || manifest.tex_sha256 !== generatedMeta.texSha256
        || manifest.tex_artifact_ref !== generatedMeta.texArtifactRef) throw new Error('CV manifest conflicts with canonical generation state.');
      assertCvSourceHashes(manifest.source_hashes, root);
      const pdfName = `validated-cv-${fingerprint}.pdf`;
      let pdfArtifact = findStoredArtifact(ledger, state.application_id, pdfName);
      let validation = canonicalBefore.metadata?.CV_VALIDATED?.inputFingerprint === fingerprint
        ? canonicalBefore.metadata.CV_VALIDATED.validation : null;
      if (!pdfArtifact) {
        if (canonicalBefore.state === 'CV_VALIDATED') throw new Error('Canonical PDF validation state has no matching immutable PDF artifact.');
        const result = await cvPipeline.validate({ applicationId: state.application_id, texPath: texReceipt.artifactPath,
          sourcePaths: [join(root, 'cv.md'), ...(existsSync(join(root, 'article-digest.md')) ? [join(root, 'article-digest.md')] : [])],
          dataRoot: root, fingerprint });
        if (!result || !Buffer.isBuffer(result.pdfBytes) || !result.pdfBytes.length
          || !hasCanonicalPdfQuality(result.pageCount, result.textCharCount)
          || result.factuality?.passed !== true) {
          throw new Error('PDF pipeline did not return a passing source-backed validation receipt.');
        }
        validation = { pageCount: result.pageCount, textCharCount: result.textCharCount,
          factualityVerdict: result.factuality.verdict || 'pass',
          factualityWarningCount: Number(result.factuality.details?.warnings || 0) + Number(result.factuality.details?.advisoryFacts || 0) + Number(result.factuality.details?.coverage === true),
          factPolicyConfigMissing: result.factuality.details?.configMissing === true };
        pdfArtifact = await ledger.storeArtifact({ applicationId: state.application_id, name: pdfName,
          content: result.pdfBytes, mediaType: 'application/pdf', producer: 'langgraph-cv-pdf',
          idempotencyKey: `validated-cv:${fingerprint}` });
      }
      const pdfBytes = readApplicationArtifact(pdfArtifact.relative_path, state.application_id, root, pdfArtifact.sha256);
      const artifactEvent = eventStore.list(state.application_id).find((entry) => entry.type === 'ARTIFACT_STORED'
        && entry.payload?.relative_path === pdfArtifact.relative_path);
      if (artifactEvent && artifactEvent.payload?.sha256 !== pdfBytes.sha256) throw new Error('PDF artifact ledger receipt hash conflicts with stored bytes.');
      if (!artifactEvent) {
        const repaired = await ledger.storeArtifact({ applicationId: state.application_id, name: pdfName,
          content: pdfBytes.bytes, mediaType: 'application/pdf', producer: 'langgraph-cv-pdf',
          idempotencyKey: `validated-cv:${fingerprint}` });
        if (repaired.sha256 !== pdfBytes.sha256 || repaired.relative_path !== pdfArtifact.relative_path) {
          throw new Error('Recovered PDF artifact receipt does not match its content-addressed bytes.');
        }
      }
      if (!validation) {
        const recovered = cvPipeline.validateArtifact?.({ pdfPath: pdfArtifact.artifactPath, applicationId: state.application_id,
          sourcePaths: [join(root, 'cv.md'), ...(existsSync(join(root, 'article-digest.md')) ? [join(root, 'article-digest.md')] : [])], dataRoot: root });
        if (!recovered?.success || !hasCanonicalPdfQuality(recovered.pageCount, recovered.textCharCount)
          || recovered.factuality?.passed !== true) {
          throw new Error('Recovered PDF artifact did not pass source-backed validation.');
        }
        validation = { pageCount: recovered.pageCount, textCharCount: recovered.textCharCount,
          factualityVerdict: recovered.factuality.verdict || 'pass',
          factualityWarningCount: Number(recovered.factuality.details?.warnings || 0) + Number(recovered.factuality.details?.advisoryFacts || 0) + Number(recovered.factuality.details?.coverage === true),
          factPolicyConfigMissing: recovered.factuality.details?.configMissing === true };
      }
      if (canonicalBefore.state === 'CV_GENERATED') {
        transition(state.application_id, 'CV_VALIDATED', {
          jdHash: state.jd_hash, inputFingerprint: fingerprint,
          texSha256: generatedMeta.texSha256, texArtifactRef: generatedMeta.texArtifactRef,
          manifestArtifactRef: generatedMeta.manifestArtifactRef,
          pdfSha256: pdfBytes.sha256, pdfArtifactRef: pdfArtifact.relative_path,
          pageCount: validation.pageCount, textCharCount: validation.textCharCount,
          factualityVerdict: validation.factualityVerdict, validation
        });
        await checkpointEvent('canonical-pdf-validated-transitioned', { applicationId: state.application_id, fingerprint });
      } else if (canonicalBefore.metadata?.CV_VALIDATED?.inputFingerprint !== fingerprint
        || canonicalBefore.metadata?.CV_VALIDATED?.pdfSha256 !== pdfBytes.sha256) {
        throw new Error('Existing canonical PDF validation does not match its immutable artifacts.');
      }
      const event = await addEvent(state, 'PDF_VALIDATED', `pdf-validated:${fingerprint}`, {
        jd_hash: state.jd_hash, input_fingerprint: fingerprint,
        cv_sha256: generatedMeta.texSha256, cv_artifact_ref: generatedMeta.texArtifactRef,
        pdf_sha256: pdfBytes.sha256, pdf_artifact_ref: pdfArtifact.relative_path,
        page_count: validation.pageCount, text_char_count: validation.textCharCount,
        factuality_verdict: validation.factualityVerdict,
        factuality_warning_count: validation.factualityWarningCount || 0,
        fact_policy_config_missing: validation.factPolicyConfigMissing === true
      });
      await checkpointEvent('pdf-validation-receipt-persisted', { applicationId: state.application_id, fingerprint });
      return { ...event, cv_fingerprint: fingerprint, cv_manifest_ref: state.cv_manifest_ref || generatedMeta.manifestArtifactRef,
        cv_artifact_ref: generatedMeta.texArtifactRef, cv_artifact_sha256: generatedMeta.texSha256,
        pdf_artifact_ref: pdfArtifact.relative_path, pdf_artifact_sha256: pdfBytes.sha256,
        pdf_validation: validation, canonical_state: 'CV_VALIDATED', status: 'CV_VALIDATED', route: 'pre_submit' };
    })
    .addNode('cv_validated_review', async (state) => {
      const canonical = resolveState(state.application_id);
      const validated = canonical?.metadata?.CV_VALIDATED || {};
      if (canonical?.state !== 'CV_VALIDATED' || state.canonical_state !== 'CV_VALIDATED'
        || !state.cv_fingerprint || validated.inputFingerprint !== state.cv_fingerprint
        || validated.pdfSha256 !== state.pdf_artifact_sha256
        || validated.jdHash !== state.jd_hash) {
        throw new Error('Pre-submit review requires a matching canonical CV_VALIDATED state; legacy shortlist-only checkpoints must be restarted explicitly.');
      }
      assertCvArtifactReceipts({ applicationId: state.application_id, jdHash: state.jd_hash,
        metadata: canonical.metadata, ledgerEvents: eventStore.list(state.application_id), dataRoot: root, requirePdfEvent: true });
      const pdf = readApplicationArtifact(validated.pdfArtifactRef, state.application_id, root, validated.pdfSha256);
      const cv = readApplicationArtifact(validated.texArtifactRef, state.application_id, root, validated.texSha256);
      const validationEvent = eventStore.list(state.application_id).find((event) => event.type === 'PDF_VALIDATED'
        && event.payload?.input_fingerprint === state.cv_fingerprint
        && event.payload?.pdf_sha256 === pdf.sha256 && event.payload?.cv_sha256 === cv.sha256);
      if (!validationEvent) throw new Error('Pre-submit review requires a matching durable PDF validation event.');
      const response = interrupt({
        type: 'PRE_SUBMIT_REVIEW',
        application_id: state.application_id,
        canonical_state: state.canonical_state,
        jd_hash: state.jd_hash,
        cv_fingerprint: state.cv_fingerprint,
        cv_artifact_ref: state.cv_artifact_ref,
        cv_artifact_sha256: state.cv_artifact_sha256,
        pdf_artifact_ref: state.pdf_artifact_ref,
        pdf_artifact_sha256: state.pdf_artifact_sha256,
        pdf_validation: state.pdf_validation,
        submission_performed: false,
        submit_capability: false,
        required_action: 'Human review only. Choose PREPARE_APPLICATION to inspect a form without filling or submitting, STOP, or CONTINUE_MANUALLY.',
        allowed_decisions: ['STOP', 'CONTINUE_MANUALLY', 'PREPARE_APPLICATION']
      });
      if (!['STOP', 'CONTINUE_MANUALLY', 'PREPARE_APPLICATION'].includes(response?.decision)) throw new Error('Pre-submit review accepts only STOP, CONTINUE_MANUALLY, or PREPARE_APPLICATION; it never submits.');
      return response.decision === 'PREPARE_APPLICATION'
        ? { status: 'PREPARING_APPLICATION', human_decision: response.decision, route: 'ats_detect' }
        : { status: 'PRE_SUBMIT_REVIEW_RECORDED', human_decision: response.decision, route: 'stop' };
    })
    .addNode('ats_detect', async (state) => {
      if (state.human_decision !== 'PREPARE_APPLICATION') throw new Error('ATS preparation requires explicit PREPARE_APPLICATION authorization.');
      const detection = detectAtsProvider(state.job.url, state.job.provider);
      const result = { ats_provider: detection.provider, ats_status: detection.status, ats_detection: detection, ats_capability: detection.capability || getAtsProviderCapability(detection.provider), route: 'form_schema_extract' };
      await checkpointEvent('ats-detection-complete', { applicationId: state.application_id, provider: result.ats_provider, status: result.ats_status });
      return result;
    })
    .addNode('form_schema_extract', async (state) => {
      if (state.human_decision !== 'PREPARE_APPLICATION') throw new Error('Form inspection requires explicit preparation authorization.');
      let snapshot = null;
      const fixtureAdapter = dependencies.fixtureAtsInspector;
      if (state.ats_status === 'HOST_RECOGNIZED' && state.ats_capability?.fixtureTested === true
        && fixtureAdapter?.mode === 'FIXTURE_TEST' && fixtureAdapter?.provider === state.ats_provider
        && typeof fixtureAdapter.inspect === 'function') {
        snapshot = await fixtureAdapter.inspect({ provider: state.ats_provider, sourceUrl: state.job.url, mode: 'FIXTURE_TEST', untrustedPageContent: true });
      }
      let schema;
      if (snapshot?.fields) {
        schema = extractApplicationFormSchema({ provider: state.ats_provider, sourceUrl: state.job.url, fields: snapshot.fields, source: snapshot.source || 'read_only_dom' });
      } else {
        schema = { provider: state.ats_provider || 'UNSUPPORTED', source_url: state.job.url, fields: [], schema_hash: sha256(JSON.stringify({ provider: state.ats_provider, source_url: state.job.url, fields: [], unavailable: true })), field_count: 0, extraction_status: state.ats_status === 'HOST_RECOGNIZED' ? 'NEEDS_REVIEW' : 'ATS_UNSUPPORTED' };
      }
      await checkpointEvent('ats-schema-extraction-complete', { applicationId: state.application_id, extractionStatus: schema.extraction_status, schemaHash: schema.schema_hash });
      return { form_schema: schema, status: schema.extraction_status, route: 'field_map' };
    })
    .addNode('field_map', async (state) => {
      if (state.human_decision !== 'PREPARE_APPLICATION') throw new Error('Field mapping requires explicit preparation authorization.');
      const facts = await loadCandidateFacts({ dataRoot: root });
      const mappings = redactMappingsForCheckpoint(mapApplicationFields(state.form_schema, facts));
      await checkpointEvent('ats-field-mapping-complete', { applicationId: state.application_id, mappingCount: mappings.length });
      return { field_mappings: mappings, route: 'application_prepared' };
    })
    .addNode('application_prepared', async (state) => {
      const canonical = resolveState(state.application_id);
      if (!['CV_VALIDATED', 'READY_TO_FILL'].includes(canonical?.state) || !['CV_VALIDATED', 'READY_TO_FILL'].includes(state.canonical_state)) throw new Error('Application preparation requires canonical CV_VALIDATED state.');
      assertCvArtifactReceipts({ applicationId: state.application_id, jdHash: state.jd_hash, metadata: canonical.metadata, ledgerEvents: eventStore.list(state.application_id), dataRoot: root, requirePdfEvent: true });
      const pdf = readApplicationArtifact(canonical.metadata.CV_VALIDATED.pdfArtifactRef, state.application_id, root, canonical.metadata.CV_VALIDATED.pdfSha256);
      let schema = state.form_schema;
      let mappings = state.field_mappings;
      let schemaChanged = false;
      const fixtureAdapter = dependencies.fixtureAtsInspector;
      if (fixtureAdapter?.mode === 'FIXTURE_TEST' && fixtureAdapter?.provider === state.ats_provider
        && typeof fixtureAdapter.inspect === 'function' && schema.extraction_status === 'EXTRACTED') {
        const refreshed = await fixtureAdapter.inspect({ provider: state.ats_provider, sourceUrl: state.job.url, mode: 'FIXTURE_TEST', untrustedPageContent: true });
        if (!refreshed?.fields) throw new Error('ATS form could not be revalidated read-only; stale field mapping cannot be reused.');
        const currentSchema = extractApplicationFormSchema({ provider: state.ats_provider, sourceUrl: state.job.url, fields: refreshed.fields, source: refreshed.source || 'read_only_dom' });
        if (currentSchema.schema_hash !== schema.schema_hash) {
          schema = currentSchema;
          mappings = redactMappingsForCheckpoint(mapApplicationFields(schema, await loadCandidateFacts({ dataRoot: root })));
          schemaChanged = true;
        }
      }
      if (schema.extraction_status !== 'EXTRACTED' && canonical.state === 'READY_TO_FILL') throw new Error('Existing READY_TO_FILL state is invalid for an unextracted ATS form.');
      const schemaArtifact = await ledger.storeArtifact({ applicationId: state.application_id, name: `ats-schema-${schema.schema_hash}.json`, content: JSON.stringify(schema), mediaType: 'application/json', producer: 'langgraph-ats-preparation', idempotencyKey: `ats-schema:${schema.schema_hash}` });
      await checkpointEvent('ats-schema-artifact-stored', { applicationId: state.application_id, schemaHash: schema.schema_hash });
      const receipt = createPreparationReceipt({ applicationId: state.application_id, provider: schema.provider, schema, mappings, pdfSha256: pdf.sha256, jdHash: state.jd_hash, cvFingerprint: state.cv_fingerprint, schemaArtifactRef: schemaArtifact.relative_path, schemaArtifactSha256: schemaArtifact.sha256, schemaChanged });
      const receiptArtifact = await ledger.storeArtifact({ applicationId: state.application_id, name: `application-prepared-${receipt.receipt_hash}.json`, content: JSON.stringify(receipt), mediaType: 'application/json', producer: 'langgraph-ats-preparation', idempotencyKey: `application-prepared:${receipt.receipt_hash}` });
      await checkpointEvent('ats-preparation-receipt-artifact-stored', { applicationId: state.application_id, receiptHash: receipt.receipt_hash });
      if (schema.extraction_status === 'EXTRACTED') {
        if (canonical.state === 'CV_VALIDATED') transition(state.application_id, 'READY_TO_FILL', { formType: schema.provider, jdHash: state.jd_hash, schemaHash: schema.schema_hash, schemaExtractionStatus: schema.extraction_status, schemaArtifactHash: schemaArtifact.sha256, schemaArtifactRef: schemaArtifact.relative_path, preparationReceiptHash: receiptArtifact.sha256, preparationReceiptRef: receiptArtifact.relative_path });
        else if (canonical.state !== 'READY_TO_FILL' || canonical.metadata?.READY_TO_FILL?.schemaExtractionStatus !== 'EXTRACTED' || canonical.metadata?.READY_TO_FILL?.preparationReceiptHash !== receiptArtifact.sha256) throw new Error('Existing READY_TO_FILL state conflicts with the extracted-schema preparation receipt.');
        await checkpointEvent('ats-ready-to-fill-transitioned', { applicationId: state.application_id, schemaHash: schema.schema_hash });
      }
      const event = await addEvent(state, 'APPLICATION_PREPARED', `application-prepared:${receipt.receipt_hash}`, { ats_provider: schema.provider, form_schema_hash: schema.schema_hash, mapping_hash: receipt.mapping_hash, cv_pdf_hash: pdf.sha256, jd_hash: state.jd_hash, receipt_hash: receipt.receipt_hash, schema_artifact_ref: schemaArtifact.relative_path, receipt_artifact_ref: receiptArtifact.relative_path, ready_fields: receipt.ready_fields.length, review_fields: receipt.review_fields.length, unsupported_fields: receipt.unsupported_fields.length, form_fields_discovered: schema.field_count, fields_ready: receipt.ready_fields.length, fields_needing_review: receipt.review_fields.length, fields_unsupported: receipt.unsupported_fields.length, extraction_status: schema.extraction_status, submission_performed: false, submit_capability: false });
      await checkpointEvent('application-prepared-ledger-event-persisted', { applicationId: state.application_id, receiptHash: receipt.receipt_hash });
      await checkpointEvent('application-preparation-receipt-persisted', { applicationId: state.application_id, receiptHash: receipt.receipt_hash });
      return { ...event, form_schema: schema, field_mappings: mappings, preparation_receipt: receipt, preparation_receipt_ref: receiptArtifact.relative_path, form_schema_ref: schemaArtifact.relative_path, canonical_state: schema.extraction_status === 'EXTRACTED' ? 'READY_TO_FILL' : 'CV_VALIDATED', status: schema.extraction_status === 'EXTRACTED' ? (schemaChanged ? 'APPLICATION_PREPARED_NEEDS_REVIEW' : 'APPLICATION_PREPARED') : schema.extraction_status, route: 'ats_preparation_review' };
    })
    .addNode('ats_preparation_review', async (state) => {
      const receipt = state.preparation_receipt;
      await checkpointEvent('before-ats-preparation-review-interrupt', { applicationId: state.application_id, extractionStatus: state.form_schema?.extraction_status || 'MISSING' });
      const response = interrupt({ type: 'ATS_PREPARATION_REVIEW', application_id: state.application_id, company: state.job.company || '', role: state.job.title || '', ats_provider: state.ats_provider, ats_status: state.ats_status, ats_capability: state.ats_capability, extraction_status: state.form_schema?.extraction_status, preparation_blockers: receipt?.preparation_blockers || [], form_schema_ref: state.form_schema_ref, canonical_state: state.canonical_state, cv_artifact_ref: state.pdf_artifact_ref, cv_artifact_sha256: state.pdf_artifact_sha256, form_schema_hash: state.form_schema?.schema_hash, field_count: state.form_schema?.field_count || 0, ready_fields: receipt?.ready_fields || [], review_fields: receipt?.review_fields || [], unsupported_fields: receipt?.unsupported_fields || [], do_not_answer_fields: receipt?.do_not_answer_fields || [], draft_answers: [], submission_performed: false, submit_capability: false, allowed_decisions: ['STOP', 'CONTINUE_MANUALLY', 'FILL_APPLICATION'] });
      if (!['STOP', 'CONTINUE_MANUALLY', 'FILL_APPLICATION'].includes(response?.decision)) throw new Error('ATS preparation review accepts only STOP, CONTINUE_MANUALLY, or explicit FILL_APPLICATION.');
      return { status: response.decision === 'FILL_APPLICATION' ? 'FILL_AUTHORIZED' : 'ATS_PREPARATION_REVIEW_RECORDED', human_decision: response.decision, route: response.decision === 'FILL_APPLICATION' ? 'controlled_application_fill' : 'stop' };
    })
    .addNode('controlled_application_fill', async (state) => {
      if (state.human_decision !== 'FILL_APPLICATION') throw new Error('Browser mutation requires explicit FILL_APPLICATION authorization.');
      const adapter = dependencies.fixtureApplicationFiller;
      if (!adapter || adapter.mode !== 'FIXTURE_TEST' || adapter.provider !== state.ats_provider
        || !['GREENHOUSE', 'LEVER'].includes(state.ats_provider)) {
        throw new Error('No controlled fixture fill adapter is configured; live ATS mutation is unsupported.');
      }
      if (state.preparation_receipt?.schema_changed_since_extraction || state.form_schema?.extraction_status !== 'EXTRACTED') {
        throw new Error('Prepared schema requires review; no mutation is permitted.');
      }
      const facts = await loadCandidateFacts({ dataRoot: root });
      const mappings = mapApplicationFields(state.form_schema, facts);
      const approvedMappings = JSON.stringify(state.field_mappings);
      const currentMappings = JSON.stringify(redactMappingsForCheckpoint(mappings));
      if (approvedMappings !== currentMappings) throw new Error('Candidate field mapping changed since ATS preparation review; explicit re-preparation and review are required.');
      const receipt = await executeControlledFill({
        authorization: 'FILL_APPLICATION',
        prepared: { application_id: state.application_id, provider: state.ats_provider, application_url: state.job.url, schema_hash: state.form_schema.schema_hash, mappings },
        adapter
      });
      const artifact = await ledger.storeArtifact({ applicationId: state.application_id, name: `application-filled-${receipt.receipt_hash}.json`, content: JSON.stringify(receipt), mediaType: 'application/json', producer: 'langgraph-controlled-fixture-fill', idempotencyKey: `application-filled:${receipt.receipt_hash}` });
      await addEvent(state, 'APPLICATION_FILLED', `application-filled:${receipt.receipt_hash}`, { receipt_hash: receipt.receipt_hash, receipt_artifact_ref: artifact.relative_path, provider: receipt.provider, schema_hash: receipt.schema_hash_live, filled_fields: receipt.filled_fields.length, skipped_fields: receipt.skipped_fields.length, submission_performed: false, submit_capability: false });
      return { status: 'APPLICATION_FILLED', application_filled_receipt_ref: artifact.relative_path, application_filled_receipt: receipt, submission_performed: false, submit_capability: false, route: 'final_human_review' };
    })
    .addNode('final_human_review', async (state) => {
      if (!state.application_filled_receipt_ref || !state.application_filled_receipt
        || state.application_filled_receipt.submission_performed !== false || state.application_filled_receipt.submit_capability !== false) {
        throw new Error('Final human review requires immutable non-submitting APPLICATION_FILLED receipt evidence.');
      }
      const review = interrupt({ type: 'FINAL_HUMAN_REVIEW', application_id: state.application_id, company: state.job.company || '', role: state.job.title || '', provider: state.ats_provider, application_url: state.job.url, receipt_artifact_ref: state.application_filled_receipt_ref, filled_fields: state.application_filled_receipt.filled_fields, skipped_fields: state.application_filled_receipt.skipped_fields, schema_hash: state.application_filled_receipt.schema_hash_live, submission_performed: false, submit_capability: false, allowed_decisions: ['STOP', 'CONTINUE_MANUALLY', 'EDIT_REQUIRED', 'REFILL_REQUIRED'] });
      if (!['STOP', 'CONTINUE_MANUALLY', 'EDIT_REQUIRED', 'REFILL_REQUIRED'].includes(review?.decision)) throw new Error('Final human review accepts only STOP, CONTINUE_MANUALLY, EDIT_REQUIRED, or REFILL_REQUIRED.');
      return { status: 'APPLICATION_FILLED', submission_performed: false, submit_capability: false, human_decision: review.decision, route: 'stop' };
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
    .addConditionalEdges('notify', (state) => state.route, { pre_submit: 'generate_cv', terminal: 'acknowledge_queue' })
    .addEdge('generate_cv', 'validate_pdf')
    .addEdge('validate_pdf', 'cv_validated_review')
    .addConditionalEdges('cv_validated_review', (state) => state.route, { ats_detect: 'ats_detect', stop: END })
    .addEdge('ats_detect', 'form_schema_extract')
    .addEdge('form_schema_extract', 'field_map')
    .addEdge('field_map', 'application_prepared')
    .addEdge('application_prepared', 'ats_preparation_review')
    .addConditionalEdges('ats_preparation_review', (state) => state.route, { controlled_application_fill: 'controlled_application_fill', stop: END })
    .addEdge('controlled_application_fill', 'final_human_review')
    .addEdge('final_human_review', END)
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
