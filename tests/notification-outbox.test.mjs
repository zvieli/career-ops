import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { NotificationOutbox, createLocalNotificationAdapter } from '../src/agent/infrastructure/communications/notification-outbox.mjs';
import { filesystemPrivacyCapabilities } from '../src/agent/infrastructure/persistence/filesystem-privacy.mjs';

test('notification outbox persists intent, deduplicates semantic requests, and delivers once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notification-outbox-'));
  try {
    const store = new NotificationOutbox({ dataRoot: dir }); let deliveries = 0;
    const adapter = createLocalNotificationAdapter({ dataRoot: dir, deliver: () => { deliveries++; return { status: 'DELIVERED' }; } });
    const one = await store.request({ semantic_key: 'review:abc', review_task_id: 'rev-1', type: 'REVIEW_TASK_CREATED', payload: { company: 'Acme', role: 'Engineer', reason: 'Review required' } });
    const duplicate = await store.request({ semantic_key: 'review:abc', payload: { company: 'Different' } });
    assert.equal(one.notification_id, duplicate.notification_id);
    assert.equal((await store.deliver(one.notification_id, adapter)).status, 'DELIVERED');
    await store.deliver(one.notification_id, adapter);
    assert.equal(deliveries, 1);
    assert.equal(readFileSync(join(dir, 'data/notifications/outbox-v2.jsonl'), 'utf8').includes('Acme'), true);
    if (filesystemPrivacyCapabilities().POSIX_MODE_ENFORCEMENT) assert.equal(statSync(join(dir, 'data', 'notifications')).mode & 0o777, 0o700);
    await assert.rejects(store.request({ semantic_key: 'unsafe', payload: { resume_text: 'candidate data' } }), /not allowed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy human-review notification intents remain visible and deliverable after upgrade', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notification-outbox-'));
  try {
    const path = join(dir, 'human-review-outbox.jsonl');
    const semantic = 'review-created:rev-legacy';
    const notificationId = `ntf-${createHash('sha256').update(semantic).digest('hex').slice(0, 32)}`;
    appendFileSync(path, `${JSON.stringify({ schema_version: 1, notification_id: notificationId, idempotency_key: semantic, review_task_id: 'rev-legacy', application_id: 'app-0123456789abcdef01234567', type: 'REVIEW_TASK_CREATED', channel: 'local', status: 'PENDING', payload: { company: 'Acme', role: 'Engineer', reason: 'Review', next_action: 'Review' }, attempts: 0, created_at: new Date().toISOString() })}\n`);
    const store = new NotificationOutbox({ outboxPath: path });
    assert.equal(store.list()[0].notification_id, notificationId);
    assert.equal((await store.request({ semantic_key: semantic, review_task_id: 'rev-legacy', payload: { company: 'Acme' } })).notification_id, notificationId);
    const adapter = createLocalNotificationAdapter({ deliveryPath: join(dir, 'deliveries.jsonl') });
    assert.equal((await store.deliver(notificationId, adapter)).status, 'DELIVERED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('retryable failures require explicit retry; permanent failures do not retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notification-outbox-'));
  try {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const store = new NotificationOutbox({ dataRoot: dir, clock: () => new Date(now) });
    const retryable = await store.request({ semantic_key: 'retry', payload: { reason: 'retry test' } });
    assert.equal((await store.deliver(retryable.notification_id, { send: async () => ({ status: 'FAILED_RETRYABLE' }) })).status, 'FAILED_RETRYABLE');
    assert.equal((await store.deliver(retryable.notification_id)).status, 'FAILED_RETRYABLE');
    await assert.rejects(store.retry(retryable.notification_id), /not due/);
    now = new Date(now.getTime() + 30_000);
    await store.retry(retryable.notification_id);
    assert.equal((await store.deliver(retryable.notification_id)).status, 'DELIVERED');
    const permanent = await store.request({ semantic_key: 'permanent', payload: { reason: 'permanent test' } });
    assert.equal((await store.deliver(permanent.notification_id, { send: async () => ({ status: 'FAILED_PERMANENT' }) })).status, 'FAILED_PERMANENT');
    await assert.rejects(store.retry(permanent.notification_id), /eligible/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent delivery attempts serialize to one send', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notification-outbox-'));
  try {
    const store = new NotificationOutbox({ dataRoot: dir });
    const item = await store.request({ semantic_key: 'concurrent', payload: { reason: 'test' } });
    let sends = 0;
    const adapter = { send: async () => { sends++; await new Promise(resolve => setTimeout(resolve, 10)); return { status: 'DELIVERED' }; } };
    await Promise.all([store.deliver(item.notification_id, adapter), store.deliver(item.notification_id, adapter)]);
    assert.equal(sends, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reconcile quarantines interrupted attempts with unknown outcome and does not redeliver', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notification-outbox-'));
  try {
    const store = new NotificationOutbox({ dataRoot: dir });
    const item = await store.request({ semantic_key: 'crash', payload: { reason: 'safe' } });
    const path = join(dir, 'data/notifications/outbox-v2.jsonl');
    appendFileSync(path, `${JSON.stringify({ kind: 'ATTEMPT_STARTED', notification_id: item.notification_id, attempt: 1, at: new Date().toISOString() })}\n`);
    assert.deepEqual(await store.reconcile(), [item.notification_id]);
    assert.equal(store.list()[0].status, 'FAILED_PERMANENT');
    let sends = 0;
    await store.deliver(item.notification_id, { send: async () => { sends++; return { status: 'DELIVERED' }; } });
    assert.equal(sends, 0);
    assert.equal(readFileSync(path, 'utf8').includes('DELIVERY_OUTCOME_UNKNOWN'), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
