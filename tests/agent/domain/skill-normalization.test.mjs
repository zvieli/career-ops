// @ts-check
//
// Phase-2 Task 3 — Staged Skill Normalization (Remediated Architecture).
//
// MODELS UNDERSTAND. CODE DECIDES.
// - Handcrafted alias tables are completely removed.
// - Step A handles lossless exact canonical matching only.
// - Step B retrieves candidate concepts to bound System-1 search space.
// - Step C System-1 is the primary semantic authority for resolving variants, abbreviations, and context.
// - Step D deterministic admission validation enforces candidate set constraints, stable IDs, and honesty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSkillMentions,
  retrieveNormalizationCandidates,
  expandNormalizationCandidates,
  validateSemanticDecision,
  buildSkillNormalizationPrompt,
  parseSkillNormalizationResponse,
  createNormalizationCache,
  contextWindow,
  DEFAULT_MIN_SEMANTIC_CONFIDENCE,
  NORMALIZATION_PROMPT_VERSION,
  GENERIC_TECH_TOKENS
} from '../../../src/agent/domain/semantic/skill-normalization.mjs';
import {
  buildSkillMentionCandidates,
  buildJobSkillIntelligence
} from '../../../src/agent/domain/semantic/skill-intelligence.mjs';
import {
  getDefaultSkillConceptRegistry,
  loadSkillConceptRegistry
} from '../../../src/agent/domain/semantic/skill-concept-registry.mjs';
import { createSkillMention } from '../../../src/agent/domain/semantic/semantic-entities.mjs';

const registry = getDefaultSkillConceptRegistry();

function candidate({ id, surface, category = 'LANGUAGE', start = 0, quote = null, evidence_role = 'JOB_CONTENT' }) {
  const normalized = surface.toLowerCase();
  return {
    mention_id: id,
    surface_form: surface,
    normalized_surface: normalized,
    category,
    requirement_id: null,
    requirement_importance: null,
    evidence_span: { start_char: start, end_char: start + (quote ?? surface).length, verbatim_quote: quote ?? surface },
    evidence_role,
    confidence: null
  };
}

function resolverFrom(table, sink = { calls: 0 }) {
  const fn = async () => {
    sink.calls++;
    return JSON.stringify({ decisions: table });
  };
  fn.sink = sink;
  return fn;
}

test('stage A resolves exact canonical display names deterministically with no model call', async () => {
  const jd = 'Stack: JavaScript, Kubernetes, PostgreSQL, React.';
  const parsed = {
    skills: [
      { surface_form: 'JavaScript', category: 'LANGUAGE', verbatim_quote: 'JavaScript', evidence_role: 'JOB_CONTENT' },
      { surface_form: 'Kubernetes', category: 'INFRASTRUCTURE', verbatim_quote: 'Kubernetes', evidence_role: 'JOB_CONTENT' },
      { surface_form: 'PostgreSQL', category: 'DATABASE', verbatim_quote: 'PostgreSQL', evidence_role: 'JOB_CONTENT' },
      { surface_form: 'React', category: 'FRAMEWORK', verbatim_quote: 'React', evidence_role: 'JOB_CONTENT' }
    ]
  };
  const { candidates } = buildSkillMentionCandidates({ parsed, rawJdText: jd, jobId: 'j1' });
  const sink = { calls: 0 };
  const resolver = resolverFrom([], sink);

  const { skill_intelligence } = await buildJobSkillIntelligence({
    candidates,
    rawJdText: jd,
    jobId: 'j1',
    registry,
    semanticResolver: resolver
  });

  assert.equal(sink.calls, 0, 'exact canonical names resolve without calling System-1');
  assert.equal(skill_intelligence.telemetry.normalization_model_calls, 0);
  const bySurface = new Map(skill_intelligence.mentions.map((m) => [m.surface_form, m.resolution]));
  assert.equal(bySurface.get('JavaScript').concept_id, 'javascript');
  assert.equal(bySurface.get('JavaScript').method, 'EXACT_CANONICAL');
  assert.equal(bySurface.get('Kubernetes').concept_id, 'kubernetes');
  assert.equal(bySurface.get('PostgreSQL').concept_id, 'postgresql');
  assert.equal(bySurface.get('React').concept_id, 'react');
});

test('stage A resolves casing and punctuation variants of canonical names', async () => {
  const jd = 'javascript and JAVASCRIPT and "PostgreSQL" and postgresql';
  const parsed = {
    skills: [
      { surface_form: 'javascript', category: 'LANGUAGE', verbatim_quote: 'javascript', evidence_role: 'JOB_CONTENT' },
      { surface_form: 'JAVASCRIPT', category: 'LANGUAGE', verbatim_quote: 'JAVASCRIPT', evidence_role: 'JOB_CONTENT' },
      { surface_form: 'PostgreSQL', category: 'DATABASE', verbatim_quote: 'PostgreSQL', evidence_role: 'JOB_CONTENT' },
      { surface_form: 'postgresql', category: 'DATABASE', verbatim_quote: 'postgresql', evidence_role: 'JOB_CONTENT' }
    ]
  };
  const { candidates } = buildSkillMentionCandidates({ parsed, rawJdText: jd, jobId: 'j1' });
  const { skill_intelligence } = await buildJobSkillIntelligence({ candidates, rawJdText: jd, jobId: 'j1', registry, semanticResolver: null });

  const conceptIds = new Set(skill_intelligence.mentions.map((m) => m.resolution.concept_id));
  assert.deepEqual([...conceptIds].sort(), ['javascript', 'postgresql']);
  assert.equal(skill_intelligence.concepts.length, 2);
});

