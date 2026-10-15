import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanReviewTaskStore } from '../../../src/agent/infrastructure/persistence/human-review-task-store.mjs';
import { decideAndResumeHumanReview } from '../../../src/agent/runtime/human-review-resume-bridge.mjs';

const app = 'app-0123456789abcdef01234567';
const type = 'PRE_SUBMIT_REVIEW';
const thread = `careerops-evaluation-v1:${app}`;
const evidence = { canonical_state: 'CV_VALIDATED', canonical_version: 4, jd_hash: 'j'.repeat(64) };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'review-resume-'));
  const store = new HumanReviewTaskStore({ dataRoot: root, logPath: join(root, 'reviews.jsonl'), notificationPath: join(root, 'notifications.jsonl') });
  const taskPromise = store.create({ application_id: app, review_type: type, source_event: `${thread}:${type}`, graph_thread_id: thread, expected_state: 'CV_VALIDATED', evidence, allowed_decisions: ['STOP', 'PREPARE_APPLICATION'], reason: 'Review required' });
  return { root, store, taskPromise, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function makeGraph(task, { afterInvoke, decision = 'PREPARE_APPLICATION' } = {}) {
  let invokes = 0; let continuations = 0;
  const snapshot = { values: { human_review_task_id: '', human_decision: '' }, next: [], tasks: [{ interrupts: [{ value: { type, application_id: app, canonical_state: task.expected_state, review_task_id: task.review_task_id, review_evidence_hash: task.evidence_hash } }] }] };
  return { snapshot, get invokes() { return invokes; }, get continuations() { return continuations; }, async getState() { return structuredClone(snapshot); }, async invoke(command) {
    if (command === null) { continuations++; snapshot.tasks = []; snapshot.next = []; return { continued: true }; }
    invokes++;
    assert.deepEqual(command.resume, { decision });
    snapshot.values.human_review_task_id = task.review_task_id;
    snapshot.values.human_decision = decision;
    snapshot.tasks = []; snapshot.next = [];
    if (afterInvoke) await afterInvoke();
    return { resumed: true };
  } };
}
const canonicalStateReader = () => ({ state: 'CV_VALIDATED', version: 4 });

test('decision receipt is durable before exact bound interrupt resumes; replay is idempotent', async () => {
  const f = fixture();
  try {
    const task = await f.taskPromise; const graph = makeGraph(task);
    const args = { graph, taskStore: f.store, reviewTaskId: task.review_task_id, applicationId: app, decision: 'PREPARE_APPLICATION', dataRoot: f.root, canonicalStateReader };
    const [first, second] = await Promise.all([decideAndResumeHumanReview(args), decideAndResumeHumanReview(args)]);
    assert.equal(graph.invokes, 1);
    assert.equal(first.receipt.decision, 'PREPARE_APPLICATION');
    assert.equal(f.store.get(task.review_task_id).status, 'DECIDED');
    assert.ok(second.duplicate);
  } finally { f.cleanup(); }
});

test('a crash after checkpoint persistence recovers from the marker without a second invoke', async () => {
  const f = fixture();
  try {
    const task = await f.taskPromise;
    let canonical = { state: 'CV_VALIDATED', version: 4 };
    const graph = makeGraph(task, { afterInvoke: () => { canonical = { state: 'READY_TO_FILL', version: 5 }; graph.snapshot.next = ['downstream']; throw new Error('simulated lost response'); } });
    const args = { graph, taskStore: f.store, reviewTaskId: task.review_task_id, applicationId: app, decision: 'PREPARE_APPLICATION', dataRoot: f.root, canonicalStateReader: () => canonical };
    await assert.rejects(decideAndResumeHumanReview(args), /simulated lost response/);
    const recovered = await decideAndResumeHumanReview(args);
    assert.equal(graph.invokes, 1);
    assert.equal(graph.continuations, 1);
    assert.ok(recovered.duplicate);
  } finally { f.cleanup(); }
});

test('decision refuses one matching interrupt when any unknown or foreign interrupt is also pending', async () => {
  for (const extra of [
    { type: 'UNKNOWN_REVIEW', application_id: app },
    { type: 'PRE_SUBMIT_REVIEW', application_id: 'app-aaaaaaaaaaaaaaaaaaaaaaaa', review_task_id: 'rev-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', review_evidence_hash: 'f'.repeat(64), canonical_state: 'CV_VALIDATED' }
  ]) {
    const f = fixture();
    try {
      const task = await f.taskPromise; const graph = makeGraph(task);
      graph.snapshot.tasks.push({ interrupts: [{ value: extra }] });
      const args = { graph, taskStore: f.store, reviewTaskId: task.review_task_id, applicationId: app, decision: 'PREPARE_APPLICATION', dataRoot: f.root, canonicalStateReader };
      await assert.rejects(decideAndResumeHumanReview(args), /missing, ambiguous/);
      assert.equal(f.store.get(task.review_task_id).status, 'OPEN');
      assert.equal(f.store.getDecisionReceipt(task.review_task_id), null);
      assert.equal(graph.invokes, 0);
    } finally { f.cleanup(); }
  }
});

test('wrong task/evidence interrupt and stale canonical version fail before decision receipt', async () => {
  const f = fixture();
  try {
    const task = await f.taskPromise;
    const graph = makeGraph(task);
    graph.snapshot.tasks[0].interrupts[0].value.review_evidence_hash = '0'.repeat(64);
    const args = { graph, taskStore: f.store, reviewTaskId: task.review_task_id, applicationId: app, decision: 'PREPARE_APPLICATION', dataRoot: f.root, canonicalStateReader };
    await assert.rejects(decideAndResumeHumanReview(args), /missing, ambiguous/);
    assert.equal(f.store.get(task.review_task_id).status, 'OPEN');
    graph.snapshot.tasks[0].interrupts[0].value.review_evidence_hash = task.evidence_hash;
    await assert.rejects(decideAndResumeHumanReview({ ...args, canonicalStateReader: () => ({ state: 'CV_VALIDATED', version: 5 }) }), /stale/);
    assert.equal(f.store.get(task.review_task_id).status, 'OPEN');
  } finally { f.cleanup(); }
});

test('disallowed or conflicting human decisions are rejected without overwriting the receipt', async () => {
  const f = fixture();
  try {
    const task = await f.taskPromise; const graph = makeGraph(task, { decision: 'STOP' });
    const args = { graph, taskStore: f.store, reviewTaskId: task.review_task_id, applicationId: app, decision: 'STOP', dataRoot: f.root, canonicalStateReader };
    await decideAndResumeHumanReview(args);
    await assert.rejects(decideAndResumeHumanReview({ ...args, decision: 'PREPARE_APPLICATION' }), /already decided differently|receipt or decision binding/);
    assert.equal(f.store.get(task.review_task_id).decision, 'STOP');
    assert.equal(graph.invokes, 1);
  } finally { f.cleanup(); }
});
