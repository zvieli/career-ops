// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isZeroCostModel,
  resolveZeroCostChain,
  loadVerifiedModelInventory,
  ZERO_COST_REGISTRY
} from '../lib/zero-cost-router.mjs';

test('loadVerifiedModelInventory loads models with incremental_cost zero and automation_access true', () => {
  const inv = loadVerifiedModelInventory();
  assert.ok(inv.size >= 8);
  assert.ok(inv.has('antigravity/gemini-3.8-flash'));
  assert.ok(inv.has('openai-codex/gpt-6.1-sol'));
  assert.ok(inv.has('ollama/qwen2.5-coder:3b'));
});

test('isZeroCostModel admits only verified exact models from inventory', () => {
  assert.equal(isZeroCostModel('antigravity/gemini-3.8-flash'), true);
  assert.equal(isZeroCostModel('openai-codex/gpt-6-luna'), true);
  assert.equal(isZeroCostModel('openai-codex/gpt-6.1-sol'), true);
  assert.equal(isZeroCostModel('antigravity/gemini-3.1-pro'), true);
  assert.equal(isZeroCostModel('ollama/qwen2.5-coder:3b'), true);
  assert.equal(isZeroCostModel('opencode/nemotron-3.5-lightning-free'), true);
  assert.equal(isZeroCostModel('kilo/nvidia/nemotron-3.5-lightning:free'), true);
});

test('isZeroCostModel strictly rejects unknown models and paid APIs (fails closed)', () => {
  // Unknown model under known provider
  assert.equal(isZeroCostModel('antigravity/unknown-model'), false);
  assert.equal(isZeroCostModel('openai-codex/gpt-6-sol'), false); // Removed unverified fallback
  assert.equal(isZeroCostModel('openai-codex/fake-model'), false);

  // Fake -free or :free suffix attacks
  assert.equal(isZeroCostModel('openai/gpt-4o-free'), false);
  assert.equal(isZeroCostModel('anthropic/claude-3-5-sonnet:free'), false);
  assert.equal(isZeroCostModel('openrouter/fake:free'), false);

  // Real paid endpoints
  assert.equal(isZeroCostModel('openai/gpt-4o'), false);
  assert.equal(isZeroCostModel('anthropic/claude-3-5-sonnet'), false);
  assert.equal(isZeroCostModel(''), false);
  assert.equal(isZeroCostModel(null), false);
  assert.equal(isZeroCostModel(undefined), false);
});

test('resolveZeroCostChain returns only verified inventory models with no duplicates', () => {
  for (const tier of ['system1', 'system2']) {
    const chain = resolveZeroCostChain(tier);
    assert.ok(chain.length >= 2);
    // Every model must be verified
    assert.ok(chain.every(isZeroCostModel));
    // No duplicates in chain
    assert.equal(new Set(chain).size, chain.length);
  }
});

test('active provider unavailability filters a chain without changing its order or admitting unverified models', () => {
  const chain = resolveZeroCostChain('system1', { unavailableProviders: ['antigravity'] });
  assert.equal(chain[0], 'openai-codex/gpt-6-luna');
  assert.deepEqual(chain, resolveZeroCostChain('system1').filter((modelId) => !modelId.startsWith('antigravity/')));
  assert.ok(chain.every(isZeroCostModel));
  assert.deepEqual(resolveZeroCostChain('system1', { unavailableProviders: [] }), resolveZeroCostChain('system1'));
});

test('all configured router chains reference models present in verified inventory', () => {
  const inv = loadVerifiedModelInventory();
  for (const tier of ['system1', 'system2']) {
    const config = ZERO_COST_REGISTRY[tier];
    assert.ok(inv.has(config.primary), `Primary ${config.primary} must be in inventory`);
    for (const fb of config.fallbacks) {
      assert.ok(inv.has(fb), `Fallback ${fb} must be in inventory`);
    }
  }
});
