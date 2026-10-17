// @ts-check
/**
 * skill-concept-registry.mjs — Phase 2 SkillConcept Persistent Concept Memory
 *
 * WHAT THIS IS
 *   A persistent concept memory registry for canonical SkillConcept identities.
 *   It answers:
 *     - "Which canonical SkillConcept identities already exist?"
 *     - "What is each concept's stable concept_id?"
 *     - "What is the canonical display label stored for this concept?"
 *
 * WHAT THIS IS NOT
 *   It is NOT an alias dictionary or ontology of how technologies appear in
 *   job descriptions. Handcrafted alias mappings, synonym dictionaries, and
 *   static distinctness lists are completely removed.
 *
 * MODELS UNDERSTAND. CODE DECIDES.
 *   System-1 is the semantic authority for understanding naming variants,
 *   abbreviations, and technology relationships.
 *   Deterministic code only handles:
 *     1. Exact, semantically lossless canonical name matching (casing/whitespace/Unicode safe).
 *     2. Retrieval of candidate concepts to bound System-1 reasoning.
 *     3. Structural and operational validation of model propositions.
 *
 * IDENTITY STABILITY
 *   Registered concept_ids are frozen slug-form constants. Derived IDs
 *   (run-local concepts) come from `deterministicConceptId()`, a pure function
 *   of the canonical name, ensuring stable resolution across runs.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createSkillConcept, SEMANTIC_SCHEMA_VERSION } from './semantic-entities.mjs';
import { SemanticProfilerError } from './semantic-errors.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const DEFAULT_SEED_PATH = join(__dirname, 'skill-concept-seed.json');

/** Reason codes attached to a non-resolved normalization outcome. */
export const NORMALIZATION_REASONS = Object.freeze({
  NO_REGISTRY_MATCH: 'NO_REGISTRY_MATCH',
  NO_CANDIDATE_FOUND: 'NO_CANDIDATE_FOUND',
  SEMANTIC_RESOLUTION_UNAVAILABLE: 'SEMANTIC_RESOLUTION_UNAVAILABLE',
  DECISION_REJECTED: 'NORMALIZATION_DECISION_REJECTED',
  PROMPT_INJECTION_REJECTED: 'PROMPT_INJECTION_REJECTED',
  MODEL_ABSTAINED: 'MODEL_ABSTAINED'
});

const CONCEPT_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Is this a valid, canonical-form concept id (`^[a-z0-9-]+$`, no empty or
 * doubled segments)?
 * @param {string} id
 * @returns {boolean}
 */
export function isValidConceptId(id) {
  return typeof id === 'string' && CONCEPT_ID_RE.test(id);
}

/**
 * Deterministic, case/whitespace/punctuation-safe normalization of a skill
 * surface form for lossless comparison and ID derivation.
 * Identity-bearing symbols are preserved as words:
 *
 *   'JS'          -> 'js'
 *   'Node.js'     -> 'node-js'
 *   'k8s'         -> 'k8s'
 *   'C++'         -> 'cplusplus'
 *   'C#'          -> 'csharp'
 *   '.NET'        -> 'net'
 *   'Postgres'    -> 'postgres'
 *
 * @param {string} surface
 * @returns {string}
 */
