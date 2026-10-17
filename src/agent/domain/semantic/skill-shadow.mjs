// @ts-check
/**
 * skill-shadow.mjs — Phase 2 Skill Intelligence Shadow Execution
 *
 * Runs Phase-2 skill extraction + normalization ALONGSIDE the legacy lexical
 * skill extractor and reports the differences. In every mode:
 *
 *   LEGACY REMAINS PRODUCTION-AUTHORITATIVE.
 *
 * Nothing in this module can change a fit decision, a tracker row, a score, or
 * any other production state. Its entire output is a comparison and a
 * PII-free telemetry record. Even a hard disagreement only ever recommends a
 * routing label; it never applies one.
 *
 * Feature flag (deliberately separate from the Phase-1 flag so rollout of the
 * two components is independently controllable):
 *
 *   features.semantic_skill_intelligence: false | "shadow" | true
 *     false / absent -> legacy only
 *     "shadow" / true -> legacy authoritative + semantic comparison + telemetry
 *
 * Configuration is strictly separated from candidate data: candidate facts
 * never influence job semantic skill extraction or normalization.
 */

import { extractSkills, canonicalize } from '../../../../skill-extract.mjs';
import { extractJdSkills } from '../../../../jd-skill-gap.mjs';
import {
  getDefaultSkillConceptRegistry,
  normalizeSkillSurface
} from './skill-concept-registry.mjs';
import {
  buildSkillMentionCandidates,
  buildJobSkillIntelligence,
  SKILL_PROMPT_VERSION
} from './skill-intelligence.mjs';
import {
  NORMALIZATION_PROMPT_VERSION,
  NORMALIZATION_TASK_VERSION
} from './skill-normalization.mjs';
import { isSemanticUncertaintyCode } from './semantic-errors.mjs';
import { SEMANTIC_SCHEMA_VERSION } from './semantic-entities.mjs';
import { profileJobWithSkillIntelligence } from './job-semantic-profiler.mjs';

export const SKILL_DISAGREEMENT_TYPES = Object.freeze([
  'LEGACY_SKILL_MISSED',
  'SEMANTIC_SKILL_EXTRA',
  'NORMALIZATION_DISAGREEMENT',
  'POSSIBLE_FALSE_MERGE',
  'POSSIBLE_FALSE_SPLIT',
  'PROVENANCE_FAILURE',
  'AMBIGUOUS_SKILL',
  'SEMANTIC_ENGINE_FAILURE'
]);

/** Longest JD evidence quote kept in telemetry. */
export const TELEMETRY_QUOTE_LIMIT = 80;

/**
 * Is Phase-2 skill intelligence enabled, and in which mode?
 * Configuration is read from runtime/feature configuration, NEVER candidate data.
 * @param {object} [config={}]
 * @returns {'off'|'shadow'}
 */
export function semanticSkillIntelligenceMode(config = {}) {
  const flag = config?.features?.semantic_skill_intelligence ??
    config?.semantic_skill_intelligence ??
    process.env.SEMANTIC_SKILL_INTELLIGENCE;
  if (flag === true || flag === 'shadow' || flag === 'true') return 'shadow';
  return 'off';
}

/**
 * Backwards-compatible boolean helper.
 * @param {object} [config={}]
 * @returns {boolean}
 */
export function isSemanticSkillIntelligenceEnabled(config = {}) {
  return semanticSkillIntelligenceMode(config) === 'shadow';
}

/**
 * Read the authoritative legacy skill set for a JD. Read-only.
 * @param {string} rawJdText
 * @returns {{ raw: string[], canonical: string[] }}
 */
export function readLegacySkills(rawJdText) {
  const raw = Array.from(new Set([...extractSkills(rawJdText || ''), ...extractJdSkills(rawJdText || '')]));
  const canonical = Array.from(new Set(raw.map((s) => canonicalize(s))));
  return { raw, canonical };
}

