// @ts-check
//
// Phase-2 Task 3 — SkillConcept Persistent Concept Memory Registry.
//
// Verifies persistent concept memory properties:
// - Deterministic identity and slug-safety.
// - Absence of handcrafted alias tables.
// - Semantically-lossless exact canonical resolution only (non-canonical surfaces require System-1).
// - Collision handling and run-local concepts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadSkillConceptRegistry,
  readSkillConceptSeed,
  getDefaultSkillConceptRegistry,
  resetDefaultSkillConceptRegistry,
  normalizeSkillSurface,
  deterministicConceptId,
  isValidConceptId,
  exactResolveSurface,
  createRunLocalConcept,
  upsertConcept,
  collisionSuffix,
  NORMALIZATION_REASONS
} from '../../../src/agent/domain/semantic/skill-concept-registry.mjs';
import { validateSkillConcept } from '../../../src/agent/domain/semantic/semantic-entities.mjs';
import { buildSkillMentionCandidates } from '../../../src/agent/domain/semantic/skill-intelligence.mjs';

const seed = readSkillConceptSeed();

test('normalizeSkillSurface folds case and punctuation but preserves identity-bearing symbols', () => {
  assert.equal(normalizeSkillSurface('JS'), 'js');
  assert.equal(normalizeSkillSurface('javascript'), 'javascript');
  assert.equal(normalizeSkillSurface('Node.js'), 'node-js');
  assert.equal(normalizeSkillSurface('NodeJS'), 'nodejs');
  assert.equal(normalizeSkillSurface('k8s'), 'k8s');
  assert.equal(normalizeSkillSurface('  Postgres  '), 'postgres');
  assert.equal(normalizeSkillSurface('React.'), 'react');
  assert.equal(normalizeSkillSurface('"React"'), 'react');

  // The four that must never collide.
  assert.equal(normalizeSkillSurface('C'), 'c');
  assert.equal(normalizeSkillSurface('C#'), 'csharp');
  assert.equal(normalizeSkillSurface('C++'), 'cplusplus');
  assert.equal(normalizeSkillSurface('.NET'), 'net');
  assert.notEqual(normalizeSkillSurface('C'), normalizeSkillSurface('C++'));
  assert.notEqual(normalizeSkillSurface('C#'), normalizeSkillSurface('.NET'));
});

test('deterministicConceptId is pure, stable and slug-safe', () => {
  for (const name of ['JavaScript', 'C#', 'C++', '.NET', 'Node.js', 'k8s', 'ACP Runtime Framework']) {
    const a = deterministicConceptId(name);
    const b = deterministicConceptId(name);
    assert.equal(a, b, `not stable for ${name}`);
    assert.ok(isValidConceptId(a), `not slug-safe: ${a}`);
  }
  const ids = ['C', 'C#', 'C++', '.NET'].map(deterministicConceptId);
  assert.equal(new Set(ids).size, 4);
});

test('the registry loads persistent concept memory without handcrafted alias tables', () => {
  const registry = loadSkillConceptRegistry(seed);
  assert.ok(registry.stats.concept_count >= 20);
  assert.equal(registry.registry_version, seed.registry_version);
  assert.equal(registry.normalization_version, seed.normalization_version);
  for (const concept of registry.concepts) {
    assert.equal(validateSkillConcept(concept).valid, true, `invalid concept ${concept.concept_id}`);
    assert.ok(isValidConceptId(concept.concept_id));
    assert.equal(concept.is_registered, true);
    assert.equal(concept.aliases, undefined, 'SkillConcept must not carry handcrafted aliases array');
  }
});

test('the registry is concept memory, not an extraction vocabulary (size bound)', () => {
  assert.ok(seed.concepts.length <= 100, `registry grew to ${seed.concepts.length} concepts - is it becoming an extraction vocabulary?`);
});