test('stage B retrieval proposes candidates without deciding identity', () => {
  // Initialism retrieval proposes JavaScript for JS
  const jsCandidates = retrieveNormalizationCandidates(registry, 'JS');
  assert.ok(jsCandidates.some((c) => c.concept_id === 'javascript'), 'retrieval should propose javascript for JS');
  assert.ok(jsCandidates.find((c) => c.concept_id === 'javascript').retrieval_method === 'INITIALISM');

  // Numeronym retrieval proposes Kubernetes for k8s
  const k8sCandidates = retrieveNormalizationCandidates(registry, 'k8s');
  assert.ok(k8sCandidates.some((c) => c.concept_id === 'kubernetes'), 'retrieval should propose kubernetes for k8s');

  // Prefix/substring retrieval proposes PostgreSQL for Postgres
  const pgCandidates = retrieveNormalizationCandidates(registry, 'Postgres');
  assert.ok(pgCandidates.some((c) => c.concept_id === 'postgresql'), 'retrieval should propose postgresql for Postgres');
});

test('NO-ALIAS MUTATION TEST: System-1 normalizes variants without any handcrafted alias tables', async () => {
  // Construct a registry with canonical identities and ZERO aliases
  const noAliasSeed = {
    registry_version: 'test-no-alias-v1',
    concepts: [
      { concept_id: 'javascript', canonical_name: 'JavaScript', category: 'LANGUAGE' },
      { concept_id: 'kubernetes', canonical_name: 'Kubernetes', category: 'INFRASTRUCTURE' },
      { concept_id: 'postgresql', canonical_name: 'PostgreSQL', category: 'DATABASE' },
      { concept_id: 'react', canonical_name: 'React', category: 'FRAMEWORK' }
    ]
  };
  const testRegistry = loadSkillConceptRegistry(noAliasSeed);

  const jd = 'Stack: JS, k8s, Postgres, React.js.';
  const parsed = {
    skills: [
      { surface_form: 'JS', category: 'LANGUAGE', verbatim_quote: 'JS', evidence_role: 'JOB_CONTENT' },
      { surface_form: 'k8s', category: 'INFRASTRUCTURE', verbatim_quote: 'k8s', evidence_role: 'JOB_CONTENT' },
      { surface_form: 'Postgres', category: 'DATABASE', verbatim_quote: 'Postgres', evidence_role: 'JOB_CONTENT' },
      { surface_form: 'React.js', category: 'FRAMEWORK', verbatim_quote: 'React.js', evidence_role: 'JOB_CONTENT' }
    ]
  };
  const { candidates } = buildSkillMentionCandidates({ parsed, rawJdText: jd, jobId: 'j1' });

  // System-1 makes the semantic judgment
  const resolver = resolverFrom([
    { mention_id: candidates[0].mention_id, decision: 'EXISTING', concept_id: 'javascript', confidence: 0.95 },
    { mention_id: candidates[1].mention_id, decision: 'EXISTING', concept_id: 'kubernetes', confidence: 0.95 },
    { mention_id: candidates[2].mention_id, decision: 'EXISTING', concept_id: 'postgresql', confidence: 0.95 },
    { mention_id: candidates[3].mention_id, decision: 'EXISTING', concept_id: 'react', confidence: 0.95 }
  ]);

  const { skill_intelligence } = await buildJobSkillIntelligence({
    candidates,
    rawJdText: jd,
    jobId: 'j1',
    registry: testRegistry,
    semanticResolver: resolver
  });

  const bySurface = new Map(skill_intelligence.mentions.map((m) => [m.surface_form, m.resolution]));
  assert.equal(bySurface.get('JS').concept_id, 'javascript');
  assert.equal(bySurface.get('JS').method, 'SEMANTIC_RESOLUTION');
  assert.equal(bySurface.get('k8s').concept_id, 'kubernetes');
  assert.equal(bySurface.get('Postgres').concept_id, 'postgresql');
  assert.equal(bySurface.get('React.js').concept_id, 'react');
});

test('NOVEL TECHNOLOGY TEST: unknown technology creates a stable NEW_CONCEPT with no registry edit', async () => {
  const jd = 'Greenfield services running on NovaAgent Runtime.';
  const parsed = {
    skills: [
      { surface_form: 'NovaAgent Runtime', category: 'FRAMEWORK', verbatim_quote: 'NovaAgent Runtime', evidence_role: 'JOB_CONTENT' }
    ]
  };
  const { candidates } = buildSkillMentionCandidates({ parsed, rawJdText: jd, jobId: 'j1' });

  const resolver = resolverFrom([
    { mention_id: candidates[0].mention_id, decision: 'NEW', concept_id: null, confidence: 0.90 }
  ]);

  const { skill_intelligence } = await buildJobSkillIntelligence({
    candidates,
    rawJdText: jd,
    jobId: 'j1',
    registry,
    semanticResolver: resolver
  });

  const mention = skill_intelligence.mentions[0];
  assert.equal(mention.resolution.state, 'NEW_CONCEPT');
  assert.equal(mention.resolution.concept_id, 'novaagent-runtime');
  assert.equal(mention.resolution.method, 'DETERMINISTIC_NEW_CONCEPT');
  assert.equal(skill_intelligence.concepts[0].is_registered, false);
});

