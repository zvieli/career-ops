#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { OperatorReadModels } from './src/agent/read-models/operator-read-models.mjs';
import { HumanReviewTaskStore } from './src/agent/infrastructure/persistence/human-review-task-store.mjs';
import { ApplicationLedger, createApplicationEventEmitter } from './src/agent/infrastructure/persistence/application-ledger.mjs';
import { confirmManualSubmission, UserFactStore } from './src/agent/infrastructure/persistence/inbound-events.mjs';
import { readExistingState } from './src/agent/domain/applications/application-state-machine.mjs';
import { readSchedulerConfig, runScheduledOnce, validateSchedulerConfig } from './src/agent/runtime/scheduler.mjs';
import { listRunLeases } from './src/agent/infrastructure/persistence/run-lease-store.mjs';
import { getRun, listRuns, summarizeRuns } from './src/agent/infrastructure/persistence/agent-run-store.mjs';
import { listShadowActionReceipts } from './src/agent/infrastructure/persistence/shadow-action-store.mjs';
import { randomUUID } from 'node:crypto';

const [resource, action, id, value] = process.argv.slice(2);
const dataRoot = getCareerOpsRoot();
const models = new OperatorReadModels({ dataRoot });
const reviewStore = new HumanReviewTaskStore({ dataRoot });
const notifications = reviewStore.notificationOutbox;
async function loadNotificationOutbox() {
  const { NotificationOutbox } = await import('./src/agent/infrastructure/communications/notification-outbox.mjs');
  return new NotificationOutbox({ dataRoot, outboxPath: reviewStore.notificationPath });
}
const userFacts = new UserFactStore({ dataRoot, reviewTaskStore: reviewStore });
async function loadCandidateFacts({ dataRoot: root }) {
  const profilePath = join(root, 'config', 'profile.yml');
  const cvPath = join(root, 'cv.md');
  const profile = existsSync(profilePath) ? yaml.load(readFileSync(profilePath, 'utf8')) || {} : {};
  const cvMarkdown = existsSync(cvPath) ? readFileSync(cvPath, 'utf8') : '';
  const { candidateFactsFromSources } = await import('./autonomous-pipeline.mjs');
  return candidateFactsFromSources(profile, cvMarkdown);
}

const commands = {
  reviews: { list: () => models.reviewsList(), show: () => models.reviewShow(id) },
  applications: { list: () => models.applicationsList(), show: () => models.applicationShow(id), timeline: () => models.applicationTimeline(id) },
  notifications: { list: () => models.notificationsList() }
};

async function readInput(prompt, { hidden = false } = {}) {
  if (hidden && process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    return new Promise((resolve, reject) => {
      let value = '';
      process.stdout.write(prompt);
      process.stdin.setRawMode(true); process.stdin.resume();
      const onData = chunk => {
        for (const char of chunk.toString('utf8')) {
          const code = char.codePointAt(0);
          if (code === 3) { cleanup(); reject(new Error('Cancelled.')); return; }
          if (code === 13 || code === 10) { process.stdout.write(String.fromCharCode(10)); cleanup(); resolve(value); return; }
          if (code === 127 || code === 8) { value = [...value].slice(0, -1).join(''); continue; }
          if (code >= 32) { value += char; process.stdout.write('*'); }
        }
      };
      const cleanup = () => { process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); };
      process.stdin.on('data', onData);
    });
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(prompt); } finally { rl.close(); }
}

