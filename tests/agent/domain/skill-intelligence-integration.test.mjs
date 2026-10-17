// @ts-check
//
// Phase-2 integration contract: entity shapes, typed-failure separation,
// Phase-1 non-regression, and the hard "no live model call in a normal test
// run" rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  createJobSkillIntelligence,
  createSkillConcept,
  createSkillMention,
  validateJobSkillIntelligence,
  validateSkillMention,
  validateSkillConcept,
  assertValidJobSkillIntelligence,
  SKILL_RESOLUTION_STATES,
  SKILL_RESOLUTION_METHODS,
  SKILL_RETRIEVAL_METHODS,
  SEMANTIC_SCHEMA_VERSION,
  getSchema
} from '../../../src/agent/domain/semantic/semantic-entities.mjs';
import {
  SemanticProfilerError,
  SEMANTIC_FAILURE_CODES,
  isSemanticUncertaintyCode
} from '../../../src/agent/domain/semantic/semantic-errors.mjs';
import {
  profileJobSemantic,
  profileJobWithSkillIntelligence,
  PROMPT_VERSION
} from '../../../src/agent/domain/semantic/job-semantic-profiler.mjs';
import { computeSourceHash } from '../../../src/agent/domain/semantic/provenance-validator.mjs';
import { SemanticEngine } from '../../../src/agent/domain/semantic/adapters/semantic-engine.mjs';
import {
  buildSkillMentionCandidates,
  buildJobSkillIntelligence,
  SKILL_TASK_VERSION,
  SKILL_PROMPT_VERSION
} from '../../../src/agent/domain/semantic/skill-intelligence.mjs';
import {
  NORMALIZATION_TASK_VERSION,
  NORMALIZATION_PROMPT_VERSION,
  createNormalizationCache
} from '../../../src/agent/domain/semantic/skill-normalization.mjs';
import { getDefaultSkillConceptRegistry } from '../../../src/agent/domain/semantic/skill-concept-registry.mjs';
import { runShadowEvaluation } from '../../../src/agent/domain/semantic/shadow/shadow-profiler.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const registry = getDefaultSkillConceptRegistry();

const MOCK_PROFILE = {
  role: { primary_family: 'ai_ml', specialization: 'Applied AI', descriptive_domain: 'Generative AI' },
  seniority: { level: 'JUNIOR', is_early_career_friendly: true, rationale: 'junior', evidence_signals: { title_signal: 'Junior AI Engineer', yoe_signal: '1 year', responsibility_scope: 'INDEPENDENT_FEATURE' } },
  experience: { overall_years_required: 1, overall_years_preferred: null, is_ambiguous: false, evidence_quotes: ['1 year of hands-on experience with Python'] },
  education: { min_degree_level: 'BACHELOR', fields_of_study: ['Computer Science'], equivalent_experience_allowed: true, min_gpa: null, gpa_scale: null, evidence_quote: 'Bachelor degree in Computer Science.' },
  work_model: { type: 'HYBRID', allowed_jurisdictions: [], hybrid_days_in_office: null, timezone_restrictions: [], evidence_quote: 'Hybrid work model.' },
  domain: { primary_vertical: 'Technology', technical_domain: 'Applied AI', architectural_style: 'MICROSERVICES' },
  requirements: [
    { description: '1 year of hands-on experience with Python', type: 'YEARS_EXPERIENCE', importance: 'REQUIRED', min_years: 1, verbatim_quote: '1 year of hands-on experience with Python' },
    { description: 'Bachelor degree in Computer Science.', type: 'EDUCATION', importance: 'REQUIRED', min_years: null, verbatim_quote: 'Bachelor degree in Computer Science.' },
    { description: 'Python', type: 'TECHNICAL_SKILL', importance: 'REQUIRED', min_years: null, verbatim_quote: 'Python' }
  ],
  confidence: 0.95
};

const MOCK_JD = [
  'Junior AI Engineer. Requirements:',
  '- 1 year of hands-on experience with Python',
  '- Bachelor degree in Computer Science.',
  '- Hybrid work model.'
].join('\n');

test('the Phase-2 schemas are present and declare no unexpected-property escape hatch', () => {
  const mention = getSchema('SkillMention');
  const intelligence = getSchema('JobSkillIntelligence');
  assert.equal(mention.additionalProperties, false);
  assert.equal(intelligence.additionalProperties, false);
  assert.equal(intelligence.schema_version, SEMANTIC_SCHEMA_VERSION);
  assert.ok(Object.keys(mention.properties).includes('evidence_span'));
  assert.ok(Object.keys(intelligence.properties).includes('mentions'));
  assert.ok(Object.keys(intelligence.properties).includes('concepts'));
  assert.ok(Object.keys(intelligence.properties).includes('unresolved_surfaces'));
});

