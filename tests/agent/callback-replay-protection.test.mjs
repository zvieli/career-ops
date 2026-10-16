import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  TelegramCallbackStore,
  TelegramDeliveryStore,
  TelegramUpdateHandler,
  TelegramAuthError,
  TelegramCallbackError
} from '../../src/agent/infrastructure/communications/telegram-control-adapter.mjs';
import { HumanReviewTaskStore } from '../../src/agent/infrastructure/persistence/human-review-task-store.mjs';

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), 'cops-replay-test-'));
  const config = {
    token: '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ_12345678',
    allowedUserId: '794384941',
    allowedChatId: '794384941',
    configured: true,
    validationErrors: []
  };

  const taskStore = new HumanReviewTaskStore({ dataRoot: root });
  const callbackStore = new TelegramCallbackStore({ dataRoot: root });
  const deliveryStore = new TelegramDeliveryStore({ dataRoot: root });

  const transportCalls = [];
  const transport = {
    async answerCallbackQuery(args) { transportCalls.push({ method: 'answerCallbackQuery', args }); return true; },
    async editMessageText(args) { transportCalls.push({ method: 'editMessageText', args }); return true; },
    async sendMessage(args) { transportCalls.push({ method: 'sendMessage', args }); return true; }
  };

  const resumes = [];
  const onDecisionResumed = async (args) => {
    resumes.push(args);
    const task = taskStore.get(args.reviewTaskId);
    const decideRes = await taskStore.decide(args.reviewTaskId, {
      application_id: args.applicationId,
      decision: args.decision,
      evidence_hash: task.evidence_hash,
      current_state: 'CV_VALIDATED',
      canonical_version: 3,
      decision_source: args.decisionSource
    });
    return { status: 'RESUMED', receipt: decideRes.receipt };
  };

  const handler = new TelegramUpdateHandler({
    config,
    transport,
    callbackStore,
    deliveryStore,
    reviewTaskStore: taskStore,
    dataRoot: root,
    onDecisionResumed,
    canonicalStateReader: () => ({ state: 'CV_VALIDATED', version: 3 })
  });

  return {
    root,
    config,
    taskStore,
    callbackStore,
    deliveryStore,
    transport,
    transportCalls,
    resumes,
    handler,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

test('CASE 1 — Exact replay: same token, same review task, same decision', async () => {
  const h = createHarness();
  try {
    const appId = 'app-111111111111111111111111';
    const task = await h.taskStore.create({
      application_id: appId,
      review_type: 'PRE_SUBMIT_REVIEW',
      source_event: 'test:event-1',
      graph_thread_id: 'careerops-evaluation-v1:' + appId,
      expected_state: 'CV_VALIDATED',
      evidence: { canonical_state: 'CV_VALIDATED', canonical_version: 3 },
      allowed_decisions: ['PREPARE_APPLICATION', 'STOP']
    });

    const token = await h.callbackStore.createToken({
      review_task_id: task.review_task_id,
      application_id: appId,
      decision: 'PREPARE_APPLICATION',
      expected_evidence_hash: task.evidence_hash,
      expected_canonical_state: 'CV_VALIDATED',
      expected_canonical_version: 3
    });

    const update = {
      callback_query: {
        id: 'cq-replay-1',
        from: { id: 794384941 },
        message: { chat: { id: 794384941 }, message_id: 101 },
        data: token
      }
    };

    // First attempt: succeeds
    const firstRes = await h.handler.processUpdate(update);
    assert.equal(firstRes.status, 'DECISION_RECORDED');
    assert.equal(h.resumes.length, 1);
    const firstReceipt = h.taskStore.getDecisionReceipt(task.review_task_id);
    assert.ok(firstReceipt);

    // Second attempt: exact duplicate
    const secondRes = await h.handler.processUpdate(update);
    assert.equal(secondRes.status, 'ALREADY_DECIDED_SAME');
    assert.equal(secondRes.duplicate, true);

    // Assert CAREER_OPS_REPLAY_PROTECTION_VERIFIED:
    // 1. Zero second decision receipt created
    const allReceipts = h.taskStore.list({ applicationId: appId })
      .map(t => h.taskStore.getDecisionReceipt(t.review_task_id))
      .filter(Boolean);
    assert.equal(allReceipts.length, 1, 'Exact replay must NOT create a second receipt');
    assert.equal(allReceipts[0].receipt_id, firstReceipt.receipt_id);

    // 2. No second graph resume invoked
    assert.equal(h.resumes.length, 1, 'Exact replay must NOT invoke a second graph resume');
  } finally {
    h.cleanup();
  }
});

test('CASE 2 — Conflicting replay: same decided review task, different decision', async () => {
  const h = createHarness();
  try {
    const appId = 'app-111111111111111111111111';
    const task = await h.taskStore.create({
      application_id: appId,
      review_type: 'PRE_SUBMIT_REVIEW',
      source_event: 'test:event-2',
      graph_thread_id: 'careerops-evaluation-v1:' + appId,
      expected_state: 'CV_VALIDATED',
      evidence: { canonical_state: 'CV_VALIDATED', canonical_version: 3 },
      allowed_decisions: ['PREPARE_APPLICATION', 'STOP']
    });

    const token1 = await h.callbackStore.createToken({
      review_task_id: task.review_task_id,
      application_id: appId,
      decision: 'PREPARE_APPLICATION',
      expected_evidence_hash: task.evidence_hash,
      expected_canonical_state: 'CV_VALIDATED',
      expected_canonical_version: 3
    });

    const token2 = await h.callbackStore.createToken({
      review_task_id: task.review_task_id,
      application_id: appId,
      decision: 'STOP',
      expected_evidence_hash: task.evidence_hash,
      expected_canonical_state: 'CV_VALIDATED',
      expected_canonical_version: 3
    });

    // First decision: PREPARE_APPLICATION
    await h.handler.processUpdate({
      callback_query: {
        id: 'cq-conf-1',
        from: { id: 794384941 },
        message: { chat: { id: 794384941 }, message_id: 102 },
        data: token1
      }
    });

    const originalReceipt = h.taskStore.getDecisionReceipt(task.review_task_id);
    assert.equal(originalReceipt.decision, 'PREPARE_APPLICATION');
    assert.equal(h.resumes.length, 1);

    // Second conflicting decision: STOP
    await assert.rejects(
      h.handler.processUpdate({
        callback_query: {
          id: 'cq-conf-2',
          from: { id: 794384941 },
          message: { chat: { id: 794384941 }, message_id: 102 },
          data: token2
        }
      }),
      (err) => err instanceof TelegramCallbackError && err.code === 'CONFLICTING_DECISION'
    );

    // Assert: original decision unchanged, no new receipt, no second resume
    const taskAfter = h.taskStore.get(task.review_task_id);
    assert.equal(taskAfter.decision, 'PREPARE_APPLICATION');
    assert.equal(h.taskStore.getDecisionReceipt(task.review_task_id).receipt_id, originalReceipt.receipt_id);
    assert.equal(h.resumes.length, 1, 'Conflicting decision must NOT trigger graph resume');
  } finally {
    h.cleanup();
  }
});

test('CASE 3 — Foreign user: valid callback token clicked by unauthorized user', async () => {
  const h = createHarness();
  try {
    const appId = 'app-111111111111111111111111';
    const task = await h.taskStore.create({
      application_id: appId,
      review_type: 'PRE_SUBMIT_REVIEW',
      source_event: 'test:event-3',
      graph_thread_id: 'careerops-evaluation-v1:' + appId,
      expected_state: 'CV_VALIDATED',
      evidence: { canonical_state: 'CV_VALIDATED', canonical_version: 3 },
      allowed_decisions: ['PREPARE_APPLICATION', 'STOP']
    });

    const token = await h.callbackStore.createToken({
      review_task_id: task.review_task_id,
      application_id: appId,
      decision: 'PREPARE_APPLICATION',
      expected_evidence_hash: task.evidence_hash,
      expected_canonical_state: 'CV_VALIDATED',
      expected_canonical_version: 3
    });

    // Foreign user clicks
    await assert.rejects(
      h.handler.processUpdate({
        callback_query: {
          id: 'cq-foreign',
          from: { id: 666777888 }, // Foreign / unauthorized
          message: { chat: { id: 794384941 }, message_id: 103 },
          data: token
        }
      }),
      (err) => err instanceof TelegramAuthError && err.code === 'TELEGRAM_UNAUTHORIZED'
    );

    // Assert: token was NOT consumed; legitimate owner can still retry
    const storedToken = h.callbackStore.get(token);
    assert.equal(storedToken.used_at, null, 'Unauthorized attempt must NOT consume the token');

    // Assert: zero decision receipts created
    const taskStatus = h.taskStore.get(task.review_task_id);
    assert.equal(taskStatus.status, 'OPEN');
    assert.equal(h.resumes.length, 0);

    // Now legitimate user clicks same token -> succeeds!
    const legitRes = await h.handler.processUpdate({
      callback_query: {
        id: 'cq-legit',
        from: { id: 794384941 },
        message: { chat: { id: 794384941 }, message_id: 103 },
        data: token
      }
    });
    assert.equal(legitRes.status, 'DECISION_RECORDED');
    assert.equal(h.resumes.length, 1);
  } finally {
    h.cleanup();
  }
});

test('CASE 4 — Wrong chat, task, or application binding rejects fail closed', async () => {
  const h = createHarness();
  try {
    const appId = 'app-111111111111111111111111';
    const task = await h.taskStore.create({
      application_id: appId,
      review_type: 'PRE_SUBMIT_REVIEW',
      source_event: 'test:event-4',
      expected_state: 'CV_VALIDATED',
      evidence: { canonical_state: 'CV_VALIDATED', canonical_version: 3 },
      allowed_decisions: ['PREPARE_APPLICATION', 'STOP']
    });

    // Subcase 4A: Wrong chat
    const token = await h.callbackStore.createToken({
      review_task_id: task.review_task_id,
      application_id: appId,
      decision: 'PREPARE_APPLICATION',
      expected_evidence_hash: task.evidence_hash,
      expected_canonical_state: 'CV_VALIDATED',
      expected_canonical_version: 3
    });

    await assert.rejects(
      h.handler.processUpdate({
        callback_query: {
          id: 'cq-wrong-chat',
          from: { id: 794384941 },
          message: { chat: { id: 111111111 }, message_id: 104 }, // Wrong chat
          data: token
        }
      }),
      (err) => err instanceof TelegramAuthError && /Unauthorized Telegram chat/i.test(err.message)
    );

    // Subcase 4B: Wrong application binding in token
    const tokenCrossApp = await h.callbackStore.createToken({
      review_task_id: task.review_task_id,
      application_id: 'app-999999999999999999999999', // Mismatched!
      decision: 'PREPARE_APPLICATION',
      expected_evidence_hash: task.evidence_hash,
      expected_canonical_state: 'CV_VALIDATED',
      expected_canonical_version: 3
    });

    await assert.rejects(
      h.handler.processUpdate({
        callback_query: {
          id: 'cq-cross-app',
          from: { id: 794384941 },
          message: { chat: { id: 794384941 }, message_id: 104 },
          data: tokenCrossApp
        }
      }),
      (err) => err instanceof TelegramCallbackError && err.code === 'CROSS_APPLICATION_MISMATCH'
    );

    // No graph resumes occurred
    assert.equal(h.resumes.length, 0);
  } finally {
    h.cleanup();
  }
});
