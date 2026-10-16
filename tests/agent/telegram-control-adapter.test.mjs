import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readTelegramConfig,
  assertTelegramAuthorized,
  createTelegramBotTransport,
  TelegramCallbackStore,
  TelegramDeliveryStore,
  TelegramUpdateHandler,
  TelegramPollingService,
  formatTelegramReviewMessage,
  deliverReviewTaskToTelegram
} from '../../src/agent/infrastructure/communications/telegram-control-adapter.mjs';
import { HumanReviewTaskStore } from '../../src/agent/infrastructure/persistence/human-review-task-store.mjs';

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'cops-tg-adapter-'));
  const config = {
    token: '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ_12345678',
    allowedUserId: '100200300',
    allowedChatId: '100200300',
    configured: true,
    validationErrors: []
  };
  const taskStore = new HumanReviewTaskStore({ dataRoot: root });
  const callbackStore = new TelegramCallbackStore({ dataRoot: root });
  const deliveryStore = new TelegramDeliveryStore({ dataRoot: root });

  const mockCalls = [];
  const fetchImpl = async (url, options) => {
    mockCalls.push({ url, body: JSON.parse(options.body || '{}') });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 12345, update_id: 888 } })
    };
  };

  const transport = createTelegramBotTransport({
    token: config.token,
    fetchImpl
  });

  return {
    root,
    config,
    taskStore,
    callbackStore,
    deliveryStore,
    mockCalls,
    transport,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

test('readTelegramConfig fails closed on missing or wildcard config', () => {
  // Empty env
  const c1 = readTelegramConfig({ env: {}, secretsFile: '/nonexistent' });
  assert.equal(c1.configured, false);
  assert.ok(c1.validationErrors.includes('TELEGRAM_BOT_TOKEN is missing'));
  assert.ok(c1.validationErrors.includes('TELEGRAM_ALLOWED_USER_ID is missing'));

  // Wildcard user
  const c2 = readTelegramConfig({
    env: {
      TELEGRAM_BOT_TOKEN: '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ_12345678',
      TELEGRAM_ALLOWED_USER_ID: '*'
    },
    secretsFile: '/nonexistent'
  });
  assert.equal(c2.configured, false);
  assert.ok(c2.validationErrors.some(e => /wildcards/i.test(e)));

  // Malformed bot token
  const c3 = readTelegramConfig({
    env: {
      TELEGRAM_BOT_TOKEN: 'invalid_token_no_colon',
      TELEGRAM_ALLOWED_USER_ID: '12345'
    },
    secretsFile: '/nonexistent'
  });
  assert.equal(c3.configured, false);
  assert.ok(c3.validationErrors.some(e => /token format/i.test(e)));

  // Valid config
  const c4 = readTelegramConfig({
    env: {
      TELEGRAM_BOT_TOKEN: '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ_12345678',
      TELEGRAM_ALLOWED_USER_ID: '123456789'
    },
    secretsFile: '/nonexistent'
  });
  assert.equal(c4.configured, true);
  assert.equal(c4.allowedUserId, '123456789');
  assert.equal(c4.validationErrors.length, 0);
});

test('Telegram delivery formatting includes required context and NO SUBMISSION notice', async () => {
  const f = createFixture();
  try {
    const task = {
      review_task_id: 'rev-abcdef1234567890abcdef1234567890',
      application_id: 'app-111111111111111111111111',
      company: 'Next Insurance',
      role: 'Graduate Backend Engineer',
      review_type: 'PRE_SUBMIT_REVIEW',
      reason: 'Fit evaluated as QUALIFIED (4.2/5)',
      expected_state: 'CV_VALIDATED',
      evidence_hash: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      allowed_decisions: ['PREPARE_APPLICATION', 'CONTINUE_MANUALLY', 'STOP']
    };

    const formatted = await formatTelegramReviewMessage(task, { callbackStore: f.callbackStore });
    assert.ok(formatted.text.includes('Next Insurance'));
    assert.ok(formatted.text.includes('Graduate Backend Engineer'));
    assert.ok(formatted.text.includes('NO APPLICATION HAS BEEN SUBMITTED'));
    assert.ok(formatted.reply_markup.inline_keyboard.length >= 2);

    // Verify callback tokens were stored
    const tokens = f.callbackStore.list();
    assert.equal(tokens.length, 3);
    for (const t of tokens) {
      assert.ok(t.token.startsWith('cb_'));
      assert.ok(t.token.length <= 64);
      assert.equal(t.review_task_id, task.review_task_id);
    }
  } finally {
    f.cleanup();
  }
});

test('deliverReviewTaskToTelegram records delivery and dedupes repeated delivery', async () => {
  const f = createFixture();
  try {
    const task = await f.taskStore.create({
      application_id: 'app-111111111111111111111111',
      review_type: 'PRE_SUBMIT_REVIEW',
      source_event: 'test:event-1',
      expected_state: 'CV_VALIDATED',
      evidence: { canonical_state: 'CV_VALIDATED', canonical_version: 1 },
      allowed_decisions: ['PREPARE_APPLICATION', 'STOP']
    });

    const d1 = await deliverReviewTaskToTelegram({
      task,
      config: f.config,
      transport: f.transport,
      callbackStore: f.callbackStore,
      deliveryStore: f.deliveryStore
    });

    assert.equal(d1.status, 'DELIVERED');
    assert.equal(d1.duplicate, false);
    assert.equal(f.mockCalls.length, 1);

    // Second call without forceResend is deduplicated
    const d2 = await deliverReviewTaskToTelegram({
      task,
      config: f.config,
      transport: f.transport,
      callbackStore: f.callbackStore,
      deliveryStore: f.deliveryStore,
      forceResend: false
    });

    assert.equal(d2.status, 'DELIVERED');
    assert.equal(d2.duplicate, true);
    assert.equal(f.mockCalls.length, 1, 'No duplicate HTTP message sent');
  } finally {
    f.cleanup();
  }
});

test('TelegramUpdateHandler generates canonical receipt with TELEGRAM actor source', async () => {
  const f = createFixture();
  try {
    const appId = 'app-111111111111111111111111';
    const task = await f.taskStore.create({
      application_id: appId,
      review_type: 'PRE_SUBMIT_REVIEW',
      source_event: 'test:event-receipt',
      expected_state: 'CV_VALIDATED',
      evidence: { canonical_state: 'CV_VALIDATED', canonical_version: 1 },
      allowed_decisions: ['PREPARE_APPLICATION', 'STOP']
    });

    const token = await f.callbackStore.createToken({
      review_task_id: task.review_task_id,
      application_id: appId,
      decision: 'PREPARE_APPLICATION',
      expected_evidence_hash: task.evidence_hash,
      expected_canonical_state: 'CV_VALIDATED',
      expected_canonical_version: 1
    });

    const handler = new TelegramUpdateHandler({
      config: f.config,
      transport: f.transport,
      callbackStore: f.callbackStore,
      deliveryStore: f.deliveryStore,
      reviewTaskStore: f.taskStore,
      dataRoot: f.root,
      canonicalStateReader: () => ({ state: 'CV_VALIDATED', version: 1 })
    });

    const result = await handler.processUpdate({
      callback_query: {
        id: 'cq-rec',
        from: { id: 100200300 },
        message: { chat: { id: 100200300 }, message_id: 55 },
        data: token
      }
    });

    assert.equal(result.status, 'DECISION_RECORDED');
    assert.equal(result.decision, 'PREPARE_APPLICATION');
    assert.ok(result.receipt_id.startsWith('rcpt-'));

    // Check durable receipt in task store
    const receipt = f.taskStore.getDecisionReceipt(task.review_task_id);
    assert.ok(receipt);
    assert.equal(receipt.decision, 'PREPARE_APPLICATION');
    assert.equal(receipt.decision_source, 'TELEGRAM:100200300');
    assert.equal(receipt.canonical_state_before, 'CV_VALIDATED');
    assert.equal(receipt.canonical_version_before, 1);
  } finally {
    f.cleanup();
  }
});

test('Offset persistence and polling state updates atomically', async () => {
  const f = createFixture();
  try {
    const handler = new TelegramUpdateHandler({
      config: f.config,
      transport: f.transport,
      callbackStore: f.callbackStore,
      deliveryStore: f.deliveryStore,
      reviewTaskStore: f.taskStore,
      dataRoot: f.root
    });

    const polling = new TelegramPollingService({
      config: f.config,
      transport: f.transport,
      updateHandler: handler,
      dataRoot: f.root
    });

    assert.equal(polling.readState().last_update_offset, 0);

    await polling.saveState({
      last_update_offset: 777,
      last_poll_time: '2026-01-01T00:00:00.000Z',
      processed_update_ids: [777]
    });

    const state = polling.readState();
    assert.equal(state.last_update_offset, 777);
    assert.equal(state.last_poll_time, '2026-01-01T00:00:00.000Z');
  } finally {
    f.cleanup();
  }
});