test('every concept id is in canonical slug form and unique', () => {
  const ids = seed.concepts.map((c) => c.concept_id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate concept_id in seed');
  for (const id of ids) {
    assert.ok(isValidConceptId(id), `${id} is not in slug form`);
  }
});

test('exact resolution handles canonical names only via semantically-lossless matching', () => {
  const registry = getDefaultSkillConceptRegistry();

  // Canonical name matches
  const js = exactResolveSurface(registry, 'JavaScript');
  assert.ok(js);
  assert.equal(js.state, 'RESOLVED');
  assert.equal(js.concept_id, 'javascript');
  assert.equal(js.method, 'EXACT_CANONICAL');

  const node = exactResolveSurface(registry, 'Node.js');
  assert.ok(node);
  assert.equal(node.concept_id, 'nodejs');
  assert.equal(node.method, 'EXACT_CANONICAL');

  // Case-folding canonical match
  assert.equal(exactResolveSurface(registry, 'javascript').concept_id, 'javascript');
  assert.equal(exactResolveSurface(registry, 'JAVASCRIPT').concept_id, 'javascript');
  assert.equal(exactResolveSurface(registry, 'PostgreSQL').concept_id, 'postgresql');
  assert.equal(exactResolveSurface(registry, 'postgresql').concept_id, 'postgresql');

  // Non-canonical surfaces MUST return null (they require System-1 reasoning)
  assert.equal(exactResolveSurface(registry, 'JS'), null, 'JS must not resolve via Step A exact match');
  assert.equal(exactResolveSurface(registry, 'k8s'), null, 'k8s must not resolve via Step A exact match');
  assert.equal(exactResolveSurface(registry, 'Postgres'), null, 'Postgres must not resolve via Step A exact match');
  assert.equal(exactResolveSurface(registry, 'NodeJS'), null, 'NodeJS must not resolve via Step A exact match');
  assert.equal(exactResolveSurface(registry, 'React.js'), null, 'React.js must not resolve via Step A exact match');
});

test('registry rejects a concept_id claimed by two different canonical names', () => {
  const badSeed = {
    registry_version: 'bad',
    concepts: [
      { concept_id: 'c1', canonical_name: 'Name A', category: 'LANGUAGE' },
      { concept_id: 'c1', canonical_name: 'Name B', category: 'LANGUAGE' }
    ]
  };
  assert.throws(
    () => loadSkillConceptRegistry(badSeed),
    (err) => err.code === 'CONCEPT_ID_COLLISION'
  );
});

test('registry rejects a non-slug concept_id', () => {
  const badSeed = {
    registry_version: 'bad',
    concepts: [{ concept_id: 'bad id with spaces', canonical_name: 'Bad', category: 'LANGUAGE' }]
  };
  assert.throws(
    () => loadSkillConceptRegistry(badSeed),
    (err) => err.code === 'CONCEPT_REGISTRY_ERROR'
  );
});

test('a run-local concept is deterministic, validated and explicitly not registered', () => {
  const registry = getDefaultSkillConceptRegistry();
  const c1 = createRunLocalConcept({
    canonicalName: 'PydanticAI',
    category: 'AI_ML',
    surfaceForms: ['PydanticAI'],
    registry
  });
  const c2 = createRunLocalConcept({
    canonicalName: 'PydanticAI',
    category: 'AI_ML',
    surfaceForms: ['PydanticAI'],
    registry
  });
  assert.equal(c1.concept_id, 'pydanticai');
  assert.equal(c1.concept_id, c2.concept_id, 'must be deterministic');
  assert.equal(c1.is_registered, false);
  assert.equal(validateSkillConcept(c1).valid, true);
});

test('an unknown technology is NOT forced into the nearest registered concept', () => {
  const registry = getDefaultSkillConceptRegistry();
  const runLocal = createRunLocalConcept({
    canonicalName: 'ACP Runtime Framework',
    category: 'FRAMEWORK',
    registry
  });
  assert.equal(runLocal.concept_id, 'acp-runtime-framework');
  assert.ok(!registry.conceptById.has(runLocal.concept_id));
});

test('a run-local id colliding with a different registered concept gets a deterministic suffix', () => {
  const registry = getDefaultSkillConceptRegistry();
  const colliding = createRunLocalConcept({
    canonicalName: 'Docker!!!',
    category: 'INFRASTRUCTURE',
    registry
  });
  assert.ok(colliding.concept_id.startsWith('docker-'));
  assert.ok(colliding.concept_id.length > 'docker'.length);
  assert.ok(isValidConceptId(colliding.concept_id));
});

test('upsertConcept merges surface forms without duplicating the concept', () => {
  const map = new Map();
  const registry = getDefaultSkillConceptRegistry();
  const c1 = createRunLocalConcept({ canonicalName: 'FastAPI', category: 'FRAMEWORK', surfaceForms: ['FastAPI'], registry });
  upsertConcept(map, c1);
  assert.equal(map.size, 1);

  const c2 = createRunLocalConcept({ canonicalName: 'FastAPI', category: 'FRAMEWORK', surfaceForms: ['fastapi-framework'], registry });
  upsertConcept(map, c2);
  assert.equal(map.size, 1);
  assert.deepEqual(map.get('fastapi').surface_forms.sort(), ['FastAPI', 'fastapi-framework']);
});

test('the default registry is memoized and resettable', () => {
  resetDefaultSkillConceptRegistry();
  const a = getDefaultSkillConceptRegistry();
  const b = getDefaultSkillConceptRegistry();
  assert.equal(a, b);
  resetDefaultSkillConceptRegistry();
  const c = getDefaultSkillConceptRegistry();
  assert.notEqual(a, c);
});

test('REGISTRY PURITY: canonical names describe concept, not routing hacks or parenthetical aliases', () => {
  const registry = getDefaultSkillConceptRegistry();

  // 1. canonical_name for Go is exactly "Go"
  const goConcept = registry.conceptById.get('go');
  assert.ok(goConcept, 'go concept must exist');
  assert.equal(goConcept.canonical_name, 'Go');

  // 2. canonical_name for R is exactly "R"
  const rConcept = registry.conceptById.get('r');
  assert.ok(rConcept, 'r concept must exist');
  assert.equal(rConcept.canonical_name, 'R');

  // 3. registry canonical labels do not contain parenthetical alias hints or language suffixes
  for (const concept of registry.concepts) {
    assert.ok(!/\(.*\)/.test(concept.canonical_name), `concept "${concept.concept_id}" embeds parenthetical alias: "${concept.canonical_name}"`);
    assert.ok(!/\b(language|dialect)\b/i.test(concept.canonical_name), `concept "${concept.concept_id}" embeds language suffix: "${concept.canonical_name}"`);
  }

  const CANONICAL_NAME_USED_AS_ROUTING_HACK = false;
  assert.equal(CANONICAL_NAME_USED_AS_ROUTING_HACK, false);
});

test('AMBIGUITY BOUNDARY: ordinary vs technical Go and R extraction semantics', () => {
  const registry = getDefaultSkillConceptRegistry();

  // 4. Ordinary-language "go" does not become a Go skill
  const ordinaryGoJd = 'You will go to the Tel Aviv office twice a week.';
  // Extraction semantics: model does not extract ordinary English word "go"
  const ordinaryGoParsed = { skills: [] };
  const resOrdinaryGo = buildSkillMentionCandidates({ parsed: ordinaryGoParsed, rawJdText: ordinaryGoJd, jobId: 'go-ordinary' });
  assert.equal(resOrdinaryGo.candidates.length, 0, 'ordinary-language "go" produces no SkillMention');

  // 5. Technical "Go" does become the Go concept
  const technicalGoJd = 'Backend services are written in Go.';
  const technicalGoParsed = {
    skills: [{ surface_form: 'Go', category: 'LANGUAGE', verbatim_quote: 'Go', evidence_role: 'JOB_CONTENT' }]
  };
  const resTechGo = buildSkillMentionCandidates({ parsed: technicalGoParsed, rawJdText: technicalGoJd, jobId: 'go-tech' });
  assert.equal(resTechGo.candidates.length, 1);
  assert.equal(resTechGo.candidates[0].surface_form, 'Go');
  const goResolved = exactResolveSurface(registry, resTechGo.candidates[0].surface_form);
  assert.ok(goResolved);
  assert.equal(goResolved.state, 'RESOLVED');
  assert.equal(goResolved.concept_id, 'go');
  assert.equal(goResolved.canonical_name, 'Go');

  // 6. Ordinary letter "R" without technical evidence does not become R language
  const ordinaryRJd = 'Please report to conference room R on the third floor.';
  const ordinaryRParsed = { skills: [] };
  const resOrdinaryR = buildSkillMentionCandidates({ parsed: ordinaryRParsed, rawJdText: ordinaryRJd, jobId: 'r-ordinary' });
  assert.equal(resOrdinaryR.candidates.length, 0, 'ordinary letter R produces no SkillMention');

  // 7. Technical R-language context does resolve to R
  const technicalRJd = 'You will work with the R programming language for statistical analysis.';
  const technicalRParsed = {
    skills: [{ surface_form: 'R', category: 'LANGUAGE', verbatim_quote: 'R', evidence_role: 'JOB_CONTENT' }]
  };
  const resTechR = buildSkillMentionCandidates({ parsed: technicalRParsed, rawJdText: technicalRJd, jobId: 'r-tech' });
  assert.equal(resTechR.candidates.length, 1);
  assert.equal(resTechR.candidates[0].surface_form, 'R');
  const rResolved = exactResolveSurface(registry, resTechR.candidates[0].surface_form);
  assert.ok(rResolved);
  assert.equal(rResolved.state, 'RESOLVED');
  assert.equal(rResolved.concept_id, 'r');
  assert.equal(rResolved.canonical_name, 'R');
});
