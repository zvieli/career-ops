import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZeroCostProviderRunner, runCommandBounded } from '../lib/llm/provider-runner.mjs';

 test('rejects a model absent from the verified zero-cost inventory', async () => {
  const runner = createZeroCostProviderRunner({ execute: async () => ({ content: 'unexpected' }) });
  await assert.rejects(runner({ modelId: 'openai/gpt-4o', systemPrompt: '', userMessage: '' }), /not verified zero-cost/);
});

test('returns exact inventory and incremental-cost provenance for a successful call', async () => {
  const results = [];
  const runner = createZeroCostProviderRunner({
    execute: async () => '{"ok":true}',
    onModelResult: (result) => results.push(result)
  });
  const result = await runner({
    modelId: 'ollama/qwen2.5-coder:3b',
    systemPrompt: 'system',
    userMessage: 'user'
  });
  assert.equal(result.provider, 'ollama');
  assert.equal(result.model, 'ollama/qwen2.5-coder:3b');
  assert.equal(result.content, '{"ok":true}');
  assert.equal(result.exact_inventory_match, true);
  assert.equal(result.incremental_cost, 0);
  assert.equal(typeof result.latency_ms, 'number');
  assert.ok(result.latency_ms >= 0);
  assert.equal(results[0].modelId, result.model);
  assert.equal(results[0].status, 'SUCCESS');
});

test('classifies rate limits and exhausted quota distinctly while applying bounded retries', async () => {
  for (const [message, expected] of [['HTTP 429 rate limit', 'RATE_LIMITED'], ['quota exhausted', 'QUOTA_EXHAUSTED'], ['401 unauthorized', 'AUTH_FAILURE'], ['request timeout', 'TIMEOUT']]) {
    let calls = 0;
    const runner = createZeroCostProviderRunner({ retries: 1, execute: async () => { calls++; throw new Error(message); } });
    await assert.rejects(runner({ modelId: 'ollama/qwen2.5-coder:3b', systemPrompt: '', userMessage: '' }), (error) => error.code === expected);
    assert.equal(calls, 2, `${expected} should be retried within the configured bound`);
  }
});

test('generic nonzero provider CLI exit stays non-retryable when stderr has no quota evidence', async () => {
  await assert.rejects(
    runCommandBounded(process.execPath, ['-e', "process.stderr.write('provider invocation failed'); process.exitCode = 1"], 1000),
    (error) => error.code === 'PROVIDER_EXECUTION_FAILED'
      && error.message === 'Provider CLI exited unsuccessfully'
      && error.stderr === undefined
  );
});

test('provider subprocess is terminated at its hard timeout', async () => {
  await assert.rejects(
    runCommandBounded(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], 50),
    (error) => error.code === 'TIMEOUT'
  );
});

test('non-retryable provider failures do not trigger fallback retries', async () => {
  let calls = 0;
  const failures = [];
  const runner = createZeroCostProviderRunner({
    retries: 1,
    onModelFailure: (failure) => failures.push(failure),
    execute: async () => { calls++; throw new Error('offline'); }
  });
  await assert.rejects(runner({ modelId: 'ollama/qwen2.5-coder:3b', systemPrompt: '', userMessage: '' }), /PROVIDER_EXECUTION_FAILED/);
  assert.equal(calls, 1);
  assert.equal(failures[0].error_code, 'PROVIDER_EXECUTION_FAILED');
});

test('bounded retry records every physical model attempt for explicit runtime failures', async () => {
  let calls = 0;
  const attempts = [];
  const runner = createZeroCostProviderRunner({
    retries: 1,
    onModelAttempt: (attempt) => attempts.push(attempt),
    execute: async () => { calls++; const error = new Error('request timeout'); error.code = 'TIMEOUT'; throw error; }
  });
  await assert.rejects(runner({
    modelId: 'ollama/qwen2.5-coder:3b',
    systemPrompt: '',
    userMessage: ''
  }), /TIMEOUT/);
  assert.equal(calls, 2);
  assert.deepEqual(attempts, [
    { modelId: 'ollama/qwen2.5-coder:3b', provider: 'ollama', tier: undefined, attempt: 1 },
    { modelId: 'ollama/qwen2.5-coder:3b', provider: 'ollama', tier: undefined, attempt: 2 }
  ]);
});
