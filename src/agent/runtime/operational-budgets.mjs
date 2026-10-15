export const DEFAULT_OPERATIONAL_LIMITS = Object.freeze({
  maxJobs: 100,
  maxConcurrency: 3,
  maxProviderAttempts: 20,
  maxRetries: 3,
  maxProviderFailures: 5,
  requestTimeoutMs: 30_000,
  maxRunMs: 30 * 60_000,
});

const LIMIT_KEYS = Object.keys(DEFAULT_OPERATIONAL_LIMITS);
const MAX_RETRY_AFTER_MS = 5 * 60_000;
export function createOperationalLimits(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new TypeError('limits must be an object');
  for (const key of Object.keys(overrides)) if (!LIMIT_KEYS.includes(key)) throw new TypeError(`unknown operational limit: ${key}`);
  const limits = { ...DEFAULT_OPERATIONAL_LIMITS, ...overrides };
  for (const key of LIMIT_KEYS) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new RangeError(`${key} must be a positive bounded integer`);
  }
  return Object.freeze(limits);
}

export function classifyFailure(error) {
  const status = Number(error?.status ?? error?.statusCode);
  if (status === 429) return 'rate_limit';
  if (status >= 500 && status <= 599) return 'server_error';
  if (error?.name === 'AbortError' || error?.code === 'ETIMEDOUT' || error?.code === 'TIMEOUT') return 'timeout';
  if (error?.code === 'ECONNRESET' || error?.code === 'ECONNREFUSED' || error?.code === 'ENOTFOUND' || error?.code === 'NETWORK_ERROR') return 'network';
  return 'non_retryable';
}

export function isRetryableFailure(error) {
  return ['rate_limit', 'timeout', 'network', 'server_error'].includes(classifyFailure(error));
}

export function retryDelayMs(retryIndex, { baseMs = 1_000, maxMs = 30_000, retryAfterMs = null, random = Math.random } = {}) {
  if (!Number.isSafeInteger(retryIndex) || retryIndex < 0) throw new RangeError('retryIndex must be a non-negative integer');
  if (!Number.isFinite(baseMs) || baseMs <= 0 || !Number.isFinite(maxMs) || maxMs <= 0) throw new RangeError('backoff bounds must be positive and finite');
  if (retryAfterMs !== null) {
    if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) throw new RangeError('retryAfterMs must be non-negative and finite');
    return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
  }
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) throw new RangeError('random must return a value from 0 to 1');
  return Math.floor(sample * Math.min(maxMs, baseMs * (2 ** Math.min(retryIndex, 52))));
}

export class ProviderCircuit {
  #failures = 0;
  #suppressed = false;
  constructor(threshold = 3) {
    if (!Number.isSafeInteger(threshold) || threshold <= 0) throw new RangeError('threshold must be a positive integer');
    this.threshold = threshold;
  }
  get suppressed() { return this.#suppressed; }
  get consecutiveFailures() { return this.#failures; }
  recordSuccess() { if (!this.#suppressed) this.#failures = 0; }
  recordFailure() { if (!this.#suppressed && ++this.#failures >= this.threshold) this.#suppressed = true; return this.#suppressed; }
}

export class RunBudget {
  constructor({ limits = createOperationalLimits(), now = Date.now, startedAt = now() } = {}) {
    this.limits = createOperationalLimits(limits);
    if (typeof now !== 'function' || !Number.isFinite(startedAt)) throw new TypeError('valid clock and startedAt required');
    this.now = now;
    this.startedAt = startedAt;
    this.jobs = 0;
    this.providerAttempts = 0;
    this.providerFailures = 0;
  }
  check({ providerWork = false } = {}) {
    if ((!providerWork && this.jobs >= this.limits.maxJobs) || this.providerAttempts >= this.limits.maxProviderAttempts || this.providerFailures >= this.limits.maxProviderFailures || this.now() - this.startedAt >= this.limits.maxRunMs) return { code: 'RUN_BUDGET_EXHAUSTED' };
    return null;
  }
  admitJob() { const exhausted = this.check(); if (exhausted) return exhausted; this.jobs++; return { admitted: true }; }
  recordProviderAttempt({ failed = false } = {}) {
    const exhausted = this.check({ providerWork: true }); if (exhausted) return exhausted;
    this.providerAttempts++;
    if (failed) this.providerFailures++;
    return this.check() || { recorded: true };
  }
}

export const QueueAdmission = Object.freeze({ ACCEPTED: 'ACCEPTED', DEDUPED: 'DEDUPED', DEFERRED_CAPACITY: 'DEFERRED_CAPACITY', REJECTED_INVALID: 'REJECTED_INVALID' });

export function admitQueueItem(item, { capacity, size, keys = new Set() } = {}) {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id.trim() || !Number.isSafeInteger(capacity) || capacity < 0 || !Number.isSafeInteger(size) || size < 0) return QueueAdmission.REJECTED_INVALID;
  if (keys.has(item.id)) return QueueAdmission.DEDUPED;
  return size >= capacity ? QueueAdmission.DEFERRED_CAPACITY : QueueAdmission.ACCEPTED;
}

export async function mapWithConcurrency(items, concurrency, mapper) {
  if (!Array.isArray(items) || !Number.isSafeInteger(concurrency) || concurrency <= 0 || typeof mapper !== 'function') throw new TypeError('items, positive concurrency, and mapper are required');
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
