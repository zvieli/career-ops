// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateEvidenceSpan, computeSourceHash } from '../../../src/agent/domain/semantic/provenance-validator.mjs';

const DATASET_PATH = resolve(process.cwd(), 'evals/fixtures/golden-25.json');

test('golden-25.json exists and contains exactly 25 structured samples', () => {
  assert.equal(existsSync(DATASET_PATH), true, `Dataset must exist at ${DATASET_PATH}`);
  const data = JSON.parse(readFileSync(DATASET_PATH, 'utf8'));
  assert.equal(Array.isArray(data), true);
  assert.equal(data.length, 25);
});

test('every sample in golden-25.json has truthful metadata and valid SHA-256 hash', () => {
  const data = JSON.parse(readFileSync(DATASET_PATH, 'utf8'));

  for (const sample of data) {
    assert.match(sample.sample_id, /^GOLDEN-IL-2026-\d{4}$/);
    assert.ok(sample.metadata?.raw_title, `Missing raw_title in ${sample.sample_id}`);
    assert.ok(sample.metadata?.company, `Missing company in ${sample.sample_id}`);
    assert.ok(['en', 'he', 'mixed'].includes(sample.metadata?.language), `Invalid language in ${sample.sample_id}`);
    assert.ok(sample.raw_jd_text?.length > 50, `JD text too short in ${sample.sample_id}`);

    // Verify SHA-256 hash
    const actualHash = computeSourceHash(sample.raw_jd_text);
    assert.equal(sample.metadata?.jd_hash, actualHash, `Hash mismatch in ${sample.sample_id}`);

    // Verify honest annotation status
    assert.equal(sample.annotations?.status, 'MODEL_PROPOSED', `Sample ${sample.sample_id} must not claim unverified human review`);
    assert.equal(sample.metadata?.synthetic, true, `Sample ${sample.sample_id} must be flagged as synthetic fixture`);
  }
});

test('every single evidence span in golden-25.json matches raw_jd_text verbatim', () => {
  const data = JSON.parse(readFileSync(DATASET_PATH, 'utf8'));
  let totalSpansVerified = 0;

  for (const sample of data) {
    const skills = sample.annotations?.gold_profile?.required_skills || [];
    for (const skill of skills) {
      assert.ok(skill.verbatim_span, `Missing verbatim_span in ${sample.sample_id} for ${skill.name}`);
      const val = validateEvidenceSpan(sample.raw_jd_text, skill.verbatim_span);
      assert.equal(val.valid, true, `Span invalid in ${sample.sample_id} for "${skill.name}": ${val.error}`);
      totalSpansVerified++;
    }
  }

  assert.ok(totalSpansVerified >= 25, `Expected at least 25 verified spans, found ${totalSpansVerified}`);
});

test('golden-25.json represents required ecosystem scenarios', () => {
  const data = JSON.parse(readFileSync(DATASET_PATH, 'utf8'));
  const tags = new Set(data.flatMap((s) => s.metadata?.tags || []));
  const languages = new Set(data.map((s) => s.metadata?.language));

  assert.ok(languages.has('he'), 'Must cover Hebrew job descriptions');
  assert.ok(languages.has('en'), 'Must cover English job descriptions');
  assert.ok(languages.has('mixed'), 'Must cover mixed Hebrew/English job descriptions');

  assert.ok(tags.has('false_reject_trap'), 'Must cover false rejection title traps');
  assert.ok(tags.has('military_tech'), 'Must cover Israeli military technology backgrounds (Mamram/8200)');
  assert.ok(tags.has('security_clearance'), 'Must cover security clearance requirements');
  assert.ok(tags.has('degree_equivalence'), 'Must cover degree equivalence');
  assert.ok(tags.has('prompt_injection'), 'Must cover prompt injection attacks');
});
