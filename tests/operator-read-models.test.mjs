import test from 'node:test';
import assert from 'node:assert/strict';
import { OperatorReadModels } from '../src/agent/read-models/operator-read-models.mjs';

const id = 'app-111111111111111111111111';
function fixture() {
  const events = [
    { event_id: 'evt-a', sequence: 1, application_id: id, type: 'APPLICATION_FILLED', occurred_at: '2026-01-01T00:00:00Z', payload: { company: 'Acme', role: 'Engineer', resume_text: 'must not leak' } }
  ];
  const ledger = { eventStore: { list: () => events }, timeline: () => events };
  const reviewTaskStore = { inbox: () => [{ review_task_id: 'rev-1', application_id: id, company: 'Acme', role: 'Engineer', review_type: 'FINAL_HUMAN_REVIEW', status: 'OPEN', priority: 70, created_at: '2026-01-01', current_state: 'FORM_FILLED', reason: 'Review', blocking_count: 0 }], get: () => ({ review_task_id: 'rev-1', application_id: id, company: 'Acme', role: 'Engineer', review_type: 'FINAL_HUMAN_REVIEW', status: 'OPEN', priority: 70, created_at: '2026-01-01', expected_state: 'FORM_FILLED', reason: 'Review', blocking_fields: [], allowed_decisions: ['STOP'], evidence_hash: 'a'.repeat(64), evidence: { resume_text: 'private' } }) };
  return new OperatorReadModels({ dataRoot: `/tmp/operator-read-model-test-${process.pid}`, ledger, reviewTaskStore, notificationStore: { list: () => [] }, stateReader: () => ({ state: 'FORM_FILLED' }) });
}

test('operator read models minimize output and never confuse fill with submission', () => {
  const models = fixture();
  assert.equal(models.applicationShow(id).workflow_status, 'FILLED / AWAITING HUMAN ACTION');
  assert.equal(JSON.stringify(models.reviewShow('rev-1')).includes('private'), false);
  assert.equal(JSON.stringify(models.applicationTimeline(id)).includes('must not leak'), false);
  assert.deepEqual(models.applicationsList(), fixture().applicationsList());
});

test('application notification status selects the newest outbox record', () => {
  const models = fixture();
  models.notificationStore = { list: () => [
    { notification_id: 'new', application_id: id, status: 'PENDING', created_at: '2026-02-01T00:00:00Z' },
    { notification_id: 'old', application_id: id, status: 'DELIVERED', created_at: '2026-01-01T00:00:00Z' }
  ] };
  assert.equal(models.applicationShow(id).notification_status, 'PENDING');
});

test('only explicit submission-confirmed event renders APPLIED_CONFIRMED', () => {
  const models = fixture();
  models.ledger.eventStore.list().push({ event_id: 'evt-b', sequence: 2, application_id: id, type: 'APPLICATION_SUBMITTED_CONFIRMED', occurred_at: '2026-01-02T00:00:00Z', payload: {} });
  assert.equal(models.applicationShow(id).workflow_status, 'APPLIED_CONFIRMED');
});
