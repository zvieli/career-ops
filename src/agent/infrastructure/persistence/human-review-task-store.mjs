import { chmodSync, closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { getCareerOpsRoot } from '../../../../path-resolver.mjs';
import { withPipelineLock } from '../../../../pipeline-lock.mjs';
import { assertApplicationId } from './application-ledger.mjs';
import { NotificationOutbox } from '../communications/notification-outbox.mjs';

export const REVIEW_STATUSES = Object.freeze(['OPEN', 'CLAIMED', 'DECIDED', 'CANCELLED', 'STALE', 'SUPERSEDED']);
export const GRAPH_REVIEW_TYPES = Object.freeze(['CANDIDATE_FIT_REVIEW', 'PRE_SUBMIT_REVIEW', 'ATS_PREPARATION_REVIEW', 'FINAL_HUMAN_REVIEW']);
export const REVIEW_DECISIONS = Object.freeze({
  PRE_SUBMIT_REVIEW: ['PREPARE_APPLICATION', 'CONTINUE_MANUALLY', 'STOP'],
  ATS_PREPARATION_REVIEW: ['FILL_APPLICATION', 'CONTINUE_MANUALLY', 'STOP'],
  FINAL_HUMAN_REVIEW: ['CONTINUE_MANUALLY', 'EDIT_REQUIRED', 'REFILL_REQUIRED', 'STOP'],
  FIT_NEEDS_REVIEW: ['EVIDENCE_UPDATED', 'STOP'],
  CANDIDATE_FIT_REVIEW: ['EVIDENCE_UPDATED', 'STOP'],
  INTERVIEW_INVITE_RECEIVED: ['ACKNOWLEDGE', 'STOP'],
  APPLICATION_FILL_NEEDS_REVIEW: ['CONTINUE_MANUALLY', 'EDIT_REQUIRED', 'REFILL_REQUIRED', 'STOP'],
  USER_FACT_REQUIRED: ['SUPPLY_FACT', 'STOP'],
  MANUAL_STEP_REQUIRED: ['CONTINUE_MANUALLY', 'STOP']
});
const PRIORITY = Object.freeze({ INTERVIEW_INVITE_RECEIVED: 100, RECRUITER_MESSAGE_RECEIVED: 90, MANUAL_STEP_REQUIRED: 80, FINAL_HUMAN_REVIEW: 70, ATS_PREPARATION_REVIEW: 60, APPLICATION_FILL_NEEDS_REVIEW: 60, PRE_SUBMIT_REVIEW: 50, USER_FACT_REQUIRED: 45, FIT_NEEDS_REVIEW: 40, CANDIDATE_FIT_REVIEW: 40 });
const CHECKPOINT_TYPES = new Set(Object.keys(REVIEW_DECISIONS));
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  if (typeof value === 'string' && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error('Evidence contains control characters.');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Evidence must be JSON-safe.');
  if (value === undefined || typeof value === 'function' || typeof value === 'bigint') throw new Error('Evidence must be JSON-safe.');
  return value;
}
function digest(value) { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(stable(value))).digest('hex'); }
export function hashHumanReviewEvidence(evidence) { return digest(stable(evidence)); }
function deterministicReviewTaskId(applicationId, reviewType, sourceEvent, evidenceHash, generation) {
  const checkpoint = `${applicationId}\0${reviewType}\0${sourceEvent}`;
  return `rev-${digest(`${checkpoint}\0${evidenceHash}\0${generation}`).slice(0, 32)}`;
}
export function createReviewRecoveryDescriptor(task) {
  if (!task || !GRAPH_REVIEW_TYPES.includes(task.review_type)) throw new Error('A graph human review task is required for recovery binding.');
  return {
    schema_version: 1, review_task_id: task.review_task_id, generation: task.generation,
    application_id: task.application_id, review_type: task.review_type, graph_thread_id: task.graph_thread_id,
    source_event: task.source_event, expected_state: task.expected_state,
    canonical_version: task.evidence?.canonical_version ?? null, evidence: structuredClone(task.evidence),
    evidence_hash: task.evidence_hash, allowed_decisions: [...task.allowed_decisions]
  };
}
export function validateReviewRecoveryDescriptor(descriptor, { allowNextGeneration = false } = {}) {
  const fields = ['schema_version', 'review_task_id', 'generation', 'application_id', 'review_type', 'graph_thread_id', 'source_event', 'expected_state', 'canonical_version', 'evidence', 'evidence_hash', 'allowed_decisions'];
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor) || Object.keys(descriptor).sort().join('|') !== [...fields].sort().join('|')
    || descriptor.schema_version !== 1 || !GRAPH_REVIEW_TYPES.includes(descriptor.review_type)) throw new Error('Invalid graph review recovery descriptor.');
  assertApplicationId(descriptor.application_id);
  const threadId = `careerops-evaluation-v1:${descriptor.application_id}`;
  if (descriptor.graph_thread_id !== threadId || descriptor.source_event !== `${threadId}:${descriptor.review_type}`) throw new Error('Review recovery thread/source binding mismatch.');
  if ((!Number.isSafeInteger(descriptor.generation) || descriptor.generation < 1) && !(allowNextGeneration && descriptor.generation === null)
    || typeof descriptor.expected_state !== 'string' || !descriptor.expected_state || !/^rev-[a-f0-9]{32}$/.test(descriptor.review_task_id || '')
    || !Number.isSafeInteger(descriptor.canonical_version) || descriptor.canonical_version < 1 || descriptor.evidence?.canonical_state !== descriptor.expected_state
    || descriptor.evidence?.canonical_version !== descriptor.canonical_version) throw new Error('Review recovery canonical state/version is incomplete.');
  const evidence = stable(descriptor.evidence);
  assertSafeEvidence(evidence);
  const evidenceHash = digest(evidence);
  if (evidenceHash !== descriptor.evidence_hash || !/^[a-f0-9]{64}$/i.test(descriptor.evidence_hash || '')) throw new Error('Review recovery evidence hash mismatch.');
  const decisions = REVIEW_DECISIONS[descriptor.review_type];
  if (!Array.isArray(descriptor.allowed_decisions) || descriptor.allowed_decisions.length !== decisions.length || new Set(descriptor.allowed_decisions).size !== decisions.length
    || [...descriptor.allowed_decisions].sort().join('\\0') !== [...decisions].sort().join('\\0')) throw new Error('Review recovery decision allowlist mismatch.');
  if (descriptor.generation !== null) {
    const expectedId = deterministicReviewTaskId(descriptor.application_id, descriptor.review_type, descriptor.source_event, evidenceHash, descriptor.generation);
    if (descriptor.review_task_id !== expectedId) throw new Error('Review recovery deterministic task ID mismatch.');
  }
  return { ...descriptor, evidence, allowed_decisions: [...decisions] };
}
function sameRecoveryTask(task, descriptor) {
  return task.review_task_id === descriptor.review_task_id && task.generation === descriptor.generation
    && task.application_id === descriptor.application_id && task.review_type === descriptor.review_type
    && task.graph_thread_id === descriptor.graph_thread_id && task.source_event === descriptor.source_event
    && task.expected_state === descriptor.expected_state && task.evidence_hash === descriptor.evidence_hash
    && JSON.stringify(stable(task.evidence)) === JSON.stringify(descriptor.evidence)
    && [...task.allowed_decisions].sort().join('\\0') === [...descriptor.allowed_decisions].sort().join('\\0');
}
function withPrivateStoreLock(path, fn) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Private store parent must be a real directory.');
  chmodSync(directory, 0o700);
  return withPipelineLock(path, fn);
}
function readLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`Human review log is corrupt at line ${i + 1}; refusing writes.`); }
  });
}
function append(path, row) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'a', 0o600);
  try { fchmodSync(fd, 0o600); writeSync(fd, `${JSON.stringify(row)}\n`, null, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
}
function projection(records) {
  const tasks = new Map();
  for (const row of records) {
    if (row.kind === 'TASK') tasks.set(row.task.review_task_id, structuredClone(row.task));
    else if (row.kind === 'STATUS') { const task = tasks.get(row.review_task_id); if (task) { task.status = row.status; task.updated_at = row.at; } }
    else if (row.kind === 'DECISION') { const task = tasks.get(row.receipt.review_task_id); if (task) { task.status = 'DECIDED'; task.decision = row.receipt.decision; task.decision_receipt_ref = row.receipt.receipt_id; task.updated_at = row.receipt.decided_at; } }
  }
  return tasks;
}

/** Durable append-only human review task and decision-receipt store. */
export class HumanReviewTaskStore {
  constructor({ dataRoot = getCareerOpsRoot(), logPath, notificationPath, clock = () => new Date() } = {}) {
    this.dataRoot = resolve(dataRoot);
    this.logPath = resolve(logPath || join(this.dataRoot, 'data', 'human-review', 'events.jsonl'));
    this.notificationPath = resolve(notificationPath || join(this.dataRoot, 'data', 'notifications', 'human-review-outbox.jsonl'));
    this.notificationOutbox = new NotificationOutbox({ dataRoot: this.dataRoot, outboxPath: this.notificationPath, clock });
    this.clock = clock;
  }
  #tasks() { return projection(readLog(this.logPath)); }
  async #ensureNotification(task) {
    await this.notificationOutbox.request({
      semantic_key: `review-created:${task.review_task_id}`,
      application_id: task.application_id,
      review_task_id: task.review_task_id,
      type: 'REVIEW_TASK_CREATED',
      channel: 'local',
      payload: { company: task.company, role: task.role, review_type: task.review_type, reason: task.reason, next_action: 'Review this task in the local review inbox.' }
    });
  }
  async create(input) {
    assertApplicationId(input?.application_id);
    if (!CHECKPOINT_TYPES.has(input.review_type)) throw new Error('Unsupported human review type.');
    const allowedDecisions = input.allowed_decisions || REVIEW_DECISIONS[input.review_type];
    if (!Array.isArray(allowedDecisions) || allowedDecisions.some(decision => !REVIEW_DECISIONS[input.review_type].includes(decision))) throw new Error('Review contains an unsupported decision allowlist.');
    if (!input.source_event || typeof input.source_event !== 'string' || input.source_event.length > 200) throw new Error('Review source_event is required.');
    const evidence = stable(input.evidence);
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new Error('Immutable review evidence is required.');
    assertSafeEvidence(evidence);
    const evidence_hash = digest(evidence);
    const now = this.clock().toISOString();
    return withPrivateStoreLock(this.logPath, async () => {
      const tasks = this.#tasks();
      const matching = [...tasks.values()].filter(task => task.application_id === input.application_id && task.review_type === input.review_type && task.source_event === input.source_event && task.evidence_hash === evidence_hash).sort((a, b) => (b.generation || 1) - (a.generation || 1));
      const reusable = matching.find(task => ['OPEN', 'CLAIMED'].includes(task.status));
      if (reusable) { await this.#ensureNotification(reusable); return reusable; }
      const decided = matching.find(task => task.status === 'DECIDED');
      const newerCheckpoint = decided && [...tasks.values()].some(task => task.application_id === input.application_id && task.review_type === input.review_type && task.source_event === input.source_event && Date.parse(task.created_at) > Date.parse(decided.created_at));
      if (decided && !newerCheckpoint) { await this.#ensureNotification(decided); return decided; }
      const generation = Math.max(0, ...matching.map(task => task.generation || 1)) + 1;
      const review_task_id = deterministicReviewTaskId(input.application_id, input.review_type, input.source_event, evidence_hash, generation);
      for (const task of tasks.values()) {
        if (task.application_id === input.application_id && task.review_type === input.review_type && task.source_event === input.source_event && ['OPEN', 'CLAIMED', 'DECIDED'].includes(task.status)) {
          append(this.logPath, { kind: 'STATUS', review_task_id: task.review_task_id, status: 'SUPERSEDED', at: now });
        }
      }
      const task = {
        review_task_id, generation, application_id: input.application_id, review_type: input.review_type, status: 'OPEN',
        priority: Number.isInteger(input.priority) ? input.priority : (PRIORITY[input.review_type] ?? 10),
        created_at: now, updated_at: now, source_event: input.source_event,
        graph_thread_id: typeof input.graph_thread_id === 'string' ? input.graph_thread_id : null,
        expected_state: String(input.expected_state || ''), evidence, evidence_hash,
        allowed_decisions: [...allowedDecisions], reason: clean(input.reason, 240),
        company: clean(input.company, 120), role: clean(input.role, 120), blocking_fields: safeLabels(input.blocking_fields),
        decision: null, decision_receipt_ref: null
      };
      append(this.logPath, { kind: 'TASK', task });
      await this.#ensureNotification(task);
      return task;
    });
  }
  async restoreFromInterrupt(input, { staleTaskIds = [], allowNextGeneration = false } = {}) {
    let descriptor = validateReviewRecoveryDescriptor(input, { allowNextGeneration });
    if (!Array.isArray(staleTaskIds) || staleTaskIds.some(id => typeof id !== 'string')) throw new Error('Stale task IDs must be an array of strings.');
    const staleSet = new Set(staleTaskIds);
    if (staleSet.size !== staleTaskIds.length || staleSet.has(descriptor.review_task_id)) throw new Error('Conflicting stale-task reconciliation set.');
    return withPrivateStoreLock(this.logPath, async () => {
      const rows = readLog(this.logPath);
      const tasks = projection(rows);
      const existing = tasks.get(descriptor.review_task_id);
      if (existing && descriptor.generation === null) descriptor = { ...descriptor, generation: existing.generation };
      if (existing && (!sameRecoveryTask(existing, descriptor) || deterministicReviewTaskId(descriptor.application_id, descriptor.review_type, descriptor.source_event, descriptor.evidence_hash, descriptor.generation) !== descriptor.review_task_id
        || !['OPEN', 'CLAIMED', 'DECIDED'].includes(existing.status))) throw new Error('Review task history conflicts with the current interrupt.');
      if (!existing && rows.some(row => row.review_task_id === descriptor.review_task_id || row.task?.review_task_id === descriptor.review_task_id || row.receipt?.review_task_id === descriptor.review_task_id)) throw new Error('Review task history exists without a restorable active task.');
      if (!existing) {
        const matching = [...tasks.values()].filter(task => task.application_id === descriptor.application_id && task.review_type === descriptor.review_type
          && task.source_event === descriptor.source_event && task.evidence_hash === descriptor.evidence_hash);
        const maxGeneration = Math.max(0, ...matching.map(task => task.generation || 1));
        const generation = descriptor.generation ?? maxGeneration + 1;
        if (generation !== maxGeneration + 1 || deterministicReviewTaskId(descriptor.application_id, descriptor.review_type, descriptor.source_event, descriptor.evidence_hash, generation) !== descriptor.review_task_id) throw new Error('Review task generation conflicts with durable history.');
        descriptor = { ...descriptor, generation };
      }
      const active = [...tasks.values()].filter(task => task.application_id === descriptor.application_id && task.graph_thread_id && ['OPEN', 'CLAIMED'].includes(task.status)
        && task.review_task_id !== descriptor.review_task_id);
      if (active.some(task => !staleSet.has(task.review_task_id)) || [...staleSet].some(id => {
        const task = tasks.get(id); return !task || task.application_id !== descriptor.application_id || !task.graph_thread_id || !['OPEN', 'CLAIMED'].includes(task.status);
      })) throw new Error('Active review tasks changed during reconciliation.');
      const at = this.clock().toISOString();
      for (const id of [...staleSet].sort()) append(this.logPath, { kind: 'STATUS', review_task_id: id, status: 'STALE', at });
      let task = existing;
      if (!task) {
        task = {
          review_task_id: descriptor.review_task_id, generation: descriptor.generation, application_id: descriptor.application_id,
          review_type: descriptor.review_type, status: 'OPEN', priority: PRIORITY[descriptor.review_type] ?? 10,
          created_at: at, updated_at: at, source_event: descriptor.source_event, graph_thread_id: descriptor.graph_thread_id,
          expected_state: descriptor.expected_state, evidence: descriptor.evidence, evidence_hash: descriptor.evidence_hash,
          allowed_decisions: [...descriptor.allowed_decisions], reason: `Human review required: ${descriptor.review_type}`,
          company: '', role: '', blocking_fields: [], decision: null, decision_receipt_ref: null
        };
        append(this.logPath, { kind: 'TASK', task });
      }
      await this.#ensureNotification(task);
      return { task, duplicate: Boolean(existing), stale_task_ids: [...staleSet] };
    });
  }
  async markStaleMany(ids) {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('Task IDs must be an array of strings.');
    const unique = [...new Set(ids)];
    return withPrivateStoreLock(this.logPath, () => {
      const tasks = this.#tasks(); const at = this.clock().toISOString(); const stale = [];
      for (const id of unique) {
        const task = tasks.get(id);
        if (!task || !['OPEN', 'CLAIMED'].includes(task.status)) continue;
        append(this.logPath, { kind: 'STATUS', review_task_id: id, status: 'STALE', at });
        stale.push(id);
      }
      return stale;
    });
  }
  get(id) { return this.#tasks().get(id) || null; }
  getDecisionReceipt(id) {
    const task = this.get(id);
    if (!task?.decision_receipt_ref) return null;
    return readLog(this.logPath).find(row => row.kind === 'DECISION' && row.receipt?.receipt_id === task.decision_receipt_ref)?.receipt || null;
  }
  async markStale(id) {
    return withPrivateStoreLock(this.logPath, () => {
      const task = this.#tasks().get(id);
      if (!task || !['OPEN', 'CLAIMED'].includes(task.status)) return task || null;
      const at = this.clock().toISOString();
      append(this.logPath, { kind: 'STATUS', review_task_id: id, status: 'STALE', at });
      return { ...task, status: 'STALE', updated_at: at };
    });
  }
  list({ activeOnly = false, applicationId } = {}) {
    return [...this.#tasks().values()].filter(task => (!activeOnly || ['OPEN', 'CLAIMED'].includes(task.status)) && (!applicationId || task.application_id === applicationId)).sort((a,b) => b.priority-a.priority || a.created_at.localeCompare(b.created_at) || a.review_task_id.localeCompare(b.review_task_id));
  }
  inbox() {
    return this.list({ activeOnly: true }).map(task => ({ review_task_id: task.review_task_id, application_id: task.application_id, company: task.company, role: task.role, review_type: task.review_type, status: task.status, priority: task.priority, created_at: task.created_at, age_ms: Math.max(0, this.clock().getTime() - Date.parse(task.created_at)), current_state: task.expected_state, reason: task.reason, blocking_count: task.blocking_fields.length, allowed_decisions: [...task.allowed_decisions], evidence_summary: `sha256:${task.evidence_hash.slice(0, 12)}` }));
  }
  async decide(id, { application_id, decision, evidence_hash, current_state, canonical_version, decision_value_hash, decision_source = 'LOCAL_HUMAN', optional_safe_comment } = {}) {
    const now = this.clock().toISOString();
    return withPrivateStoreLock(this.logPath, () => {
      const tasks = this.#tasks();
      const task = tasks.get(id);
      if (!task) throw new Error('Human review task not found.');
      if (task.application_id !== application_id) throw new Error('Review application binding mismatch.');
      if (!task.allowed_decisions.includes(decision)) throw new Error('Decision is not allowed for this review type.');
      if (decision_value_hash !== undefined && (task.review_type !== 'USER_FACT_REQUIRED' || decision !== 'SUPPLY_FACT' || !/^[a-f0-9]{64}$/i.test(decision_value_hash))) throw new Error('Value commitments are allowed only for a structured fact-supply decision.');
      if (task.review_type === 'USER_FACT_REQUIRED' && decision === 'SUPPLY_FACT' && !/^[a-f0-9]{64}$/i.test(decision_value_hash || '')) throw new Error('Fact-supply decisions must bind the explicit value commitment.');
      if (task.status === 'DECIDED') {
        const receipt = readLog(this.logPath).find(row => row.kind === 'DECISION' && row.receipt.receipt_id === task.decision_receipt_ref)?.receipt;
        if (task.decision === decision && evidence_hash === receipt?.evidence_hash && current_state === receipt?.canonical_state_before && (canonical_version ?? task.evidence.canonical_version ?? null) === receipt?.canonical_version_before && (decision_value_hash ?? null) === (receipt?.decision_value_hash ?? null)) return { task, receipt, duplicate: true };
        throw new Error('Review task already decided or replay bindings conflict.');
      }
      if (!['OPEN', 'CLAIMED'].includes(task.status)) throw new Error(`Review task is ${task.status}; decision rejected.`);
      if (evidence_hash !== task.evidence_hash || current_state !== task.expected_state || (task.evidence.canonical_version !== undefined && canonical_version !== task.evidence.canonical_version)) throw new Error('Stale review evidence or canonical state/version mismatch.');
      const receipt = Object.freeze({ receipt_id: `rcpt-${digest(`${id}\0${decision}\0${task.evidence_hash}`).slice(0, 32)}`, review_task_id: id, application_id, review_type: task.review_type, decision, evidence_hash: task.evidence_hash, canonical_state_before: task.expected_state, canonical_version_before: canonical_version ?? task.evidence.canonical_version ?? null, decision_value_hash: decision_value_hash ?? null, decided_at: now, decision_source: clean(decision_source, 40), optional_safe_comment: clean(optional_safe_comment, 240) });
      append(this.logPath, { kind: 'DECISION', receipt });
      return { task: { ...task, status: 'DECIDED', decision, decision_receipt_ref: receipt.receipt_id, updated_at: now }, receipt, duplicate: false };
    });
  }
}
function assertSafeEvidence(value, path = 'evidence') {
  if (Array.isArray(value)) return value.forEach((item, index) => assertSafeEvidence(item, `${path}[${index}]`));
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:token|secret|password|cookie|authorization|email_body|raw_body|message_body|resume_text|candidate_answer)/i.test(key)) throw new Error(`Sensitive evidence field is not permitted: ${path}.${key}`);
    assertSafeEvidence(child, `${path}.${key}`);
  }
}
function clean(value, max) { return typeof value === 'string' ? value.replace(/[\r\n\t\u0000-\u001f\u007f\u2028\u2029]/g, ' ').slice(0, max) : ''; }
function safeLabels(value) { return Array.isArray(value) ? value.filter(item => typeof item === 'string').map(item => clean(item, 80)).slice(0, 50) : []; }