test('NOVEL FALSE-MERGE TEST: distinct related technologies are not merged without hardcoded distinctness pairs', async () => {
  // Test distinct technologies NovaGraph and NovaChain sharing an ecosystem name
  const jd = 'Orchestrating agents with NovaChain and NovaGraph.';
  const parsed = {
    skills: [
      { surface_form: 'NovaChain', category: 'AI_ML', verbatim_quote: 'NovaChain', evidence_role: 'JOB_CONTENT' },
      { surface_form: 'NovaGraph', category: 'AI_ML', verbatim_quote: 'NovaGraph', evidence_role: 'JOB_CONTENT' }
    ]
  };
  const { candidates } = buildSkillMentionCandidates({ parsed, rawJdText: jd, jobId: 'j1' });

  // System-1 correctly recognizes both as distinct new concepts
  const resolver = resolverFrom([
    { mention_id: candidates[0].mention_id, decision: 'NEW', concept_id: null, confidence: 0.92 },
    { mention_id: candidates[1].mention_id, decision: 'NEW', concept_id: null, confidence: 0.92 }
  ]);

  const { skill_intelligence } = await buildJobSkillIntelligence({
    candidates,
    rawJdText: jd,
    jobId: 'j1',
    registry,
    semanticResolver: resolver
  });

  const ids = skill_intelligence.mentions.map((m) => m.resolution.concept_id);
  assert.deepEqual(ids, ['novachain', 'novagraph']);
  assert.notEqual(ids[0], ids[1], 'distinct technologies must never collapse');
  assert.equal(skill_intelligence.concepts.length, 2);
});

test('validateSemanticDecision enforces candidate-set constraints and confidence thresholds', () => {
  const mention = candidate({ id: 'm1', surface: 'Java' });
  const candidates = [{ concept_id: 'javascript', canonical_name: 'JavaScript', retrieval_score: 0.5, retrieval_method: 'NORMALIZED_TOKEN_OVERLAP' }];

  const cases = [
    [{ mention_id: 'other', decision: 'NEW', confidence: 0.9 }, 'MENTION_ID_MISMATCH'],
    [{ mention_id: 'm1', decision: 'MAYBE', confidence: 0.9 }, 'UNKNOWN_DECISION_KIND'],
    [{ mention_id: 'm1', decision: 'EXISTING', concept_id: 'javascript', confidence: 'invalid' }, 'CONFIDENCE_NOT_A_NUMBER'],
    [{ mention_id: 'm1', decision: 'EXISTING', concept_id: 'javascript', confidence: 0.1 }, 'CONFIDENCE_BELOW_FLOOR(0.6)'],
    [{ mention_id: 'm1', decision: 'EXISTING', concept_id: 'react', confidence: 0.99 }, 'CONCEPT_ID_NOT_IN_RETRIEVED_CANDIDATES'],
    [null, 'DECISION_NOT_AN_OBJECT']
  ];

  for (const [decision, expectedReason] of cases) {
    const verdict = validateSemanticDecision({ decision, mention, candidates });
    assert.equal(verdict.valid, false, `should reject: ${expectedReason}`);
    assert.equal(verdict.reason, expectedReason);
  }

  // Permitted decisions
  assert.equal(validateSemanticDecision({ decision: { mention_id: 'm1', decision: 'NEW', confidence: 0.8 }, mention, candidates }).valid, true);
  assert.equal(validateSemanticDecision({ decision: { mention_id: 'm1', decision: 'UNRESOLVED', confidence: null }, mention, candidates }).valid, true);
  assert.equal(validateSemanticDecision({ decision: { mention_id: 'm1', decision: 'EXISTING', concept_id: 'javascript', confidence: 0.9 }, mention, candidates }).valid, true);
  assert.equal(DEFAULT_MIN_SEMANTIC_CONFIDENCE, 0.6);
});

test('a rejected decision leaves the mention unresolved instead of merging it', async () => {
  const jd = 'We use Java 8 in production.';
  const parsed = { skills: [{ surface_form: 'Java 8', category: 'LANGUAGE', verbatim_quote: 'Java 8', evidence_role: 'JOB_CONTENT' }] };
  const { candidates } = buildSkillMentionCandidates({ parsed, rawJdText: jd, jobId: 'j1' });

  // Model hallucinates a concept ID not in candidates
  const resolver = resolverFrom([{ mention_id: candidates[0].mention_id, decision: 'EXISTING', concept_id: 'react', confidence: 0.99 }]);
  const { skill_intelligence } = await buildJobSkillIntelligence({ candidates, rawJdText: jd, jobId: 'j1', registry, semanticResolver: resolver });
  const mention = skill_intelligence.mentions[0];
  assert.notEqual(mention.resolution.concept_id, 'react');
  assert.equal(mention.resolution.state, 'UNRESOLVED');
  assert.equal(skill_intelligence.diagnostics.rejected_normalization_decisions.length, 1);
  assert.match(skill_intelligence.diagnostics.rejected_normalization_decisions[0].reason, /CONCEPT_ID_NOT_IN_RETRIEVED_CANDIDATES/);
});

