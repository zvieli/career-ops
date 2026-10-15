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
    this.providerOperations = 0;
    this.providerFailures = 0;
    this.retries = 0;
    this.rateLimits = 0;
    this.providerSuccesses = 0;
    this.providerSourcesSkippedBudget = 0;
    this.livenessChecksSkippedBudget = 0;
    this.securityFailures = 0;
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

export function parseRetryAfter(value, nowMs = Date.now()) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!text) return null;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(300_000, Math.ceil(seconds * 1000));
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, Math.min(300_000, date - nowMs)) : null;
}

/** Execute a bounded provider read. Cancellation is cooperative; late results are discarded. */
export async function executeProviderBounded(provider, operation, {
  budget = new RunBudget(), circuits = new Map(), signal, sleep = (ms, s) => abortableDelay(ms, s),
  random = Math.random, now = Date.now, countAttempt = true,
} = {}) {
  if (typeof provider !== 'string' || !provider || typeof operation !== 'function' || typeof countAttempt !== 'boolean') throw new TypeError('provider, operation and valid countAttempt are required');
  if (!(circuits instanceof Map)) throw new TypeError('circuits must be a Map');
  let circuit = circuits.get(provider);
  if (!circuit) { circuit = new ProviderCircuit(Math.min(3, budget.limits.maxProviderFailures)); circuits.set(provider, circuit); }
  if (circuit.suppressed) return { status: 'DEFERRED', code: 'PROVIDER_SUPPRESSED' };
  const limits = budget.limits;
  for (let retry = 0; ; retry++) {
    if (signal?.aborted) return { status: 'DEFERRED', code: 'CANCELLED' };
    if (budget.providerFailures >= limits.maxProviderFailures) return { status: 'DEFERRED', code: 'RUN_BUDGET_EXHAUSTED' };
    const exhausted = budget.check({ providerWork: true });
    if (exhausted) return { status: 'DEFERRED', ...exhausted };
    budget.providerOperations++;
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const remaining = limits.maxRunMs - (now() - budget.startedAt);
    const timeoutMs = Math.max(0, Math.min(limits.requestTimeoutMs, remaining));
    let timedOut = false;
    const timeoutError = new Error('Provider request timed out');
    timeoutError.name = 'TimeoutError'; timeoutError.code = 'ETIMEDOUT';
    const timer = setTimeout(() => { timedOut = true; controller.abort(timeoutError); }, timeoutMs);
    if (countAttempt) budget.providerAttempts++;
    let timeoutHandle;
    try {
      const operationPromise = Promise.resolve().then(() => operation({ signal: controller.signal, attempt: retry + 1 }));
      const timeoutPromise = new Promise((_, reject) => { timeoutHandle = setTimeout(() => { timedOut = true; controller.abort(timeoutError); reject(timeoutError); }, timeoutMs); });
      const value = await Promise.race([operationPromise, timeoutPromise]);
      if (signal?.aborted) return { status: 'DEFERRED', code: 'CANCELLED', attempts: retry + 1 };
      circuit.recordSuccess(); budget.providerSuccesses++;
      return { status: 'SUCCESS', value, attempts: retry + 1 };
    } catch (error) {
      if (signal?.aborted) return { status: 'DEFERRED', code: 'CANCELLED', attempts: retry + 1 };
      if (error?.code === 'RUN_BUDGET_EXHAUSTED') return { status: 'DEFERRED', code: 'RUN_BUDGET_EXHAUSTED', attempts: retry + 1 };
      budget.providerFailures++;
      circuit.recordFailure();
      const failure = timedOut ? 'timeout' : classifyFailure(error);
      if (failure === 'rate_limit') budget.rateLimits++;
      if (failure === 'non_retryable' && error?.code === 'SHADOW_METHOD_BLOCKED') budget.securityFailures++;
      if (signal?.aborted) return { status: 'DEFERRED', code: 'CANCELLED', attempts: retry + 1 };
      if (now() - budget.startedAt >= limits.maxRunMs) return { status: 'DEFERRED', code: 'RUN_BUDGET_EXHAUSTED', attempts: retry + 1 };
      if (circuit.suppressed) return { status: 'DEFERRED', code: 'PROVIDER_SUPPRESSED', failure, attempts: retry + 1 };
      if (budget.providerFailures >= limits.maxProviderFailures) return { status: 'DEFERRED', code: 'RUN_BUDGET_EXHAUSTED', failure, attempts: retry + 1 };
      if (!isRetryableFailure(timedOut ? timeoutError : error) || retry >= limits.maxRetries) return { status: 'FAILED', failure, error_code: error?.code || null, attempts: retry + 1 };
      const header = error?.retryAfterMs;
      const retryAfterMs = Number.isFinite(header) ? Math.min(300_000, Math.max(0, header)) : parseRetryAfter(error?.retryAfter, now());
      budget.retries++;
      try { await sleep(retryDelayMs(retry, { retryAfterMs, random }), signal); }
      catch { return { status: 'DEFERRED', code: 'CANCELLED', attempts: retry + 1 }; }
    } finally {
      clearTimeout(timer); clearTimeout(timeoutHandle);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('Aborted'));
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason || new Error('Aborted')); }
    signal?.addEventListener('abort', abort, { once: true });
  });
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