async function main() {
  if (resource === 'scheduler') {
    const configPath = join(dataRoot, 'data', 'scheduler-config.json');
    if (action === 'status') {
      let config, configError = null;
      try { config = readSchedulerConfig({ dataRoot }); } catch (error) { config = { enabled: false }; configError = error.message; }
      console.log(JSON.stringify({ config, config_valid: !configError, config_error: configError, leases: listRunLeases({ dataRoot }) }, null, 2)); return;
    }
    if (action === 'enable' || action === 'disable') {
      const config = action === 'disable'
        ? { enabled: false }
        : { enabled: true, mode: 'shadow', schedulerId: 'default', cadenceMs: 6 * 60 * 60_000, maxRuntimeMs: 30 * 60_000, maxJobs: 100 };
      const validated = validateSchedulerConfig(config);
      const directory = join(dataRoot, 'data'); mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temp = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temp, `${JSON.stringify(validated, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); chmodSync(temp, 0o600); renameSync(temp, configPath);
      console.log(JSON.stringify({ status: action === 'enable' ? 'ENABLED_CONFIG_ONLY' : 'DISABLED', scheduler_started: false, config: validated }, null, 2)); return;
    }
    if (action === 'run-once') {
      const result = await runScheduledOnce({ dataRoot });
      console.log(JSON.stringify(result, null, 2)); return;
    }
  }
  if (resource === 'runs' && action === 'list') { console.log(JSON.stringify(listRuns({ dataRoot }), null, 2)); return; }
  if (resource === 'runs' && action === 'show' && id) { console.log(JSON.stringify(getRun(id, { dataRoot }), null, 2)); return; }
  if (resource === 'system' && action === 'health') {
    const leases = listRunLeases({ dataRoot });
    const now = Date.now();
    console.log(JSON.stringify({ last_run: listRuns({ dataRoot })[0] || null, active_leases: leases.filter(item => item.status === 'ACTIVE' && Date.parse(item.expiresAt) > now), expired_active_leases: leases.filter(item => item.status === 'ACTIVE' && Date.parse(item.expiresAt) <= now), open_reviews: reviewStore.inbox().length, pending_notifications: notifications.list().filter(item => !['DELIVERED', 'CANCELLED'].includes(item.status)).length, run_totals: summarizeRuns({ dataRoot }) }, null, 2)); return;
  }
  if (resource === 'system' && action === 'readiness') {
    const leases = listRunLeases({ dataRoot }); const runs = listRuns({ dataRoot }); const recent = runs.slice(0, 10);
    let configValid = false; try { readSchedulerConfig({ dataRoot }); configValid = true; } catch {}
    const metricRuns = recent.filter(run => Array.isArray(run.stages) && run.stages.length > 0);
    const sumCounter = key => metricRuns.reduce((sum, run) => sum + (run.counters?.[key] || 0), 0);
    const requestAttempts = sumCounter('provider_attempts');
    const providerOperations = sumCounter('provider_operations');
    const failures = sumCounter('provider_failures');
    const rateLimits = sumCounter('rate_limits');
    const capacitySkipped = sumCounter('capacity_skipped_rediscoverable');
    const providerSourcesSkipped = sumCounter('provider_sources_skipped_budget');
    const livenessChecksSkipped = sumCounter('liveness_checks_skipped_budget');
    const securityFailures = sumCounter('security_failures');
    const latestMeasured = metricRuns[0] || null;
    const actionReceipts = listShadowActionReceipts({ dataRoot });
    const metricsAvailable = metricRuns.length > 0;
    const outcomeOf = run => run.outcome || (run.status === 'COMPLETED' ? ((run.warnings || []).length ? 'DEGRADED' : 'COMPLETED') : run.status);
    const successful = recent.filter(run => outcomeOf(run) === 'COMPLETED').length;
    const latestOutcome = runs.length ? outcomeOf(runs[0]) : null;
    const degradedRuns = recent.filter(run => outcomeOf(run) === 'DEGRADED').length;
    console.log(JSON.stringify({ scheduler_config_valid: configValid, run_count: runs.length, last_n_runs_success_rate: recent.length ? successful / recent.length : null, latest_run_outcome: latestOutcome, degraded_runs_in_window: degradedRuns, provider_failure_rate: providerOperations ? failures / providerOperations : null, provider_request_count: requestAttempts, provider_operation_count: providerOperations, provider_failure_count: failures, rate_limit_count: rateLimits, capacity_skipped_rediscoverable: capacitySkipped, capacity_skip_policy: 'REDISCOVER_ON_LATER_PROVIDER_SCAN', provider_sources_skipped_budget: providerSourcesSkipped, liveness_checks_skipped_budget: livenessChecksSkipped, durable_deferred_queue: false, run_stage_timings: latestMeasured?.timings || null, measured_runs_in_window: metricRuns.length, runs_in_window: recent.length, metrics_coverage: recent.length ? metricRuns.length / recent.length : null, stale_run_count: new Set(leases.filter(item => item.status === 'EXPIRED' || item.status === 'ABANDONED').map(item => item.runId)).size, expired_active_lease_count: leases.filter(item => item.status === 'ACTIVE' && Date.parse(item.expiresAt) <= Date.now()).length, active_lease_count: leases.filter(item => item.status === 'ACTIVE' && Date.parse(item.expiresAt) > Date.now()).length, open_review_count: reviewStore.inbox().length, pending_notifications: notifications.list().filter(item => !['DELIVERED', 'CANCELLED'].includes(item.status)).length, shadow_blocked_actions: actionReceipts.length, security_failures: securityFailures, detailed_metrics_status: metricsAvailable ? 'INTEGRATED' : 'NO_RUN_METRICS_YET', submission_capability: false, live_fill_supported: false, employer_contact: false, production_readiness: false }, null, 2)); return;
  }
  if (resource === 'facts' && action === 'list') { console.log(JSON.stringify(userFacts.listRequests(), null, 2)); return; }
  if (resource === 'facts' && action === 'provide' && id) {
    const request = userFacts.listRequests().find(item => item.request_id === id);
    if (!request) throw new Error('User fact request not found.');
    if (request.status !== 'OPEN') {
      const task = userFacts.reviewTaskStore.get(request.review_task_id);
      const receipt = userFacts.reviewTaskStore.getDecisionReceipt(request.review_task_id);
      const recoverable = request.status === 'DECIDED' && task?.status === 'DECIDED' && task.decision === 'SUPPLY_FACT'
        && receipt?.review_task_id === request.review_task_id && receipt.application_id === request.application_id
        && receipt.evidence_hash === task.evidence_hash && receipt.canonical_state_before === request.expected_state
        && receipt.canonical_version_before === request.canonical_version && /^[a-f0-9]{64}$/i.test(receipt.decision_value_hash || '');
      if (!recoverable) throw new Error('Open or receipt-bound recoverable user fact request not found.');
    }
    const canonical = readExistingState(request.application_id, { dataRoot });
    if (!canonical) throw new Error('The application has no canonical state.');
    const value = await readInput(`${request.prompt} (input hidden): `, { hidden: true });
    const result = await userFacts.provide({ requestId: id, value, currentState: canonical.state, currentVersion: canonical.version });
    console.log(JSON.stringify({ status: 'FACT_RECORDED', request_id: result.request_id, application_id: result.application_id, field: result.field, provenance: result.provenance, sensitive: result.sensitive }, null, 2)); return;
  }
  if (resource === 'applications' && action === 'confirm-submission' && id) {
    const assertion = await readInput(`Type SUBMITTED to confirm that you already submitted application ${id}: `);
    if (assertion !== 'SUBMITTED') throw new Error('No submission confirmation recorded.');
    const ledger = new ApplicationLedger({ dataRoot });
    const emitter = createApplicationEventEmitter(ledger, 'local-human-confirmation');
    const result = await confirmManualSubmission({ applicationId: id, confirmationId: `manual-submission:${id}`, assertedBy: 'local-human', dataRoot, applicationExists: appId => Boolean(readExistingState(appId, { dataRoot })), emitEvent: ({ applicationId, type, idempotencyKey, payload }) => emitter(applicationId, type, idempotencyKey, payload) });
    console.log(JSON.stringify({ status: result.duplicate ? 'ALREADY_CONFIRMED' : 'SUBMISSION_CONFIRMED', application_id: result.application_id, event_id: result.event_id }, null, 2)); return;
  }
  if (resource === 'reviews' && action === 'reconcile') {
    const ledger = new ApplicationLedger({ dataRoot });
    const applicationIds = id ? [id] : [...new Set([
      ...reviewStore.list().filter(task => task.graph_thread_id).map(task => task.application_id),
      ...ledger.eventStore.list().map(event => event.application_id)
    ])].sort();
    const [{ createAutonomousEvaluationGraph, openLangGraphCheckpointStore }, { reconcileHumanReviewInterrupt }] = await Promise.all([
      import('./src/agent/graph/autonomous-langgraph.mjs'), import('./src/agent/runtime/human-review-resume-bridge.mjs')
    ]);
    const checkpoint = openLangGraphCheckpointStore({ dataRoot });
    try {
      const graph = createAutonomousEvaluationGraph({ checkpointer: checkpoint.checkpointer, dataRoot, dependencies: { loadCandidateFacts } });
      const results = [];
      for (const applicationId of applicationIds) results.push(await reconcileHumanReviewInterrupt({ graph, taskStore: reviewStore, applicationId, dataRoot }));
      console.log(JSON.stringify(id ? (results[0] || { status: 'NO_APPLICATIONS_TO_RECONCILE' }) : { status: 'RECONCILIATION_COMPLETE', applications_checked: results.length, results }, null, 2));
    } finally { checkpoint.close(); }
    return;
  }
  if (resource === 'reviews' && action === 'decide' && id && value) {
    const task = reviewStore.get(id);
    if (!task) throw new Error('Human review task not found.');
    if (!task.graph_thread_id) {
      if (task.review_type === 'USER_FACT_REQUIRED' && value === 'SUPPLY_FACT') {
        const request = userFacts.listRequests().find(item => item.review_task_id === id);
        throw new Error(`Enter the human value with: node operator.mjs facts provide ${request?.request_id || '<request-id>'}`);
      }
      const current = readExistingState(task.application_id, { dataRoot });
      const result = await reviewStore.decide(id, { application_id: task.application_id, decision: value, evidence_hash: task.evidence_hash, current_state: current?.state || 'UNKNOWN', canonical_version: current?.version ?? null, decision_source: 'LOCAL_HUMAN' });
      console.log(JSON.stringify({ status: 'DECISION_RECORDED', review_task_id: id, receipt_id: result.receipt.receipt_id, decision: result.receipt.decision }, null, 2)); return;
    }
    const [{ createAutonomousEvaluationGraph, openLangGraphCheckpointStore }, { decideAndResumeHumanReview }] = await Promise.all([
      import('./src/agent/graph/autonomous-langgraph.mjs'), import('./src/agent/runtime/human-review-resume-bridge.mjs')
    ]);
    const checkpoint = openLangGraphCheckpointStore({ dataRoot });
    try {
      const graph = createAutonomousEvaluationGraph({ checkpointer: checkpoint.checkpointer, dataRoot, dependencies: { loadCandidateFacts } });
      const result = await decideAndResumeHumanReview({ graph, taskStore: reviewStore, reviewTaskId: id, applicationId: reviewStore.get(id)?.application_id, decision: value, dataRoot });
      console.log(JSON.stringify({ status: result.status, duplicate: result.duplicate, review_task_id: result.task.review_task_id, receipt_id: result.receipt.receipt_id, decision: result.receipt.decision }, null, 2));
    } finally { checkpoint.close(); }
    return;
  }
  if (resource === 'notifications' && action === 'deliver' && id) {
    const [{ createLocalNotificationAdapter }, outbox] = await Promise.all([
      import('./src/agent/infrastructure/communications/notification-outbox.mjs'), loadNotificationOutbox()
    ]);
    console.log(JSON.stringify(await outbox.deliver(id, createLocalNotificationAdapter({ dataRoot })), null, 2)); return;
  }
  if (resource === 'notifications' && action === 'retry' && id) {
    console.log(JSON.stringify(await (await loadNotificationOutbox()).retry(id), null, 2)); return;
  }
  if (resource === 'notifications' && action === 'cancel' && id) {
    console.log(JSON.stringify(await (await loadNotificationOutbox()).cancel(id), null, 2)); return;
  }
  if (resource === 'notifications' && action === 'reconcile') {
    console.log(JSON.stringify(await (await loadNotificationOutbox()).reconcile(), null, 2)); return;
  }
  if (resource === 'telegram') {
    const {
      readTelegramConfig,
      createTelegramBotTransport,
      TelegramCallbackStore,
      TelegramDeliveryStore,
      TelegramUpdateHandler,
      TelegramPollingService,
      deliverReviewTaskToTelegram
    } = await import('./src/agent/infrastructure/communications/telegram-control-adapter.mjs');

    const config = readTelegramConfig({ dataRoot });
    const transport = createTelegramBotTransport({ token: config.token });
    const callbackStore = new TelegramCallbackStore({ dataRoot });
    const deliveryStore = new TelegramDeliveryStore({ dataRoot });

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

      async function onDecisionResumed({ reviewTaskId, applicationId, decision, decisionSource }) {
        const [{ createAutonomousEvaluationGraph, openLangGraphCheckpointStore }, { decideAndResumeHumanReview }, { inspectLiveAtsReadOnly }] = await Promise.all([
          import('./src/agent/graph/autonomous-langgraph.mjs'),
          import('./src/agent/runtime/human-review-resume-bridge.mjs'),
          import('./src/agent/domain/applications/ats-preparation.mjs')
        ]);
        const checkpoint = openLangGraphCheckpointStore({ dataRoot });
        try {
          const graph = createAutonomousEvaluationGraph({
            checkpointer: checkpoint.checkpointer,
            dataRoot,
            dependencies: {
              loadCandidateFacts,
              liveAtsInspector: {
                inspect: async ({ provider, sourceUrl }) => inspectLiveAtsReadOnly({ provider, sourceUrl })
              }
            }
          });
          return await decideAndResumeHumanReview({ graph, taskStore: reviewStore, reviewTaskId, applicationId, decision, dataRoot, decisionSource });
        } finally {
          checkpoint.close();
        }
      }

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
  }
  if (!commands[resource]?.[action] || (['show', 'timeline'].includes(action) && !id)) {
    console.error('Usage: node operator.mjs scheduler status|run-once|enable|disable | runs list|show <run-id> | system health|readiness | reviews list|show <id>|decide <id> <decision>|reconcile [application-id] | applications list|show|timeline <id>|confirm-submission <id> | facts list|provide <request-id> | notifications list|deliver|retry|cancel <id>|reconcile | telegram status|test|pending|resend <id>|poll [--once]');
    process.exitCode = 2; return;
  }
  const result = commands[resource][action]();
  if (result === null) { console.error('Not found.'); process.exitCode = 1; }
  else console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