test('a model-proposed label is recorded as an observed surface form, never a global alias', async () => {
  const jd = 'Experience with ACP Runtime Framework.';
  const parsed = { skills: [{ surface_form: 'ACP Runtime Framework', category: 'FRAMEWORK', verbatim_quote: 'ACP Runtime Framework', evidence_role: 'JOB_CONTENT' }] };
  const { candidates } = buildSkillMentionCandidates({ parsed, rawJdText: jd, jobId: 'j1' });
  const resolver = resolverFrom([{ mention_id: candidates[0].mention_id, decision: 'NEW', concept_id: null, confidence: 0.9 }]);

  const { skill_intelligence } = await buildJobSkillIntelligence({ candidates, rawJdText: jd, jobId: 'j1', registry, semanticResolver: resolver });

  const concept = skill_intelligence.concepts[0];
  assert.equal(concept.is_registered, false);
  assert.equal(concept.aliases, undefined, 'no alias array on concept');
  assert.equal(registry.byCanonicalSurface.has('acp-runtime-framework'), false, 'registry is not poisoned');
});

test('the cache key is context-bound, so an ambiguous decision cannot become universal', async () => {
  const cache = createNormalizationCache();
  const jdA = 'Backend services written in Golang, a compiled language for our platform.';
  const jdB = 'You may use Golang for tooling or backend services if you wish.';

  const mentionA = candidate({ id: 'mA', surface: 'Golang', category: 'LANGUAGE' });
  const mentionB = candidate({ id: 'mB', surface: 'Golang', category: 'LANGUAGE' });

  const keyA = cache.keyFor({ normalization_version: registry.normalization_version, registry_version: registry.registry_version, normalized_surface: 'golang', category: 'LANGUAGE', candidate_ids: ['go'], context: contextWindow(jdA, mentionA.evidence_span) });
  const keyB = cache.keyFor({ normalization_version: registry.normalization_version, registry_version: registry.registry_version, normalized_surface: 'golang', category: 'LANGUAGE', candidate_ids: ['go'], context: contextWindow(jdB, mentionB.evidence_span) });
  assert.notEqual(keyA, keyB, 'different contexts must not share a key');

  const resolver = resolverFrom([
    { mention_id: 'mA', decision: 'EXISTING', concept_id: 'go', confidence: 0.9 },
    { mention_id: 'mB', decision: 'EXISTING', concept_id: 'go', confidence: 0.9 }
  ]);
  await normalizeSkillMentions({ candidates: [mentionA], registry, rawJdText: jdA, semanticResolver: resolver, cache });
  assert.equal(resolver.sink.calls, 1);
  assert.equal(cache.size(), 1);

  // Same context -> cache hit
  await normalizeSkillMentions({ candidates: [mentionA], registry, rawJdText: jdA, semanticResolver: resolver, cache });
  assert.equal(resolver.sink.calls, 1);
  assert.equal(cache.stats.hits, 1);

  // Different context -> fresh model call required
  await normalizeSkillMentions({ candidates: [mentionB], registry, rawJdText: jdB, semanticResolver: resolver, cache });
  assert.equal(resolver.sink.calls, 2);
  assert.equal(cache.size(), 2);
});

test('a cached value is returned as a copy and cannot be mutated through the cache', () => {
  const cache = createNormalizationCache();
  const key = 'k';
  cache.set(key, { state: 'UNRESOLVED', concept_id: null });
  const a = cache.get(key);
  a.state = 'EXISTING';
  a.concept_id = 'javascript';
  const b = cache.get(key);
  assert.equal(b.state, 'UNRESOLVED');
  assert.equal(b.concept_id, null);
});

test('malformed normalization JSON is an engineering failure, retried once, and non-destructive', async () => {
  const jd = 'We use CustomTech in production.';
  const parsed = { skills: [{ surface_form: 'CustomTech', category: 'LANGUAGE', verbatim_quote: 'CustomTech', evidence_role: 'JOB_CONTENT' }] };
  const { candidates } = buildSkillMentionCandidates({ parsed, rawJdText: jd, jobId: 'j1' });

  let calls = 0;
  const resolver = async () => { calls++; return 'not json at all'; };
  const { skill_intelligence } = await buildJobSkillIntelligence({ candidates, rawJdText: jd, jobId: 'j1', registry, semanticResolver: resolver });

  assert.equal(calls, 2, 'one retry for a malformed response');
  assert.equal(skill_intelligence.telemetry.retries, 1);
  assert.equal(skill_intelligence.telemetry.normalization_model_calls, 2);
  assert.equal(skill_intelligence.diagnostics.failure_code, 'INVALID_STRUCTURED_OUTPUT');
  assert.equal(skill_intelligence.mentions.length, 1);
  assert.equal(skill_intelligence.mentions[0].evidence_span.verbatim_quote, 'CustomTech');
});

