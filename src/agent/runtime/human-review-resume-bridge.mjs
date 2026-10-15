import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command } from '@langchain/langgraph';
import { withPipelineLock } from '../../../pipeline-lock.mjs';
import { readExistingState } from '../domain/applications/application-state-machine.mjs';
import { stableEvaluationThreadId } from '../graph/autonomous-langgraph.mjs';
import { hashHumanReviewEvidence } from '../infrastructure/persistence/human-review-task-store.mjs';

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
function pendingInterrupts(snapshot) { return snapshot?.tasks?.flatMap(item => item.interrupts || []) || []; }
function hasRunnableWork(snapshot) {
  if (Array.isArray(snapshot?.next)) return snapshot.next.length > 0;
  return (snapshot?.tasks || []).some(task => !(task.interrupts || []).length);
}
function matchesTask(snapshot, task) {
  return pendingInterrupts(snapshot).filter(item => item.value?.type === task.review_type && item.value?.application_id === task.application_id
    && item.value?.canonical_state === task.expected_state && item.value?.review_task_id === task.review_task_id && item.value?.review_evidence_hash === task.evidence_hash);
}

/**
 * Durable-decision-before-resume coordinator. Per-application OS lock serializes
 * operators. A checkpoint marker makes post-invoke recovery idempotent; if the
 * process dies before checkpoint persistence, graph node recovery guards remain
 * responsible for making replay safe. This is not a claim of distributed exactly-once.
 */
export async function decideAndResumeHumanReview({ graph, taskStore, reviewTaskId, applicationId, decision, dataRoot, canonicalStateReader = readExistingState, optionalSafeComment } = {}) {
  assertGraph(graph);
  if (!taskStore || typeof taskStore.get !== 'function' || typeof taskStore.decide !== 'function') throw new Error('A persistent human review task store is required.');
  const root = resolve(dataRoot || process.cwd());
  const lockPath = join(root, 'data', 'human-review', 'resume-locks', `${applicationId}.lock`);
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  return withPipelineLock(lockPath, async () => {
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
    } else if (!['OPEN', 'CLAIMED'].includes(task.status)) {
      throw new Error(`Review task is ${task.status}; resume rejected.`);
    }
    let matches = matchesTask(snapshot, task);
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
  });
}
