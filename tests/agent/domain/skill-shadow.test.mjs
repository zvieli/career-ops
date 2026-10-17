// @ts-check
//
// Phase-2 shadow execution.
//
// The invariant under test: legacy lexical skill extraction stays
// production-authoritative in every mode, Phase-2 disagreement telemetry can
// never alter a decision, and a semantic failure is non-destructive.
// Candidate data never influences job skill extraction or normalization.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SKILL_DISAGREEMENT_TYPES,
  semanticSkillIntelligenceMode,
  isSemanticSkillIntelligenceEnabled,
  readLegacySkills,
  compareSkillExtraction,
  buildSkillShadowTelemetry,
  runSkillShadowEvaluation,
  runSkillShadowHook,
  TELEMETRY_QUOTE_LIMIT
} from '../../../src/agent/domain/semantic/skill-shadow.mjs';
import { createJobSkillIntelligence, SEMANTIC_SCHEMA_VERSION } from '../../../src/agent/domain/semantic/semantic-entities.mjs';
import { buildSkillMentionCandidates, buildJobSkillIntelligence } from '../../../src/agent/domain/semantic/skill-intelligence.mjs';
import { getDefaultSkillConceptRegistry } from '../../../src/agent/domain/semantic/skill-concept-registry.mjs';
import { computeSourceHash } from '../../../src/agent/domain/semantic/provenance-validator.mjs';

const registry = getDefaultSkillConceptRegistry();

const JD = [
  'We build services in Python and FastAPI.',
  'Requirements:',
  '- 3+ years of experience with Python',
  '- Experience with k8s and Postgres'
].join('\n');

const MOCK_EXTRACTION = {
  skills: [
    { surface_form: 'Python', category: 'LANGUAGE', verbatim_quote: 'Python', evidence_role: 'JOB_CONTENT' },
    { surface_form: 'FastAPI', category: 'FRAMEWORK', verbatim_quote: 'FastAPI', evidence_role: 'JOB_CONTENT' },
    { surface_form: 'k8s', category: 'INFRASTRUCTURE', verbatim_quote: 'k8s', evidence_role: 'JOB_CONTENT' },
    { surface_form: 'Postgres', category: 'DATABASE', verbatim_quote: 'Postgres', evidence_role: 'JOB_CONTENT' }
  ]
};

test('the feature flag is separate from the Phase-1 flag and defaults to off', () => {
  assert.equal(SKILL_DISAGREEMENT_TYPES.length, 8);
  assert.equal(semanticSkillIntelligenceMode({}), 'off');
  assert.equal(semanticSkillIntelligenceMode({ features: {} }), 'off');
  assert.equal(semanticSkillIntelligenceMode({ features: { semantic_skill_intelligence: 'shadow' } }), 'shadow');
  assert.equal(semanticSkillIntelligenceMode({ features: { semantic_skill_intelligence: true } }), 'shadow');
  assert.equal(semanticSkillIntelligenceMode({ features: { semantic_skill_intelligence: false } }), 'off');
  // Turning on the Phase-1 flag must NOT silently turn on the Phase-2 one.
  assert.equal(semanticSkillIntelligenceMode({ features: { semantic_job_profile: 'shadow' } }), 'off');
  assert.equal(isSemanticSkillIntelligenceEnabled({ features: { semantic_skill_intelligence: 'shadow' } }), true);
});

test('shadow OFF runs legacy only and reports no semantic work', async () => {
  const result = await runSkillShadowEvaluation({ sample: { sample_id: 'j1', raw_jd_text: JD } });
  assert.equal(result.shadow_executed, false);
  assert.equal(result.skill_intelligence, null);
  assert.equal(result.telemetry, null);
  assert.ok(Array.isArray(result.legacy_skills.canonical));
  assert.ok(result.legacy_skills.canonical.length > 0, 'legacy extraction still ran');
});

test('shadow ON executes and returns BOTH the authoritative legacy set and the semantic view', async () => {
  const result = await runSkillShadowEvaluation({
    sample: { sample_id: 'j1', raw_jd_text: JD },
    config: { features: { semantic_skill_intelligence: 'shadow' } },
    options: { skillExtraction: MOCK_EXTRACTION, enableSemanticResolution: false }
  });
  assert.equal(result.shadow_executed, true);
  assert.ok(result.legacy_skills.canonical.includes('Python'));
  assert.ok(result.legacy_skills.canonical.includes('Kubernetes'), 'legacy canonical names are still authoritative');
  assert.deepEqual(
    result.skill_intelligence.concepts.map((c) => c.concept_id).sort(),
    ['fastapi', 'python']
  );
  assert.equal(result.telemetry.component, 'semantic_skill_intelligence_shadow');
  assert.equal(result.telemetry.disagreement.recommended_routing, 'AUTHORITATIVE_LEGACY');
});