/**
 * Compare semantic skill intelligence against legacy lexical skill output.
 *
 * @param {object} params
 * @param {{ raw: string[], canonical: string[] }} params.legacySkills
 * @param {object} params.skillIntelligence - JobSkillIntelligence
 * @param {object} [params.registry]
 * @returns {{ has_disagreement: boolean, disagreements: string[], details: object }}
 */
export function compareSkillExtraction({ legacySkills, skillIntelligence, registry = getDefaultSkillConceptRegistry() }) {
  const disagreements = new Set();
  const details = {
    legacy_skills: legacySkills?.canonical || [],
    legacy_skills_missed: [],
    semantic_skills_extra: [],
    normalization_disagreements: [],
    possible_false_merges: [],
    possible_false_splits: [],
    rejected_mentions: [],
    unresolved_surfaces: [],
    rejected_normalization_decisions: [],
    failure_code: null,
    failure_is_engineering_fault: false
  };

  if (!skillIntelligence) {
    disagreements.add('SEMANTIC_ENGINE_FAILURE');
    details.failure_code = 'NO_SKILL_INTELLIGENCE';
    details.failure_is_engineering_fault = true;
    return { has_disagreement: true, disagreements: [...disagreements], details };
  }

  const mentions = skillIntelligence.mentions || [];
  const concepts = skillIntelligence.concepts || [];
  const diagnostics = skillIntelligence.diagnostics || {};

  // ── failure and ambiguity surfacing ──────────────────────────────────────
  if (Array.isArray(diagnostics.rejected_mentions)) {
    for (const r of diagnostics.rejected_mentions) {
      details.rejected_mentions.push({ surface_form: r.surface_form, reason: r.reason });
    }
    if (details.rejected_mentions.length > 0) disagreements.add('PROVENANCE_FAILURE');
  }
  if (Array.isArray(diagnostics.rejected_normalization_decisions) && diagnostics.rejected_normalization_decisions.length > 0) {
    details.rejected_normalization_decisions = diagnostics.rejected_normalization_decisions.map((r) => ({ ...r }));
  }
  if (Array.isArray(skillIntelligence.unresolved_surfaces) && skillIntelligence.unresolved_surfaces.length > 0) {
    details.unresolved_surfaces = [...skillIntelligence.unresolved_surfaces];
    disagreements.add('AMBIGUOUS_SKILL');
  }
  if (diagnostics.failure_code) {
    details.failure_code = diagnostics.failure_code;
    details.failure_is_engineering_fault = !isSemanticUncertaintyCode(diagnostics.failure_code);
    if (details.failure_is_engineering_fault) disagreements.add('SEMANTIC_ENGINE_FAILURE');
  }

  // ── legacy coverage ──────────────────────────────────────────────────────
  const semanticIdentitySet = new Set();
  for (const concept of concepts) {
    semanticIdentitySet.add(normalizeSkillSurface(concept.canonical_name));
    for (const s of concept.surface_forms || []) semanticIdentitySet.add(normalizeSkillSurface(s));
  }

  for (const legacyName of legacySkills?.canonical || []) {
    const key = normalizeSkillSurface(legacyName);
    if (key && !semanticIdentitySet.has(key)) {
      details.legacy_skills_missed.push(legacyName);
    }
  }
  if (details.legacy_skills_missed.length > 0) disagreements.add('LEGACY_SKILL_MISSED');

  const legacyKeySet = new Set((legacySkills?.canonical || []).map((s) => normalizeSkillSurface(s)));
  for (const concept of concepts) {
    const identities = [concept.canonical_name, ...(concept.surface_forms || [])]
      .map((s) => normalizeSkillSurface(s));
    if (identities.length > 0 && !identities.some((k) => legacyKeySet.has(k))) {
      details.semantic_skills_extra.push(concept.concept_id);
    }
  }
  if (details.semantic_skills_extra.length > 0) disagreements.add('SEMANTIC_SKILL_EXTRA');

  // ── per-concept legacy-name spread (false-merge signal) ──────────────────
  const legacyNamesByConcept = new Map();
  const conceptsByLegacyName = new Map();
  for (const mention of mentions) {
    const conceptId = mention.resolution?.concept_id;
    if (!conceptId) continue;
    const legacyName = canonicalize(mention.surface_form);
    const set = legacyNamesByConcept.get(conceptId) || new Set();
    set.add(legacyName);
    legacyNamesByConcept.set(conceptId, set);

    const key = normalizeSkillSurface(legacyName);
    const cs = conceptsByLegacyName.get(key) || new Set();
    cs.add(conceptId);
    conceptsByLegacyName.set(key, cs);

    const semanticConcept = concepts.find((c) => c.concept_id === conceptId);
    if (semanticConcept && normalizeSkillSurface(legacyName) !== normalizeSkillSurface(semanticConcept.canonical_name)) {
      details.normalization_disagreements.push({
        surface_form: mention.surface_form,
        legacy_canonical: legacyName,
        semantic_concept_id: conceptId,
        semantic_canonical: semanticConcept.canonical_name
      });
    }
  }
  if (details.normalization_disagreements.length > 0) disagreements.add('NORMALIZATION_DISAGREEMENT');

  // If semantic mapped multiple distinct legacy canonical names to one concept
  for (const [conceptId, names] of legacyNamesByConcept) {
    const keys = [...names].map((n) => normalizeSkillSurface(n));
    if (new Set(keys).size > 1) {
      const concept = concepts.find((c) => c.concept_id === conceptId);
      const conceptKey = normalizeSkillSurface(concept?.canonical_name || conceptId);
      const allFoldOntoConcept = keys.every((k) => k === conceptKey);
      if (!allFoldOntoConcept) {
        details.possible_false_merges.push({
          concept_id: conceptId,
          legacy_names: [...names],
          reason: 'SEMANTIC_CONCEPT_SPANS_MULTIPLE_LEGACY_DISTINCT_NAMES'
        });
      }
    }
  }
  if (details.possible_false_merges.length > 0) disagreements.add('POSSIBLE_FALSE_MERGE');

  // ── false-split heuristics (telemetry only) ──────────────────────────────
  for (let i = 0; i < concepts.length; i++) {
    for (let j = i + 1; j < concepts.length; j++) {
      const a = concepts[i];
      const b = concepts[j];
      if (a.concept_id === b.concept_id) continue;
      const ka = normalizeSkillSurface(a.canonical_name);
      const kb = normalizeSkillSurface(b.canonical_name);
      if (ka.length < 4 || kb.length < 4) continue;
      if (ka.includes(kb) || kb.includes(ka)) {
        details.possible_false_splits.push({
          concept_ids: [a.concept_id, b.concept_id],
          reason: 'NESTED_CANONICAL_LABELS'
        });
      }
    }
  }
  if (details.possible_false_splits.length > 0) disagreements.add('POSSIBLE_FALSE_SPLIT');

  return {
    has_disagreement: disagreements.size > 0,
    disagreements: [...disagreements],
    details
  };
}