export function normalizeSkillSurface(surface) {
  if (typeof surface !== 'string') return '';
  let s = surface
    .normalize('NFKC')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  s = s.replace(/^["'`(\[{<]+/, '').replace(/["'`)\]}>,;:!?]+$/, '');
  if (!s.startsWith('.') && s.length > 1 && s.endsWith('.')) s = s.slice(0, -1);
  s = s
    .toLowerCase()
    .replace(/\+\+/g, 'plusplus')
    .replace(/\+/g, 'plus')
    .replace(/#/g, 'sharp')
    .replace(/&/g, 'and')
    .replace(/\//g, 'slash')
    .replace(/\./g, '-')
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return s;
}

/**
 * Deterministic concept id derived from a canonical name. Pure function.
 * @param {string} canonicalName
 * @returns {string}
 */
export function deterministicConceptId(canonicalName) {
  const normalized = normalizeSkillSurface(canonicalName);
  if (normalized) return normalized;
  const digest = createHash('sha256').update(String(canonicalName), 'utf8').digest('hex').slice(0, 12);
  return `concept-${digest}`;
}

/**
 * Deterministic disambiguating suffix for a concept-id collision.
 * @param {string} canonicalName
 * @param {number} [length=8]
 * @returns {string}
 */
export function collisionSuffix(canonicalName, length = 8) {
  return createHash('sha256').update(String(canonicalName), 'utf8').digest('hex').slice(0, length);
}

/**
 * Read the default registry seed from disk.
 * @param {string} [path]
 * @returns {object}
 */
export function readSkillConceptSeed(path = DEFAULT_SEED_PATH) {
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new SemanticProfilerError('CONCEPT_REGISTRY_ERROR', `Skill concept seed is not valid JSON: ${err.message}`, { path });
  }
}

/**
 * Load and validate a skill-concept persistent concept memory registry.
 *
 * @param {object} [seed]
 * @returns {object} registry
 */
export function loadSkillConceptRegistry(seed = readSkillConceptSeed()) {
  const registryVersion = seed.registry_version;
  const normalizationVersion = seed.normalization_version || registryVersion;
  const schemaVersion = seed.schema_version || SEMANTIC_SCHEMA_VERSION;

  if (!registryVersion || !Array.isArray(seed.concepts)) {
    throw new SemanticProfilerError('CONCEPT_REGISTRY_ERROR', 'Skill concept seed is missing registry_version or concepts[]');
  }

  const conceptById = new Map();
  const byCanonicalSurface = new Map();
  const concepts = [];

  for (const raw of seed.concepts) {
    let concept;
    try {
      concept = createSkillConcept({
        concept_id: raw.concept_id,
        canonical_name: raw.canonical_name,
        category: raw.category,
        surface_forms: raw.surface_forms || [raw.canonical_name],
        parent_concept_id: raw.parent_concept_id ?? null,
        ecosystem: raw.ecosystem ?? null,
        is_registered: true,
        normalization_version: normalizationVersion,
        registry_version: registryVersion
      });
    } catch (err) {
      throw new SemanticProfilerError(
        'CONCEPT_REGISTRY_ERROR',
        `seed concept "${raw.concept_id}" is not a valid SkillConcept: ${err.message}`,
        { cause: err, concept_id: raw.concept_id }
      );
    }

    if (!isValidConceptId(concept.concept_id)) {
      throw new SemanticProfilerError(
        'CONCEPT_REGISTRY_ERROR',
        `concept_id "${concept.concept_id}" is not in canonical slug form (^[a-z0-9]+(-[a-z0-9]+)*$)`,
        { canonical_name: concept.canonical_name }
      );
    }

    const clash = conceptById.get(concept.concept_id);
    if (clash) {
      throw new SemanticProfilerError(
        'CONCEPT_ID_COLLISION',
        `concept_id "${concept.concept_id}" is claimed by both "${clash.canonical_name}" and "${concept.canonical_name}"`,
        { concept_id: concept.concept_id, names: [clash.canonical_name, concept.canonical_name] }
      );
    }

    const canonicalKey = normalizeSkillSurface(concept.canonical_name);
    if (canonicalKey) {
      const existingSurface = byCanonicalSurface.get(canonicalKey);
      if (existingSurface && existingSurface.concept_id !== concept.concept_id) {
        throw new SemanticProfilerError(
          'CONCEPT_ID_COLLISION',
          `canonical surface "${canonicalKey}" is claimed by both "${existingSurface.concept_id}" and "${concept.concept_id}"`,
          { surface: canonicalKey, concept_ids: [existingSurface.concept_id, concept.concept_id] }
        );
      }
      byCanonicalSurface.set(canonicalKey, { concept_id: concept.concept_id, canonical_name: concept.canonical_name });
    }

    conceptById.set(concept.concept_id, concept);
    concepts.push(concept);
  }

  return {
    registry_version: registryVersion,
    normalization_version: normalizationVersion,
    schema_version: schemaVersion,
    policy: seed.policy || null,
    concepts,
    conceptById,
    byCanonicalSurface,
    stats: {
      concept_count: concepts.length,
      canonical_surface_count: byCanonicalSurface.size
    }
  };
}

let defaultRegistry = null;

/**
 * Memoized default registry (seeded from skill-concept-seed.json).
 * @returns {object}
 */
export function getDefaultSkillConceptRegistry() {
  if (!defaultRegistry) defaultRegistry = loadSkillConceptRegistry();
  return defaultRegistry;
}

/** Drop the memoized registry. Test isolation only. */
export function resetDefaultSkillConceptRegistry() {
  defaultRegistry = null;
}

/**
 * STEP A — deterministic semantically-lossless exact resolution.
 *
 * Resolves ONLY when surface folds onto a registered canonical display name
 * via case/whitespace/punctuation normalization (e.g. 'kubernetes' -> 'Kubernetes').
 *
 * It does NOT resolve aliases, abbreviations, or related technologies.
 * Any non-exact match returns null and must proceed to System-1 semantic resolution.
 *
 * @param {object} registry
 * @param {string} surface
 * @returns {{ state: 'RESOLVED', concept_id: string, canonical_name: string, method: 'EXACT_CANONICAL', confidence: number } | null}
 */
export function exactResolveSurface(registry, surface) {
  const key = normalizeSkillSurface(surface);
  if (!key) return null;

  const hit = registry.byCanonicalSurface.get(key);
  if (hit) {
    const concept = registry.conceptById.get(hit.concept_id);
    return {
      state: 'RESOLVED',
      concept_id: concept.concept_id,
      canonical_name: concept.canonical_name,
      method: 'EXACT_CANONICAL',
      confidence: 1.0
    };
  }

  return null;
}

/**
 * Create a run-local concept for a technology the registry does not know.
 *
 * @param {object} params
 * @param {string} params.canonicalName
 * @param {string} params.category
 * @param {string[]} [params.surfaceForms]
 * @param {object} params.registry
 * @returns {object} SkillConcept
 */
export function createRunLocalConcept({ canonicalName, category, surfaceForms = [], registry }) {
  const base = deterministicConceptId(canonicalName);
  let id = base;
  const existing = registry.conceptById.get(id);
  if (existing && existing.canonical_name !== canonicalName) {
    id = `${base}-${collisionSuffix(canonicalName)}`;
    let attempt = 1;
    while (registry.conceptById.has(id) && registry.conceptById.get(id).canonical_name !== canonicalName) {
      attempt++;
      id = `${base}-${collisionSuffix(`${canonicalName}#${attempt}`, 8 + attempt)}`;
    }
  }

  return createSkillConcept({
    concept_id: id,
    canonical_name: canonicalName,
    category,
    surface_forms: surfaceForms.length > 0 ? surfaceForms : [canonicalName],
    is_registered: false,
    normalization_version: registry.normalization_version,
    registry_version: registry.registry_version
  });
}

/**
 * Merge an observed concept into a job's concept set.
 *
 * @param {Map<string, object>} conceptMap
 * @param {object} concept
 * @returns {object} the concept now in the map
 */
export function upsertConcept(conceptMap, concept) {
  const existing = conceptMap.get(concept.concept_id);
  if (!existing) {
    conceptMap.set(concept.concept_id, concept);
    return concept;
  }
  const merged = {
    ...existing,
    surface_forms: Array.from(new Set([...existing.surface_forms, ...concept.surface_forms]))
  };
  conceptMap.set(concept.concept_id, merged);
  return merged;
}