test('legacy authority is preserved: nothing production-facing is mutated', async () => {
  const sample = { sample_id: 'j1', raw_jd_text: JD, metadata: { company: 'Acme' } };
  const before = JSON.parse(JSON.stringify(sample));

  const result = await runSkillShadowEvaluation({
    sample,
    config: { features: { semantic_skill_intelligence: 'shadow' } },
    options: { skillExtraction: MOCK_EXTRACTION, enableSemanticResolution: false, forceShadow: true }
  });

  assert.deepEqual(sample, before, 'the shadow run must not mutate its input');
  assert.equal(result.production_result, undefined, 'shadow mode never returns a production decision');
  assert.deepEqual(result.legacy_skills, readLegacySkills(JD));
});

test('changing candidate data has zero influence on job skill extraction and normalization', async () => {
  const runWithCandidate = async (candidateData) => {
    return runSkillShadowEvaluation({
      sample: { sample_id: 'j1', raw_jd_text: JD },
      config: { features: { semantic_skill_intelligence: 'shadow' } },
      candidateProfile: candidateData,
      options: { skillExtraction: MOCK_EXTRACTION, enableSemanticResolution: false, forceShadow: true }
    });
  };

  const res1 = await runWithCandidate({ name: 'Alice', yoe: 10, skills: ['Python', 'Kubernetes'], clearance: true });
  const res2 = await runWithCandidate({ name: 'Bob', yoe: 0, skills: ['Ruby', 'PHP'], clearance: false });

  assert.deepEqual(
    res1.skill_intelligence.concepts.map((c) => c.concept_id).sort(),
    res2.skill_intelligence.concepts.map((c) => c.concept_id).sort(),
    'candidate facts must not change extracted job concepts'
  );
  assert.deepEqual(
    res1.skill_intelligence.mentions.map((m) => m.surface_form),
    res2.skill_intelligence.mentions.map((m) => m.surface_form),
    'candidate facts must not change job mentions'
  );
});

test('a legacy skill the semantic layer missed is reported, not silently dropped', () => {
  const legacySkills = { raw: ['Terraform'], canonical: ['Terraform'] };
  const skillIntelligence = createJobSkillIntelligence({
    job_id: 'j1',
    jd_hash: computeSourceHash(JD),
    mentions: [],
    concepts: [],
    unresolved_surfaces: [],
    diagnostics: { rejected_mentions: [] },
    model_metadata: { model_id: 'm', prompt_version: 'p', task_version: 't', schema_version: SEMANTIC_SCHEMA_VERSION }
  });
  const comparison = compareSkillExtraction({ legacySkills, skillIntelligence, registry });
  assert.ok(comparison.disagreements.includes('LEGACY_SKILL_MISSED'));
  assert.deepEqual(comparison.details.legacy_skills_missed, ['Terraform']);
});

test('a semantic-only concept is reported as extra', async () => {
  const built = await buildJobSkillIntelligence({
    ...buildSkillMentionCandidates({ parsed: MOCK_EXTRACTION, rawJdText: JD, jobId: 'j1' }),
    rawJdText: JD,
    jobId: 'j1',
    registry,
    options: { enableSemanticResolution: false }
  });
  const comparison = compareSkillExtraction({
    legacySkills: { raw: [], canonical: [] },
    skillIntelligence: built.skill_intelligence,
    registry
  });
  assert.ok(comparison.disagreements.includes('SEMANTIC_SKILL_EXTRA'));
  assert.ok(comparison.details.semantic_skills_extra.length >= 2);
});

