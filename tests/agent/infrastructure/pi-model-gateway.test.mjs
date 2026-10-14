// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPiModelGateway, createZeroCostProviderRunner } from '../../../src/agent/infrastructure/model-gateway/provider-runner.mjs';
import { resolveZeroCostChain } from '../../../src/agent/infrastructure/model-gateway/zero-cost-router.mjs';

test('PiModelGateway sends the exact allowlisted model through PI without provider-specific execution', async () => {
  const calls = [];
  const gateway = createPiModelGateway({
    retries: 0,
    runCommand: async (command, args, timeoutMs, options) => {
      calls.push({ command, args, timeoutMs, options });
      return { stdout: '{"result":"ok"}', stderr: '' };
    }
  });
  const modelId = resolveZeroCostChain('system1')[0];
  const result = await gateway({ modelId, tier: 'system1', systemPrompt: 'system', userMessage: 'user' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'pi');
  assert.deepEqual(calls[0].args, [
    '--model', modelId, '--mode', 'text', '--no-session', '--no-tools', '--no-mcp',
    '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes',
    '--system-prompt', 'system', '-p', 'user'
  ]);
  assert.equal(calls[0].options.env.PI_OFFLINE, '');
  assert.equal(result.model, modelId);
  assert.equal(result.incremental_cost, 0);
  assert.equal(result.model_version, null);
});

test('PiModelGateway rejects models outside the exact zero-cost inventory before invoking PI', async () => {
  let called = false;
  const gateway = createPiModelGateway({ runCommand: async () => { called = true; return { stdout: 'x' }; } });
  await assert.rejects(gateway({ modelId: 'unlisted/provider-model', systemPrompt: 'x', userMessage: 'y' }), /not verified zero-cost/);
  assert.equal(called, false);
});

test('legacy runner name is an alias for the PI gateway', () => {
  assert.equal(createZeroCostProviderRunner, createPiModelGateway);
});
