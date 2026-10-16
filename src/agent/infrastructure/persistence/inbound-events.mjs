import { closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { withPipelineLock } from '../../../../pipeline-lock.mjs';
import { getCareerOpsRoot } from '../../../../path-resolver.mjs';
import { readExistingState } from '../../domain/applications/application-state-machine.mjs';
import { HumanReviewTaskStore } from './human-review-task-store.mjs';

export const INBOUND_TYPES = Object.freeze(['RECRUITER_MESSAGE_RECEIVED', 'INTERVIEW_INVITE_RECEIVED', 'APPLICATION_STATUS_CHANGED', 'UNMATCHED_INBOUND_EVENT']);
const APP_ID = /^app-[a-f0-9]{24}$/i;
const digest = value => createHash('sha256').update(String(value)).digest('hex');
function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`Inbound event store corrupt at line ${i + 1}; refusing writes.`); }
  });
}
function append(path, record) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'a', 0o600);
  try { fchmodSync(fd, 0o600); writeSync(fd, `${JSON.stringify(record)}\n`, null, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
}
function matchingIds(applications, predicate) { return [...new Set(applications.filter(predicate).map(app => app.application_id))]; }
function exactMatch(event, applications) {
  const signals = [];
  if (event.applicationId) signals.push(['application_id', id => id === event.applicationId]);
  if (event.providerApplicationId) signals.push(['provider_application_id', app => event.provider && app.provider === event.provider && app.provider_application_id === event.providerApplicationId]);
  if (event.threadId) signals.push(['thread_id', app => app.thread_id === event.threadId]);
  if (event.externalId) signals.push(['external_id', app => event.provider && app.provider === event.provider && app.external_id === event.externalId]);
  const matched = new Set();
  for (const [field, predicate] of signals) {
    const ids = field === 'application_id' ? matchingIds(applications, id => predicate(id.application_id)) : matchingIds(applications, predicate);
    if (ids.length !== 1) return { applicationId: null, matchLevel: null };
    matched.add(ids[0]);
  }
  if (matched.size > 1) return { applicationId: null, matchLevel: null };
  if (matched.size === 1) {
    const applicationId = [...matched][0];
    const app = applications.find(candidate => candidate.application_id === applicationId);
    if (event.provider && app.provider !== event.provider) return { applicationId: null, matchLevel: null };
    if (event.company && app.company !== event.company) return { applicationId: null, matchLevel: null };
    if (event.role && app.role !== event.role) return { applicationId: null, matchLevel: null };
    return { applicationId, matchLevel: 1 };
  }
  if (event.provider && event.company && event.role) {
    const ids = matchingIds(applications, app => app.provider === event.provider && app.company === event.company && app.role === event.role);
    if (ids.length === 1) return { applicationId: ids[0], matchLevel: 2 };
  }
  return { applicationId: null, matchLevel: null };
}

/** Fixture/adapter ingestion only. Message bodies are neither stored nor emitted. */
export async function ingestInboundEvents({ events, applications, storePath, dataRoot, reviewTaskStore, emitEvent, emitUnmatchedEvent, requestHighPriorityReview } = {}) {
  if (!Array.isArray(events) || !Array.isArray(applications)) throw new Error('events and applications must be arrays.');
  if (typeof emitEvent !== 'function' && typeof emitUnmatchedEvent !== 'function') throw new Error('An event persistence adapter is required.');
  dataRoot = resolve(dataRoot || (storePath ? dirname(resolve(storePath)) : getCareerOpsRoot()));
  reviewTaskStore ||= new HumanReviewTaskStore({ dataRoot });
  const path = resolve(storePath || join(dataRoot, 'data', 'inbound-events.jsonl'));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const result = [];
  for (const event of events) {
    if (!event || !['recruiter_message', 'interview_invite', 'application_status_change'].includes(event.kind)
      || typeof event.sourceId !== 'string' || !event.sourceId.trim() || typeof event.provider !== 'string' || !event.provider.trim()) throw new Error('Invalid normalized inbound event.');
    const { applicationId, matchLevel } = exactMatch(event, applications);
    const sourceKey = digest(`${event.provider}\0${event.sourceId}`);
    const type = applicationId ? ({ recruiter_message: 'RECRUITER_MESSAGE_RECEIVED', interview_invite: 'INTERVIEW_INVITE_RECEIVED', application_status_change: 'APPLICATION_STATUS_CHANGED' })[event.kind] : 'UNMATCHED_INBOUND_EVENT';
    const externalStatus = typeof event.status === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(event.status) ? event.status : null;
    const payload = { provider: event.provider.replace(/[\r\n\t\u0000-\u001f\u007f]/g, '').slice(0, 80), source_id_hash: sourceKey, received_at: typeof event.receivedAt === 'string' && !/[\r\n\t\u0000-\u001f\u007f]/.test(event.receivedAt) ? event.receivedAt.slice(0, 40) : null,
      match_status: applicationId ? 'MATCHED_EXACT' : 'UNMATCHED_OR_AMBIGUOUS', match_level: matchLevel,
      ...(type === 'APPLICATION_STATUS_CHANGED' ? { external_status: externalStatus || 'UNRECOGNIZED' } : {}) };
    const item = await withPipelineLock(path, async () => {
      const rows = readJsonl(path);
      const prior = rows.find(row => row.source_key === sourceKey && row.kind === 'INBOUND_RECEIVED');
      if (prior?.event_id || prior?.type === 'UNMATCHED_INBOUND_EVENT') return { ...prior, duplicate: true };
      let emitted = null;
      if (type === 'UNMATCHED_INBOUND_EVENT') {
        if (typeof emitUnmatchedEvent === 'function') emitted = await emitUnmatchedEvent({ type, source_key: sourceKey, payload });
      } else {
        if (typeof emitEvent !== 'function') throw new Error('Matched inbound event emitter is required.');
        emitted = await emitEvent({ applicationId, type, idempotencyKey: `inbound:${sourceKey}`, payload });
      }
      const row = { kind: 'INBOUND_RECEIVED', source_key: sourceKey, application_id: applicationId, type, payload, event_id: emitted?.event_id || null, created_at: new Date().toISOString() };
      append(path, row);
      return { ...row, duplicate: false };
    });
    if (item.type === 'INTERVIEW_INVITE_RECEIVED' && item.application_id) {
      const matchedApp = applications.find(candidate => candidate.application_id === item.application_id);
      const canonical = readExistingState(item.application_id, { dataRoot });
      const review = await reviewTaskStore.create({ application_id: item.application_id, review_type: 'INTERVIEW_INVITE_RECEIVED', source_event: `inbound-interview:${item.event_id || sourceKey}`, expected_state: canonical?.state || 'UNKNOWN', evidence: { inbound_event_id: item.event_id || sourceKey, source_id_hash: sourceKey, provider: event.provider }, allowed_decisions: ['ACKNOWLEDGE', 'STOP'], reason: 'Interview invitation received; human review required', priority: 100, company: matchedApp?.company || '', role: matchedApp?.role || '' });
      if (!item.duplicate && typeof requestHighPriorityReview === 'function') await requestHighPriorityReview({ applicationId: item.application_id, eventId: item.event_id, priority: 100, reviewTaskId: review.review_task_id });
    }
    result.push(item);
  }
  return result;
}

/** Structured fact requests bind the review and state; provided values remain in private user data only. */
export class UserFactStore {
  constructor({ filePath, dataRoot = getCareerOpsRoot(), reviewTaskStore, onBoundary = async () => {} } = {}) {
    this.filePath = resolve(filePath || join(dataRoot, 'data', 'user-facts', 'records.jsonl'));
    this.reviewTaskStore = reviewTaskStore || new HumanReviewTaskStore({ dataRoot: dataRoot || dirname(this.filePath) });
    this.onBoundary = onBoundary;
  }
  listRequests() {
    const rows = readJsonl(this.filePath);
    return rows.filter(row => row.kind === 'FACT_REQUEST').map(row => {
      const task = this.reviewTaskStore.get(row.review_task_id);
      const provided = rows.some(item => item.kind === 'FACT_PROVIDED' && item.request_id === row.request_id);
      return { request_id: row.request_id, review_task_id: row.review_task_id, application_id: row.application_id, field: row.field, prompt: row.prompt, sensitive: row.sensitive, expected_state: row.expected_state, canonical_version: row.canonical_version, status: provided ? 'PROVIDED' : task?.status === 'DECIDED' && task.decision === 'STOP' ? 'STOPPED' : task?.status || row.status, created_at: row.created_at };
    });
  }
  factsForApplication(applicationId) {
    if (!APP_ID.test(applicationId || '')) throw new Error('Valid application ID required.');
    const rows = readJsonl(this.filePath);
    return Object.fromEntries(rows.filter(row => row.kind === 'FACT_PROVIDED' && row.application_id === applicationId).map(row => [row.field, { value: row.value, provenance: row.provenance, sensitive: row.sensitive, provided_at: row.provided_at }]));
  }
  async request({ applicationId, field, prompt, sensitive = false, currentState, currentVersion, evidenceHash }) {
    if (!APP_ID.test(applicationId || '') || !/^[A-Za-z][A-Za-z0-9_]{1,63}$/.test(field || '') || typeof prompt !== 'string' || !prompt.trim() || typeof currentState !== 'string' || !currentState || !Number.isSafeInteger(currentVersion) || currentVersion < 1 || typeof evidenceHash !== 'string' || !/^[a-f0-9]{64}$/i.test(evidenceHash)) throw new Error('Valid application, structured fact key, current state/version and evidence hash are required.');
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    return withPipelineLock(this.filePath, async () => {
      const rows = readJsonl(this.filePath); const id = digest(`${applicationId}\0${field}\0${evidenceHash}\0${currentState}\0${currentVersion}`);
      const prior = rows.find(row => row.kind === 'FACT_REQUEST' && row.request_id === id);
      if (prior) return { ...prior, duplicate: true };
      const review = await this.reviewTaskStore.create({ application_id: applicationId, review_type: 'USER_FACT_REQUIRED', source_event: `user-fact:${id}`, expected_state: currentState, evidence: { canonical_state: currentState, canonical_version: currentVersion, requested_fact_key: field, source_evidence_hash: evidenceHash }, allowed_decisions: ['SUPPLY_FACT', 'STOP'], reason: `Candidate fact required: ${field}`, blocking_fields: [field] });
      const request = { kind: 'FACT_REQUEST', request_id: id, value_commitment_salt: randomBytes(32).toString('hex'), review_task_id: review.review_task_id, application_id: applicationId, field, prompt: prompt.replace(/[\r\n\t\u0000-\u001f\u007f\u2028\u2029]/g, ' ').slice(0, 240), sensitive: Boolean(sensitive), expected_state: currentState, canonical_version: currentVersion, evidence_hash: evidenceHash, status: 'OPEN', created_at: new Date().toISOString() };
      append(this.filePath, request); return request;
    });
  }
  async provide({ requestId, value, currentState, currentVersion }) {
    if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw new Error('An explicit bounded human value is required.');
    return withPipelineLock(this.filePath, async () => {
      const rows = readJsonl(this.filePath); const request = rows.find(row => row.kind === 'FACT_REQUEST' && row.request_id === requestId);
      if (!request) throw new Error('Unknown user fact request.');
      if (currentState !== request.expected_state || currentVersion !== request.canonical_version) throw new Error('User fact request is stale against canonical state/version.');
      const commitment = digest(`${request.value_commitment_salt}\0${value}`);
      const existing = rows.find(row => row.kind === 'FACT_PROVIDED' && row.request_id === requestId);
      if (existing) {
        if (existing.value !== value || existing.value_commitment !== commitment) throw new Error('Conflicting human fact value rejected.');
        const receipt = this.reviewTaskStore.getDecisionReceipt(request.review_task_id);
        if (receipt?.decision_value_hash !== commitment) throw new Error('Fact value does not match its durable decision receipt.');
        return { ...existing, duplicate: true };
      }
      const priorFact = rows.filter(row => row.kind === 'FACT_PROVIDED' && row.application_id === request.application_id && row.field === request.field).at(-1);
      if (priorFact && priorFact.value !== value) throw new Error('A different value already exists for this application fact; explicit correction is required.');
      const review = this.reviewTaskStore.get(request.review_task_id);
      if (!review) throw new Error('User fact review task is missing.');
      await this.reviewTaskStore.decide(request.review_task_id, { application_id: request.application_id, decision: 'SUPPLY_FACT', evidence_hash: review.evidence_hash, current_state: currentState, canonical_version: currentVersion, decision_value_hash: commitment, decision_source: 'LOCAL_HUMAN' });
      await this.onBoundary('fact-decision-persisted', { requestId, reviewTaskId: request.review_task_id });
      const supplied = { kind: 'FACT_PROVIDED', request_id: requestId, value_commitment: commitment, review_task_id: request.review_task_id, application_id: request.application_id, field: request.field, value, provenance: 'HUMAN_EXPLICIT', sensitive: request.sensitive, provided_at: new Date().toISOString() };
      append(this.filePath, supplied);
      return supplied;
    });
  }
}

/** Records only a human assertion. No browser, ATS, HTTP, fill, or submit capability is imported. */
export async function confirmManualSubmission({ applicationId, confirmationId, assertedBy, assertedAt, storePath, dataRoot = getCareerOpsRoot(), emitEvent, applicationExists = id => Boolean(readExistingState(id, { dataRoot })) } = {}) {
  if (!APP_ID.test(applicationId || '') || typeof confirmationId !== 'string' || !/^[A-Za-z0-9:._-]{1,160}$/.test(confirmationId) || !['local-human', 'telegram-human'].includes(assertedBy) || typeof emitEvent !== 'function') throw new Error('Explicit application, safe confirmation ID, human assertion and event emitter required.');
  const assertedTime = assertedAt ? new Date(assertedAt) : new Date();
  if (!Number.isFinite(assertedTime.getTime())) throw new Error('Invalid human assertion timestamp.');
  const path = resolve(storePath || join(dataRoot, 'data', 'manual-submission-confirmations.jsonl'));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withPipelineLock(path, async () => {
    if (!applicationExists(applicationId)) throw new Error('Manual submission confirmation requires an existing application.');
    const rows = readJsonl(path); const priorRows = rows.filter(row => row.confirmation_id === confirmationId); const old = priorRows.at(-1);
    if (old && (old.application_id !== applicationId || old.asserted_by !== assertedBy)) throw new Error('Conflicting manual submission assertion rejected.');
    if (old?.kind === 'CONFIRMED' && old.event_id) return { ...old, duplicate: true };
    const assertion = old || { kind: 'CONFIRM_REQUESTED', application_id: applicationId, confirmation_id: confirmationId, asserted_by: assertedBy, asserted_at: assertedTime.toISOString(), created_at: new Date().toISOString(), event_id: null };
    if (!old) append(path, assertion);
    const event = await emitEvent({ applicationId, type: 'APPLICATION_SUBMITTED_CONFIRMED', idempotencyKey: `manual-confirm:${confirmationId}`, payload: { assertion: 'HUMAN_EXPLICIT', asserted_by: assertion.asserted_by, asserted_at: assertion.asserted_at } });
    const confirmed = { ...assertion, kind: 'CONFIRMED', event_id: event?.event_id || null };
    append(path, confirmed);
    return { ...confirmed, duplicate: false };
  });
}
