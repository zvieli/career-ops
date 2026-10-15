import { chmodSync, closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { withPipelineLock } from '../../../../pipeline-lock.mjs';
import { getCareerOpsRoot } from '../../../../path-resolver.mjs';

export const NOTIFICATION_STATUSES = Object.freeze(['PENDING', 'DELIVERED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT', 'CANCELLED']);
const MAX_ATTEMPTS = 5;
const SAFE_PAYLOAD_KEYS = new Set(['company', 'role', 'review_type', 'reason', 'next_action', 'summary', 'event_type']);
const hash = value => createHash('sha256').update(value).digest('hex');
function withPrivateStoreLock(path, fn) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Private store parent must be a real directory.');
  chmodSync(directory, 0o700);
  return withPipelineLock(path, fn);
}
function read(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`Notification outbox corrupt at line ${i + 1}; refusing writes.`); }
  });
}
function append(path, row) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'a', 0o600);
  try { fchmodSync(fd, 0o600); writeSync(fd, `${JSON.stringify(row)}\n`, null, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
}
function sanitizePayload(payload) {
  const safe = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!SAFE_PAYLOAD_KEYS.has(key)) throw new Error(`Notification payload field is not allowed: ${key}`);
    if (typeof value !== 'string') continue;
    safe[key] = value.replace(/[\r\n\t\u0000-\u001f\u007f\u2028\u2029]/g, ' ').slice(0, key === 'reason' || key === 'summary' ? 180 : 120);
  }
  return safe;
}
function project(records) {
  const map = new Map();
  for (const row of records) {
    if (row.kind === 'REQUEST' || (!row.kind && row.notification_id && row.schema_version === 1)) {
      map.set(row.notification_id, { ...row, status: row.status || 'PENDING', attempts: row.attempts || 0, next_attempt_at: row.next_attempt_at || row.created_at, attempt_started_at: row.attempt_started_at || null });
    }
    else {
      const prior = map.get(row.notification_id);
      if (!prior) continue;
      if (row.kind === 'ATTEMPT_STARTED') map.set(row.notification_id, { ...prior, status: 'PENDING', attempts: row.attempt, attempt_started_at: row.at, next_attempt_at: row.at });
      else if (row.kind === 'STATUS') map.set(row.notification_id, { ...prior, status: row.status, attempts: row.attempts ?? prior.attempts, attempt_started_at: null, next_attempt_at: row.next_attempt_at || null, delivered_at: row.status === 'DELIVERED' ? row.at : prior.delivered_at || null, last_error: row.last_error || null, updated_at: row.at });
    }
  }
  return map;
}

/** Deterministic local adapter; successful delivery IDs are durably deduplicated. */
export function createLocalNotificationAdapter({ dataRoot = getCareerOpsRoot(), deliveryPath, deliver = () => ({ status: 'DELIVERED' }) } = {}) {
  const path = resolve(deliveryPath || join(dataRoot, 'data', 'notifications', 'local-deliveries.jsonl'));
  return { id: 'local', async send(notification) {
    return withPrivateStoreLock(path, async () => {
      const rows = read(path);
      if (rows.some(row => row.notification_id === notification.notification_id && row.status === 'DELIVERED')) return { status: 'DELIVERED', duplicate: true };
      let result;
      try { result = await deliver(structuredClone(notification)); } catch { result = { status: 'FAILED_PERMANENT', error: 'LOCAL_DELIVERY_UNKNOWN' }; }
      if (result?.status === 'DELIVERED') append(path, { notification_id: notification.notification_id, status: 'DELIVERED', delivered_at: new Date().toISOString() });
      return result;
    });
  } };
}