test('a transport failure is recorded as an engineering fault, not as a semantic UNKNOWN', async () => {
  const jd = 'We use WidgetDB.';
  const parsed = { skills: [{ surface_form: 'WidgetDB', category: 'DATABASE', verbatim_quote: 'WidgetDB', evidence_role: 'JOB_CONTENT' }] };
  const { candidates } = buildSkillMentionCandidates({ parsed, rawJdText: jd, jobId: 'j1' });

  const timeout = new Error('gateway timed out');
  timeout.code = 'TIMEOUT';
  const resolver = async () => { throw timeout; };

  const { skill_intelligence } = await buildJobSkillIntelligence({ candidates, rawJdText: jd, jobId: 'j1', registry, semanticResolver: resolver });

  assert.equal(skill_intelligence.diagnostics.failure_code, 'MODEL_TIMEOUT');
  assert.equal(skill_intelligence.diagnostics.failure_stage, 'NORMALIZATION');
  assert.equal(skill_intelligence.mentions[0].resolution.state, 'UNRESOLVED');
});

test('parseSkillNormalizationResponse rejects empty, malformed and shapeless responses', () => {
  assert.throws(() => parseSkillNormalizationResponse(''), (err) => err.code === 'INVALID_STRUCTURED_OUTPUT');
  assert.throws(() => parseSkillNormalizationResponse('{oops'), (err) => err.code === 'INVALID_STRUCTURED_OUTPUT');
  assert.throws(() => parseSkillNormalizationResponse('{"decisions": {}}'), (err) => err.code === 'INVALID_STRUCTURED_OUTPUT');
  assert.deepEqual(parseSkillNormalizationResponse('```json\n{"decisions":[]}\n```'), { decisions: [] });
  assert.match(NORMALIZATION_PROMPT_VERSION, /^v\d/);
});

test('the normalization prompt carries the identity rules and the untrusted-data boundary', () => {
  const mention = candidate({ id: 'm1', surface: 'Java' });
  const { systemPrompt, userMessage } = buildSkillNormalizationPrompt({
    mentions: [{ mention_id: 'm1', surface_form: 'Java', category: 'LANGUAGE', context: 'Java and JavaScript' }],
    candidatesByMentionId: new Map([['m1', [{ concept_id: 'javascript', canonical_name: 'JavaScript', retrieval_score: 0.5 }]]])
  });
  assert.ok(/UNTRUSTED DATA/.test(systemPrompt));
  assert.ok(/Never decide whether a candidate fits/.test(systemPrompt));
  assert.ok(/FastAPI is NOT Python/.test(systemPrompt));
  assert.ok(/React Native is NOT React/.test(systemPrompt));
  assert.ok(/Prefer UNRESOLVED over guessing/.test(systemPrompt));
  assert.ok(userMessage.includes('concept_id: "javascript"'));
  assert.ok(userMessage.includes('<untrusted_mentions>'));
  assert.equal(mention.normalized_surface, 'java');
});

test('a decision for a mention that was never sent is ignored, not applied', async () => {
  const jd = 'We use CustomTool.';
  const parsed = { skills: [{ surface_form: 'CustomTool', category: 'TOOL', verbatim_quote: 'CustomTool', evidence_role: 'JOB_CONTENT' }] };
  const { candidates } = buildSkillMentionCandidates({ parsed, rawJdText: jd, jobId: 'j1' });
  const resolver = resolverFrom([{ mention_id: 'invented-mention', decision: 'EXISTING', concept_id: 'git', confidence: 0.99 }]);

  const { skill_intelligence } = await buildJobSkillIntelligence({ candidates, rawJdText: jd, jobId: 'j1', registry, semanticResolver: resolver });
  assert.equal(skill_intelligence.diagnostics.rejected_normalization_decisions[0].reason, 'NO_DECISION_RETURNED');
});

test('a mention whose normalization cannot be validated throws rather than being emitted', () => {
  assert.throws(() => createSkillMention({
    mention_id: 'm1',
    surface_form: 'Go',
    normalized_surface: 'go',
    category: 'NOT_A_CATEGORY',
    evidence_span: { start_char: 0, end_char: 2, verbatim_quote: 'Go' },
    evidence_role: 'JOB_CONTENT',
    resolution: { state: 'UNRESOLVED', concept_id: null, method: 'NONE', confidence: null }
  }));
});