test('JobSkillIntelligence factory is fail-safe and never fabricates a positive value', () => {
  const entity = createJobSkillIntelligence({
    job_id: 'j1',
    jd_hash: computeSourceHash('x'),
    model_metadata: { model_id: 'm', prompt_version: 'p', task_version: 't', schema_version: SEMANTIC_SCHEMA_VERSION }
  });
  assert.deepEqual(entity.mentions, []);
  assert.deepEqual(entity.concepts, []);
  assert.deepEqual(entity.unresolved_surfaces, []);
  assert.equal(entity.diagnostics.failure_code, null);
  assert.equal(entity.diagnostics.failure_stage, null);
  assert.equal(entity.telemetry.model_calls, 0);
  assert.equal(entity.telemetry.normalization_model_calls, 0);
  assert.equal(entity.telemetry.semantic_resolution_skipped, false);
  assert.equal(validateJobSkillIntelligence(entity).valid, true);
  assert.equal(assertValidJobSkillIntelligence(entity), undefined);
});

test('JobSkillIntelligence schema rejects malformed envelopes', () => {
  const base = {
    job_id: 'j1',
    jd_hash: computeSourceHash('x'),
    mentions: [],
    concepts: [],
    unresolved_surfaces: [],
    diagnostics: { rejected_mentions: [] },
    model_metadata: { model_id: 'm', prompt_version: 'p', task_version: 't', schema_version: SEMANTIC_SCHEMA_VERSION }
  };
  assert.equal(validateJobSkillIntelligence(base).valid, true);
  assert.equal(validateJobSkillIntelligence({ ...base, job_id: undefined }).valid, false);
  assert.equal(validateJobSkillIntelligence({ ...base, jd_hash: 'not-a-hash' }).valid, false);
  assert.equal(validateJobSkillIntelligence({ ...base, surprise: 1 }).valid, false);
  assert.equal(validateJobSkillIntelligence({ ...base, diagnostics: {} }).valid, false, 'rejected_mentions is required');
});

test('SkillMention schema rejects an unknown property and an unknown resolution state', () => {
  const good = createSkillMention({
    mention_id: 'm1',
    surface_form: 'k8s',
    normalized_surface: 'k8s',
    category: 'INFRASTRUCTURE',
    evidence_span: { start_char: 0, end_char: 3, verbatim_quote: 'k8s' },
    evidence_role: 'JOB_CONTENT',
    resolution: { state: 'RESOLVED', concept_id: 'kubernetes', canonical_name: 'Kubernetes', method: 'SEMANTIC_RESOLUTION', confidence: 1 }
  });
  assert.equal(validateSkillMention(good).valid, true);
  assert.equal(validateSkillMention({ ...good, extra: true }).valid, false);
  assert.equal(validateSkillMention({ ...good, resolution: { ...good.resolution, state: 'MAYBE' } }).valid, false);
  assert.equal(validateSkillMention({ ...good, category: 'MAGIC' }).valid, false);
});

test('resolution state and method vocabularies are closed', () => {
  assert.deepEqual([...SKILL_RESOLUTION_STATES], ['RESOLVED', 'NEW_CONCEPT', 'AMBIGUOUS', 'UNRESOLVED']);
  assert.deepEqual([...SKILL_RESOLUTION_METHODS], ['EXACT_CANONICAL', 'DETERMINISTIC_NEW_CONCEPT', 'SEMANTIC_RESOLUTION', 'NONE']);
  assert.deepEqual([...SKILL_RETRIEVAL_METHODS], ['NORMALIZED_TOKEN_OVERLAP', 'SUBSTRING', 'TRIGRAM', 'INITIALISM', 'CATEGORY_BACKFILL', 'EMBEDDING']);
});

