import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  createAutonomousEvaluationGraph,
  openLangGraphCheckpointStore,
  stableEvaluationThreadId
} from '../../src/agent/graph/autonomous-langgraph.mjs';
import { HumanReviewTaskStore } from '../../src/agent/infrastructure/persistence/human-review-task-store.mjs';
import { ApplicationLedger } from '../../src/agent/infrastructure/persistence/application-ledger.mjs';
import {
  reconcileHumanReviewInterrupt,
  decideAndResumeHumanReview
} from '../../src/agent/runtime/human-review-resume-bridge.mjs';
import {
  TelegramDeliveryStore,
  TelegramCallbackStore,
  deliverReviewTaskToTelegram
} from '../../src/agent/infrastructure/communications/telegram-control-adapter.mjs';
import { transitionState, resetState } from '../../src/agent/domain/applications/application-state-machine.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function setupTestEnvironment() {
  const root = mkdtempSync(join(tmpdir(), 'cops-isolation-'));
  const appId = 'app-111111111111111111111111';

  // Seed minimum canonical files
  mkdirSync(join(root, 'cv'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });

  writeFileSync(join(root, 'cv.md'), '# CV\n\nExperience with Python and Backend.');
  writeFileSync(join(root, 'cv', 'lior_zvieli_cv.tex'), '% LaTeX\n\\begin{document}Lior Zvieli\\end{document}');
  writeFileSync(join(root, 'config', 'profile.yml'), 'candidate:\n  full_name: Lior Zvieli\n  gpa_value: 85\n');

  const cp = openLangGraphCheckpointStore({ dataRoot: root });
  const taskStore = new HumanReviewTaskStore({ dataRoot: root });
  const ledger = new ApplicationLedger({ dataRoot: root });
  const deliveryStore = new TelegramDeliveryStore({ dataRoot: root });
  const callbackStore = new TelegramCallbackStore({ dataRoot: root });

  return {
    root,
    appId,
    cp,
    taskStore,
    ledger,
    deliveryStore,
    callbackStore,
    cleanup: () => {
      try { cp.close(); } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test('Isolation & Recovery: Stale canonical version throws before decision receipt', async () => {
  const env = setupTestEnvironment();
  try {
    const task = await env.taskStore.create({
      application_id: env.appId,
      review_type: 'PRE_SUBMIT_REVIEW',
      source_event: `careerops-evaluation-v1:${env.appId}:PRE_SUBMIT_REVIEW`,
      graph_thread_id: `careerops-evaluation-v1:${env.appId}`,
      expected_state: 'CV_VALIDATED',
      evidence: { canonical_state: 'CV_VALIDATED', canonical_version: 2 },
      allowed_decisions: ['PREPARE_APPLICATION', 'STOP']
    });

    // Canonical state moves ahead to version 3
    resetState(env.appId, 'CV_VALIDATED', { dataRoot: env.root });
    const graph = createAutonomousEvaluationGraph({ checkpointer: env.cp.checkpointer, dataRoot: env.root });

    await assert.rejects(
      decideAndResumeHumanReview({
        graph,
        taskStore: env.taskStore,
        reviewTaskId: task.review_task_id,
        applicationId: env.appId,
        decision: 'PREPARE_APPLICATION',
        dataRoot: env.root
      }),
      /stale against canonical application state\/version/i
    );

    // Assert: zero decision receipts created for stale version
    const receipt = env.taskStore.getDecisionReceipt(task.review_task_id);
    assert.equal(receipt, null);
  } finally {
    env.cleanup();
  }
});

test('Isolation & Recovery: Checkpoint exists but canonical state moved fails closed', async () => {
  const env = setupTestEnvironment();
  try {
    // Application state is reset to DISCOVERED
    resetState(env.appId, 'DISCOVERED', { dataRoot: env.root });
    const graph = createAutonomousEvaluationGraph({ checkpointer: env.cp.checkpointer, dataRoot: env.root });

    const task = await env.taskStore.create({
      application_id: env.appId,
      review_type: 'PRE_SUBMIT_REVIEW',
      source_event: `careerops-evaluation-v1:${env.appId}:PRE_SUBMIT_REVIEW`,
      graph_thread_id: `careerops-evaluation-v1:${env.appId}`,
      expected_state: 'CV_VALIDATED',
      evidence: { canonical_state: 'CV_VALIDATED', canonical_version: 1 },
      allowed_decisions: ['PREPARE_APPLICATION', 'STOP']
    });

    await assert.rejects(
      decideAndResumeHumanReview({
        graph,
        taskStore: env.taskStore,
        reviewTaskId: task.review_task_id,
        applicationId: env.appId,
        decision: 'PREPARE_APPLICATION',
        dataRoot: env.root
      }),
      /stale against canonical application state/i
    );
  } finally {
    env.cleanup();
  }
});

test('Isolation & Recovery: Delivery deduplication across restart reuses existing message', async () => {
  const env = setupTestEnvironment();
  try {
    const task = await env.taskStore.create({
      application_id: env.appId,
      review_type: 'PRE_SUBMIT_REVIEW',
      source_event: `careerops-evaluation-v1:${env.appId}:PRE_SUBMIT_REVIEW`,
      expected_state: 'CV_VALIDATED',
      evidence: { canonical_state: 'CV_VALIDATED', canonical_version: 1 },
      allowed_decisions: ['PREPARE_APPLICATION', 'STOP']
    });

    const sent = [];
    const transport = {
      async sendMessage(args) { sent.push(args); return { message_id: 888 }; },
      async editMessageText() { return true; }
    };
    const config = { token: 'fake', allowedUserId: '123', configured: true };

    // Delivery 1
    const d1 = await deliverReviewTaskToTelegram({
      task,
      config,
      transport,
      callbackStore: env.callbackStore,
      deliveryStore: env.deliveryStore
    });

    assert.equal(d1.status, 'DELIVERED');
    assert.equal(d1.duplicate, false);
    assert.equal(sent.length, 1);

    // Simulate process restart with fresh in-memory delivery store loading from same disk
    const restartedDeliveryStore = new TelegramDeliveryStore({ dataRoot: env.root });
    const d2 = await deliverReviewTaskToTelegram({
      task,
      config,
      transport,
      callbackStore: env.callbackStore,
      deliveryStore: restartedDeliveryStore,
      forceResend: false
    });

    assert.equal(d2.status, 'DELIVERED');
    assert.equal(d2.duplicate, true);
    assert.equal(sent.length, 1, 'Delivery store MUST NOT dispatch second Telegram message across restart');
  } finally {
    env.cleanup();
  }
});

test('Isolation & Recovery: Isolated canary data root does not overwrite canonical historical state', async () => {
  const mainRoot = mkdtempSync(join(tmpdir(), 'cops-main-hist-'));
  const canaryRoot = mkdtempSync(join(tmpdir(), 'cops-canary-ns-'));
  try {
    const appId = 'app-111111111111111111111111';

    // Establish historical application record in main root
    resetState(appId, 'DISCOVERED', { dataRoot: mainRoot });
    transitionState(appId, 'NORMALIZED', {}, { dataRoot: mainRoot });
    transitionState(appId, 'DEDUPED', { dedupKey: 'next-backend' }, { dataRoot: mainRoot });

    const historicalStateBefore = readFileSync(join(mainRoot, 'data', 'applications', appId, 'state.json'), 'utf8');

    // Run canary in isolated canaryRoot
    resetState(appId, 'DISCOVERED', { dataRoot: canaryRoot });
    transitionState(appId, 'NORMALIZED', {}, { dataRoot: canaryRoot });

    // Verify main root historical application file was byte-identical / untouched
    const historicalStateAfter = readFileSync(join(mainRoot, 'data', 'applications', appId, 'state.json'), 'utf8');
    assert.equal(historicalStateBefore, historicalStateAfter, 'Canary namespace MUST NOT mutate main application state');
  } finally {
    rmSync(mainRoot, { recursive: true, force: true });
    rmSync(canaryRoot, { recursive: true, force: true });
  }
});
