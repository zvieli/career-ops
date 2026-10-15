import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { getCareerOpsRoot } from '../../../../path-resolver.mjs';
import { withPipelineLock } from '../../../../pipeline-lock.mjs';
import { assertApplicationId } from './application-ledger.mjs';

export const REVIEW_STATUSES = Object.freeze(['OPEN', 'CLAIMED', 'DECIDED', 'CANCELLED', 'STALE', 'SUPERSEDED']);
export const REVIEW_DECISIONS = Object.freeze({
  PRE_SUBMIT_REVIEW: ['PREPARE_APPLICATION', 'CONTINUE_MANUALLY', 'STOP'],
  ATS_PREPARATION_REVIEW: ['FILL_APPLICATION', 'CONTINUE_MANUALLY', 'STOP'],
  FINAL_HUMAN_REVIEW: ['CONTINUE_MANUALLY', 'EDIT_REQUIRED', 'REFILL_REQUIRED', 'STOP'],
  FIT_NEEDS_REVIEW: ['ACCEPT_FOR_SHORTLIST', 'REJECT', 'STOP'],
  APPLICATION_FILL_NEEDS_REVIEW: ['CONTINUE_MANUALLY', 'EDIT_REQUIRED', 'REFILL_REQUIRED', 'STOP'],
  USER_FACT_REQUIRED: ['SUPPLY_FACT', 'STOP'],
  MANUAL_STEP_REQUIRED: ['CONTINUE_MANUALLY', 'STOP']
});
const PRIORITY = Object.freeze({ INTERVIEW_INVITE_RECEIVED: 100, RECRUITER_MESSAGE_RECEIVED: 90, MANUAL_STEP_REQUIRED: 80, FINAL_HUMAN_REVIEW: 70, ATS_PREPARATION_REVIEW: 60, APPLICATION_FILL_NEEDS_REVIEW: 60, PRE_SUBMIT_REVIEW: 50, USER_FACT_REQUIRED: 45, FIT_NEEDS_REVIEW: 40 });
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
function readLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`Human review log is corrupt at line ${i + 1}; refusing writes.`); }
  });
}
function append(path, row) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'a', 0o600);
  try { writeSync(fd, `${JSON.stringify(row)}\n`, null, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
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
    this.clock = clock;
  }
  #tasks() { return projection(readLog(this.logPath)); }
  async #ensureNotification(task) {
    const notification_id = `ntf-${digest(`review-created:${task.review_task_id}`).slice(0, 32)}`;
    await withPipelineLock(this.notificationPath, () => {
      if (readLog(this.notificationPath).some(row => row.notification_id === notification_id)) return;
      append(this.notificationPath, { schema_version: 1, notification_id, idempotency_key: `review-created:${task.review_task_id}`, review_task_id: task.review_task_id, application_id: task.application_id, type: 'REVIEW_TASK_CREATED', channel: 'local', status: 'PENDING', payload: { company: task.company, role: task.role, review_type: task.review_type, reason: task.reason, next_action: 'Review this task in the local review inbox.' }, attempts: 0, created_at: task.created_at });
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
    const checkpoint = `${input.application_id}\0${input.review_type}\0${input.source_event}`;
    const now = this.clock().toISOString();
    return withPipelineLock(this.logPath, async () => {
      const tasks = this.#tasks();
      const matching = [...tasks.values()].filter(task => task.application_id === input.application_id && task.review_type === input.review_type && task.source_event === input.source_event && task.evidence_hash === evidence_hash).sort((a, b) => (b.generation || 1) - (a.generation || 1));
      const reusable = matching.find(task => ['OPEN', 'CLAIMED', 'DECIDED'].includes(task.status));
      if (reusable) { await this.#ensureNotification(reusable); return reusable; }
      const generation = Math.max(0, ...matching.map(task => task.generation || 1)) + 1;
      const review_task_id = `rev-${digest(`${checkpoint}\0${evidence_hash}\0${generation}`).slice(0, 32)}`;
      for (const task of tasks.values()) {
        if (task.application_id === input.application_id && task.review_type === input.review_type && task.source_event === input.source_event && ['OPEN', 'CLAIMED'].includes(task.status)) {
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
  get(id) { return this.#tasks().get(id) || null; }
  async markStale(id) {
    return withPipelineLock(this.logPath, () => {
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
  async decide(id, { application_id, decision, evidence_hash, current_state, decision_source = 'LOCAL_HUMAN', optional_safe_comment } = {}) {
    const now = this.clock().toISOString();
    return withPipelineLock(this.logPath, () => {
      const tasks = this.#tasks();
      const task = tasks.get(id);
      if (!task) throw new Error('Human review task not found.');
      if (task.application_id !== application_id) throw new Error('Review application binding mismatch.');
      if (!task.allowed_decisions.includes(decision)) throw new Error('Decision is not allowed for this review type.');
      if (task.status === 'DECIDED') {
        if (task.decision === decision) return { task, receipt: readLog(this.logPath).find(row => row.kind === 'DECISION' && row.receipt.receipt_id === task.decision_receipt_ref)?.receipt, duplicate: true };
        throw new Error('Review task already decided; conflicting decision rejected.');
      }
      if (!['OPEN', 'CLAIMED'].includes(task.status)) throw new Error(`Review task is ${task.status}; decision rejected.`);
      if (evidence_hash !== task.evidence_hash || current_state !== task.expected_state) throw new Error('Stale review evidence or canonical state mismatch.');
      const receipt = Object.freeze({ receipt_id: `rcpt-${digest(`${id}\0${decision}\0${task.evidence_hash}`).slice(0, 32)}`, review_task_id: id, application_id, review_type: task.review_type, decision, evidence_hash: task.evidence_hash, canonical_state_before: task.expected_state, canonical_version_before: task.evidence.canonical_version ?? null, decided_at: now, decision_source: clean(decision_source, 40), optional_safe_comment: clean(optional_safe_comment, 240) });
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