test('an extended SkillConcept stays valid and defaults are non-positive', () => {
  const concept = createSkillConcept({ concept_id: 'x', canonical_name: 'X', category: 'TOOL', surface_forms: ['X'] });
  assert.equal(concept.aliases, undefined, 'no alias field on SkillConcept');
  assert.equal(concept.is_registered, false);
  assert.equal(concept.normalization_version, null);
  assert.equal(concept.registry_version, null);
  assert.equal(validateSkillConcept(concept).valid, true);

  const registered = createSkillConcept({
    concept_id: 'java',
    canonical_name: 'Java',
    category: 'LANGUAGE',
    surface_forms: ['Java'],
    is_registered: true,
    normalization_version: 'nv',
    registry_version: 'rv'
  });
  assert.equal(validateSkillConcept(registered).valid, true);
  assert.equal(registered.is_registered, true);
});

test('the Phase-2 failure codes are registered and semantic uncertainty is classified separately', () => {
  for (const code of ['AMBIGUOUS_SKILL', 'NORMALIZATION_UNRESOLVED', 'CONCEPT_REGISTRY_ERROR', 'CONCEPT_ID_COLLISION', 'CONCEPT_ALIAS_CONFLICT', 'NORMALIZATION_DECISION_REJECTED']) {
    assert.ok(SEMANTIC_FAILURE_CODES.includes(code), `missing failure code ${code}`);
  }
  assert.equal(isSemanticUncertaintyCode('AMBIGUOUS_SKILL'), true);
  assert.equal(isSemanticUncertaintyCode('NORMALIZATION_UNRESOLVED'), true);
  assert.equal(isSemanticUncertaintyCode('INSUFFICIENT_EVIDENCE'), true);
  // Engineering faults are NOT semantic uncertainty.
  assert.equal(isSemanticUncertaintyCode('SCHEMA_VALIDATION_FAILED'), false);
  assert.equal(isSemanticUncertaintyCode('CONCEPT_ID_COLLISION'), false);
  assert.equal(isSemanticUncertaintyCode('MODEL_TIMEOUT'), false);
  assert.equal(isSemanticUncertaintyCode('PROVENANCE_VALIDATION_FAILED'), false);

  const err = new SemanticProfilerError('CONCEPT_ID_COLLISION', 'boom');
  assert.equal(err.code, 'CONCEPT_ID_COLLISION');
  assert.match(err.message, /^\[CONCEPT_ID_COLLISION\]/);
});

test('version identifiers are tracked and distinct per component', () => {
  assert.equal(PROMPT_VERSION, 'v1.2.0-phase1');
  assert.match(SKILL_PROMPT_VERSION, /^v1\.2\.0-phase2/);
  assert.match(SKILL_TASK_VERSION, /^v1\.2\.0-phase2/);
  assert.match(NORMALIZATION_TASK_VERSION, /^v1\.2\.0-phase2/);
  assert.match(NORMALIZATION_PROMPT_VERSION, /^v1\.2\.0-phase2/);
  assert.equal(registry.schema_version, SEMANTIC_SCHEMA_VERSION);
  assert.notEqual(registry.registry_version, registry.schema_version);
});

test('Phase-1 profileJobSemantic still produces a valid Phase-1 profile and no skill payload', async () => {
  const result = await profileJobSemantic({ jdText: MOCK_JD, title: 'Junior AI Engineer', company: 'Acme', jobId: 'j1' }, { mockResponse: MOCK_PROFILE });
  assert.equal(result.profile.role_family, 'ai_ml');
  assert.equal(result.profile.seniority.level, 'JUNIOR');
  assert.equal(result.profile.overall_yoe_required, 1);
  assert.equal(result.profile.education.min_degree_level, 'BACHELOR');
  assert.equal(result.profile.work_model.type, 'HYBRID');
  assert.equal(result.profile.seniority.is_early_career_friendly, true);
  assert.equal(result.profile.model_metadata.prompt_version, PROMPT_VERSION);
  assert.equal(result.skill_intelligence, undefined, 'the Phase-1 path must not gain a Phase-2 payload');
  assert.equal(result.telemetry.gateway_calls, 0);
});

test('Phase-1 semantic engine is unaffected by the Phase-2 modules', async () => {
  const engine = new SemanticEngine({ mockResponse: MOCK_PROFILE });
  const result = await engine.evaluate({
    sample: { sample_id: 'j1', raw_jd_text: MOCK_JD, metadata: { raw_title: 'Junior AI Engineer', company: 'Acme' } },
    candidateFacts: { professional_years: 1, degrees: ['BSc Computer Science'] },
    candidateProfile: {}
  });
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.job_profile.role_family, 'ai_ml');
  assert.equal(result.semantic_diagnostics.fit_status, 'STRONG');
  assert.equal(result.semantic_diagnostics.gateway_calls, 0);
});