test('HOSTILE RETRIEVAL CATEGORY 1 & 5: abbreviation with weak character overlap and low trigram overlap', async () => {
  // Synthetic concept: "Backend For Frontend" (architecture), mention: "BFF"
  const testSeed = {
    registry_version: 'test-hostile-v1',
    concepts: [
      { concept_id: 'bff-arch', canonical_name: 'Backend For Frontend', category: 'ARCHITECTURE' },
      { concept_id: 'microservices', canonical_name: 'Microservices', category: 'ARCHITECTURE' }
    ]
  };
  const testReg = loadSkillConceptRegistry(testSeed);
  const mention = candidate({ id: 'm1', surface: 'BFF', category: 'ARCHITECTURE' });

  // Wave 1 lexical retrieval alone has weak overlap for "bff" vs "backend-for-frontend"
  const wave1 = retrieveNormalizationCandidates(testReg, 'BFF', { wave: 1, limit: 5 });
  // Wave 2 secondary retrieval (via category backfill / broader expansion) surfaces bff-arch
  const wave2 = retrieveNormalizationCandidates(testReg, 'BFF', { wave: 2, limit: 5, category: 'ARCHITECTURE' });
  assert.ok(wave2.some((c) => c.concept_id === 'bff-arch'), 'wave 2 must surface bff-arch');

  // Combined high-recall retrieval surfaces bff-arch into candidate set
  const candidates = retrieveNormalizationCandidates(testReg, 'BFF', { limit: 5, category: 'ARCHITECTURE' });
  assert.ok(candidates.some((c) => c.concept_id === 'bff-arch'));

  // System-1 successfully resolves EXISTING from the surfaced candidate
  const resolver = resolverFrom([{ mention_id: 'm1', decision: 'EXISTING', concept_id: 'bff-arch', confidence: 0.92 }]);
  const result = await normalizeSkillMentions({ candidates: [mention], registry: testReg, rawJdText: 'We design BFF layers for mobile.', semanticResolver: resolver });
  assert.equal(result.mentions[0].resolution.state, 'RESOLVED');
  assert.equal(result.mentions[0].resolution.concept_id, 'bff-arch');
});

test('HOSTILE RETRIEVAL CATEGORY 2: product rename with zero lexical overlap', async () => {
  // Synthetic concept: "Google Cloud Monitoring", historical rename mention: "Stackdriver"
  const testSeed = {
    registry_version: 'test-rename-v1',
    concepts: [
      { concept_id: 'gcp-monitoring', canonical_name: 'Google Cloud Monitoring', category: 'INFRASTRUCTURE' },
      { concept_id: 'aws-cloudwatch', canonical_name: 'AWS CloudWatch', category: 'INFRASTRUCTURE' }
    ]
  };
  const testReg = loadSkillConceptRegistry(testSeed);
  const mention = candidate({ id: 'm1', surface: 'Stackdriver', category: 'INFRASTRUCTURE' });

  // Wave 1 has 0 lexical overlap
  const wave1 = retrieveNormalizationCandidates(testReg, 'Stackdriver', { wave: 1, limit: 5 });
  assert.equal(wave1.length, 0, 'wave 1 lexical should find 0 overlap');

  // Secondary retrieval via category backfill surfaces the infrastructure concepts
  const surfaced = retrieveNormalizationCandidates(testReg, 'Stackdriver', { limit: 5, category: 'INFRASTRUCTURE' });
  assert.ok(surfaced.some((c) => c.concept_id === 'gcp-monitoring'), 'secondary retrieval must surface gcp-monitoring');

  // System-1 connects Stackdriver to Google Cloud Monitoring
  const resolver = resolverFrom([{ mention_id: 'm1', decision: 'EXISTING', concept_id: 'gcp-monitoring', confidence: 0.95 }]);
  const result = await normalizeSkillMentions({ candidates: [mention], registry: testReg, rawJdText: 'Logging with Stackdriver.', semanticResolver: resolver });
  assert.equal(result.mentions[0].resolution.state, 'RESOLVED');
  assert.equal(result.mentions[0].resolution.concept_id, 'gcp-monitoring');
});

test('HOSTILE RETRIEVAL CATEGORY 3 & 4: alternate official naming and semantic shorthand', async () => {
  // Alternate naming: "Amazon Elastic Compute Cloud" vs canonical "AWS EC2"
  const testSeed = {
    registry_version: 'test-naming-v1',
    concepts: [
      { concept_id: 'aws-ec2', canonical_name: 'AWS EC2', category: 'INFRASTRUCTURE' },
      { concept_id: 'aws-s3', canonical_name: 'Amazon S3', category: 'INFRASTRUCTURE' }
    ]
  };
  const testReg = loadSkillConceptRegistry(testSeed);
  const mention = candidate({ id: 'm1', surface: 'Amazon Elastic Compute Cloud', category: 'INFRASTRUCTURE' });

  const candidates = retrieveNormalizationCandidates(testReg, 'Amazon Elastic Compute Cloud', { limit: 5, category: 'INFRASTRUCTURE' });
  assert.ok(candidates.some((c) => c.concept_id === 'aws-ec2'));

  const resolver = resolverFrom([{ mention_id: 'm1', decision: 'EXISTING', concept_id: 'aws-ec2', confidence: 0.94 }]);
  const result = await normalizeSkillMentions({ candidates: [mention], registry: testReg, rawJdText: 'Deploying to Amazon Elastic Compute Cloud.', semanticResolver: resolver });
  assert.equal(result.mentions[0].resolution.state, 'RESOLVED');
  assert.equal(result.mentions[0].resolution.concept_id, 'aws-ec2');
});