test('a concept fed by multiple distinct legacy names raises POSSIBLE_FALSE_MERGE', () => {
  const spanFor = (quote, start) => ({ start_char: start, end_char: start + quote.length, verbatim_quote: quote });
  const skillIntelligence = createJobSkillIntelligence({
    job_id: 'j1',
    jd_hash: computeSourceHash('Java and JavaScript'),
    mentions: [
      {
        mention_id: 'm1',
        surface_form: 'Java',
        normalized_surface: 'java',
        category: 'LANGUAGE',
        evidence_span: spanFor('Java', 0),
        evidence_role: 'JOB_CONTENT',
        resolution: { state: 'RESOLVED', concept_id: 'java', canonical_name: 'Java', method: 'EXACT_CANONICAL', confidence: 1 },
        confidence: 0.9
      },
      {
        mention_id: 'm2',
        surface_form: 'JavaScript',
        normalized_surface: 'javascript',
        category: 'LANGUAGE',
        evidence_span: spanFor('JavaScript', 9),
        evidence_role: 'JOB_CONTENT',
        resolution: { state: 'RESOLVED', concept_id: 'java', canonical_name: 'Java', method: 'SEMANTIC_RESOLUTION', confidence: 0.9 },
        confidence: 0.9
      }
    ],
    concepts: [{
      concept_id: 'java',
      canonical_name: 'Java',
      category: 'LANGUAGE',
      surface_forms: ['Java', 'JavaScript'],
      is_registered: true,
      normalization_version: registry.normalization_version,
      registry_version: registry.registry_version
    }],
    unresolved_surfaces: [],
    diagnostics: { rejected_mentions: [] },
    model_metadata: { model_id: 'm', prompt_version: 'p', task_version: 't', schema_version: SEMANTIC_SCHEMA_VERSION }
  });

  const comparison = compareSkillExtraction({ legacySkills: { raw: ['Java', 'JavaScript'], canonical: ['Java', 'JavaScript'] }, skillIntelligence, registry });
  assert.ok(comparison.disagreements.includes('POSSIBLE_FALSE_MERGE'), 'false merge must be flagged');
  assert.equal(comparison.has_disagreement, true);
});

test('nested canonical labels raise POSSIBLE_FALSE_SPLIT for review', () => {
  const concepts = [
    { concept_id: 'react', canonical_name: 'React', category: 'FRAMEWORK', surface_forms: ['React'], is_registered: true, normalization_version: 'nv', registry_version: 'rv' },
    { concept_id: 'react-server-components', canonical_name: 'React Server Components', category: 'FRAMEWORK', surface_forms: ['React Server Components'], is_registered: false, normalization_version: 'nv', registry_version: 'rv' }
  ];
  const skillIntelligence = createJobSkillIntelligence({
    job_id: 'j1',
    jd_hash: computeSourceHash('React'),
    mentions: [],
    concepts,
    unresolved_surfaces: [],
    diagnostics: { rejected_mentions: [] },
    model_metadata: { model_id: 'm', prompt_version: 'p', task_version: 't', schema_version: SEMANTIC_SCHEMA_VERSION }
  });
  const comparison = compareSkillExtraction({ legacySkills: { raw: [], canonical: [] }, skillIntelligence, registry });
  assert.ok(comparison.disagreements.includes('POSSIBLE_FALSE_SPLIT'));
});

test('provenance failures, ambiguity and engineering faults are classified distinctly', () => {
  const base = {
    job_id: 'j1',
    jd_hash: computeSourceHash('x'),
    mentions: [],
    concepts: [],
    model_metadata: { model_id: 'm', prompt_version: 'p', task_version: 't', schema_version: SEMANTIC_SCHEMA_VERSION }
  };

  const provenance = compareSkillExtraction({
    legacySkills: { raw: [], canonical: [] },
    skillIntelligence: createJobSkillIntelligence({
      ...base,
      unresolved_surfaces: [],
      diagnostics: { rejected_mentions: [{ surface_form: 'Ghost', reason: 'QUOTE_NOT_FOUND_IN_SOURCE' }] }
    }),
    registry
  });
  assert.ok(provenance.disagreements.includes('PROVENANCE_FAILURE'));

  const ambiguous = compareSkillExtraction({
    legacySkills: { raw: [], canonical: [] },
    skillIntelligence: createJobSkillIntelligence({
      ...base,
      unresolved_surfaces: ['Go'],
      diagnostics: { rejected_mentions: [] }
    }),
    registry
  });
  assert.ok(ambiguous.disagreements.includes('AMBIGUOUS_SKILL'));
  assert.ok(!ambiguous.disagreements.includes('SEMANTIC_ENGINE_FAILURE'), 'an honest abstention is not an engineering fault');

  const engineering = compareSkillExtraction({
    legacySkills: { raw: [], canonical: [] },
    skillIntelligence: createJobSkillIntelligence({
      ...base,
      unresolved_surfaces: [],
      diagnostics: { rejected_mentions: [], failure_code: 'INVALID_STRUCTURED_OUTPUT', failure_stage: 'NORMALIZATION' }
    }),
    registry
  });
  assert.ok(engineering.disagreements.includes('SEMANTIC_ENGINE_FAILURE'));
  assert.equal(engineering.details.failure_is_engineering_fault, true);

  const semanticUncertainty = compareSkillExtraction({
    legacySkills: { raw: [], canonical: [] },
    skillIntelligence: createJobSkillIntelligence({
      ...base,
      unresolved_surfaces: [],
      diagnostics: { rejected_mentions: [], failure_code: 'NORMALIZATION_UNRESOLVED', failure_stage: 'NORMALIZATION' }
    }),
    registry
  });
  assert.ok(!semanticUncertainty.disagreements.includes('SEMANTIC_ENGINE_FAILURE'));
  assert.equal(semanticUncertainty.details.failure_is_engineering_fault, false);

  const noIntelligence = compareSkillExtraction({ legacySkills: { raw: [], canonical: [] }, skillIntelligence: null, registry });
  assert.ok(noIntelligence.disagreements.includes('SEMANTIC_ENGINE_FAILURE'));
});

