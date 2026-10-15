import { chmodSync, existsSync, mkdirSync, lstatSync, readFileSync, openSync, fchmodSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { withPipelineLock } from '../../../../pipeline-lock.mjs';
import { getCareerOpsRoot } from '../../../../path-resolver.mjs';

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
    if (typeof value === 'string') safe[key] = value.replace(/[\r\n\t\u0000-\u001f\u007f\u2028\u2029]/g, ' ').slice(0, key === 'reason' || key === 'summary' ? 180 : 120);
  }
  return safe;
}
function project(records) {
  const map = new Map();
  for (const row of records) {
    if (row.kind === 'REQUEST' || (!row.kind && row.notification_id && row.schema_version === 1)) {
      map.set(row.notification_id, { ...row, status: row.status || 'PENDING', attempts: row.attempts || 0, next_attempt_at: row.next_attempt_at || row.created_at, attempt_started_at: row.attempt_started_at || null });
    } else {
      const prior = map.get(row.notification_id);
      if (!prior) continue;
      if (row.kind === 'ATTEMPT_STARTED') map.set(row.notification_id, { ...prior, status: 'PENDING', attempts: row.attempt, attempt_started_at: row.at, next_attempt_at: row.at });
      else if (row.kind === 'STATUS') map.set(row.notification_id, { ...prior, status: row.status, attempts: row.attempts ?? prior.attempts, attempt_started_at: null, next_attempt_at: row.next_attempt_at || null, delivered_at: row.status === 'DELIVERED' ? row.at : prior.delivered_at || null, last_error: row.last_error || null, updated_at: row.at });
    }
  }
  return map;
}

/** Local persistence for notification intents only. It deliberately has no delivery API. */
export class NotificationIntentStore {
  constructor({ dataRoot = getCareerOpsRoot(), outboxPath, clock = () => new Date() } = {}) {
    this.path = resolve(outboxPath || join(resolve(dataRoot), 'data', 'notifications', 'outbox-v2.jsonl'));
    this.clock = clock;
  }
  list() { return [...project(read(this.path)).values()].map(row => structuredClone(row)); }
  async request({ semantic_key, application_id = null, review_task_id = null, type = 'APPLICATION_UPDATE', channel = 'local', payload }, { signal, guard } = {}) {
    if (typeof semantic_key !== 'string' || !semantic_key.trim() || semantic_key.length > 300) throw new Error('A bounded semantic_key is required.');
    if (channel !== 'local') throw new Error('Only the local notification channel is supported.');
    if (guard !== undefined && typeof guard !== 'function') throw new TypeError('Notification guard must be a function.');
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(type)) throw new Error('Invalid notification type.');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Notification payload must be an object.');
    const notification_id = `ntf-${hash(semantic_key).slice(0, 32)}`;
    return withPrivateStoreLock(this.path, () => {
      if (signal?.aborted) throw signal.reason || Object.assign(new Error('Notification intent request cancelled.'), { code: 'SHADOW_CANCELLED' });
      guard?.();
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
}