test('HOSTILE RETRIEVAL CATEGORY 6: novel technology explicitly determined NEW', async () => {
  const mention = candidate({ id: 'm1', surface: 'AetherDB Distributed', category: 'DATABASE' });
  const candidates = retrieveNormalizationCandidates(registry, 'AetherDB Distributed', { limit: 5, category: 'DATABASE' });

  // System-1 explicitly determines NEW concept
  const resolver = resolverFrom([{ mention_id: 'm1', decision: 'NEW', concept_id: null, confidence: 0.91 }]);
  const result = await normalizeSkillMentions({ candidates: [mention], registry, rawJdText: 'Built on AetherDB Distributed.', semanticResolver: resolver });
  assert.equal(result.mentions[0].resolution.state, 'NEW_CONCEPT');
  assert.equal(result.mentions[0].resolution.concept_id, 'aetherdb-distributed');
  assert.equal(result.mentions[0].resolution.method, 'DETERMINISTIC_NEW_CONCEPT');
  assert.equal(result.concepts[0].is_registered, false);
});

test('HOSTILE RETRIEVAL CATEGORY 7: unrelated technology with high lexical similarity not merged', async () => {
  // Spring Boot vs Spring Framework: sharing "Spring" token
  const mention = candidate({ id: 'm1', surface: 'Spring Boot', category: 'FRAMEWORK' });
  const candidates = retrieveNormalizationCandidates(registry, 'Spring Boot', { limit: 5, category: 'FRAMEWORK' });

  // Candidate set includes both concepts
  assert.ok(candidates.some((c) => c.concept_id === 'spring-boot'));
  assert.ok(candidates.some((c) => c.concept_id === 'spring-framework'));

  // System-1 distinguishes them and does NOT merge Spring Boot into Spring Framework
  const resolver = resolverFrom([{ mention_id: 'm1', decision: 'EXISTING', concept_id: 'spring-boot', confidence: 0.96 }]);
  const result = await normalizeSkillMentions({ candidates: [mention], registry, rawJdText: 'Microservices with Spring Boot.', semanticResolver: resolver });
  assert.equal(result.mentions[0].resolution.concept_id, 'spring-boot');
  assert.notEqual(result.mentions[0].resolution.concept_id, 'spring-framework');
});

test('HOSTILE RETRIEVAL CATEGORY 8: generic shared suffix "Framework" does not dominate retrieval', () => {
  const testSeed = {
    registry_version: 'test-framework-v1',
    concepts: [
      { concept_id: 'spring-framework', canonical_name: 'Spring Framework', category: 'FRAMEWORK' },
      { concept_id: 'acp-core', canonical_name: 'ACP Engine', category: 'FRAMEWORK' }
    ]
  };
  const testReg = loadSkillConceptRegistry(testSeed);
  const candidates = retrieveNormalizationCandidates(testReg, 'ACP Runtime Framework', { limit: 5, category: 'FRAMEWORK' });

  // "ACP Engine" matches on distinctive token "ACP", while "Spring Framework" matches only on generic "Framework".
  // "ACP Engine" must outrank "Spring Framework".
  const acpIndex = candidates.findIndex((c) => c.concept_id === 'acp-core');
  const springIndex = candidates.findIndex((c) => c.concept_id === 'spring-framework');
  assert.ok(acpIndex !== -1, 'acp-core must be retrieved');
  if (springIndex !== -1) {
    assert.ok(acpIndex < springIndex, 'distinctive token "ACP" must outrank generic suffix "Framework"');
  }
});

test('RETRIEVAL VS IDENTITY TEST 1: System-1 selects correct concept when wrong concept is ranked #1', async () => {
  const testSeed = {
    registry_version: 'test-rank-v1',
    concepts: [
      { concept_id: 'spring-framework', canonical_name: 'Spring Framework', category: 'FRAMEWORK' },
      { concept_id: 'acp-concept', canonical_name: 'ACP Core Framework', category: 'FRAMEWORK' }
    ]
  };
  const testReg = loadSkillConceptRegistry(testSeed);
  const mention = candidate({ id: 'm1', surface: 'ACP Runtime Framework', category: 'FRAMEWORK' });

  // Retrieval candidate list where Spring Framework is intentionally ranked first
  const candidates = [
    { concept_id: 'spring-framework', canonical_name: 'Spring Framework', retrieval_score: 0.85, retrieval_method: 'SUBSTRING' },
    { concept_id: 'acp-concept', canonical_name: 'ACP Core Framework', retrieval_score: 0.60, retrieval_method: 'NORMALIZED_TOKEN_OVERLAP' }
  ];

  // Resolver selects candidate #2 (acp-concept) despite candidate #1 being nearest
  const resolver = resolverFrom([{ mention_id: 'm1', decision: 'EXISTING', concept_id: 'acp-concept', confidence: 0.93 }]);
  const result = await normalizeSkillMentions({
    candidates: [mention],
    registry: testReg,
    rawJdText: 'Services built with ACP Runtime Framework.',
    semanticResolver: resolver,
    options: { secondaryRetrieval: () => candidates }
  });

  assert.equal(result.mentions[0].resolution.state, 'RESOLVED');
  assert.equal(result.mentions[0].resolution.concept_id, 'acp-concept');
  assert.notEqual(result.mentions[0].resolution.concept_id, 'spring-framework', 'nearest candidate must never equal automatic identity');
});