test('a semantic engine failure is non-destructive: legacy output is still returned', async () => {
  const result = await runSkillShadowEvaluation({
    sample: { sample_id: 'j1', raw_jd_text: JD },
    config: { features: { semantic_skill_intelligence: 'shadow' } },
    options: { mockResponse: 'this is not json' }
  });
  assert.equal(result.shadow_executed, true);
  assert.equal(result.skill_intelligence, null);
  assert.ok(result.legacy_skills.canonical.includes('Python'), 'legacy result survives the semantic failure');
  assert.ok(result.telemetry.disagreement.types.includes('SEMANTIC_ENGINE_FAILURE'));
  assert.equal(result.telemetry.disagreement.recommended_routing, 'AUTHORITATIVE_LEGACY');
});

test('telemetry carries no candidate PII and clips long evidence quotes', () => {
  const longQuote = 'A'.repeat(400);
  const skillIntelligence = createJobSkillIntelligence({
    job_id: 'j1',
    jd_hash: computeSourceHash(longQuote),
    mentions: [{
      mention_id: 'm1',
      surface_form: longQuote,
      normalized_surface: 'a',
      category: 'TOOL',
      evidence_span: { start_char: 0, end_char: 400, verbatim_quote: longQuote },
      evidence_role: 'JOB_CONTENT',
      resolution: { state: 'UNRESOLVED', concept_id: null, method: 'NONE', confidence: null },
      confidence: null
    }],
    concepts: [],
    unresolved_surfaces: [longQuote],
    diagnostics: { rejected_mentions: [] },
    registry_version: registry.registry_version,
    normalization_version: registry.normalization_version,
    model_metadata: { model_id: 'm', prompt_version: 'p', task_version: 't', schema_version: SEMANTIC_SCHEMA_VERSION }
  });
  const comparison = { has_disagreement: false, disagreements: [], details: { legacy_skills: [] } };
  const telemetry = buildSkillShadowTelemetry({ jobId: 'j1', comparison, skillIntelligence, modelCalls: 2, latencyMs: 12 });

  assert.equal(telemetry.semantic.mentions[0].evidence_quote.length, TELEMETRY_QUOTE_LIMIT);
  assert.equal(telemetry.semantic.mentions[0].evidence_start, 0);

  const serialized = JSON.stringify(telemetry);
  for (const forbidden of ['email', 'phone', 'full_name', 'first_name', 'last_name', 'linkedin', 'address', 'candidate_id', 'resume', 'cv_text']) {
    assert.ok(!serialized.includes(forbidden), `telemetry leaked ${forbidden}`);
  }
  assert.ok(telemetry.metadata.registry_version);
  assert.ok(telemetry.metadata.normalization_version);
  assert.equal(telemetry.metadata.model_calls, 2);
  assert.equal(telemetry.metadata.failure_is_engineering_fault, false);
});

test('the live-path hook is a no-op when the flag is off and never throws when on', async () => {
  const off = await runSkillShadowHook({ job: { jobId: 'j1', jdText: JD } });
  assert.deepEqual(off, { shadow_executed: false });

  const on = await runSkillShadowHook({
    job: { jobId: 'j1', jdText: JD, title: 'SWE', company: 'Acme' },
    config: { features: { semantic_skill_intelligence: 'shadow' } },
    options: { skillExtraction: MOCK_EXTRACTION, enableSemanticResolution: false }
  });
  assert.equal(on.shadow_executed, true);
  assert.ok(on.telemetry);

  const crashed = await runSkillShadowHook({
    job: { jobId: 'j1', jdText: JD },
    config: { features: { semantic_skill_intelligence: 'shadow' } },
    options: { mockResponse: 'not json' }
  });
  assert.equal(crashed.shadow_executed, true);
  assert.ok(crashed.telemetry);
});