/** Append-only outbox. Delivery and retry are explicit; no scheduler is started. */
export class NotificationOutbox {
  constructor({ dataRoot = getCareerOpsRoot(), outboxPath, clock = () => new Date(), maxAttempts = MAX_ATTEMPTS } = {}) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) throw new Error(`maxAttempts must be 1-${MAX_ATTEMPTS}.`);
    this.path = resolve(outboxPath || join(resolve(dataRoot), 'data', 'notifications', 'outbox-v2.jsonl'));
    this.clock = clock;
    this.maxAttempts = maxAttempts;
  }
  list() { return [...project(read(this.path)).values()].map(row => structuredClone(row)); }
  async request({ semantic_key, application_id = null, review_task_id = null, type = 'APPLICATION_UPDATE', channel = 'local', payload }) {
    if (typeof semantic_key !== 'string' || !semantic_key.trim() || semantic_key.length > 300) throw new Error('A bounded semantic_key is required.');
    if (channel !== 'local') throw new Error('Only the local notification channel is supported.');
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(type)) throw new Error('Invalid notification type.');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Notification payload must be an object.');
    const notification_id = `ntf-${hash(semantic_key).slice(0, 32)}`;
    return withPrivateStoreLock(this.path, () => {
      const existing = project(read(this.path)).get(notification_id);
      if (existing) return structuredClone(existing);
      const now = this.clock().toISOString();
      const row = { kind: 'REQUEST', schema_version: 1, notification_id, idempotency_key: semantic_key,
        review_task_id: typeof review_task_id === 'string' ? review_task_id : null,
        application_id: typeof application_id === 'string' ? application_id : null,
        type, channel, payload: sanitizePayload(payload), status: 'PENDING', attempts: 0,
        next_attempt_at: now, created_at: now };
      append(this.path, row);
      return { ...row, kind: undefined, status: 'PENDING', attempt_started_at: null };
    });
  }
  async deliver(notificationId, adapter = createLocalNotificationAdapter({ dataRoot: dirname(dirname(dirname(this.path))) })) {
    if (!adapter || typeof adapter.send !== 'function') throw new Error('Delivery adapter must implement send(notification).');
    const started = await withPrivateStoreLock(this.path, () => {
      const current = project(read(this.path)).get(notificationId);
      if (!current) throw new Error('Notification not found.');
      if (current.status !== 'PENDING' || current.attempt_started_at || current.attempts >= this.maxAttempts) return { terminal: current };
      if (Date.parse(current.next_attempt_at || '') > this.clock().getTime()) return { terminal: current };
      const attempt = current.attempts + 1;
      append(this.path, { kind: 'ATTEMPT_STARTED', notification_id: notificationId, attempt, at: this.clock().toISOString() });
      return { current, attempt };
    });
    if (started.terminal) return structuredClone(started.terminal);
    let result;
    try { result = await adapter.send({ ...started.current, kind: undefined }); }
    catch { result = { status: 'FAILED_PERMANENT', error: 'DELIVERY_OUTCOME_UNKNOWN' }; }
    const status = ['DELIVERED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT'].includes(result?.status) ? result.status : 'FAILED_PERMANENT';
    const boundedStatus = status === 'FAILED_RETRYABLE' && started.attempt >= this.maxAttempts ? 'FAILED_PERMANENT' : status;
    const retryDelay = Math.min(60 * 60 * 1000, 30_000 * (2 ** (started.attempt - 1)));
    return withPrivateStoreLock(this.path, () => {
      const now = this.clock();
      append(this.path, { kind: 'STATUS', notification_id: notificationId, status: boundedStatus, attempts: started.attempt,
        last_error: boundedStatus === 'FAILED_RETRYABLE' || boundedStatus === 'FAILED_PERMANENT' ? safeError(result?.error) : null,
        next_attempt_at: boundedStatus === 'FAILED_RETRYABLE' ? new Date(now.getTime() + retryDelay).toISOString() : null,
        at: now.toISOString() });
      return structuredClone(project(read(this.path)).get(notificationId));
    });
  }
  async retry(notificationId) {
    return withPrivateStoreLock(this.path, () => {
      const current = project(read(this.path)).get(notificationId);
      if (!current) throw new Error('Notification not found.');
      if (current.status !== 'FAILED_RETRYABLE' || current.attempts >= this.maxAttempts) throw new Error('Notification is not eligible for retry.');
      const now = this.clock();
      if (current.next_attempt_at && Date.parse(current.next_attempt_at) > now.getTime()) throw new Error('Notification retry is not due yet.');
      append(this.path, { kind: 'STATUS', notification_id: notificationId, status: 'PENDING', attempts: current.attempts, next_attempt_at: now.toISOString(), at: now.toISOString() });
      return structuredClone(project(read(this.path)).get(notificationId));
    });
  }
  async reconcile() {
    return withPrivateStoreLock(this.path, () => {
      const rows = project(read(this.path)); const reconciled = [];
      for (const row of rows.values()) if (row.status === 'PENDING' && row.attempt_started_at) {
        // Unknown delivery outcome is not retried automatically; avoid duplicate external side effects.
        append(this.path, { kind: 'STATUS', notification_id: row.notification_id, status: 'FAILED_PERMANENT', attempts: row.attempts, last_error: 'DELIVERY_OUTCOME_UNKNOWN', at: this.clock().toISOString() });
        reconciled.push(row.notification_id);
      }
      return reconciled;
    });
  }
  async cancel(notificationId) {
    return withPrivateStoreLock(this.path, () => {
      const row = project(read(this.path)).get(notificationId);
      if (!row) throw new Error('Notification not found.');
      if (row.attempt_started_at) throw new Error('Cannot cancel while a delivery attempt is in progress or unresolved.');
      if (row.status !== 'PENDING' && row.status !== 'FAILED_RETRYABLE') return structuredClone(row);
      append(this.path, { kind: 'STATUS', notification_id: notificationId, status: 'CANCELLED', attempts: row.attempts, at: this.clock().toISOString() });
      return structuredClone(project(read(this.path)).get(notificationId));
    });
  }
}
function safeError(value) { return typeof value === 'string' && /^[A-Z0-9_:-]{1,80}$/i.test(value) ? value : value ? 'ADAPTER_ERROR' : null; }
