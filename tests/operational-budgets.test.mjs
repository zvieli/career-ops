import test from 'node:test';
import assert from 'node:assert/strict';
import { admitQueueItem, classifyFailure, createOperationalLimits, isRetryableFailure, mapWithConcurrency, ProviderCircuit, QueueAdmission, retryDelayMs, RunBudget } from '../src/agent/runtime/operational-budgets.mjs';

test('operational limits are immutable, defaulted, and reject invalid values', () => {
  const limits = createOperationalLimits({ maxJobs: 2 });
  assert.equal(limits.maxJobs, 2);
  assert.equal(limits.maxConcurrency, 3);
  assert.ok(Object.isFrozen(limits));
  for (const value of [0, -1, Infinity, NaN, '2', 2_147_483_648]) assert.throws(() => createOperationalLimits({ maxJobs: value }));
});

test('failures classify deterministically and retry-after/backoff stay bounded', () => {
  assert.equal(classifyFailure({ status: 429 }), 'rate_limit');
  assert.equal(classifyFailure({ status: 503 }), 'server_error');
  assert.equal(classifyFailure({ code: 'ETIMEDOUT' }), 'timeout');
  assert.equal(classifyFailure({ status: 400 }), 'non_retryable');
  assert.equal(isRetryableFailure({ status: 429 }), true);
  assert.equal(isRetryableFailure({ status: 400 }), false);
  assert.equal(retryDelayMs(0, { random: () => 0.5 }), 500);
  assert.equal(retryDelayMs(9, { random: () => 1, maxMs: 4_000 }), 4_000);
  assert.equal(retryDelayMs(1, { retryAfterMs: 900_000 }), 300_000);
  assert.equal(retryDelayMs(1, { retryAfterMs: 2_000 }), 2_000);
});

test('provider circuit suppresses after three consecutive failures for run lifetime', () => {
  const circuit = new ProviderCircuit();
  circuit.recordFailure(); circuit.recordSuccess();
  circuit.recordFailure(); circuit.recordFailure();
  assert.equal(circuit.suppressed, false);
  assert.equal(circuit.recordFailure(), true);
  circuit.recordSuccess();
  assert.equal(circuit.suppressed, true);
});

test('run budget enforces jobs, provider attempts/failures, and runtime', () => {
  let now = 10;
  const limits = createOperationalLimits({ maxJobs: 1, maxProviderAttempts: 2, maxProviderFailures: 1, maxRunMs: 100 });
  const budget = new RunBudget({ limits, now: () => now, startedAt: 10 });
  assert.deepEqual(budget.admitJob(), { admitted: true });
  assert.deepEqual(budget.admitJob(), { code: 'RUN_BUDGET_EXHAUSTED' });
  assert.deepEqual(budget.recordProviderAttempt({ failed: true }), { code: 'RUN_BUDGET_EXHAUSTED' });
  assert.equal(budget.providerAttempts, 1, 'the last admitted job may record its provider attempt');
  now = 110;
  assert.deepEqual(budget.check(), { code: 'RUN_BUDGET_EXHAUSTED' });
});

test('queue admission reports duplicate, capacity, invalid, and accepted states', () => {
  const opts = { capacity: 2, size: 1, keys: new Set(['known']) };
  assert.equal(admitQueueItem({ id: 'new' }, opts), QueueAdmission.ACCEPTED);
  assert.equal(admitQueueItem({ id: 'known' }, opts), QueueAdmission.DEDUPED);
  assert.equal(admitQueueItem({ id: 'new' }, { ...opts, size: 2 }), QueueAdmission.DEFERRED_CAPACITY);
  assert.equal(admitQueueItem({}, opts), QueueAdmission.REJECTED_INVALID);
});

test('bounded concurrency preserves result order and never exceeds limit', async () => {
  let active = 0;
  let peak = 0;
  const result = await mapWithConcurrency([3, 2, 1, 0], 2, async (value) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return value * 2;
  });
  assert.deepEqual(result, [6, 4, 2, 0]);
  assert.equal(peak, 2);
});
