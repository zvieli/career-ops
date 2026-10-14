// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeReasoningCacheKey,
  getReasoningCache,
  setReasoningCache,
  deleteReasoningCache,
  clearReasoningCache,
  getReasoningCacheDir,
  SCHEMA_VERSION,
  validateReasoningCacheEntry
} from '../lib/reasoning-cache.mjs';

function withTempDataRoot(fn) {
  const tempDir = mkdtempSync(join(tmpdir(), 'career-ops-cache-test-'));
  try {
    fn(tempDir);
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

test('computeReasoningCacheKey generates deterministic SHA256 from parameters', () => {
  const jdText = 'Senior AI Engineer with 5+ years experience.';
  const profileHash = 'abcdef123456';
  const promptVersion = 'v1.0.0';
  const modelId = 'antigravity/gemini-3.8-flash';

  const key1 = computeReasoningCacheKey(jdText, profileHash, promptVersion, modelId);
  const key2 = computeReasoningCacheKey({
    jd_text: jdText,
    candidate_profile_hash: profileHash,
    prompt_version: promptVersion,
    model_id: modelId
  });

  assert.equal(typeof key1, 'string');
  assert.equal(key1.length, 64); // SHA256 hex length
  assert.equal(key1, key2);

  // Different model gives different hash
  const keyDifferentModel = computeReasoningCacheKey(
    jdText,
    profileHash,
    promptVersion,
    'openai-codex/gpt-6.1-sol'
  );
  assert.notEqual(key1, keyDifferentModel);
});

test('setReasoningCache and getReasoningCache roundtrip persists expected fields', () => {
  withTempDataRoot((tempDir) => {
    const key = 'test-cache-key-123456';
    const payload = {
      provider: 'antigravity',
      model: 'gemini-3.8-flash',
      created_at: new Date().toISOString(),
      schema_version: SCHEMA_VERSION,
      extracted_fields: {
        required_yoe: 5,
        preferred_yoe: 7,
        degree: 'Bachelor',
        gpa: null,
        role_family: 'ai_ml',
        confidence: 0.95
      },
      evidence_quotes: [
        '5+ years experience required in machine learning',
        'BS in Computer Science required'
      ]
    };

    // Cache miss before set
    const miss = getReasoningCache(key, { dataRoot: tempDir });
    assert.equal(miss, null);

    // Set cache
    const stored = setReasoningCache(key, payload, { dataRoot: tempDir });
    assert.equal(stored.key, key);
    assert.equal(stored.provider, 'antigravity');

    // Cache hit after set
    const hit = getReasoningCache(key, { dataRoot: tempDir });
    assert.ok(hit !== null);
    assert.equal(hit.key, key);
    assert.equal(hit.provider, 'antigravity');
    assert.equal(hit.model, 'gemini-3.8-flash');
    assert.equal(hit.schema_version, SCHEMA_VERSION);
    assert.deepEqual(hit.extracted_fields, payload.extracted_fields);
    assert.deepEqual(hit.evidence_quotes, payload.evidence_quotes);
  });
});

test('getReasoningCache respects maxAgeMs TTL expiration', () => {
  withTempDataRoot((tempDir) => {
    const key = 'test-ttl-key';
    const oldTimestamp = new Date(Date.now() - 100_000).toISOString();

    setReasoningCache(
      key,
      {
        provider: 'antigravity',
        model: 'gemini-3.8-flash',
        created_at: oldTimestamp,
        extracted_fields: { required_yoe: 3 },
        evidence_quotes: ['3 years experience']
      },
      { dataRoot: tempDir }
    );

    // If maxAgeMs is 50,000ms, entry is expired
    const expired = getReasoningCache(key, { dataRoot: tempDir, maxAgeMs: 50_000 });
    assert.equal(expired, null);

    // If maxAgeMs is 200,000ms, entry is valid
    const valid = getReasoningCache(key, { dataRoot: tempDir, maxAgeMs: 200_000 });
    assert.ok(valid !== null);
    assert.equal(valid.extracted_fields.required_yoe, 3);
  });
});

const provenanceExpected = {
  prompt_version: 'prompt-v2',
  schema_version: SCHEMA_VERSION,
  candidate_profile_hash: 'profile-hash',
  job_description_hash: 'jd-hash'
};

function validProvenanceEntry(overrides = {}) {
  return {
    provider: 'ollama',
    model_id: 'ollama/qwen2.5-coder:3b',
    model_version: null,
    prompt_version: provenanceExpected.prompt_version,
    schema_version: provenanceExpected.schema_version,
    candidate_profile_hash: provenanceExpected.candidate_profile_hash,
    job_description_hash: provenanceExpected.job_description_hash,
    created_at: new Date().toISOString(),
    validation_status: 'PASS',
    evidence_quotes: ['3 years of Python experience'],
    ...overrides
  };
}

test('LEGACY_CACHE_REJECTED', () => {
  assert.equal(validateReasoningCacheEntry({ provider: 'ollama', model: 'qwen' }, provenanceExpected, () => true), false);
});

test('UNKNOWN_MODEL_CACHE_REJECTED', () => {
  assert.equal(validateReasoningCacheEntry(validProvenanceEntry({ model_id: 'paid-api/model' }), provenanceExpected, () => true), false);
});

test('MISMATCHED_PROMPT_CACHE_REJECTED', () => {
  assert.equal(validateReasoningCacheEntry(validProvenanceEntry({ prompt_version: 'old-prompt' }), provenanceExpected, () => true), false);
});

test('EVIDENCE_REVALIDATED', () => {
  const entry = validProvenanceEntry();
  assert.equal(validateReasoningCacheEntry(entry, provenanceExpected, (quotes) => quotes[0] === '3 years of Python experience'), true);
  assert.equal(validateReasoningCacheEntry(entry, provenanceExpected, () => false), false);
});

test('VALID_CACHE_ACCEPTED', () => {
  assert.equal(validateReasoningCacheEntry(validProvenanceEntry(), provenanceExpected, () => true), true);
});

test('deleteReasoningCache and clearReasoningCache delete entries', () => {
  withTempDataRoot((tempDir) => {
    const key1 = 'key-one';
    const key2 = 'key-two';

    setReasoningCache(key1, { model: 'm1' }, { dataRoot: tempDir });
    setReasoningCache(key2, { model: 'm2' }, { dataRoot: tempDir });

    assert.ok(getReasoningCache(key1, { dataRoot: tempDir }) !== null);
    assert.ok(getReasoningCache(key2, { dataRoot: tempDir }) !== null);

    // Delete single entry
    const deleted = deleteReasoningCache(key1, { dataRoot: tempDir });
    assert.equal(deleted, true);
    assert.equal(getReasoningCache(key1, { dataRoot: tempDir }), null);
    assert.ok(getReasoningCache(key2, { dataRoot: tempDir }) !== null);

    // Clear all
    const clearedCount = clearReasoningCache({ dataRoot: tempDir });
    assert.equal(clearedCount, 1);
    assert.equal(getReasoningCache(key2, { dataRoot: tempDir }), null);
  });
});