/**
 * Build a PII-free telemetry record for a skill-intelligence shadow run.
 * @param {object} params
 * @returns {object}
 */
export function buildSkillShadowTelemetry({
  jobId,
  component = 'semantic_skill_intelligence_shadow',
  comparison,
  skillIntelligence,
  modelCalls = 0,
  latencyMs = 0
}) {
  const clippedQuote = (q) => (typeof q === 'string' ? q.slice(0, TELEMETRY_QUOTE_LIMIT) : '');
  return {
    timestamp: new Date().toISOString(),
    job_id: jobId,
    component,
    legacy_skills: comparison.details.legacy_skills,
    semantic: {
      mentions: (skillIntelligence?.mentions || []).map((m) => ({
        mention_id: m.mention_id,
        surface_form: m.surface_form,
        category: m.category,
        requirement_id: m.requirement_id,
        requirement_importance: m.requirement_importance,
        evidence_start: m.evidence_span?.start_char,
        evidence_end: m.evidence_span?.end_char,
        evidence_quote: clippedQuote(m.evidence_span?.verbatim_quote),
        resolution_state: m.resolution?.state,
        resolution_method: m.resolution?.method,
        concept_id: m.resolution?.concept_id || null
      })),
      concept_ids: (skillIntelligence?.concepts || []).map((c) => c.concept_id),
      concept_names: (skillIntelligence?.concepts || []).map((c) => c.canonical_name),
      unresolved_surfaces: skillIntelligence?.unresolved_surfaces || [],
      registered_concept_count: (skillIntelligence?.concepts || []).filter((c) => c.is_registered).length,
      run_local_concept_count: (skillIntelligence?.concepts || []).filter((c) => !c.is_registered).length
    },
    disagreement: {
      detected: comparison.has_disagreement,
      types: comparison.disagreements,
      details: comparison.details,
      recommended_routing: 'AUTHORITATIVE_LEGACY'
    },
    metadata: {
      task_version: NORMALIZATION_TASK_VERSION,
      prompt_version: SKILL_PROMPT_VERSION,
      normalization_prompt_version: NORMALIZATION_PROMPT_VERSION,
      schema_version: SEMANTIC_SCHEMA_VERSION,
      model_id: skillIntelligence?.model_metadata?.model_id || 'system1-default',
      registry_version: skillIntelligence?.registry_version || null,
      normalization_version: skillIntelligence?.normalization_version || null,
      model_calls: modelCalls,
      normalization_model_calls: skillIntelligence?.telemetry?.normalization_model_calls ?? 0,
      retries: skillIntelligence?.telemetry?.retries ?? 0,
      cache_hits: skillIntelligence?.telemetry?.cache_hits ?? 0,
      cache_misses: skillIntelligence?.telemetry?.cache_misses ?? 0,
      latency_ms: latencyMs,
      failure_code: comparison.details.failure_code || null,
      failure_is_engineering_fault: comparison.details.failure_is_engineering_fault === true
    }
  };
}

