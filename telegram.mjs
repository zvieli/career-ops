#!/usr/bin/env node
import { getCareerOpsRoot } from './path-resolver.mjs';
import { HumanReviewTaskStore } from './src/agent/infrastructure/persistence/human-review-task-store.mjs';
import {
  readTelegramConfig,
  createTelegramBotTransport,
  TelegramCallbackStore,
  TelegramDeliveryStore,
  TelegramUpdateHandler,
  TelegramPollingService,
  deliverReviewTaskToTelegram
} from './src/agent/infrastructure/communications/telegram-control-adapter.mjs';

const [action, id] = process.argv.slice(2);
const dataRoot = getCareerOpsRoot();
const reviewStore = new HumanReviewTaskStore({ dataRoot });
const config = readTelegramConfig({ dataRoot });
const transport = createTelegramBotTransport({ token: config.token });
const callbackStore = new TelegramCallbackStore({ dataRoot });
const deliveryStore = new TelegramDeliveryStore({ dataRoot });

async function loadCandidateFacts({ dataRoot: root }) {
  const { existsSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const yaml = await import('js-yaml');
  const profilePath = join(root, 'config', 'profile.yml');
  const cvPath = join(root, 'cv.md');
  const profile = existsSync(profilePath) ? yaml.load(readFileSync(profilePath, 'utf8')) || {} : {};
  const cvMarkdown = existsSync(cvPath) ? readFileSync(cvPath, 'utf8') : '';
  const { candidateFactsFromSources } = await import('./autonomous-pipeline.mjs');
  return candidateFactsFromSources(profile, cvMarkdown);
}

async function onDecisionResumed({ reviewTaskId, applicationId, decision, decisionSource }) {
  const [{ createAutonomousEvaluationGraph, openLangGraphCheckpointStore }, { decideAndResumeHumanReview }] = await Promise.all([
    import('./src/agent/graph/autonomous-langgraph.mjs'),
    import('./src/agent/runtime/human-review-resume-bridge.mjs')
  ]);
  const checkpoint = openLangGraphCheckpointStore({ dataRoot });
  try {
    const graph = createAutonomousEvaluationGraph({ checkpointer: checkpoint.checkpointer, dataRoot, dependencies: { loadCandidateFacts } });
    return await decideAndResumeHumanReview({ graph, taskStore: reviewStore, reviewTaskId, applicationId, decision, dataRoot, decisionSource });
  } finally {
    checkpoint.close();
  }
}

async function main() {
  if (action === 'status') {
    const polling = new TelegramPollingService({ config, transport, dataRoot });
    const pollState = polling.readState();
    const openReviews = reviewStore.inbox();
    const deliveries = deliveryStore.list();
    const lastDelivery = deliveries.at(-1) || null;
    console.log(JSON.stringify({
      bot_configured: Boolean(config.token),
      authorized_user_configured: Boolean(config.allowedUserId),
      authorized_chat_configured: Boolean(config.allowedChatId),
      status: config.configured ? 'CONFIGURED' : 'BLOCKED_BY_CONFIGURATION',
      last_update_offset: pollState.last_update_offset || 0,
      last_poll_time: pollState.last_poll_time || null,
      pending_review_count: openReviews.length,
      total_deliveries: deliveries.length,
      last_successful_delivery: lastDelivery ? {
        delivery_id: lastDelivery.delivery_id,
        review_task_id: lastDelivery.review_task_id,
        sent_at: lastDelivery.sent_at,
        status: lastDelivery.status
      } : null,
      validation_errors: config.validationErrors
    }, null, 2));
    return;
  }

  if (action === 'test') {
    if (!config.configured) {
      console.error(JSON.stringify({ status: 'BLOCKED_BY_CONFIGURATION', errors: config.validationErrors }, null, 2));
      process.exitCode = 1;
      return;
    }
    const chatId = config.allowedChatId || config.allowedUserId;
    try {
      const res = await transport.sendMessage({
        chatId,
        text: `🤖 Career-Ops Telegram Control Plane: Connection Test Successful\nTimestamp: ${new Date().toISOString()}`
      });
      console.log(JSON.stringify({ status: 'DELIVERED', message_id: res.message_id, chat_id: chatId }, null, 2));
    } catch (err) {
      console.error(JSON.stringify({ status: 'FAILED', error: err.message }, null, 2));
      process.exitCode = 1;
    }
    return;
  }

  if (action === 'pending') {
    const inbox = reviewStore.inbox();
    console.log(JSON.stringify({
      count: inbox.length,
      tasks: inbox.map(t => ({
        review_task_id: t.review_task_id,
        application_id: t.application_id,
        company: t.company,
        role: t.role,
        review_type: t.review_type,
        current_state: t.current_state,
        allowed_decisions: t.allowed_decisions,
        delivered: Boolean(deliveryStore.findDeliveryByTask(t.review_task_id))
      }))
    }, null, 2));
    return;
  }

  if (action === 'resend' && id) {
    const task = reviewStore.get(id);
    if (!task) throw new Error(`Human review task ${id} not found.`);
    const res = await deliverReviewTaskToTelegram({
      task,
      config,
      transport,
      callbackStore,
      deliveryStore,
      forceResend: true
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (action === 'poll') {
    const once = process.argv.includes('--once');
    const timeoutArg = process.argv.find(a => a.startsWith('--timeout='));
    const timeoutSec = timeoutArg ? parseInt(timeoutArg.split('=')[1], 10) : 20;

    const updateHandler = new TelegramUpdateHandler({
      config,
      transport,
      callbackStore,
      deliveryStore,
      reviewTaskStore: reviewStore,
      dataRoot,
      onDecisionResumed
    });

    const polling = new TelegramPollingService({
      config,
      transport,
      updateHandler,
      dataRoot
    });

    if (once) {
      const result = await polling.pollOnce({ timeout: Math.min(timeoutSec, 10) });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());
    process.on('SIGTERM', () => controller.abort());

    console.error(`Telegram polling started for authorized user ${config.allowedUserId}... (Ctrl+C to stop)`);
    const result = await polling.pollLoop({
      signal: controller.signal,
      timeout: timeoutSec,
      onProgress: p => {
        if (p.processed_count > 0) console.error(`Processed ${p.processed_count} Telegram update(s).`);
      }
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.error('Usage: node telegram.mjs status | test | pending | resend <review-task-id> | poll [--once] [--timeout=N]');
  process.exitCode = 2;
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