test('Phase-1 shadow evaluation still routes through authoritative legacy and reports telemetry', async () => {
  const result = await runShadowEvaluation({
    sample: { sample_id: 'j1', raw_jd_text: MOCK_JD, metadata: { raw_title: 'Junior AI Engineer', company: 'Acme' } },
    candidateFacts: { professional_years: 1 },
    candidateProfile: { features: { semantic_job_profile: 'shadow' } },
    options: { mockResponse: MOCK_PROFILE }
  });
  assert.equal(result.shadow_executed, true);
  assert.ok(result.production_result);
  assert.ok(result.telemetry);
  assert.equal(result.telemetry.component, 'semantic_job_profile_shadow');
});

test('a Phase-2 run makes exactly one extraction call and at most one normalization call', async () => {
  const sink = { calls: 0, systemPrompts: [] };
  const gateway = async ({ systemPrompt }) => {
    sink.calls++;
    sink.systemPrompts.push(systemPrompt);
    if (sink.calls === 1) return { content: JSON.stringify(MOCK_PROFILE) };
    return { content: JSON.stringify({ decisions: [] }) };
  };

  const result = await profileJobWithSkillIntelligence(
    { jdText: MOCK_JD, title: 'Junior AI Engineer', company: 'Acme', jobId: 'j1' },
    { gateway, semanticResolver: async () => JSON.stringify({ decisions: [] }) }
  );

  assert.equal(sink.calls, 1, 'the normalization resolver was injected, so the gateway saw one call');
  assert.equal(result.telemetry.gateway_calls, 1);
  assert.equal(result.telemetry.normalization_model_calls, 0, 'every mention resolved deterministically');
  assert.equal(result.telemetry.semantic_resolution_skipped, false);
  assert.ok(sink.systemPrompts[0].includes('SKILL EXTRACTION'));
});

test('normalization cache telemetry is surfaced on the entity', async () => {
  const cache = createNormalizationCache();
  const jd = 'Experience with the ACP Runtime Framework.';
  const parsed = { skills: [{ surface_form: 'ACP Runtime Framework', category: 'FRAMEWORK', verbatim_quote: 'ACP Runtime Framework', evidence_role: 'JOB_CONTENT' }] };

  const once = async () => {
    const { candidates, rejected_mentions } = buildSkillMentionCandidates({ parsed, rawJdText: jd, jobId: 'j1' });
    return buildJobSkillIntelligence({
      candidates,
      rejected_mentions,
      rawJdText: jd,
      jobId: 'j1',
      registry,
      semanticResolver: async () => JSON.stringify({ decisions: [] }),
      cache
    });
  };

  const first = await once();
  assert.equal(first.skill_intelligence.telemetry.cache_hits, 0);
  assert.equal(first.skill_intelligence.telemetry.cache_misses, 1);
  // Nothing was cached, because the "response" carried no decision for the
  // mention: a rejected or absent decision must never become a cached answer.
  assert.equal(cache.size(), 0);
  assert.equal(first.skill_intelligence.diagnostics.rejected_normalization_decisions.length, 1);
});

test('no Phase-2 skill module imports a provider or gateway, so tests cannot reach a live model', () => {
  // Static, not behavioural: a behavioural test can only prove the paths it
  // exercises make no call. This proves no Phase-2 module CAN, by inspecting
  // what each one imports.
  const modules = [
    'src/agent/domain/semantic/skill-concept-registry.mjs',
    'src/agent/domain/semantic/skill-normalization.mjs',
    'src/agent/domain/semantic/skill-intelligence.mjs',
    'src/agent/domain/semantic/skill-shadow.mjs',
    'src/agent/domain/semantic/semantic-errors.mjs'
  ];
  for (const rel of modules) {
    const source = readFileSync(join(ROOT, rel), 'utf8');
    const importLines = source.split('\n').filter((l) => /^\s*import\s|^\s*export\s+.*from\s/.test(l));
    for (const line of importLines) {
      assert.ok(!/provider-runner|zero-cost-router|openai-eval|gemini-eval|ollama-eval/.test(line),
        `${rel} imports a live provider: ${line.trim()}`);
    }
  }
  // The profiler MAY import the gateway, but it is only reachable through an
  // injected function or an explicit gateway build, which tests always supply.
  const profiler = readFileSync(join(ROOT, 'src/agent/domain/semantic/job-semantic-profiler.mjs'), 'utf8');
  assert.ok(profiler.includes('options.gateway'));
  assert.ok(/mockResponse/.test(profiler));
});