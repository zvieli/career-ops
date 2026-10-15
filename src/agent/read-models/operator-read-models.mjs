import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ApplicationLedger } from '../infrastructure/persistence/application-ledger.mjs';
import { HumanReviewTaskStore } from '../infrastructure/persistence/human-review-task-store.mjs';
import { NotificationIntentStore } from '../infrastructure/communications/notification-intent-store.mjs';
import { listApplications, readExistingState } from '../domain/applications/application-state-machine.mjs';
import { getCareerOpsRoot } from '../../../path-resolver.mjs';

const EVENT_APP_ID = /^app-[a-f0-9]{24}$/i;
const safeText = (value, max = 120) => typeof value === 'string' ? value.replace(/[\r\n\t\u0000-\u001f\u007f\u2028\u2029]/g, ' ').slice(0, max) : '';
const latestOf = (events, predicate) => [...events].reverse().find(predicate);
const safeArtifactRef = value => typeof value === 'string' && /^[a-zA-Z0-9._/-]{1,240}$/.test(value) && !value.split('/').includes('..') ? value : null;
function readJsonl(path, label) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`${label} is corrupt at line ${i + 1}.`); }
  });
}

/** Rebuildable projections only; canonical state, ledger, and domain stores remain authoritative. */
export class OperatorReadModels {
  constructor({ dataRoot, ledger = new ApplicationLedger({ dataRoot }), reviewTaskStore = new HumanReviewTaskStore({ dataRoot }), notificationStore, stateReader = (id) => readExistingState(id, { dataRoot }) } = {}) {
    this.dataRoot = resolve(dataRoot || getCareerOpsRoot());
    this.ledger = ledger;
    this.reviewTaskStore = reviewTaskStore;
    this.notificationStore = notificationStore || reviewTaskStore.notificationOutbox || new NotificationIntentStore({ dataRoot: this.dataRoot });
    this.stateReader = stateReader;
  }
  reviewsList() {
    return this.reviewTaskStore.inbox().map(({ review_task_id, application_id, company, role, review_type, status, priority, created_at, current_state, reason, blocking_count }) => ({ review_task_id, application_id, company: safeText(company), role: safeText(role), review_type, status, priority, created_at, current_state, reason: safeText(reason), blocking_count }));
  }
  reviewShow(id) {
    const task = this.reviewTaskStore.get(id);
    if (!task) return null;
    const refs = Object.fromEntries(Object.entries(task.evidence || {}).filter(([key, value]) => /(?:artifact|receipt|schema)_ref$/i.test(key) && safeArtifactRef(value)).map(([key, value]) => [key, safeArtifactRef(value)]));
    return { review_task_id: task.review_task_id, application_id: task.application_id, company: safeText(task.company), role: safeText(task.role), review_type: task.review_type, status: task.status, priority: task.priority, created_at: task.created_at, updated_at: task.updated_at, expected_canonical_state: task.expected_state, reason: safeText(task.reason), blocking_fields: (task.blocking_fields || []).map(value => safeText(value, 80)), blocking_count: task.blocking_fields?.length || 0, allowed_decisions: [...task.allowed_decisions], decision: task.decision || null, evidence_hash: `sha256:${task.evidence_hash.slice(0, 16)}`, artifact_refs: refs, submission_performed: false, submit_capability: false };
  }
  applicationsList() {
    const events = this.ledger.eventStore.list();
    const ids = new Set([...events.map(event => event.application_id), ...listApplications({ dataRoot: this.dataRoot })]);
    return [...ids].sort().map(id => this.applicationShow(id));
  }
  applicationShow(id) {
    const events = EVENT_APP_ID.test(id) ? this.ledger.timeline(id) : [];
    const state = this.stateReader(id);
    if (!state && events.length === 0) return null;
    const discovered = events.find(event => event.type === 'JOB_DISCOVERED');
    const infoEvents = events.filter(event => event.payload?.company || event.payload?.role || event.payload?.title || event.payload?.provider);
    const details = infoEvents.flatMap(event => [event.payload, event.payload?.posting, event.payload?.job].filter(Boolean));
    const take = key => safeText([...details].reverse().find(item => typeof item[key] === 'string')?.[key]);
    const fit = latestOf(events, event => ['FIT_REASONABLE', 'FIT_REJECTED', 'FIT_NEEDS_REVIEW'].includes(event.type));
    const cv = latestOf(events, event => ['CV_GENERATED', 'PDF_VALIDATED'].includes(event.type));
    const ats = latestOf(events, event => event.type === 'APPLICATION_PREPARED');
    const fill = latestOf(events, event => ['APPLICATION_FILLED', 'APPLICATION_FILL_NEEDS_REVIEW'].includes(event.type));
    const activeReview = (typeof this.reviewTaskStore.list === 'function'
      ? this.reviewTaskStore.list({ activeOnly: true, applicationId: id })
      : this.reviewTaskStore.inbox().filter(item => item.application_id === id))[0] || null;
    const notifications = this.notificationsList().filter(item => item.application_id === id);
    const explicitSubmit = events.some(event => event.type === 'APPLICATION_SUBMITTED_CONFIRMED');
    const formFilled = fill?.type === 'APPLICATION_FILLED';
    const workflow = explicitSubmit ? 'APPLIED_CONFIRMED' : formFilled ? 'FILLED / AWAITING HUMAN ACTION' : fill?.type === 'APPLICATION_FILL_NEEDS_REVIEW' ? 'MANUAL_ACTION_REQUIRED' : state?.state || 'UNKNOWN';
    const last = events.at(-1);
    return {
      application_id: id, company: take('company'), role: take('role') || take('title'), canonical_state: state?.state || 'UNKNOWN',
      fit_status: fit?.payload?.fit_status || (fit?.type === 'FIT_REASONABLE' ? 'REASONABLE' : null),
      provider: take('provider') || fill?.payload?.provider || ats?.payload?.ats_provider || null,
      discovered_at: discovered?.occurred_at || null, last_updated_at: last?.occurred_at || state?.lastRun || null,
      cv_status: cv?.type || null, ats_status: ats?.payload?.extraction_status || (ats ? 'PREPARED' : null),
      fill_status: fill?.type === 'APPLICATION_FILLED' ? 'FILLED / AWAITING HUMAN ACTION' : fill?.type || null,
      active_review: activeReview ? { review_task_id: activeReview.review_task_id, review_type: activeReview.review_type, status: activeReview.status } : null,
      notification_status: notifications.length ? notifications[0].status : 'NONE',
      recruiter_status: events.some(event => event.type === 'RECRUITER_MESSAGE_RECEIVED') ? 'MESSAGE_RECEIVED' : 'NONE',
      interview_status: events.some(event => event.type === 'INTERVIEW_INVITE_RECEIVED') ? 'INVITE_RECEIVED' : 'NONE',
      workflow_status: workflow, event_count: events.length
    };
  }
  applicationTimeline(id) {
    if (!EVENT_APP_ID.test(id)) return [];
    return this.ledger.timeline(id).map(event => ({ event_id: event.event_id, sequence: event.sequence, type: event.type, occurred_at: event.occurred_at, summary: event.type === 'APPLICATION_SUBMITTED_CONFIRMED' ? 'Submission explicitly confirmed by a human' : event.type === 'APPLICATION_FILLED' ? 'Form filled; awaiting human action' : event.type.replaceAll('_', ' ').toLowerCase() }));
  }
  notificationsList() {
    const human = this.notificationStore.list().map(item => ({ notification_id: item.notification_id, application_id: item.application_id, review_task_id: item.review_task_id, type: item.type, channel: item.channel, status: item.status, created_at: item.created_at, attempts: item.attempts, next_attempt_at: item.next_attempt_at, source: 'human-review-outbox' }));
    const routerPath = join(this.dataRoot, 'data', 'notifications', 'outbox.jsonl');
    const latest = new Map();
    for (const row of readJsonl(routerPath, 'Router notification outbox')) latest.set(row.notification_id, row);
    const router = [...latest.values()].map(item => ({ notification_id: item.notification_id, application_id: item.application_id, review_task_id: null, type: item.event_id ? 'APPLICATION_EVENT' : 'APPLICATION_UPDATE', channel: item.channel, status: item.status, created_at: item.recorded_at, attempts: item.attempt || 0, next_attempt_at: null, source: 'event-router-outbox' }));
    return [...human, ...router].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || a.notification_id.localeCompare(b.notification_id));
  }
}
