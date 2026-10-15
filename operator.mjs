#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { OperatorReadModels } from './src/agent/read-models/operator-read-models.mjs';
import { HumanReviewTaskStore } from './src/agent/infrastructure/persistence/human-review-task-store.mjs';
import { ApplicationLedger, createApplicationEventEmitter } from './src/agent/infrastructure/persistence/application-ledger.mjs';
import { candidateFactsFromSources } from './autonomous-pipeline.mjs';
import { confirmManualSubmission, UserFactStore } from './src/agent/infrastructure/persistence/inbound-events.mjs';
import { readExistingState } from './src/agent/domain/applications/application-state-machine.mjs';
import { NotificationOutbox, createLocalNotificationAdapter } from './src/agent/infrastructure/communications/notification-outbox.mjs';
import { createAutonomousEvaluationGraph, openLangGraphCheckpointStore } from './src/agent/graph/autonomous-langgraph.mjs';
import { decideAndResumeHumanReview, reconcileHumanReviewInterrupt } from './src/agent/runtime/human-review-resume-bridge.mjs';

const [resource, action, id, value] = process.argv.slice(2);
const dataRoot = getCareerOpsRoot();
const models = new OperatorReadModels({ dataRoot });
const reviewStore = new HumanReviewTaskStore({ dataRoot });
const notifications = reviewStore.notificationOutbox || new NotificationOutbox({ dataRoot });
const userFacts = new UserFactStore({ dataRoot, reviewTaskStore: reviewStore });
function loadCandidateFacts({ dataRoot: root }) {
  const profilePath = join(root, 'config', 'profile.yml');
  const cvPath = join(root, 'cv.md');
  const profile = existsSync(profilePath) ? yaml.load(readFileSync(profilePath, 'utf8')) || {} : {};
  const cvMarkdown = existsSync(cvPath) ? readFileSync(cvPath, 'utf8') : '';
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
    const checkpoint = openLangGraphCheckpointStore({ dataRoot });
    try {
      const graph = createAutonomousEvaluationGraph({ checkpointer: checkpoint.checkpointer, dataRoot, dependencies: { loadCandidateFacts } });
      const result = await decideAndResumeHumanReview({ graph, taskStore: reviewStore, reviewTaskId: id, applicationId: reviewStore.get(id)?.application_id, decision: value, dataRoot });
      console.log(JSON.stringify({ status: result.status, duplicate: result.duplicate, review_task_id: result.task.review_task_id, receipt_id: result.receipt.receipt_id, decision: result.receipt.decision }, null, 2));
    } finally { checkpoint.close(); }
    return;
  }
  if (resource === 'notifications' && action === 'deliver' && id) {
    console.log(JSON.stringify(await notifications.deliver(id, createLocalNotificationAdapter({ dataRoot })), null, 2)); return;
  }
  if (resource === 'notifications' && action === 'retry' && id) {
    console.log(JSON.stringify(await notifications.retry(id), null, 2)); return;
  }
  if (resource === 'notifications' && action === 'cancel' && id) {
    console.log(JSON.stringify(await notifications.cancel(id), null, 2)); return;
  }
  if (resource === 'notifications' && action === 'reconcile') {
    console.log(JSON.stringify(await notifications.reconcile(), null, 2)); return;
  }
  if (!commands[resource]?.[action] || (['show', 'timeline'].includes(action) && !id)) {
    console.error('Usage: node operator.mjs reviews list|show <id>|decide <id> <decision>|reconcile [application-id] | applications list|show|timeline <id>|confirm-submission <id> | facts list|provide <request-id> | notifications list|deliver|retry|cancel <id>|reconcile');
    process.exitCode = 2; return;
  }
  const result = commands[resource][action]();
  if (result === null) { console.error('Not found.'); process.exitCode = 1; }
  else console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
