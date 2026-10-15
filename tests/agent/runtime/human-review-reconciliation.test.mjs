import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanReviewTaskStore, createReviewRecoveryDescriptor } from '../../../src/agent/infrastructure/persistence/human-review-task-store.mjs';
import { ApplicationLedger } from '../../../src/agent/infrastructure/persistence/application-ledger.mjs';
import { reconcileHumanReviewInterrupt } from '../../../src/agent/runtime/human-review-resume-bridge.mjs';

const app = 'app-0123456789abcdef01234567';
const thread = `careerops-evaluation-v1:${app}`;
const type = 'PRE_SUBMIT_REVIEW';
const evidence = { canonical_state: 'CV_VALIDATED', canonical_version: 4, jd_hash: 'a'.repeat(64) };
const decisions = ['PREPARE_APPLICATION', 'CONTINUE_MANUALLY', 'STOP'];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'review-reconcile-'));
  const notificationPath = join(root, 'data', 'notifications', 'human-review-outbox.jsonl');
  const makeStore = name => new HumanReviewTaskStore({ dataRoot: root, logPath: join(root, `${name}.jsonl`), notificationPath });
  return { root, makeStore, notificationPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
async function makeTask(store, overrides = {}) {
  return store.create({ application_id: app, review_type: type, source_event: `${thread}:${type}`, graph_thread_id: thread, expected_state: 'CV_VALIDATED', evidence, allowed_decisions: decisions, reason: 'Review required', ...overrides });
}
function interruptFor(task, overrides = {}) {
  const node = task.review_type === 'CANDIDATE_FIT_REVIEW' ? 'candidate_fit_review' : task.review_type === 'ATS_PREPARATION_REVIEW' ? 'ats_preparation_review' : task.review_type === 'FINAL_HUMAN_REVIEW' ? 'final_human_review' : 'cv_validated_review';
  return { node, value: {
    type: task.review_type, application_id: task.application_id, canonical_state: task.expected_state,
    allowed_decisions: [...task.allowed_decisions], review_task_id: task.review_task_id,
    review_evidence_hash: task.evidence_hash, review_recovery: createReviewRecoveryDescriptor(task), ...overrides
  } };
}
function fakeGraph({ applicationId = app, threadId = thread, canonicalState = 'CV_VALIDATED', canonicalVersion = 4, interrupts = [], values = {}, next = [], changeTaskIdentityOnSecondRead = false } = {}) {
  const snapshot = { config: { configurable: { thread_id: threadId } }, values: { application_id: applicationId, canonical_state: canonicalState, canonical_version: canonicalVersion, human_review_task_id: '', human_decision: '', ...values }, next: [...next], tasks: interrupts.map((item, i) => ({ id: `pregel-${i}`, name: item.node, interrupts: [{ id: `interrupt-${i}`, value: item.value }] })) };
  let resumes = 0; let continuations = 0; let reads = 0;
  return { snapshot, get resumes() { return resumes; }, get continuations() { return continuations; }, async getState(config) { assert.equal(config.configurable.thread_id, threadId); reads++; if (changeTaskIdentityOnSecondRead && reads === 2 && snapshot.tasks[0]) snapshot.tasks[0].id = 'changed-pregel-task'; return structuredClone(snapshot); }, async invoke(command) {
    if (command === null) { continuations++; snapshot.next = []; snapshot.tasks = []; return { continued: true }; }
    resumes++;
    const decision = command.resume?.action === 'evidence_updated' ? 'EVIDENCE_UPDATED' : command.resume?.decision;
    snapshot.values.human_review_task_id = command.reviewTaskId || snapshot.tasks[0]?.interrupts[0]?.value?.review_task_id || '';
    snapshot.values.human_decision = decision || '';
    snapshot.next = []; snapshot.tasks = [];
    return { resumed: true };
  } };
}
function reconcileArgs(f, graph, taskStore, applicationId = app, canonical = { state: 'CV_VALIDATED', version: 4 }) {
  return { graph, taskStore, applicationId, dataRoot: f.root, canonicalStateReader: id => id === app ? canonical : null };
}
function notificationRows(path) {
  try { return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

test('orphan interrupt restores the exact deterministic task and replay keeps one notification', async () => {
  const f = fixture();
  try {
    const source = f.makeStore('source'); const original = await makeTask(source);
    const target = f.makeStore('target'); const graph = fakeGraph({ interrupts: [interruptFor(original)] });
    const first = await reconcileHumanReviewInterrupt(reconcileArgs(f, graph, target));
    assert.equal(first.status, 'TASK_RECONSTRUCTED');
    assert.equal(first.review_task_id, original.review_task_id);
    assert.deepEqual(target.get(original.review_task_id).evidence, evidence);
    const replay = await reconcileHumanReviewInterrupt(reconcileArgs(f, graph, target));
    assert.equal(replay.status, 'INTERRUPT_MATCHED');
    assert.equal(replay.review_task_id, original.review_task_id);
    assert.equal(target.list().length, 1);
    assert.equal(notificationRows(f.notificationPath).filter(row => row.idempotency_key === `review-created:${original.review_task_id}`).length, 1);
  } finally { f.cleanup(); }
});

test('open graph task with no current interrupt becomes stale', async () => {
  const f = fixture();
  try {
    const store = f.makeStore('tasks'); const task = await makeTask(store);
    const result = await reconcileHumanReviewInterrupt(reconcileArgs(f, fakeGraph(), store));
    assert.equal(result.status, 'TASKS_STALE');
    assert.equal(store.get(task.review_task_id).status, 'STALE');
  } finally { f.cleanup(); }
});

test('changed interrupt stales the old task and materializes the independently valid current task', async () => {
  const f = fixture();
  try {
    const active = f.makeStore('active');
    const old = await makeTask(active);
    const newEvidence = { ...evidence, jd_hash: 'b'.repeat(64) };
    const descriptorStore = f.makeStore('descriptor');
    const replacement = await makeTask(descriptorStore, { evidence: newEvidence });
    const graph = fakeGraph({ interrupts: [interruptFor(replacement)] });
    const result = await reconcileHumanReviewInterrupt(reconcileArgs(f, graph, active));
    assert.equal(result.status, 'TASK_RECONSTRUCTED');
    assert.equal(active.get(old.review_task_id).status, 'STALE');
    assert.equal(active.get(replacement.review_task_id).status, 'OPEN');
  } finally { f.cleanup(); }
});

test('persisted decision resumes the exact pending interrupt once; applied marker is idempotent', async () => {
  const f = fixture();
  try {
    const store = f.makeStore('tasks'); const task = await makeTask(store);
    await store.decide(task.review_task_id, { application_id: app, decision: 'STOP', evidence_hash: task.evidence_hash, current_state: task.expected_state, canonical_version: 4 });
    const graph = fakeGraph({ interrupts: [interruptFor(task)] });
    const first = await reconcileHumanReviewInterrupt(reconcileArgs(f, graph, store));
    assert.equal(first.status, 'RESUMED');
    assert.equal(graph.resumes, 1);
    const replay = await reconcileHumanReviewInterrupt(reconcileArgs(f, graph, store));
    assert.equal(replay.status, 'ALREADY_RESUMED');
    assert.equal(graph.resumes, 1);
  } finally { f.cleanup(); }
});

test('already-applied decision uses continuation semantics, never Command resume again', async () => {
  const f = fixture();
  try {
    const store = f.makeStore('tasks'); const task = await makeTask(store);
    await store.decide(task.review_task_id, { application_id: app, decision: 'STOP', evidence_hash: task.evidence_hash, current_state: task.expected_state, canonical_version: 4 });
    const graph = fakeGraph({ values: { human_review_task_id: task.review_task_id, human_decision: 'STOP' }, next: ['downstream'] });
    const result = await reconcileHumanReviewInterrupt(reconcileArgs(f, graph, store));
    assert.equal(result.status, 'ALREADY_RESUMED');
    assert.equal(graph.resumes, 0);
    assert.equal(graph.continuations, 1);
  } finally { f.cleanup(); }
});

test('multiple interrupts are ambiguous and do not create tasks or resume', async () => {
  const f = fixture();
  try {
    const source = f.makeStore('source'); const first = await makeTask(source);
    const second = await makeTask(source, { source_event: `${thread}:another`, evidence: { ...evidence, jd_hash: 'c'.repeat(64) } });
    const target = f.makeStore('target'); const graph = fakeGraph({ interrupts: [interruptFor(first), interruptFor(second)] });
    const result = await reconcileHumanReviewInterrupt(reconcileArgs(f, graph, target));
    assert.equal(result.status, 'AMBIGUOUS_REVIEW_INTERRUPT');
    assert.equal(target.list().length, 0);
    assert.equal(graph.resumes, 0);
  } finally { f.cleanup(); }
});

test('unknown interrupt type is fail-closed and never materialized', async () => {
  const f = fixture();
  try {
    const source = f.makeStore('source'); const task = await makeTask(source);
    const target = f.makeStore('target'); const graph = fakeGraph({ interrupts: [interruptFor(task, { type: 'UNKNOWN_REVIEW_TYPE' })] });
    const result = await reconcileHumanReviewInterrupt(reconcileArgs(f, graph, target));
    assert.equal(result.status, 'UNKNOWN_REVIEW_INTERRUPT');
    assert.equal(target.list().length, 0);
    assert.equal(graph.resumes, 0);
  } finally { f.cleanup(); }
});

test('canonical state/version mismatch prevents reconstruction and stales existing active tasks', async () => {
  const f = fixture();
  try {
    const task = await makeTask(f.makeStore('source'));
    const target = f.makeStore('target');
    const graph = fakeGraph({ canonicalVersion: 5, interrupts: [interruptFor(task)] });
    const result = await reconcileHumanReviewInterrupt(reconcileArgs(f, graph, target, app, { state: 'CV_VALIDATED', version: 5 }));
    assert.equal(result.status, 'CANONICAL_STATE_MISMATCH');
    assert.equal(target.list().length, 0);
    assert.equal(graph.resumes, 0);
  } finally { f.cleanup(); }
});

test('identity-only checkpoint change between inspection and restoration fails closed', async () => {
  const f = fixture();
  try {
    const task = await makeTask(f.makeStore('source'));
    const target = f.makeStore('target');
    const graph = fakeGraph({ interrupts: [interruptFor(task)], changeTaskIdentityOnSecondRead: true });
    const result = await reconcileHumanReviewInterrupt(reconcileArgs(f, graph, target));
    assert.equal(result.status, 'CHECKPOINT_CHANGED_DURING_RECONCILIATION');
    assert.equal(target.list().length, 0);
  } finally { f.cleanup(); }
});

test('foreign application task referenced by a legacy interrupt is rejected without staling it', async () => {
  const f = fixture();
  try {
    const otherApp = 'app-aaaaaaaaaaaaaaaaaaaaaaaa';
    const otherThread = `careerops-evaluation-v1:${otherApp}`;
    const store = f.makeStore('tasks');
    const foreign = await makeTask(store, { application_id: otherApp, graph_thread_id: otherThread, source_event: `${otherThread}:${type}` });
    const pending = interruptFor(foreign); delete pending.value.review_recovery; pending.value.application_id = app;
    const result = await reconcileHumanReviewInterrupt(reconcileArgs(f, fakeGraph({ interrupts: [pending] }), store));
    assert.equal(result.status, 'CROSS_APPLICATION_REVIEW_TASK');
    assert.equal(store.get(foreign.review_task_id).status, 'OPEN');
  } finally { f.cleanup(); }
});

test('advanced candidate canonical state resumes only with matching receipt and resumed-event evidence', async () => {
  const f = fixture();
  try {
    const store = f.makeStore('tasks');
    const oldFitHash = 'd'.repeat(64); const newFitHash = 'c'.repeat(64);
    const reviewTask = await makeTask(store, { review_type: 'CANDIDATE_FIT_REVIEW', source_event: `${thread}:CANDIDATE_FIT_REVIEW`,
      expected_state: 'NEEDS_REVIEW', allowed_decisions: ['EVIDENCE_UPDATED', 'STOP'],
      evidence: { canonical_state: 'NEEDS_REVIEW', canonical_version: 4, fit_evidence_hash: oldFitHash, policy_version: 'fit-v1' } });
    await store.decide(reviewTask.review_task_id, { application_id: app, decision: 'EVIDENCE_UPDATED', evidence_hash: reviewTask.evidence_hash, current_state: 'NEEDS_REVIEW', canonical_version: 4 });
    await new ApplicationLedger({ dataRoot: f.root }).recordEvent({ applicationId: app, type: 'CANDIDATE_REVIEW_RESUMED', producer: 'fixture',
      idempotencyKey: `candidate-review-resume:${oldFitHash}:${newFitHash}`, payload: { previous_evidence_hash: oldFitHash, new_evidence_hash: newFitHash } });
    const graph = fakeGraph({ canonicalState: 'NEEDS_REVIEW', canonicalVersion: 4, interrupts: [interruptFor(reviewTask)] });
    const canonical = { state: 'DEDUPED', version: 5, metadata: { DEDUPED: { reviewEvidenceHash: newFitHash } } };
    const result = await reconcileHumanReviewInterrupt(reconcileArgs(f, graph, store, app, canonical));
    assert.equal(result.status, 'RESUMED');
    assert.equal(result.review_task_id, reviewTask.review_task_id);
    assert.equal(graph.resumes, 1);
  } finally { f.cleanup(); }
});

test('cross-application and cross-thread bindings are rejected before mutation', async () => {
  const f = fixture();
  try {
    const source = f.makeStore('source'); const task = await makeTask(source);
    const target = f.makeStore('target');
    const crossApp = await reconcileHumanReviewInterrupt(reconcileArgs(f, fakeGraph({ interrupts: [interruptFor(task, { application_id: 'app-aaaaaaaaaaaaaaaaaaaaaaaa' })] }), target));
    assert.equal(crossApp.status, 'CROSS_APPLICATION_REVIEW_INTERRUPT');
    const descriptor = { ...createReviewRecoveryDescriptor(task), graph_thread_id: 'careerops-evaluation-v1:app-bbbbbbbbbbbbbbbbbbbbbbbb' };
    const crossThreadInterrupt = { ...interruptFor(task), value: { ...interruptFor(task).value, review_recovery: descriptor } };
    const crossThread = await reconcileHumanReviewInterrupt(reconcileArgs(f, fakeGraph({ interrupts: [crossThreadInterrupt] }), target));
    assert.equal(crossThread.status, 'CROSS_THREAD_REVIEW_BINDING');
    assert.equal(target.list().length, 0);
  } finally { f.cleanup(); }
});

test('malformed present recovery descriptor cannot downgrade to legacy reconstruction', async () => {
  const f = fixture();
  try {
    const task = await makeTask(f.makeStore('source'));
    const target = f.makeStore('target');
    const graph = fakeGraph({ interrupts: [interruptFor(task, { review_recovery: { schema_version: 999 } })] });
    const result = await reconcileHumanReviewInterrupt(reconcileArgs(f, graph, target));
    assert.equal(result.status, 'INVALID_REVIEW_RECOVERY_DESCRIPTOR');
    assert.equal(target.list().length, 0);
  } finally { f.cleanup(); }
});

test('recovery descriptors reject unknown fields rather than accepting an expanded evidence contract', async () => {
  const f = fixture();
  try {
    const task = await makeTask(f.makeStore('source'));
    const target = f.makeStore('target');
    const descriptor = { ...createReviewRecoveryDescriptor(task), page_text: 'must not become a recovery input' };
    const result = await reconcileHumanReviewInterrupt(reconcileArgs(f, fakeGraph({ interrupts: [interruptFor(task, { review_recovery: descriptor })] }), target));
    assert.equal(result.status, 'INVALID_REVIEW_RECOVERY_DESCRIPTOR');
    assert.equal(target.list().length, 0);
  } finally { f.cleanup(); }
});

test('legacy candidate interrupt reconstructs only when checkpoint and fit policy reproduce its evidence hash', async () => {
  const f = fixture();
  try {
    const fitHash = 'f'.repeat(64);
    const legacyEvidence = { canonical_state: 'NEEDS_REVIEW', canonical_version: 4, fit_evidence_hash: fitHash, policy_version: 'fit-v1' };
    const source = f.makeStore('source');
    const task = await source.create({ application_id: app, review_type: 'CANDIDATE_FIT_REVIEW', source_event: `${thread}:CANDIDATE_FIT_REVIEW`, graph_thread_id: thread,
      expected_state: 'NEEDS_REVIEW', evidence: legacyEvidence, allowed_decisions: ['EVIDENCE_UPDATED', 'STOP'] });
    const pending = interruptFor(task); delete pending.value.review_recovery; pending.value.evidence_hash = fitHash;
    const graph = fakeGraph({ canonicalState: 'NEEDS_REVIEW', canonicalVersion: 4,
      values: { review_evidence_hash: fitHash, review_evidence: { fitPolicyVersion: 'fit-v1' } }, interrupts: [pending] });
    const target = f.makeStore('target');
    const result = await reconcileHumanReviewInterrupt(reconcileArgs(f, graph, target, app, { state: 'NEEDS_REVIEW', version: 4 }));
    assert.equal(result.status, 'TASK_RECONSTRUCTED');
    assert.equal(result.review_task_id, task.review_task_id);
  } finally { f.cleanup(); }
});

test('legacy reconstruction refuses to guess a missing non-first task generation', async () => {
  const f = fixture();
  try {
    const fitHash = 'e'.repeat(64);
    const legacyEvidence = { canonical_state: 'NEEDS_REVIEW', canonical_version: 4, fit_evidence_hash: fitHash, policy_version: 'fit-v1' };
    const source = f.makeStore('source');
    const first = await source.create({ application_id: app, review_type: 'CANDIDATE_FIT_REVIEW', source_event: `${thread}:CANDIDATE_FIT_REVIEW`, graph_thread_id: thread,
      expected_state: 'NEEDS_REVIEW', evidence: legacyEvidence, allowed_decisions: ['EVIDENCE_UPDATED', 'STOP'] });
    await source.markStale(first.review_task_id);
    const second = await source.create({ application_id: app, review_type: 'CANDIDATE_FIT_REVIEW', source_event: `${thread}:CANDIDATE_FIT_REVIEW`, graph_thread_id: thread,
      expected_state: 'NEEDS_REVIEW', evidence: legacyEvidence, allowed_decisions: ['EVIDENCE_UPDATED', 'STOP'] });
    const pending = interruptFor(second); delete pending.value.review_recovery; pending.value.evidence_hash = fitHash;
    const graph = fakeGraph({ canonicalState: 'NEEDS_REVIEW', canonicalVersion: 4,
      values: { review_evidence_hash: fitHash, review_evidence: { fitPolicyVersion: 'fit-v1' } }, interrupts: [pending] });
    const target = f.makeStore('target');
    const result = await reconcileHumanReviewInterrupt(reconcileArgs(f, graph, target, app, { state: 'NEEDS_REVIEW', version: 4 }));
    assert.equal(result.status, 'REVIEW_TASK_HISTORY_CONFLICT');
    assert.equal(target.list().length, 0);
  } finally { f.cleanup(); }
});

test('matching existing task replay repairs a missing notification intent exactly once', async () => {
  const f = fixture();
  try {
    const store = f.makeStore('tasks'); const task = await makeTask(store);
    writeFileSync(f.notificationPath, '');
    const graph = fakeGraph({ interrupts: [interruptFor(task)] });
    const first = await reconcileHumanReviewInterrupt(reconcileArgs(f, graph, store));
    assert.equal(first.status, 'INTERRUPT_MATCHED');
    const second = await reconcileHumanReviewInterrupt(reconcileArgs(f, graph, store));
    assert.equal(second.status, 'INTERRUPT_MATCHED');
    assert.equal(notificationRows(f.notificationPath).filter(row => row.idempotency_key === `review-created:${task.review_task_id}`).length, 1);
  } finally { f.cleanup(); }
});

test('operator-facing target store cannot reopen task ID with surviving receipt history', async () => {
  const f = fixture();
  try {
    const source = f.makeStore('source'); const task = await makeTask(source);
    await source.decide(task.review_task_id, { application_id: app, decision: 'STOP', evidence_hash: task.evidence_hash, current_state: task.expected_state, canonical_version: 4 });
    const orphanedLog = join(f.root, 'orphaned.jsonl');
    mkdirSync(f.root, { recursive: true });
    const sourceRows = readFileSync(source.logPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    writeFileSync(orphanedLog, `${JSON.stringify(sourceRows.find(row => row.kind === 'DECISION'))}\n`);
    const target = new HumanReviewTaskStore({ dataRoot: f.root, logPath: orphanedLog, notificationPath: f.notificationPath });
    const result = await reconcileHumanReviewInterrupt(reconcileArgs(f, fakeGraph({ interrupts: [interruptFor(task)] }), target));
    assert.equal(result.status, 'REVIEW_TASK_HISTORY_CONFLICT');
    assert.equal(target.list().length, 0);
  } finally { f.cleanup(); }
});
