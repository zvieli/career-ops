import test from 'node:test';
import assert from 'node:assert/strict';
import { admitQueueItem, classifyFailure, createOperationalLimits, executeProviderBounded, isRetryableFailure, mapWithConcurrency, ProviderCircuit, QueueAdmission, retryDelayMs, RunBudget } from '../src/agent/runtime/operational-budgets.mjs';

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

test('bounded provider execution retries only transient failures and suppresses exhausted providers', async () => {
  const budget = new RunBudget({ limits: createOperationalLimits({ maxRetries: 2, maxProviderFailures: 10 }) });
  const circuits = new Map();
  let attempts = 0;
  const result = await executeProviderBounded('api', async () => {
    attempts++;
    if (attempts < 3) throw { status: 503 };
    return 'ok';
  }, { budget, circuits, sleep: async () => {}, random: () => 0 });
  assert.equal(result.status, 'SUCCESS');
  assert.equal(attempts, 3);
  assert.equal(budget.providerOperations, 3);
  assert.equal(budget.providerFailures, 2);
  assert.equal(budget.providerSuccesses, 1);
  const fail = await executeProviderBounded('bad', async () => { throw { status: 400 }; }, { budget, circuits, sleep: async () => {} });
  assert.deepEqual({ status: fail.status, attempts: fail.attempts }, { status: 'FAILED', attempts: 1 });
  const suppressedBudget = new RunBudget({ limits: createOperationalLimits({ maxProviderFailures: 1 }) });
  const suppressedCircuits = new Map();
  const exhausted = await executeProviderBounded('limited', async () => { throw { status: 429 }; }, { budget: suppressedBudget, circuits: suppressedCircuits, sleep: async () => {} });
  assert.equal(exhausted.code, 'PROVIDER_SUPPRESSED');
  assert.equal((await executeProviderBounded('limited', async () => 'wrong', { budget: suppressedBudget, circuits: suppressedCircuits })).code, 'PROVIDER_SUPPRESSED');
});

test('Retry-After parses seconds and HTTP dates, and timed-out ignored work returns boundedly', async () => {
  const { parseRetryAfter } = await import('../src/agent/runtime/operational-budgets.mjs');
  assert.equal(parseRetryAfter('2', 1_000), 2_000);
  assert.equal(parseRetryAfter('Thu, 01 Jan 1970 00:00:03 GMT', 1_000), 2_000);
  assert.equal(parseRetryAfter('n/a', 1_000), null);
  const budget = new RunBudget({ limits: createOperationalLimits({ requestTimeoutMs: 5, maxRetries: 1 }) });
  const result = await executeProviderBounded('hang', () => new Promise(() => {}), { budget });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.failure, 'timeout');
  assert.equal(result.attempts, 2);
});

test('provider suppression and global failure exhaustion have distinct outcomes', async () => {
  const budget = new RunBudget({ limits: createOperationalLimits({ maxRetries: 1, maxProviderFailures: 3 }) });
  const circuits = new Map();
  const first = await executeProviderBounded('a', async () => { throw { status: 400 }; }, { budget, circuits });
  assert.equal(first.status, 'FAILED');
  await executeProviderBounded('a', async () => { throw { status: 400 }; }, { budget, circuits });
  await executeProviderBounded('a', async () => { throw { status: 400 }; }, { budget, circuits });
  assert.equal((await executeProviderBounded('a', async () => 'no', { budget, circuits })).code, 'PROVIDER_SUPPRESSED');
  assert.equal((await executeProviderBounded('b', async () => 'no', { budget, circuits })).code, 'RUN_BUDGET_EXHAUSTED');
});

test('provider execution respects attempt caps and caller cancellation', async () => {
  const budget = new RunBudget({ limits: createOperationalLimits({ maxProviderAttempts: 1 }) });
  let calls = 0;
  const result = await executeProviderBounded('api', async () => { calls++; throw { status: 503 }; }, { budget, sleep: async () => {} });
  assert.equal(result.status, 'DEFERRED');
  assert.equal(result.code, 'RUN_BUDGET_EXHAUSTED');
  assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  const cancelled = await executeProviderBounded('other', async () => { throw new Error('must not run'); }, { signal: controller.signal });
  assert.equal(cancelled.code, 'CANCELLED');
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
