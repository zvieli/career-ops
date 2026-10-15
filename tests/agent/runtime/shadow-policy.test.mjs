import assert from 'node:assert/strict';
import test from 'node:test';
import { decideOperation, OPERATION_CLASSES, SHADOW_MODE, MANUAL_MODE } from '../../../src/agent/runtime/shadow-policy.mjs';

const base = { mode: SHADOW_MODE, operation: OPERATION_CLASSES.READ_ONLY, action: 'READ_JOB', reason: 'scheduled review', runId: 'run-1', now: '2025-01-02T03:04:05.000Z' };

test('shadow policy allows read-only work and returns a stable review receipt', () => {
  const result = decideOperation(base);
  assert.equal(result.decision, 'ALLOWED_IN_SHADOW');
  assert.equal(result.allowed, true);
  assert.deepEqual(result.receipt, {
    run_id: 'run-1', application_id: null, action: 'READ_JOB', reason: 'scheduled review',
    required_human_review: false, blocked_by_shadow_mode: false, created_at: '2025-01-02T03:04:05.000Z'
  });
});

test('shadow policy permits local durable writes but blocks all external operation classes', () => {
  assert.equal(decideOperation({ ...base, operation: OPERATION_CLASSES.LOCAL_DURABLE_WRITE }).allowed, true);
  for (const operation of [OPERATION_CLASSES.EXTERNAL_REVERSIBLE, OPERATION_CLASSES.EXTERNAL_MUTATION, OPERATION_CLASSES.IRREVERSIBLE]) {
    const result = decideOperation({ ...base, operation, applicationId: 'app-1' });
    assert.equal(result.decision, 'BLOCKED_BY_SHADOW_MODE');
    assert.equal(result.allowed, false);
    assert.equal(result.receipt.blocked_by_shadow_mode, true);
    assert.equal(result.receipt.required_human_review, true);
    assert.equal(result.receipt.application_id, 'app-1');
  }
});

test('scheduled decisions never invoke an external action callback', () => {
  let invoked = false;
  const action = () => { invoked = true; };
  assert.throws(() => decideOperation({ ...base, operation: OPERATION_CLASSES.EXTERNAL_MUTATION, action }), /action must be a non-empty string/);
  assert.equal(invoked, false);
});

test('explicit application and communication actions are blocked even when mislabeled', () => {
  for (const action of ['FILL_APPLICATION', 'SUBMIT_APPLICATION', 'APPLY', 'SEND', 'CONFIRM_MANUAL_SUBMISSION', 'CONTACT_RECRUITER', 'ACCEPT_CALENDAR_INVITE']) {
    const result = decideOperation({ ...base, action });
    assert.equal(result.allowed, false, action);
    assert.equal(result.receipt.blocked_by_shadow_mode, true, action);
  }
});

test('unknown mode and operation fail closed; manual remains a separate path', () => {
  assert.throws(() => decideOperation({ ...base, mode: 'AUTOMATIC' }), /Unknown execution mode/);
  assert.throws(() => decideOperation({ ...base, operation: 'UNKNOWN' }), /Unknown operation class/);
  assert.deepEqual(decideOperation({ ...base, mode: MANUAL_MODE }), { decision: 'MANUAL_PATH', allowed: false });
});