/**
 * Shadow-evaluate one job posting: legacy skill extraction (authoritative) plus
 * Phase-2 skill intelligence, compared and reported. Never mutates anything.
 *
 * @param {object} params
 * @param {{ sample_id?: string, raw_jd_text: string, metadata?: object }} params.sample
 * @param {object} [params.config={}] - Runtime configuration (never candidate data)
 * @param {object} [params.options={}]
 * @returns {Promise<{ legacy_skills: object, shadow_executed: boolean, skill_intelligence: object|null, telemetry: object|null }>}
 */
export async function runSkillShadowEvaluation({ sample, config = {}, options = {} }) {
  const started = Date.now();
  const rawJd = sample?.raw_jd_text || '';
  const jobId = sample?.sample_id || sample?.metadata?.job_id || 'unknown-job';

  // 1. Authoritative legacy extractor. Always runs.
  const legacySkills = readLegacySkills(rawJd);

  const enabled = isSemanticSkillIntelligenceEnabled(config) || options.forceShadow === true;
  if (!enabled) {
    return { legacy_skills: legacySkills, shadow_executed: false, skill_intelligence: null, telemetry: null };
  }

  // 2. Phase-2 semantic skill intelligence, shadow only.
  let skillIntelligence = null;
  let failureCode = null;
  let failureStage = null;
  let modelCalls = 0;
  const registry = options.registry || getDefaultSkillConceptRegistry();

  try {
    const parsedSkills = Array.isArray(options.skillExtraction?.skills) ? options.skillExtraction : null;
    if (parsedSkills) {
      const { candidates, rejected_mentions } = buildSkillMentionCandidates({
        parsed: parsedSkills,
        rawJdText: rawJd,
        jobId,
        requirements: options.requirements || [],
        strictProvenance: options.strictSkillProvenance === true
      });
      const built = await buildJobSkillIntelligence({
        candidates,
        rejected_mentions,
        rawJdText: rawJd,
        jobId,
        registry,
        semanticResolver: options.semanticResolver || null,
        cache: options.cache || null,
        options,
        extractionModelCalls: 0,
        modelId: options.modelId || 'system1-default'
      });
      skillIntelligence = built.skill_intelligence;
      modelCalls = built.telemetry.model_calls;
    } else {
      const profiled = await profileJobWithSkillIntelligence(
        {
          jdText: rawJd,
          title: sample?.metadata?.raw_title || sample?.metadata?.title || '',
          company: sample?.metadata?.company || '',
          jobId
        },
        {
          gateway: options.gateway,
          modelId: options.modelId,
          timeoutMs: options.timeoutMs,
          mockResponse: options.mockResponse,
          mockSkillResponse: options.mockSkillResponse,
          semanticResolver: options.semanticResolver,
          cache: options.cache,
          registry,
          enableSemanticResolution: options.enableSemanticResolution,
          strictSkillProvenance: options.strictSkillProvenance
        }
      );
      skillIntelligence = profiled.skill_intelligence;
      modelCalls = profiled.telemetry.gateway_calls;
    }
  } catch (err) {
    failureCode = err?.code || 'SEMANTIC_ENGINE_FAILURE';
    failureStage = 'EXTRACTION';
  }

  if (!skillIntelligence) {
    const comparison = {
      has_disagreement: true,
      disagreements: ['SEMANTIC_ENGINE_FAILURE'],
      details: {
        legacy_skills: legacySkills.canonical,
        legacy_skills_missed: [],
        semantic_skills_extra: [],
        normalization_disagreements: [],
        possible_false_merges: [],
        possible_false_splits: [],
        rejected_mentions: [],
        unresolved_surfaces: [],
        rejected_normalization_decisions: [],
        failure_code: failureCode,
        failure_is_engineering_fault: true
      }
    };
    return {
      legacy_skills: legacySkills,
      shadow_executed: true,
      skill_intelligence: null,
      telemetry: buildSkillShadowTelemetry({
        jobId,
        comparison,
        skillIntelligence: null,
        modelCalls,
        latencyMs: Date.now() - started
      })
    };
  }

  // 3. Compare. Legacy authority is untouched by the result.
  const comparison = compareSkillExtraction({ legacySkills, skillIntelligence, registry });
  if (failureStage) {
    comparison.details.failure_code = comparison.details.failure_code || failureCode;
  }

  return {
    legacy_skills: legacySkills,
    shadow_executed: true,
    skill_intelligence: skillIntelligence,
    comparison,
    telemetry: buildSkillShadowTelemetry({
      jobId,
      comparison,
      skillIntelligence,
      modelCalls,
      latencyMs: Date.now() - started
    })
  };
}

/**
 * Live-path shadow hook.
 * Configuration is read from runtime/feature configuration, NEVER candidate data.
 *
 * @param {object} params
 * @param {object} params.job
 * @param {object} [params.config={}] - Runtime configuration (never candidate data)
 * @param {object} [params.options={}]
 * @returns {Promise<{ shadow_executed: boolean, telemetry?: object }>}
 */
export async function runSkillShadowHook({ job, config = {}, options = {} }) {
  const enabled = isSemanticSkillIntelligenceEnabled(config) || options.forceShadow === true;
  if (!enabled) return { shadow_executed: false };

  const result = await runSkillShadowEvaluation({
    sample: {
      sample_id: job?.jobId || `live-${Date.now()}`,
      raw_jd_text: job?.jdText || '',
      metadata: { raw_title: job?.title || '', company: job?.company || '' }
    },
    config,
    options: { ...options, forceShadow: true }
  });

  return { shadow_executed: result.shadow_executed, telemetry: result.telemetry };
}
