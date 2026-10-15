import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command } from '@langchain/langgraph';
import { withPipelineLock } from '../../../pipeline-lock.mjs';
import { readExistingState } from '../domain/applications/application-state-machine.mjs';
import { stableEvaluationThreadId } from '../graph/autonomous-langgraph.mjs';
import { ApplicationLedger } from '../infrastructure/persistence/application-ledger.mjs';
import {
  createReviewRecoveryDescriptor, GRAPH_REVIEW_TYPES, hashHumanReviewEvidence, REVIEW_DECISIONS, validateReviewRecoveryDescriptor
} from '../infrastructure/persistence/human-review-task-store.mjs';

const REVIEW_NODE = Object.freeze({
  CANDIDATE_FIT_REVIEW: 'candidate_fit_review', PRE_SUBMIT_REVIEW: 'cv_validated_review',
  ATS_PREPARATION_REVIEW: 'ats_preparation_review', FINAL_HUMAN_REVIEW: 'final_human_review'
});
const ACTIVE = new Set(['OPEN', 'CLAIMED']);

function assertGraph(graph) {
  if (!graph || typeof graph.getState !== 'function' || typeof graph.invoke !== 'function') throw new Error('A compiled graph with state inspection and invoke APIs is required.');
}
function assertTask(task, applicationId) {
  if (!task || applicationId !== task.application_id) throw new Error('Review application binding mismatch.');
  const threadId = stableEvaluationThreadId(applicationId);
  if (task.graph_thread_id !== threadId || task.source_event !== `${threadId}:${task.review_type}`) throw new Error('Review graph thread/source binding mismatch.');
  if (!task.evidence_hash || hashHumanReviewEvidence(task.evidence) !== task.evidence_hash) throw new Error('Review task evidence hash mismatch.');
  return threadId;
}
function assertReceipt(task, receipt, decision, canonical, allowStateAdvance = false) {
  if (!receipt || receipt.receipt_id !== task.decision_receipt_ref || receipt.application_id !== task.application_id || receipt.review_task_id !== task.review_task_id
    || receipt.review_type !== task.review_type || receipt.evidence_hash !== task.evidence_hash || receipt.canonical_state_before !== task.expected_state
    || receipt.canonical_version_before !== (task.evidence.canonical_version ?? null) || receipt.decision !== decision || !task.allowed_decisions?.includes(decision)) throw new Error('Persisted review receipt or decision binding mismatch.');
  if (!canonical || (!allowStateAdvance && (canonical.state !== receipt.canonical_state_before || canonical.version !== receipt.canonical_version_before))) throw new Error('Canonical state/version changed after review evidence was captured.');
}
function pendingInterruptRecords(snapshot) {
  return (snapshot?.tasks || []).flatMap(task => (task.interrupts || []).map(interrupt => ({ node: task.name, interrupt })));
}
function pendingInterrupts(snapshot) { return pendingInterruptRecords(snapshot).map(record => record.interrupt); }
function hasRunnableWork(snapshot) {
  if (Array.isArray(snapshot?.next)) return snapshot.next.length > 0;
  return (snapshot?.tasks || []).some(task => !(task.interrupts || []).length);
}
function matchesTask(snapshot, task) {
  return pendingInterrupts(snapshot).filter(item => item.value?.type === task.review_type && item.value?.application_id === task.application_id
    && item.value?.canonical_state === task.expected_state && item.value?.review_task_id === task.review_task_id && item.value?.review_evidence_hash === task.evidence_hash);
}
function lockPath(root, applicationId) { return join(root, 'data', 'human-review', 'resume-locks', `${applicationId}.lock`); }
function withApplicationReviewLock(root, applicationId, work) {
  const path = lockPath(root, applicationId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withPipelineLock(path, work);
}

async function decideAndResumeUnderLock({ graph, taskStore, reviewTaskId, applicationId, decision, dataRoot: root, canonicalStateReader, optionalSafeComment }) {
  let task = taskStore.get(reviewTaskId);
  if (!task) throw new Error('Human review task not found.');
  const threadId = assertTask(task, applicationId);
  if (!task.allowed_decisions?.includes(decision)) throw new Error('Decision is not allowed for this review type.');
  const config = { configurable: { thread_id: threadId } };
  let snapshot = await graph.getState(config);
  const completed = snapshot?.values?.human_review_task_id === task.review_task_id && snapshot?.values?.human_decision === decision;
  let canonical = canonicalStateReader(applicationId, { dataRoot: root });
  const candidateRecovery = task.review_type === 'CANDIDATE_FIT_REVIEW' && task.status === 'DECIDED' && task.decision === 'EVIDENCE_UPDATED'
    && canonical?.state === 'DEDUPED' && /^[a-f0-9]{64}$/i.test(canonical.metadata?.DEDUPED?.reviewEvidenceHash || '');
  if (!canonical || (!completed && !candidateRecovery && (canonical.state !== task.expected_state || (task.evidence?.canonical_version !== undefined && canonical.version !== task.evidence.canonical_version)))) throw new Error('Human review is stale against canonical application state/version.');
  if (task.status === 'DECIDED') {
    const receipt = taskStore.getDecisionReceipt(task.review_task_id);
    assertReceipt(task, receipt, decision, canonical, completed || candidateRecovery);
    if (completed) {
      const interrupts = pendingInterrupts(snapshot);
      if (interrupts.length) return { status: 'RESUMED_PAUSED_FOR_NEXT_REVIEW', duplicate: true, task, receipt, snapshot };
      if (hasRunnableWork(snapshot)) {
        const result = await graph.invoke(null, config);
        snapshot = await graph.getState(config);
        if (snapshot?.values?.human_review_task_id !== task.review_task_id || snapshot?.values?.human_decision !== decision) throw new Error('Checkpoint continuation lost the applied human decision marker.');
        return { status: 'RESUMED', duplicate: true, task, receipt, result, snapshot };
      }
      return { status: 'RESUMED', duplicate: true, task, receipt, snapshot };
    }
    if (task.decision !== decision) throw new Error('Review task was already decided differently.');
  } else if (!ACTIVE.has(task.status)) {
    throw new Error(`Review task is ${task.status}; resume rejected.`);
  }
  const matches = matchesTask(snapshot, task);
  if (completed) throw new Error('Checkpoint shows a completed review but no matching durable decision receipt exists.');
  if (matches.length !== 1) throw new Error('Graph interrupt is missing, ambiguous, or not bound to this task/evidence.');
  if (task.status !== 'DECIDED') {
    const result = await taskStore.decide(task.review_task_id, { application_id: applicationId, decision, evidence_hash: task.evidence_hash, current_state: canonical.state, canonical_version: canonical.version, decision_source: 'LOCAL_HUMAN', optional_safe_comment: optionalSafeComment });
    task = result.task;
  }
  const receipt = taskStore.getDecisionReceipt(task.review_task_id);
  assertReceipt(task, receipt, decision, canonical, candidateRecovery);
  const resumeValue = decision === 'EVIDENCE_UPDATED' ? { action: 'evidence_updated' } : { decision };
  const result = await graph.invoke(new Command({ resume: resumeValue }), config);
  snapshot = await graph.getState(config);
  if (snapshot?.values?.human_review_task_id !== task.review_task_id || snapshot?.values?.human_decision !== decision) throw new Error('Graph resume returned without a durable checkpoint marker for this decision. The receipt remains recorded; reconcile before retrying.');
  return { status: 'RESUMED', duplicate: false, task, receipt, result, snapshot };
}

/** Durable-decision-before-resume coordinator. Per-application OS lock serializes operators.
 * Checkpoint markers make replay idempotent; graph writers outside this lock remain outside
 * the local coordination guarantee. This is not distributed exactly-once. */
export async function decideAndResumeHumanReview(args = {}) {
  const { graph, taskStore, applicationId } = args;
  assertGraph(graph);
  if (!taskStore || typeof taskStore.get !== 'function' || typeof taskStore.decide !== 'function') throw new Error('A persistent human review task store is required.');
  const root = resolve(args.dataRoot || process.cwd());
  return withApplicationReviewLock(root, applicationId, () => decideAndResumeUnderLock({ ...args, dataRoot: root, canonicalStateReader: args.canonicalStateReader || readExistingState }));
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
  return value;
}
function checkpointFingerprint(snapshot) {
  const values = snapshot?.values || {};
  return JSON.stringify(sorted({
    config: snapshot?.config?.configurable, checkpoint_id: snapshot?.config?.configurable?.checkpoint_id,
    metadata: snapshot?.metadata, next: snapshot?.next || [],
    application_id: values.application_id, canonical_state: values.canonical_state, canonical_version: values.canonical_version,
    human_review_task_id: values.human_review_task_id, human_decision: values.human_decision,
    tasks: (snapshot?.tasks || []).map(task => ({ id: task.id, name: task.name, interrupts: (task.interrupts || []).map(item => {
      const value = item.value || {};
      return { id: item.id, type: value.type, application_id: value.application_id, canonical_state: value.canonical_state,
        review_task_id: value.review_task_id, review_evidence_hash: value.review_evidence_hash,
        allowed_decisions: value.allowed_decisions, review_recovery: value.review_recovery };
    }) }))
  }));
}
function sameDecisionSet(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && new Set(actual).size === expected.length
    && [...actual].sort().join('\0') === [...expected].sort().join('\0');
}
function validTaskId(value) { return typeof value === 'string' && /^rev-[a-f0-9]{32}$/.test(value); }
function interruptStatus(record, applicationId, threadId) {
  const value = record?.interrupt?.value;
  if (!value || value.application_id !== applicationId) return { status: 'CROSS_APPLICATION_REVIEW_INTERRUPT' };
  if (threadId !== stableEvaluationThreadId(applicationId)) return { status: 'CROSS_THREAD_REVIEW_BINDING' };
  if (!GRAPH_REVIEW_TYPES.includes(value.type)) return { status: 'UNKNOWN_REVIEW_INTERRUPT' };
  if (record.node !== REVIEW_NODE[value.type]) return { status: 'REVIEW_NODE_BINDING_MISMATCH' };
  if (!sameDecisionSet(value.allowed_decisions, REVIEW_DECISIONS[value.type])) return { status: 'INVALID_REVIEW_DECISIONS' };
  if (!validTaskId(value.review_task_id) || !/^[a-f0-9]{64}$/i.test(value.review_evidence_hash || '')) return { status: 'INSUFFICIENT_REVIEW_EVIDENCE' };
  return { status: 'VALID', value };
}
function taskDescriptorMatches(task, descriptor) {
  if (!task || !descriptor) return false;
  try {
    const checked = validateReviewRecoveryDescriptor(descriptor);
    return task.review_task_id === checked.review_task_id && task.generation === checked.generation
      && task.application_id === checked.application_id && task.review_type === checked.review_type
      && task.graph_thread_id === checked.graph_thread_id && task.source_event === checked.source_event
      && task.expected_state === checked.expected_state && task.evidence_hash === checked.evidence_hash
      && JSON.stringify(sorted(task.evidence)) === JSON.stringify(checked.evidence)
      && sameDecisionSet(task.allowed_decisions, checked.allowed_decisions);
  } catch { return false; }
}
function structuredDescriptor(value, applicationId, threadId) {
  if (!Object.hasOwn(value, 'review_recovery')) return { status: 'ABSENT' };
  try {
    const descriptor = validateReviewRecoveryDescriptor(value.review_recovery);
    if (descriptor.application_id !== applicationId || descriptor.graph_thread_id !== threadId
      || descriptor.review_task_id !== value.review_task_id || descriptor.review_type !== value.type
      || descriptor.source_event !== `${threadId}:${value.type}` || descriptor.expected_state !== value.canonical_state
      || descriptor.evidence_hash !== value.review_evidence_hash || !sameDecisionSet(descriptor.allowed_decisions, value.allowed_decisions)) {
      return { status: 'INVALID' };
    }
    return { status: 'VALID', descriptor };
  } catch { return { status: 'INVALID' }; }
}
function legacyDescriptor(snapshot, canonical, ledgerEvents, value, threadId) {
  if (!canonical) return null;
  const state = snapshot.values || {};
  let evidence;
  if (value.type === 'CANDIDATE_FIT_REVIEW') {
    const policyVersion = state.review_evidence?.fitPolicyVersion;
    if (typeof policyVersion !== 'string' || !policyVersion || !Number.isSafeInteger(state.canonical_version) || state.canonical_version !== canonical.version
      || state.review_evidence_hash !== value.evidence_hash) return null;
    evidence = { canonical_state: value.canonical_state, canonical_version: state.canonical_version,
      fit_evidence_hash: state.review_evidence_hash, policy_version: policyVersion };
  } else if (value.type === 'PRE_SUBMIT_REVIEW') {
    const matching = ledgerEvents.filter(event => event.type === 'PDF_VALIDATED'
      && event.payload?.input_fingerprint === state.cv_fingerprint && event.payload?.cv_sha256 === state.cv_artifact_sha256
      && event.payload?.pdf_sha256 === state.pdf_artifact_sha256 && event.payload?.jd_hash === state.jd_hash);
    if (matching.length !== 1) return null;
    evidence = { canonical_state: value.canonical_state, canonical_version: canonical.version, jd_hash: state.jd_hash,
      cv_fingerprint: state.cv_fingerprint, cv_artifact_sha256: state.cv_artifact_sha256,
      pdf_artifact_sha256: state.pdf_artifact_sha256, validation_event_id: matching[0].event_id };
  } else if (value.type === 'ATS_PREPARATION_REVIEW') {
    if (typeof state.ats_provider !== 'string' || !state.form_schema?.schema_hash || !state.preparation_receipt_ref) return null;
    evidence = { canonical_state: value.canonical_state, canonical_version: canonical.version, provider: state.ats_provider,
      form_schema_hash: state.form_schema.schema_hash, cv_artifact_sha256: state.pdf_artifact_sha256,
      preparation_receipt_ref: state.preparation_receipt_ref };
  } else if (value.type === 'FINAL_HUMAN_REVIEW') {
    const receipt = state.application_filled_receipt;
    if (!receipt || !state.application_filled_receipt_ref || typeof state.ats_provider !== 'string' || !state.job?.url) return null;
    evidence = { canonical_state: value.canonical_state, canonical_version: canonical.version, provider: state.ats_provider,
      application_url: state.job.url, schema_hash: receipt.schema_hash_live, fill_receipt_ref: state.application_filled_receipt_ref,
      fill_receipt_hash: receipt.receipt_hash, fill_event_type: state.status };
  } else return null;
  if (canonical.state !== value.canonical_state || hashHumanReviewEvidence(evidence) !== value.review_evidence_hash) return null;
  return { schema_version: 1, review_task_id: value.review_task_id, generation: null, application_id: value.application_id,
    review_type: value.type, graph_thread_id: threadId, source_event: `${threadId}:${value.type}`,
    expected_state: value.canonical_state, canonical_version: canonical.version, evidence,
    evidence_hash: value.review_evidence_hash, allowed_decisions: [...value.allowed_decisions] };
}
function failure(status, applicationId, taskIds = []) { return { status, application_id: applicationId, ...(taskIds.length ? { stale_task_ids: taskIds } : {}) }; }
function sameCanonical(canonical, descriptor) {
  return Boolean(canonical && canonical.state === descriptor.expected_state && canonical.version === descriptor.canonical_version);
}
function candidateReviewAdvanced(task, receipt, canonical, ledgerEvents) {
  if (!task || task.review_type !== 'CANDIDATE_FIT_REVIEW' || task.status !== 'DECIDED' || task.decision !== 'EVIDENCE_UPDATED'
    || !canonical || canonical.state !== 'DEDUPED') return false;
  const previousHash = task.evidence?.fit_evidence_hash;
  const nextHash = canonical.metadata?.DEDUPED?.reviewEvidenceHash;
  if (!/^[a-f0-9]{64}$/i.test(previousHash || '') || !/^[a-f0-9]{64}$/i.test(nextHash || '') || previousHash === nextHash) return false;
  try { assertReceipt(task, receipt, 'EVIDENCE_UPDATED', canonical, true); } catch { return false; }
  const events = ledgerEvents.filter(event => event.type === 'CANDIDATE_REVIEW_RESUMED'
    && event.payload?.previous_evidence_hash === previousHash && event.payload?.new_evidence_hash === nextHash);
  return events.length === 1;
}
async function staleIfCheckpointStable({ graph, config, snapshot, taskStore, taskIds, applicationId, dataRoot, canonicalStateReader, canonical }) {
  const latest = await graph.getState(config);
  if (checkpointFingerprint(latest) !== checkpointFingerprint(snapshot)) return { status: 'CHECKPOINT_CHANGED_DURING_RECONCILIATION' };
  const before = canonical || canonicalStateReader(applicationId, { dataRoot });
  const after = canonicalStateReader(applicationId, { dataRoot });
  if (before?.state !== after?.state || before?.version !== after?.version) return { status: 'CANONICAL_CHANGED_DURING_RECONCILIATION' };
  return { stale: await taskStore.markStaleMany(taskIds) };
}
function response(status, applicationId, taskId, extra = {}) {
  return { status, application_id: applicationId, ...(taskId ? { review_task_id: taskId } : {}), ...extra };
}

/** Reconciles durable review tasks with one public LangGraph checkpoint snapshot.
 * It never edits checkpoint internals and reports only identifiers/action statuses. */
export async function reconcileHumanReviewInterrupt({ graph, taskStore, applicationId, dataRoot, canonicalStateReader = readExistingState } = {}) {
  assertGraph(graph);
  if (!taskStore || typeof taskStore.list !== 'function' || typeof taskStore.get !== 'function' || typeof taskStore.markStaleMany !== 'function'
    || typeof taskStore.restoreFromInterrupt !== 'function') throw new Error('A persistent human review task store with reconciliation support is required.');
  const root = resolve(dataRoot || process.cwd());
  const threadId = stableEvaluationThreadId(applicationId);
  return withApplicationReviewLock(root, applicationId, async () => {
    const config = { configurable: { thread_id: threadId } };
    const snapshot = await graph.getState(config);
    if (snapshot?.config?.configurable?.thread_id !== threadId) return failure('CHECKPOINT_THREAD_UNVERIFIED', applicationId);
    if (snapshot?.values?.application_id !== applicationId) return failure('CROSS_APPLICATION_CHECKPOINT', applicationId);
    const records = pendingInterruptRecords(snapshot);
    const openTasks = taskStore.list({ applicationId }).filter(task => task.graph_thread_id && ACTIVE.has(task.status));
    if (records.length > 1) return failure('AMBIGUOUS_REVIEW_INTERRUPT', applicationId);

    const markerId = snapshot.values?.human_review_task_id;
    const markerDecision = snapshot.values?.human_decision;
    let appliedMarker = null;
    if (markerId || markerDecision) {
      const task = markerId && taskStore.get(markerId);
      if (!task || !markerDecision || task.application_id !== applicationId || task.graph_thread_id !== threadId || task.status !== 'DECIDED' || task.decision !== markerDecision) return failure('INVALID_APPLIED_DECISION_MARKER', applicationId);
      const canonical = canonicalStateReader(applicationId, { dataRoot: root });
      try { assertReceipt(task, taskStore.getDecisionReceipt(markerId), markerDecision, canonical, true); }
      catch { return failure('INVALID_APPLIED_DECISION_MARKER', applicationId); }
      appliedMarker = task;
    }

    if (records.length === 0) {
      const staleIds = openTasks.map(task => task.review_task_id);
      if (staleIds.length) {
        const outcome = await staleIfCheckpointStable({ graph, config, snapshot, taskStore, taskIds: staleIds, applicationId, dataRoot: root, canonicalStateReader });
        if (outcome.status) return failure(outcome.status, applicationId);
        const stale = outcome.stale;
        if (appliedMarker) {
          const resumed = await decideAndResumeUnderLock({ graph, taskStore, reviewTaskId: appliedMarker.review_task_id, applicationId,
            decision: appliedMarker.decision, dataRoot: root, canonicalStateReader });
          return response('ALREADY_RESUMED', applicationId, appliedMarker.review_task_id, { stale_task_ids: stale, continuation_status: resumed.status });
        }
        return failure('TASKS_STALE', applicationId, stale);
      }
      if (appliedMarker) {
        const resumed = await decideAndResumeUnderLock({ graph, taskStore, reviewTaskId: appliedMarker.review_task_id, applicationId,
          decision: appliedMarker.decision, dataRoot: root, canonicalStateReader });
        return response('ALREADY_RESUMED', applicationId, appliedMarker.review_task_id, { continuation_status: resumed.status });
      }
      const decided = taskStore.list({ applicationId }).filter(task => task.graph_thread_id && task.status === 'DECIDED');
      return failure(decided.length ? 'DECIDED_RECEIPT_UNRESOLVED' : 'NO_PENDING_REVIEW_INTERRUPT', applicationId);
    }

    const record = records[0];
    const binding = interruptStatus(record, applicationId, snapshot.config.configurable.thread_id);
    if (binding.status !== 'VALID') {
      if (binding.status === 'UNKNOWN_REVIEW_INTERRUPT' || binding.status === 'INVALID_REVIEW_DECISIONS' || binding.status === 'REVIEW_NODE_BINDING_MISMATCH') {
        const outcome = await staleIfCheckpointStable({ graph, config, snapshot, taskStore, taskIds: openTasks.map(task => task.review_task_id), applicationId, dataRoot: root, canonicalStateReader });
        if (outcome.status) return failure(outcome.status, applicationId);
        return failure(binding.status, applicationId, outcome.stale);
      }
      return failure(binding.status, applicationId);
    }
    const value = binding.value;
    const canonical = canonicalStateReader(applicationId, { dataRoot: root });
    if (value.canonical_state !== snapshot.values.canonical_state) return failure('CHECKPOINT_CANONICAL_BINDING_MISMATCH', applicationId);
    if (Object.hasOwn(value, 'review_recovery') && value.review_recovery?.application_id && value.review_recovery.application_id !== applicationId) return failure('CROSS_APPLICATION_REVIEW_INTERRUPT', applicationId);
    if (Object.hasOwn(value, 'review_recovery') && value.review_recovery?.graph_thread_id && value.review_recovery.graph_thread_id !== threadId) return failure('CROSS_THREAD_REVIEW_BINDING', applicationId);
    const descriptorResult = structuredDescriptor(value, applicationId, threadId);
    if (descriptorResult.status === 'INVALID') {
      const outcome = await staleIfCheckpointStable({ graph, config, snapshot, taskStore, taskIds: openTasks.filter(task => task.review_task_id === value.review_task_id).map(task => task.review_task_id), applicationId, dataRoot: root, canonicalStateReader, canonical });
      if (outcome.status) return failure(outcome.status, applicationId);
      return failure('INVALID_REVIEW_RECOVERY_DESCRIPTOR', applicationId, outcome.stale);
    }
    const existing = taskStore.get(value.review_task_id);
    if (existing && existing.application_id !== applicationId) return failure('CROSS_APPLICATION_REVIEW_TASK', applicationId);
    if (existing?.graph_thread_id && existing.graph_thread_id !== threadId) return failure('CROSS_THREAD_REVIEW_BINDING', applicationId);
    let descriptor = descriptorResult.descriptor;
    if (descriptorResult.status === 'ABSENT' && existing) {
      let existingEvidenceMatches = false;
      try { existingEvidenceMatches = hashHumanReviewEvidence(existing.evidence) === existing.evidence_hash; } catch {}
      if (existing.application_id !== applicationId || existing.review_type !== value.type || existing.graph_thread_id !== threadId
        || existing.source_event !== `${threadId}:${value.type}` || existing.evidence_hash !== value.review_evidence_hash
        || !existingEvidenceMatches || existing.expected_state !== value.canonical_state
        || !sameDecisionSet(existing.allowed_decisions, value.allowed_decisions)) {
        const outcome = await staleIfCheckpointStable({ graph, config, snapshot, taskStore, taskIds: [existing.review_task_id], applicationId, dataRoot: root, canonicalStateReader, canonical });
        if (outcome.status) return failure(outcome.status, applicationId);
        return failure('REVIEW_TASK_BINDING_MISMATCH', applicationId, outcome.stale);
      }
      descriptor = createReviewRecoveryDescriptor(existing);
    }
    if (descriptorResult.status === 'ABSENT' && !existing) {
      const ledgerEvents = new ApplicationLedger({ dataRoot: root }).eventStore.list(applicationId);
      descriptor = legacyDescriptor(snapshot, canonical, ledgerEvents, value, threadId);
      if (!descriptor) return failure('INSUFFICIENT_REVIEW_EVIDENCE', applicationId);
    }
    if (descriptorResult.status === 'VALID' && existing && !taskDescriptorMatches(existing, descriptor)) {
      const outcome = await staleIfCheckpointStable({ graph, config, snapshot, taskStore, taskIds: [existing.review_task_id], applicationId, dataRoot: root, canonicalStateReader, canonical });
      if (outcome.status) return failure(outcome.status, applicationId);
      return failure('REVIEW_TASK_BINDING_MISMATCH', applicationId, outcome.stale);
    }
    const ledgerEvents = existing?.review_type === 'CANDIDATE_FIT_REVIEW' && existing.status === 'DECIDED'
      ? new ApplicationLedger({ dataRoot: root }).eventStore.list(applicationId) : [];
    if (descriptor && !sameCanonical(canonical, descriptor)) {
      if (candidateReviewAdvanced(existing, existing && taskStore.getDecisionReceipt(existing.review_task_id), canonical, ledgerEvents)) {
        const latest = await graph.getState(config);
        const latestCanonical = canonicalStateReader(applicationId, { dataRoot: root });
        if (checkpointFingerprint(latest) !== checkpointFingerprint(snapshot) || latestCanonical?.state !== canonical?.state
          || latestCanonical?.version !== canonical?.version
          || latestCanonical?.metadata?.DEDUPED?.reviewEvidenceHash !== canonical?.metadata?.DEDUPED?.reviewEvidenceHash) return failure('CHECKPOINT_CHANGED_DURING_RECONCILIATION', applicationId);
        const resumed = await decideAndResumeUnderLock({ graph, taskStore, reviewTaskId: existing.review_task_id, applicationId,
          decision: 'EVIDENCE_UPDATED', dataRoot: root, canonicalStateReader });
        return response(resumed.duplicate ? 'ALREADY_RESUMED' : 'RESUMED', applicationId, existing.review_task_id, { duplicate: resumed.duplicate });
      }
      const outcome = await staleIfCheckpointStable({ graph, config, snapshot, taskStore, taskIds: openTasks.map(task => task.review_task_id), applicationId, dataRoot: root, canonicalStateReader, canonical });
      if (outcome.status) return failure(outcome.status, applicationId);
      return failure('CANONICAL_STATE_MISMATCH', applicationId, outcome.stale);
    }
    if (!canonical || canonical.state !== value.canonical_state) return failure('CANONICAL_STATE_MISMATCH', applicationId);
    if (existing?.status === 'DECIDED') {
      const receipt = taskStore.getDecisionReceipt(existing.review_task_id);
      if (!receipt || existing.decision !== receipt.decision) return failure('INVALID_DECISION_RECEIPT', applicationId);
      const resumed = await decideAndResumeUnderLock({ graph, taskStore, reviewTaskId: existing.review_task_id, applicationId,
        decision: existing.decision, dataRoot: root, canonicalStateReader });
      return response(resumed.duplicate ? 'ALREADY_RESUMED' : 'RESUMED', applicationId, existing.review_task_id, { duplicate: resumed.duplicate });
    }
    if (appliedMarker && appliedMarker.review_task_id === value.review_task_id) return response('ALREADY_RESUMED', applicationId, value.review_task_id);
    if (existing && !ACTIVE.has(existing.status)) return failure('REVIEW_TASK_HISTORY_CONFLICT', applicationId);
    if (existing && (existing.expected_state !== descriptor?.expected_state || existing.evidence_hash !== descriptor?.evidence_hash)) {
      const outcome = await staleIfCheckpointStable({ graph, config, snapshot, taskStore, taskIds: [existing.review_task_id], applicationId, dataRoot: root, canonicalStateReader, canonical });
      if (outcome.status) return failure(outcome.status, applicationId);
      return failure('REVIEW_TASK_BINDING_MISMATCH', applicationId, outcome.stale);
    }
    const staleTaskIds = openTasks.filter(task => task.review_task_id !== value.review_task_id).map(task => task.review_task_id);
    const before = checkpointFingerprint(snapshot);
    const latest = await graph.getState(config);
    if (checkpointFingerprint(latest) !== before) return failure('CHECKPOINT_CHANGED_DURING_RECONCILIATION', applicationId);
    const latestCanonical = canonicalStateReader(applicationId, { dataRoot: root });
    if (descriptor && !sameCanonical(latestCanonical, descriptor)) return failure('CANONICAL_STATE_MISMATCH', applicationId);
    try {
      const restored = await taskStore.restoreFromInterrupt(descriptor, { staleTaskIds, allowNextGeneration: descriptor.generation === null });
      return response(restored.duplicate ? 'INTERRUPT_MATCHED' : 'TASK_RECONSTRUCTED', applicationId, restored.task.review_task_id,
        { duplicate: restored.duplicate, stale_task_ids: restored.stale_task_ids });
    } catch (error) {
      const status = /history|generation|conflict|changed/i.test(error.message) ? 'REVIEW_TASK_HISTORY_CONFLICT' : 'INVALID_REVIEW_RECOVERY_DESCRIPTOR';
      return failure(status, applicationId);
    }
  });
}