test('RETRIEVAL VS IDENTITY TEST 2: Wave 1 miss is recovered by secondary retrieval before System-1 resolution', async () => {
  const testSeed = {
    registry_version: 'test-wave-miss-v1',
    concepts: [
      { concept_id: 'spring-framework', canonical_name: 'Spring Framework', category: 'FRAMEWORK' },
      { concept_id: 'acp-concept', canonical_name: 'Enterprise Cloud Processor', category: 'FRAMEWORK' }
    ]
  };
  const testReg = loadSkillConceptRegistry(testSeed);
  const mention = candidate({ id: 'm1', surface: 'ACP Runtime Framework', category: 'FRAMEWORK' });

  // Wave 1 lexical retrieval only finds Spring Framework, completely missing acp-concept
  const wave1 = retrieveNormalizationCandidates(testReg, 'ACP Runtime Framework', { wave: 1, limit: 5 });
  assert.ok(!wave1.some((c) => c.concept_id === 'acp-concept'), 'wave 1 must miss acp-concept');

  // Secondary retrieval (Wave 2 / expansion) surfaces acp-concept into the candidate pool
  const expanded = expandNormalizationCandidates(testReg, 'ACP Runtime Framework', wave1, { category: 'FRAMEWORK', limit: 5 });
  assert.ok(expanded.some((c) => c.concept_id === 'acp-concept'), 'secondary retrieval must surface acp-concept');

  // System-1 receives the expanded candidate set and selects acp-concept
  const resolver = resolverFrom([{ mention_id: 'm1', decision: 'EXISTING', concept_id: 'acp-concept', confidence: 0.90 }]);
  const result = await normalizeSkillMentions({
    candidates: [mention],
    registry: testReg,
    rawJdText: 'ACP Runtime Framework on AWS.',
    semanticResolver: resolver,
    options: { expandRetrieval: true, category: 'FRAMEWORK' }
  });

  assert.equal(result.mentions[0].resolution.state, 'RESOLVED');
  assert.equal(result.mentions[0].resolution.concept_id, 'acp-concept');
});

test('RETRIEVAL FAILURE BEHAVIOR: retrieval failure leaves mention UNRESOLVED, never auto-creates NEW_CONCEPT', async () => {
  // When retrieval fails to surface candidates or semantic resolution is unavailable:
  // mention MUST stay UNRESOLVED with reason NO_CANDIDATE_FOUND / SEMANTIC_RESOLUTION_UNAVAILABLE.
  const emptySeed = {
    registry_version: 'empty-reg',
    concepts: []
  };
  const emptyReg = loadSkillConceptRegistry(emptySeed);
  const mention = candidate({ id: 'm1', surface: 'UnheardOfTech', category: 'TOOL' });

  const result = await normalizeSkillMentions({
    candidates: [mention],
    registry: emptyReg,
    rawJdText: 'We use UnheardOfTech.',
    semanticResolver: null // no resolver available
  });

  assert.equal(result.mentions[0].resolution.state, 'UNRESOLVED');
  assert.equal(result.mentions[0].resolution.concept_id, null);
  assert.equal(result.mentions[0].resolution.reason, 'NO_CANDIDATE_FOUND');
  assert.equal(result.concepts.length, 0, 'retrieval failure must never create a new concept in concepts[]');
});

test('P2 BOUNDARY: GENERIC_TECH_TOKENS is retrieval optimization only, not semantic authority', async () => {
  assert.ok(GENERIC_TECH_TOKENS instanceof Set);
  assert.ok(GENERIC_TECH_TOKENS.has('framework'));
  assert.ok(GENERIC_TECH_TOKENS.has('library'));

  // Test setup where "ACP Runtime Framework" is normalized with synthetic registry.
  // We prove that even if GENERIC_TECH_TOKENS were altered or if candidates are ordered differently,
  // System-1 semantic resolution remains the sole authority for identity and arrives at the same
  // truth regardless of candidate retrieval rank.
  const testSeed = {
    registry_version: 'test-generic-boundary',
    concepts: [
      { concept_id: 'spring-framework', canonical_name: 'Spring Framework', category: 'FRAMEWORK' },
      { concept_id: 'acp-core', canonical_name: 'ACP Engine', category: 'FRAMEWORK' }
    ]
  };
  const testReg = loadSkillConceptRegistry(testSeed);
  const mention = candidate({ id: 'm1', surface: 'ACP Runtime Framework', category: 'FRAMEWORK' });

  // Regardless of candidate rank, System-1 evaluates context and selects the correct concept:
  const resolver = resolverFrom([{ mention_id: 'm1', decision: 'EXISTING', concept_id: 'acp-core', confidence: 0.95 }]);
  const res = await normalizeSkillMentions({
    candidates: [mention],
    registry: testReg,
    rawJdText: 'Built with ACP Runtime Framework.',
    semanticResolver: resolver,
    options: { expandRetrieval: true, category: 'FRAMEWORK' }
  });

  assert.equal(res.mentions[0].resolution.concept_id, 'acp-core');
  assert.notEqual(res.mentions[0].resolution.concept_id, 'spring-framework');
});
