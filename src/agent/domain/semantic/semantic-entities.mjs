// @ts-check
/**
 * semantic-entities.mjs — Canonical v1.2 Semantic Domain Entities & Strict Runtime Validation
 *
 * Implements canonical domain entities:
 * - SkillConcept
 * - CandidateCapability
 * - JobRequirement
 * - JobSemanticProfile
 * - CandidateSemanticProfile
 * - RequirementMatch
 * - MatchProfile
 *
 * Invariants:
 * - Strict schema validation: additionalProperties: false, required fields, typed enums
 * - Explicit versioning (SEMANTIC_SCHEMA_VERSION = 'v1.2.0')
 * - Clear validation errors (path, code, expected, actual, message)
 * - Deterministic, canonical serialization
 * - Unknown & abstention states explicitly supported
 * - Distinction between verified vs inferred candidate capabilities
 * - No promotion of related skills into verified skills
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const SEMANTIC_SCHEMA_VERSION = 'v1.2.0';

export const SKILL_CATEGORIES = Object.freeze([
  'LANGUAGE',
  'FRAMEWORK',
  'DATABASE',
  'INFRASTRUCTURE',
  'AI_ML',
  'TOOL',
  'METHODOLOGY',
  'ARCHITECTURE'
]);

export const CAPABILITY_DEPTHS = Object.freeze([
  'EXPOSURE',
  'PRACTICAL',
  'PRODUCTION',
  'EXPERT'
]);

export const REQUIREMENT_TYPES = Object.freeze([
  'TECHNICAL_SKILL',
  'YEARS_EXPERIENCE',
  'EDUCATION',
  'LEGAL_ADMINISTRATIVE',
  'WORK_MODEL',
  'SECURITY_CLEARANCE',
  'LANGUAGE',
  'DOMAIN_KNOWLEDGE'
]);

export const REQUIREMENT_IMPORTANCES = Object.freeze([
  'LEGAL_MANDATORY',
  'REQUIRED',
  'PREFERRED',
  'OPTIONAL',
  'RESPONSIBILITY',
  'CONTEXT'
]);

export const ROLE_FAMILIES = Object.freeze([
  'software_engineering',
  'ai_ml',
  'data_engineering',
  'devops_cloud',
  'cybersecurity',
  'product_management',
  'design',
  'data_analytics',
  'qa_testing',
  'other'
]);

export const SENIORITY_LEVELS = Object.freeze([
  'INTERN',
  'JUNIOR',
  'ENTRY',
  'MID',
  'SENIOR',
  'STAFF_PRINCIPAL',
  'DIRECTOR_PLUS',
  'UNKNOWN'
]);

export const WORK_MODELS = Object.freeze([
  'REMOTE',
  'HYBRID',
  'ONSITE',
  'UNKNOWN'
]);

export const SKILL_RESOLUTION_STATES = Object.freeze([
  'RESOLVED',
  'NEW_CONCEPT',
  'AMBIGUOUS',
  'UNRESOLVED'
]);

export const SKILL_RESOLUTION_METHODS = Object.freeze([
  'EXACT_CANONICAL',
  'DETERMINISTIC_NEW_CONCEPT',
  'SEMANTIC_RESOLUTION',
  'NONE'
]);

export const SKILL_RETRIEVAL_METHODS = Object.freeze([
  'NORMALIZED_TOKEN_OVERLAP',
  'SUBSTRING',
  'TRIGRAM',
  'INITIALISM',
  'CATEGORY_BACKFILL',
  'EMBEDDING'
]);

export const SKILL_EVIDENCE_ROLES = Object.freeze([
  'JOB_CONTENT',
  'META_INSTRUCTION',
  'QUOTED_OR_REFERENCED_CONTENT',
  'UNKNOWN'
]);

export const CANDIDATE_EXPERIENCE_TYPES = Object.freeze([
  'EMPLOYMENT',
  'INTERNSHIP',
  'FREELANCE',
  'OPEN_SOURCE',
  'RESEARCH',
  'ACADEMIC',
  'PERSONAL_PROJECT',
  'COURSEWORK',
  'VOLUNTEER',
  'UNKNOWN'
]);

export const CANDIDATE_EVIDENCE_ROLES = Object.freeze([
  'CANDIDATE_FACT',
  'META_INSTRUCTION',
  'QUOTED_OR_REFERENCED_CONTENT',
  'UNKNOWN'
]);

export const CANDIDATE_RESPONSIBILITY_LEVELS = Object.freeze([
  'MENTIONED',
  'USED',
  'IMPLEMENTED',
  'DESIGNED',
  'DEPLOYED',
  'OWNED',
  'LED',
  'UNKNOWN'
]);

export const CANDIDATE_EDUCATION_STATUSES = Object.freeze([
  'IN_PROGRESS',
  'COMPLETED',
  'PAUSED',
  'UNKNOWN'
]);

export const CANDIDATE_DEGREE_LEVELS = Object.freeze([
  'BACHELOR',
  'MASTER',
  'DOCTORATE',
  'ASSOCIATE',
  'CERTIFICATE',
  'BOOTCAMP',
  'SECONDARY',
  'OTHER',
  'UNKNOWN'
]);

export const CANDIDATE_ENVIRONMENT_TYPES = Object.freeze([
  'PRODUCTION',
  'STAGING',
  'TEST_LOCAL',
  'ACADEMIC_STUDY',
  'UNKNOWN'
]);

export const CANDIDATE_EVIDENCE_CONTEXT_TYPES = Object.freeze([
  'EMPLOYMENT',
  'INTERNSHIP',
  'FREELANCE',
  'OPEN_SOURCE',
  'RESEARCH',
  'ACADEMIC',
  'PERSONAL_PROJECT',
  'COURSEWORK',
  'VOLUNTEER',
  'STANDALONE_SKILL_LIST',
  'SUMMARY_STATEMENT',
  'UNKNOWN'
]);

export const LEGACY_MATCH_RELATIONS = Object.freeze([
  'EXACT',
  'EQUIVALENT',
  'STRONG_RELATED',
  'TRANSFERABLE',
  'PARTIAL',
  'NO_EVIDENCE',
  'UNKNOWN'
]);

export const REQUIREMENT_MATCH_RELATIONS = Object.freeze([
  'SATISFIES',
  'PARTIALLY_SUPPORTS',
  'RELATED_BUT_INSUFFICIENT',
  'CONTRADICTS',
  'NO_EVIDENCE',
  'UNKNOWN'
]);

export const MATCH_RELATIONS = REQUIREMENT_MATCH_RELATIONS;

export const SUPPORT_DIMENSION_STATUSES = Object.freeze([
  'SUPPORTED',
  'PARTIALLY_SUPPORTED',
  'UNSUPPORTED',
  'NOT_APPLICABLE',
  'UNKNOWN'
]);

export const SEMANTIC_ORIGINS = Object.freeze([
  'MODEL_PROPOSED',
  'TEST_FAKE',
  'BENCHMARK_SYNTHETIC',
  'UNKNOWN'
]);

export const PRIORITY_BANDS = Object.freeze([
  'HIGH_PRIORITY',
  'MEDIUM_PRIORITY',
  'LOW_PRIORITY',
  'INSUFFICIENT_INFORMATION'
]);

export const EXPLANATION_FACT_TYPES = Object.freeze([
  'POSITIVE',
  'NEGATIVE',
  'UNCERTAINTY',
  'BLOCKER'
]);

export const POLICY_STATUSES = Object.freeze([
  'STRONG',
  'REASONABLE',
  'LONG_STRETCH',
  'REJECT',
  'NEEDS_REVIEW'
]);

export const LEGAL_ELIGIBILITY_STATUSES = Object.freeze([
  'ELIGIBLE',
  'INELIGIBLE',
  'NEEDS_REVIEW'
]);

export const PROVENANCE_SOURCE_FILES = Object.freeze([
  'cv.md',
  'article-digest.md',
  'config/profile.yml',
  'user-stated',
  'interview-prep/story-bank.md'
]);

export class SemanticValidationError extends Error {
  /**
   * @param {string} message
   * @param {Array<{ path: string, code: string, message: string, expected?: any, actual?: any }>} errors
   */
  constructor(message, errors = []) {
    super(message);
    this.name = 'SemanticValidationError';
    this.errors = errors;
  }
}

/**
 * Load raw JSON schemas from disk
 */
const SCHEMAS = new Map();
function loadSchema(name) {
  if (SCHEMAS.has(name)) return SCHEMAS.get(name);
  const path = join(__dirname, 'schemas', `${name}.json`);
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw);
  SCHEMAS.set(name, parsed);
  return parsed;
}

export function getSchema(name) {
  return loadSchema(name);
}

/**
 * Deterministic JSON stringify with recursively sorted keys
 * @param {any} value
 * @returns {string}
 */
export function canonicalJsonStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJsonStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  const pairs = keys.map((k) => JSON.stringify(k) + ':' + canonicalJsonStringify(value[k]));
  return '{' + pairs.join(',') + '}';
}

/**
 * SHA-256 digest of canonical JSON serialization
 * @param {any} value
 * @returns {string}
 */
export function hashCanonicalJson(value) {
  const serialized = canonicalJsonStringify(value);
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/**
 * Internal recursive schema validator
 * @param {any} data
 * @param {object} schema
 * @param {string} path
 * @param {Array<object>} errors
 */
function validateNode(data, schema, path, errors) {
  if (!schema) return;

  // Handle oneOf schemas
  if (schema.oneOf && Array.isArray(schema.oneOf)) {
    let matchedCount = 0;
    for (const subSchema of schema.oneOf) {
      let resolvedSubSchema = subSchema;
      if (subSchema.$ref) {
        const refName = subSchema.$ref.replace(/\.json$/, '').replace(/^.*[\\/]/, '');
        resolvedSubSchema = loadSchema(refName);
      }
      const subErrors = [];
      validateNode(data, resolvedSubSchema, path, subErrors);
      if (subErrors.length === 0) {
        matchedCount++;
      }
    }
    if (matchedCount !== 1) {
      errors.push({
        path: path || '#',
        code: 'ONE_OF_MISMATCH',
        expected: 'exactly one matching branch in oneOf',
        actual: `${matchedCount} matching branches`,
        message: `Expected data to match exactly one schema in oneOf (matched ${matchedCount}) at ${path || '#'}`
      });
    }
    return;
  }

  // Handle type checks (including type unions e.g. ["string", "null"])
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    let matched = false;

    for (const t of types) {
      if (t === 'null' && data === null) matched = true;
      else if (t === 'string' && typeof data === 'string') matched = true;
      else if (t === 'number' && typeof data === 'number' && Number.isFinite(data)) matched = true;
      else if (t === 'integer' && typeof data === 'number' && Number.isInteger(data)) matched = true;
      else if (t === 'boolean' && typeof data === 'boolean') matched = true;
      else if (t === 'array' && Array.isArray(data)) matched = true;
      else if (t === 'object' && data !== null && typeof data === 'object' && !Array.isArray(data)) matched = true;
    }

    if (!matched) {
      errors.push({
        path: path || '#',
        code: 'TYPE_MISMATCH',
        expected: schema.type,
        actual: data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data,
        message: `Expected type ${JSON.stringify(schema.type)} at ${path || '#'}`
      });
      return;
    }
  }

  if (data === null || data === undefined) {
    return;
  }

  // String constraints
  if (typeof data === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      errors.push({
        path,
        code: 'MIN_LENGTH_VIOLATION',
        expected: `>= ${schema.minLength}`,
        actual: data.length,
        message: `String length ${data.length} is less than minLength ${schema.minLength} at ${path}`
      });
    }
    if (schema.pattern) {
      const reg = new RegExp(schema.pattern);
      if (!reg.test(data)) {
        errors.push({
          path,
          code: 'PATTERN_MISMATCH',
          expected: schema.pattern,
          actual: data,
          message: `String "${data}" does not match pattern ${schema.pattern} at ${path}`
        });
      }
    }
  }

  // Number constraints
  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) {
      errors.push({
        path,
        code: 'MINIMUM_VIOLATION',
        expected: `>= ${schema.minimum}`,
        actual: data,
        message: `Value ${data} is less than minimum ${schema.minimum} at ${path}`
      });
    }
    if (schema.maximum !== undefined && data > schema.maximum) {
      errors.push({
        path,
        code: 'MAXIMUM_VIOLATION',
        expected: `<= ${schema.maximum}`,
        actual: data,
        message: `Value ${data} exceeds maximum ${schema.maximum} at ${path}`
      });
    }
  }

  // Enum constraints
  if (schema.enum) {
    if (!schema.enum.includes(data)) {
      errors.push({
        path,
        code: 'INVALID_ENUM',
        expected: schema.enum,
        actual: data,
        message: `Value ${JSON.stringify(data)} is not one of enum [${schema.enum.join(', ')}] at ${path}`
      });
    }
  }

  // Array constraints
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      errors.push({
        path,
        code: 'MIN_ITEMS_VIOLATION',
        expected: `>= ${schema.minItems}`,
        actual: data.length,
        message: `Array length ${data.length} is less than minItems ${schema.minItems} at ${path}`
      });
    }
    if (schema.items) {
      let itemSchema = schema.items;
      if (itemSchema.$ref) {
        const refName = itemSchema.$ref.replace(/\.json$/, '').replace(/^.*[\\/]/, '');
        itemSchema = loadSchema(refName);
      }
      for (let i = 0; i < data.length; i++) {
        validateNode(data[i], itemSchema, `${path}[${i}]`, errors);
      }
    }
  }

  // Object constraints
  if (typeof data === 'object' && !Array.isArray(data)) {
    // Check required fields
    if (schema.required) {
      for (const reqKey of schema.required) {
        if (data[reqKey] === undefined) {
          errors.push({
            path: path ? `${path}.${reqKey}` : reqKey,
            code: 'MISSING_REQUIRED',
            expected: 'defined',
            actual: 'undefined',
            message: `Missing required property "${reqKey}" at ${path || '#'}`
          });
        }
      }
    }

    // Check additionalProperties: false
    if (schema.additionalProperties === false && schema.properties) {
      const allowedKeys = new Set(Object.keys(schema.properties));
      for (const actualKey of Object.keys(data)) {
        if (!allowedKeys.has(actualKey)) {
          errors.push({
            path: path ? `${path}.${actualKey}` : actualKey,
            code: 'UNEXPECTED_PROPERTY',
            expected: 'none',
            actual: actualKey,
            message: `Unexpected property "${actualKey}" is forbidden by additionalProperties: false at ${path || '#'}`
          });
        }
      }
    }

    // Validate declared properties
    if (schema.properties) {
      for (const [propKey, propSchema] of Object.entries(schema.properties)) {
        if (data[propKey] !== undefined) {
          let resolvedPropSchema = propSchema;
          if (propSchema.$ref) {
            const refName = propSchema.$ref.replace(/\.json$/, '').replace(/^.*[\\/]/, '');
            resolvedPropSchema = loadSchema(refName);
          }
          validateNode(data[propKey], resolvedPropSchema, path ? `${path}.${propKey}` : propKey, errors);
        }
      }
    }
  }
}

/**
 * Validate data against a named canonical schema
 * @param {string} schemaName
 * @param {any} data
 * @returns {{ valid: boolean, errors: Array<{ path: string, code: string, message: string, expected?: any, actual?: any }> }}
 */
export function validateEntity(schemaName, data) {
  const schema = loadSchema(schemaName);
  const errors = [];
  if (data === undefined) {
    return {
      valid: false,
      errors: [{ path: '#', code: 'UNDEFINED_INPUT', message: 'Data to validate is undefined' }]
    };
  }
  validateNode(data, schema, '', errors);
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Assert that data conforms to the schema or throw SemanticValidationError
 * @param {string} schemaName
 * @param {any} data
 */
export function assertValidEntity(schemaName, data) {
  const { valid, errors } = validateEntity(schemaName, data);
  if (!valid) {
    const errorMessages = errors.map((e) => `[${e.code}] ${e.path}: ${e.message}`).join('; ');
    throw new SemanticValidationError(`Validation failed for ${schemaName}: ${errorMessages}`, errors);
  }
}

// Entity-specific validation wrappers
export const validateSkillConcept = (data) => validateEntity('SkillConcept', data);
export const validateSkillMention = (data) => validateEntity('SkillMention', data);
export const validateJobSkillIntelligence = (data) => validateEntity('JobSkillIntelligence', data);
export const validateCandidateEvidence = (data) => validateEntity('CandidateEvidence', data);
export const validateCandidateExperience = (data) => validateEntity('CandidateExperience', data);
export const validateCandidateSkillEvidence = (data) => validateEntity('CandidateSkillEvidence', data);
export const validateCandidateEducation = (data) => validateEntity('CandidateEducation', data);
export const validateCandidateCertification = (data) => validateEntity('CandidateCertification', data);
export const validateCandidateCapability = (data) => validateEntity('CandidateCapability', data);
export const validateJobRequirement = (data) => validateEntity('JobRequirement', data);
export const validateJobSemanticProfile = (data) => validateEntity('JobSemanticProfile', data);
export const validateCandidateSemanticProfile = (data) => validateEntity('CandidateSemanticProfile', data);
export const validateRequirementMatch = (data) => validateEntity('RequirementMatch', data);
export const validateMatchProfile = (data) => validateEntity('MatchProfile', data);
export const validateRequirementMatchResult = (data) => validateEntity('RequirementMatchResult', data);
export const validateCandidateMatchProfile = (data) => validateEntity('CandidateMatchProfile', data);
export const validateRequirementInterpretation = (data) => validateEntity('RequirementInterpretation', data);
export const validateRequirementPolicyResult = (data) => validateEntity('RequirementPolicyResult', data);
export const validatePolicyConfiguration = (data) => validateEntity('PolicyConfiguration', data);
export const validatePolicyAssessment = (data) => validateEntity('PolicyAssessment', data);

export const assertValidSkillConcept = (data) => assertValidEntity('SkillConcept', data);
export const assertValidSkillMention = (data) => assertValidEntity('SkillMention', data);
export const assertValidJobSkillIntelligence = (data) => assertValidEntity('JobSkillIntelligence', data);
export const assertValidCandidateEvidence = (data) => assertValidEntity('CandidateEvidence', data);
export const assertValidCandidateExperience = (data) => assertValidEntity('CandidateExperience', data);
export const assertValidCandidateSkillEvidence = (data) => assertValidEntity('CandidateSkillEvidence', data);
export const assertValidCandidateEducation = (data) => assertValidEntity('CandidateEducation', data);
export const assertValidCandidateCertification = (data) => assertValidEntity('CandidateCertification', data);
export const assertValidCandidateCapability = (data) => assertValidEntity('CandidateCapability', data);
export const assertValidJobRequirement = (data) => assertValidEntity('JobRequirement', data);
export const assertValidJobSemanticProfile = (data) => assertValidEntity('JobSemanticProfile', data);
export const assertValidCandidateSemanticProfile = (data) => assertValidEntity('CandidateSemanticProfile', data);
export const assertValidRequirementMatch = (data) => assertValidEntity('RequirementMatch', data);
export const assertValidMatchProfile = (data) => assertValidEntity('MatchProfile', data);
export const assertValidRequirementMatchResult = (data) => assertValidEntity('RequirementMatchResult', data);
export const assertValidCandidateMatchProfile = (data) => assertValidEntity('CandidateMatchProfile', data);
export const assertValidRequirementInterpretation = (data) => assertValidEntity('RequirementInterpretation', data);
export const assertValidRequirementPolicyResult = (data) => assertValidEntity('RequirementPolicyResult', data);
export const assertValidPolicyConfiguration = (data) => assertValidEntity('PolicyConfiguration', data);
export const assertValidPolicyAssessment = (data) => assertValidEntity('PolicyAssessment', data);

/**
 * Factory for SkillConcept
 */
export function createSkillConcept({
  concept_id,
  canonical_name,
  category,
  surface_forms = [],
  parent_concept_id = null,
  ecosystem = null,
  is_registered = false,
  normalization_version = null,
  registry_version = null
}) {
  const dedupeStrings = (values) => Array.from(new Set(values.map((s) => String(s).trim()))).filter(Boolean);
  const entity = {
    concept_id: String(concept_id || '').toLowerCase().trim(),
    canonical_name: String(canonical_name || '').trim(),
    category,
    surface_forms: dedupeStrings(surface_forms),
    parent_concept_id: parent_concept_id ? String(parent_concept_id).toLowerCase().trim() : null,
    ecosystem: ecosystem ? String(ecosystem).trim() : null,
    is_registered: Boolean(is_registered),
    normalization_version: normalization_version ? String(normalization_version) : null,
    registry_version: registry_version ? String(registry_version) : null
  };
  assertValidSkillConcept(entity);
  return entity;
}

/**
 * Factory for SkillMention
 *
 * Note the deliberate asymmetry with createSkillConcept: the mention keeps the
 * SOURCE surface form and its verbatim evidence, and never rewrites either to
 * the canonical label. Neither `requirement_importance` nor any resolution
 * state is defaulted to a positive value - absent context stays null and an
 * absent decision stays UNRESOLVED. Confidence is never fabricated.
 */
export function createSkillMention({
  mention_id,
  surface_form,
  normalized_surface,
  category,
  requirement_id = null,
  requirement_importance = null,
  evidence_span,
  evidence_role,
  resolution,
  confidence = null
}) {
  const parseConfidence = (v) => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const role = typeof evidence_role === 'string' ? evidence_role.trim() : evidence_role;
  if (!role || !SKILL_EVIDENCE_ROLES.includes(role)) {
    throw new SemanticValidationError('SkillMention', [{
      path: 'evidence_role',
      code: !role ? 'MISSING_REQUIRED' : 'INVALID_ENUM',
      expected: SKILL_EVIDENCE_ROLES,
      actual: evidence_role,
      message: `SkillMention requires an explicit, valid evidence_role (${SKILL_EVIDENCE_ROLES.join(', ')}), got: ${JSON.stringify(evidence_role)}`
    }]);
  }

  const entity = {
    mention_id: String(mention_id),
    surface_form: String(surface_form),
    normalized_surface: String(normalized_surface),
    category,
    requirement_id: requirement_id ? String(requirement_id) : null,
    requirement_importance: requirement_importance || null,
    evidence_span: {
      start_char: Number(evidence_span?.start_char),
      end_char: Number(evidence_span?.end_char),
      verbatim_quote: String(evidence_span?.verbatim_quote || '')
    },
    evidence_role: role,
    resolution: {
      state: resolution?.state || 'UNRESOLVED',
      concept_id: resolution?.concept_id ? String(resolution.concept_id) : null,
      canonical_name: resolution?.canonical_name ? String(resolution.canonical_name) : null,
      method: resolution?.method || 'NONE',
      confidence: parseConfidence(resolution?.confidence),
      ...(Array.isArray(resolution?.candidates) && resolution.candidates.length > 0
        ? {
            candidates: resolution.candidates.map((c) => ({
              concept_id: String(c.concept_id),
              canonical_name: String(c.canonical_name),
              retrieval_score: Number(c.retrieval_score),
              retrieval_method: c.retrieval_method
            }))
          }
        : {}),
      ...(resolution?.reason ? { reason: String(resolution.reason) } : {})
    },
    confidence: parseConfidence(confidence)
  };
  assertValidSkillMention(entity);
  return entity;
}

/**
 * Factory for JobSkillIntelligence
 */
export function createJobSkillIntelligence({
  job_id,
  jd_hash,
  mentions = [],
  concepts = [],
  unresolved_surfaces = [],
  diagnostics = {},
  registry_version = null,
  normalization_version = null,
  model_metadata,
  telemetry = {}
}) {
  const entity = {
    job_id: String(job_id),
    jd_hash: String(jd_hash),
    mentions,
    concepts,
    unresolved_surfaces: Array.from(new Set(unresolved_surfaces.map((s) => String(s)))),
    diagnostics: {
      rejected_mentions: Array.isArray(diagnostics.rejected_mentions) ? diagnostics.rejected_mentions : [],
      ...(Array.isArray(diagnostics.rejected_normalization_decisions)
        ? { rejected_normalization_decisions: diagnostics.rejected_normalization_decisions }
        : {}),
      failure_code: diagnostics.failure_code || null,
      failure_stage: diagnostics.failure_stage || null
    },
    registry_version: registry_version ? String(registry_version) : null,
    normalization_version: normalization_version ? String(normalization_version) : null,
    model_metadata: {
      model_id: String(model_metadata?.model_id || 'system1-default'),
      prompt_version: String(model_metadata?.prompt_version || 'v1.0.0'),
      task_version: String(model_metadata?.task_version || 'v1.0.0'),
      schema_version: String(model_metadata?.schema_version || SEMANTIC_SCHEMA_VERSION)
    },
    telemetry: {
      extraction_ms: typeof telemetry.extraction_ms === 'number' ? telemetry.extraction_ms : 0,
      normalization_ms: typeof telemetry.normalization_ms === 'number' ? telemetry.normalization_ms : 0,
      model_calls: Number(telemetry.model_calls || 0),
      normalization_model_calls: Number(telemetry.normalization_model_calls || 0),
      retries: Number(telemetry.retries || 0),
      cache_hits: Number(telemetry.cache_hits || 0),
      cache_misses: Number(telemetry.cache_misses || 0),
      semantic_resolution_skipped: Boolean(telemetry.semantic_resolution_skipped)
    }
  };
  assertValidJobSkillIntelligence(entity);
  return entity;
}

/**
 * Factory for CandidateEvidence
 */
export function createCandidateEvidence({
  evidence_id,
  candidate_id,
  source_id,
  source_type = 'TEXT_DOCUMENT',
  source_hash,
  section = null,
  evidence_span,
  evidence_role,
  extraction_version
}) {
  const role = typeof evidence_role === 'string' ? evidence_role.trim() : evidence_role;
  if (!role || !CANDIDATE_EVIDENCE_ROLES.includes(role)) {
    throw new SemanticValidationError('CandidateEvidence', [{
      path: 'evidence_role',
      code: !role ? 'MISSING_REQUIRED' : 'INVALID_ENUM',
      expected: CANDIDATE_EVIDENCE_ROLES,
      actual: evidence_role,
      message: `CandidateEvidence requires an explicit, valid evidence_role (${CANDIDATE_EVIDENCE_ROLES.join(', ')}), got: ${JSON.stringify(evidence_role)}`
    }]);
  }

  const entity = {
    evidence_id: String(evidence_id),
    candidate_id: String(candidate_id),
    source_id,
    source_type,
    source_hash: String(source_hash || ''),
    section: section ? String(section) : null,
    evidence_span: {
      start_char: evidence_span?.start_char !== undefined && evidence_span?.start_char !== null ? Number(evidence_span.start_char) : null,
      end_char: evidence_span?.end_char !== undefined && evidence_span?.end_char !== null ? Number(evidence_span.end_char) : null,
      verbatim_quote: String(evidence_span?.verbatim_quote || '')
    },
    evidence_role: role,
    extraction_version: String(extraction_version || 'v1.3.0-phase3')
  };
  assertValidCandidateEvidence(entity);
  return entity;
}

/**
 * Factory for CandidateExperience
 */
export function createCandidateExperience({
  experience_id,
  experience_type,
  organization_or_project_name,
  role_title = null,
  start_date = null,
  end_date = null,
  is_current = false,
  evidence_ids = [],
  source_confidence = null
}) {
  if (!CANDIDATE_EXPERIENCE_TYPES.includes(experience_type)) {
    throw new SemanticValidationError('CandidateExperience', [{
      path: 'experience_type',
      code: 'INVALID_ENUM',
      expected: CANDIDATE_EXPERIENCE_TYPES,
      actual: experience_type,
      message: `Invalid experience_type: ${experience_type}`
    }]);
  }
  const entity = {
    experience_id: String(experience_id),
    experience_type,
    organization_or_project_name: String(organization_or_project_name),
    role_title: role_title ? String(role_title) : null,
    start_date: start_date ? (typeof start_date === 'string' ? start_date : {
      raw: String(start_date.raw || ''),
      year: start_date.year !== undefined && start_date.year !== null ? Number(start_date.year) : null,
      month: start_date.month !== undefined && start_date.month !== null ? Number(start_date.month) : null,
      precision: start_date.precision || 'UNKNOWN'
    }) : null,
    end_date: end_date ? (typeof end_date === 'string' ? end_date : {
      raw: String(end_date.raw || ''),
      year: end_date.year !== undefined && end_date.year !== null ? Number(end_date.year) : null,
      month: end_date.month !== undefined && end_date.month !== null ? Number(end_date.month) : null,
      precision: end_date.precision || 'UNKNOWN'
    }) : null,
    is_current: Boolean(is_current),
    evidence_ids: Array.isArray(evidence_ids) ? evidence_ids.map(String) : [],
    source_confidence: typeof source_confidence === 'number' ? source_confidence : null
  };
  assertValidCandidateExperience(entity);
  return entity;
}

/**
 * Factory for CandidateSkillEvidence
 */
export function createCandidateSkillEvidence({
  skill_evidence_id,
  surface_form,
  normalized_surface,
  category,
  evidence_id,
  experience_id = null,
  evidence_context_type = 'UNKNOWN',
  resolution,
  confidence = null
}) {
  const parseConfidence = (v) => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const entity = {
    skill_evidence_id: String(skill_evidence_id),
    surface_form: String(surface_form),
    normalized_surface: String(normalized_surface),
    category,
    evidence_id: String(evidence_id),
    experience_id: experience_id ? String(experience_id) : null,
    evidence_context_type: CANDIDATE_EVIDENCE_CONTEXT_TYPES.includes(evidence_context_type) ? evidence_context_type : 'UNKNOWN',
    resolution: {
      state: resolution?.state || 'UNRESOLVED',
      concept_id: resolution?.concept_id ? String(resolution.concept_id) : null,
      canonical_name: resolution?.canonical_name ? String(resolution.canonical_name) : null,
      method: resolution?.method || 'NONE',
      confidence: parseConfidence(resolution?.confidence),
      ...(Array.isArray(resolution?.candidates) && resolution.candidates.length > 0
        ? {
            candidates: resolution.candidates.map((c) => ({
              concept_id: String(c.concept_id),
              canonical_name: String(c.canonical_name),
              retrieval_score: Number(c.retrieval_score),
              retrieval_method: c.retrieval_method
            }))
          }
        : {}),
      ...(resolution?.reason ? { reason: String(resolution.reason) } : {})
    },
    confidence: parseConfidence(confidence)
  };
  assertValidCandidateSkillEvidence(entity);
  return entity;
}

/**
 * Factory for CandidateEducation
 */
export function createCandidateEducation({
  education_id,
  degree_level,
  field = null,
  institution = null,
  status,
  start_date = null,
  expected_completion = null,
  completion_date = null,
  gpa = null,
  gpa_scale = null,
  evidence_ids = []
}) {
  if (!degree_level || !CANDIDATE_DEGREE_LEVELS.includes(degree_level)) {
    throw new SemanticValidationError('CandidateEducation', [{
      path: 'degree_level',
      code: !degree_level ? 'MISSING_REQUIRED' : 'INVALID_ENUM',
      expected: CANDIDATE_DEGREE_LEVELS,
      actual: degree_level,
      message: `CandidateEducation requires an explicit degree_level (${CANDIDATE_DEGREE_LEVELS.join(', ')}), got: ${JSON.stringify(degree_level)}`
    }]);
  }
  if (!status || !CANDIDATE_EDUCATION_STATUSES.includes(status)) {
    throw new SemanticValidationError('CandidateEducation', [{
      path: 'status',
      code: !status ? 'MISSING_REQUIRED' : 'INVALID_ENUM',
      expected: CANDIDATE_EDUCATION_STATUSES,
      actual: status,
      message: `CandidateEducation requires an explicit status (${CANDIDATE_EDUCATION_STATUSES.join(', ')}), got: ${JSON.stringify(status)}`
    }]);
  }
  const entity = {
    education_id: String(education_id),
    degree_level,
    field: field ? String(field) : null,
    institution: institution ? String(institution) : null,
    status,
    start_date: start_date ? (typeof start_date === 'string' ? start_date : {
      raw: String(start_date.raw || ''),
      year: start_date.year !== undefined && start_date.year !== null ? Number(start_date.year) : null,
      month: start_date.month !== undefined && start_date.month !== null ? Number(start_date.month) : null,
      precision: start_date.precision || 'UNKNOWN'
    }) : null,
    expected_completion: expected_completion ? (typeof expected_completion === 'string' ? expected_completion : {
      raw: String(expected_completion.raw || ''),
      year: expected_completion.year !== undefined && expected_completion.year !== null ? Number(expected_completion.year) : null,
      month: expected_completion.month !== undefined && expected_completion.month !== null ? Number(expected_completion.month) : null,
      precision: expected_completion.precision || 'UNKNOWN'
    }) : null,
    completion_date: completion_date ? (typeof completion_date === 'string' ? completion_date : {
      raw: String(completion_date.raw || ''),
      year: completion_date.year !== undefined && completion_date.year !== null ? Number(completion_date.year) : null,
      month: completion_date.month !== undefined && completion_date.month !== null ? Number(completion_date.month) : null,
      precision: completion_date.precision || 'UNKNOWN'
    }) : null,
    gpa: gpa !== null && gpa !== undefined ? Number(gpa) : null,
    gpa_scale: gpa_scale ? String(gpa_scale) : null,
    evidence_ids: Array.isArray(evidence_ids) ? evidence_ids.map(String) : []
  };
  assertValidCandidateEducation(entity);
  return entity;
}

/**
 * Factory for CandidateCertification
 */
export function createCandidateCertification({
  certification_id,
  name,
  issuer = null,
  issue_date = null,
  is_certified,
  evidence_ids = []
}) {
  if (typeof is_certified !== 'boolean') {
    throw new SemanticValidationError('CandidateCertification', [{
      path: 'is_certified',
      code: is_certified === undefined ? 'MISSING_REQUIRED' : 'INVALID_TYPE',
      expected: 'boolean',
      actual: is_certified,
      message: `CandidateCertification requires an explicit boolean is_certified, got: ${JSON.stringify(is_certified)}`
    }]);
  }
  const entity = {
    certification_id: String(certification_id),
    name: String(name),
    issuer: issuer ? String(issuer) : null,
    issue_date: issue_date ? (typeof issue_date === 'string' ? issue_date : {
      raw: String(issue_date.raw || ''),
      year: issue_date.year !== undefined && issue_date.year !== null ? Number(issue_date.year) : null,
      month: issue_date.month !== undefined && issue_date.month !== null ? Number(issue_date.month) : null,
      precision: issue_date.precision || 'UNKNOWN'
    }) : null,
    is_certified,
    evidence_ids: Array.isArray(evidence_ids) ? evidence_ids.map(String) : []
  };
  assertValidCandidateCertification(entity);
  return entity;
}

/**
 * Factory for CandidateCapability
 */
export function createCandidateCapability({
  capability_id,
  concept_id = null,
  name,
  depth = null,
  years_experience = null,
  is_verified = true,
  provenance,
  activity = null,
  object = null,
  skill_concept_ids = [],
  experience_id = null,
  evidence_ids = [],
  responsibility_level = 'UNKNOWN',
  outcome = null,
  environment_type = 'UNKNOWN'
}) {
  if (depth !== null && depth !== undefined && !CAPABILITY_DEPTHS.includes(depth)) {
    throw new SemanticValidationError('CandidateCapability', [{
      path: 'depth',
      code: 'INVALID_ENUM',
      expected: CAPABILITY_DEPTHS,
      actual: depth,
      message: `CandidateCapability depth must be null or in (${CAPABILITY_DEPTHS.join(', ')}), got: ${JSON.stringify(depth)}`
    }]);
  }
  const entity = {
    capability_id: String(capability_id),
    concept_id: concept_id ? String(concept_id).toLowerCase().trim() : null,
    name: String(name),
    depth: depth || null,
    years_experience: years_experience !== null && years_experience !== undefined ? Number(years_experience) : null,
    is_verified: Boolean(is_verified),
    provenance: {
      source_file: provenance?.source_file,
      verbatim_quote: String(provenance?.verbatim_quote || ''),
      source_hash: String(provenance?.source_hash || ''),
      start_char: provenance?.start_char !== undefined && provenance?.start_char !== null ? Number(provenance.start_char) : null,
      end_char: provenance?.end_char !== undefined && provenance?.end_char !== null ? Number(provenance.end_char) : null
    },
    ...(activity !== null && activity !== undefined ? { activity: String(activity) } : {}),
    ...(object !== null && object !== undefined ? { object: String(object) } : {}),
    skill_concept_ids: Array.isArray(skill_concept_ids) ? skill_concept_ids.map(String) : [],
    ...(experience_id !== null && experience_id !== undefined ? { experience_id: String(experience_id) } : {}),
    evidence_ids: Array.isArray(evidence_ids) ? evidence_ids.map(String) : [],
    ...(responsibility_level && CANDIDATE_RESPONSIBILITY_LEVELS.includes(responsibility_level) ? { responsibility_level } : {}),
    ...(outcome !== null && outcome !== undefined ? { outcome: String(outcome) } : {}),
    ...(environment_type && CANDIDATE_ENVIRONMENT_TYPES.includes(environment_type) ? { environment_type } : {})
  };
  assertValidCandidateCapability(entity);
  return entity;
}

/**
 * Factory for JobRequirement
 */
export function createJobRequirement({
  requirement_id,
  type,
  importance,
  description,
  target_concept_id = null,
  min_years = null,
  evidence_span,
  confidence = 1.0
}) {
  const entity = {
    requirement_id: String(requirement_id),
    type,
    importance,
    description: String(description),
    target_concept_id: target_concept_id ? String(target_concept_id).toLowerCase().trim() : null,
    min_years: min_years !== null && min_years !== undefined ? Number(min_years) : null,
    evidence_span: {
      start_char: Number(evidence_span?.start_char),
      end_char: Number(evidence_span?.end_char),
      verbatim_quote: String(evidence_span?.verbatim_quote || '')
    },
    confidence: Number(confidence)
  };
  assertValidJobRequirement(entity);
  return entity;
}

/**
 * Factory for JobSemanticProfile
 */
export function createJobSemanticProfile({
  job_id,
  title,
  company,
  role_family,
  specialization = null,
  seniority,
  work_model,
  education = null,
  domain = null,
  requirements = [],
  overall_yoe_required = null,
  overall_yoe_preferred = null,
  extraction_confidence = 1.0,
  jd_hash,
  model_metadata
}) {
  const entity = {
    job_id: String(job_id),
    title: String(title),
    company: String(company),
    role_family,
    specialization: specialization ? String(specialization) : null,
    seniority: {
      level: seniority?.level || 'UNKNOWN',
      is_early_career_friendly: Boolean(seniority?.is_early_career_friendly),
      rationale: String(seniority?.rationale || ''),
      ...(seniority?.evidence_signals ? {
        evidence_signals: {
          title_signal: String(seniority.evidence_signals.title_signal || ''),
          yoe_signal: String(seniority.evidence_signals.yoe_signal || ''),
          responsibility_scope: seniority.evidence_signals.responsibility_scope || 'UNKNOWN'
        }
      } : {})
    },
    work_model: {
      type: work_model?.type || 'UNKNOWN',
      allowed_jurisdictions: Array.isArray(work_model?.allowed_jurisdictions) ? work_model.allowed_jurisdictions : [],
      hybrid_days_in_office: typeof work_model?.hybrid_days_in_office === 'number' ? work_model.hybrid_days_in_office : null,
      timezone_restrictions: Array.isArray(work_model?.timezone_restrictions) ? work_model.timezone_restrictions : [],
      evidence_span: work_model?.evidence_span ? {
        start_char: Number(work_model.evidence_span.start_char),
        end_char: Number(work_model.evidence_span.end_char),
        verbatim_quote: String(work_model.evidence_span.verbatim_quote || '')
      } : null
    },
    education: {
      min_degree_level: education?.min_degree_level !== undefined ? education.min_degree_level : null,
      fields_of_study: Array.isArray(education?.fields_of_study) ? education.fields_of_study : [],
      equivalent_experience_allowed: typeof education?.equivalent_experience_allowed === 'boolean'
        ? education.equivalent_experience_allowed
        : null,
      min_gpa: typeof education?.min_gpa === 'number' ? education.min_gpa : null,
      gpa_scale: education?.gpa_scale ? String(education.gpa_scale) : null,
      evidence_span: education?.evidence_span ? {
        start_char: Number(education.evidence_span.start_char),
        end_char: Number(education.evidence_span.end_char),
        verbatim_quote: String(education.evidence_span.verbatim_quote || '')
      } : null
    },
    domain: {
      primary_vertical: domain?.primary_vertical ? String(domain.primary_vertical) : null,
      technical_domain: domain?.technical_domain ? String(domain.technical_domain) : null,
      architectural_style: domain?.architectural_style || 'UNKNOWN'
    },
    requirements,
    overall_yoe_required: overall_yoe_required !== null && overall_yoe_required !== undefined ? Number(overall_yoe_required) : null,
    overall_yoe_preferred: overall_yoe_preferred !== null && overall_yoe_preferred !== undefined ? Number(overall_yoe_preferred) : null,
    extraction_confidence: Number(extraction_confidence),
    jd_hash: String(jd_hash),
    model_metadata: {
      model_id: String(model_metadata?.model_id || 'legacy-adapter'),
      prompt_version: String(model_metadata?.prompt_version || 'v1.0.0'),
      schema_version: String(model_metadata?.schema_version || SEMANTIC_SCHEMA_VERSION)
    }
  };
  assertValidJobSemanticProfile(entity);
  return entity;
}

/**
 * Factory for CandidateSemanticProfile
 */
export function createCandidateSemanticProfile({
  candidate_id,
  candidate_hash,
  verified_yoe = null,
  verified_yoe_source = null,
  capabilities = [],
  education = [],
  legal_eligibility,
  target_roles = [],
  provenance_summary,
  evidence = [],
  experiences = [],
  skills = [],
  certifications = [],
  model_metadata = null,
  telemetry = null,
  diagnostics = null
}) {
  const entity = {
    candidate_id: String(candidate_id),
    candidate_hash: String(candidate_hash),
    verified_yoe: typeof verified_yoe === 'number' && Number.isFinite(verified_yoe) ? verified_yoe : null,
    verified_yoe_source: verified_yoe !== null && verified_yoe !== undefined && verified_yoe_source ? String(verified_yoe_source) : null,
    capabilities,
    education: education.map((edu) => ({
      degree: String(edu.degree),
      ...(edu.degree_level ? { degree_level: edu.degree_level } : {}),
      ...(edu.status ? { status: edu.status } : {}),
      ...(Array.isArray(edu.evidence_ids) ? { evidence_ids: edu.evidence_ids } : {}),
      field: String(edu.field),
      institution: edu.institution ? String(edu.institution) : null,
      gpa: edu.gpa !== null && edu.gpa !== undefined ? Number(edu.gpa) : null,
      gpa_scale: edu.gpa_scale ? String(edu.gpa_scale) : null,
      is_verified: Boolean(edu.is_verified),
      source_file: edu.source_file,
      source_quote: String(edu.source_quote || '')
    })),
    legal_eligibility: {
      work_authorization: legal_eligibility?.work_authorization !== undefined ? legal_eligibility.work_authorization : null,
      security_clearance: legal_eligibility?.security_clearance !== undefined ? legal_eligibility.security_clearance : null,
      citizenship: Array.isArray(legal_eligibility?.citizenship) ? legal_eligibility.citizenship : null,
      requires_sponsorship: legal_eligibility?.requires_sponsorship !== undefined ? legal_eligibility.requires_sponsorship : null
    },
    target_roles: Array.isArray(target_roles) ? target_roles : [],
    provenance_summary: {
      cv_hash: String(provenance_summary?.cv_hash || ''),
      profile_config_hash: provenance_summary?.profile_config_hash ? String(provenance_summary.profile_config_hash) : null,
      article_digest_hash: provenance_summary?.article_digest_hash ? String(provenance_summary.article_digest_hash) : null
    },
    evidence: Array.isArray(evidence) ? evidence : [],
    experiences: Array.isArray(experiences) ? experiences : [],
    skills: Array.isArray(skills) ? skills : [],
    certifications: Array.isArray(certifications) ? certifications : [],
    ...(model_metadata ? {
      model_metadata: {
        model_id: String(model_metadata.model_id),
        prompt_version: String(model_metadata.prompt_version),
        task_version: String(model_metadata.task_version),
        schema_version: String(model_metadata.schema_version)
      }
    } : {}),
    ...(telemetry ? { telemetry } : {}),
    ...(diagnostics ? {
      diagnostics: {
        rejected_evidence: Array.isArray(diagnostics.rejected_evidence) ? diagnostics.rejected_evidence : [],
        rejected_experiences: Array.isArray(diagnostics.rejected_experiences) ? diagnostics.rejected_experiences : [],
        rejected_skills: Array.isArray(diagnostics.rejected_skills) ? diagnostics.rejected_skills : [],
        rejected_capabilities: Array.isArray(diagnostics.rejected_capabilities) ? diagnostics.rejected_capabilities : [],
        rejected_education: Array.isArray(diagnostics.rejected_education) ? diagnostics.rejected_education : [],
        rejected_certifications: Array.isArray(diagnostics.rejected_certifications) ? diagnostics.rejected_certifications : [],
        failure_code: diagnostics.failure_code || null,
        failure_stage: diagnostics.failure_stage || null
      }
    } : {})
  };
  assertValidCandidateSemanticProfile(entity);
  return entity;
}

/**
 * Factory for RequirementMatch
 */
export function createRequirementMatch({
  requirement_id,
  relation,
  matched_capability_id = null,
  evidence_quote,
  candidate_proof_quote = null,
  is_gap,
  match_confidence = 1.0
}) {
  const entity = {
    requirement_id: String(requirement_id),
    relation,
    matched_capability_id: matched_capability_id ? String(matched_capability_id) : null,
    evidence_quote: String(evidence_quote || ''),
    candidate_proof_quote: candidate_proof_quote ? String(candidate_proof_quote) : null,
    is_gap: Boolean(is_gap),
    match_confidence: Number(match_confidence)
  };
  assertValidRequirementMatch(entity);
  return entity;
}

/**
 * Factory for RequirementInterpretation
 */
export function createRequirementInterpretation({
  requirement_id,
  logical_structure = { operator: 'SINGLE', branches: [] },
  mandatory_dimensions = [],
  optional_dimensions = [],
  semantic_constraints = {},
  ambiguity = [],
  requirement_provenance = { requirement_id: String(requirement_id) }
}) {
  const entity = {
    requirement_id: String(requirement_id),
    logical_structure: {
      operator: logical_structure?.operator || 'SINGLE',
      branches: Array.isArray(logical_structure?.branches) ? [...logical_structure.branches] : []
    },
    mandatory_dimensions: Array.isArray(mandatory_dimensions) ? [...mandatory_dimensions] : [],
    optional_dimensions: Array.isArray(optional_dimensions) ? [...optional_dimensions] : [],
    semantic_constraints: { ...semantic_constraints },
    ambiguity: Array.isArray(ambiguity) ? [...ambiguity] : [],
    requirement_provenance: { ...requirement_provenance }
  };
  assertValidRequirementInterpretation(entity);
  return entity;
}

/**
 * Factory for RequirementMatchResult
 */
export function createRequirementMatchResult({
  requirement_match_id,
  requirement_id,
  relation,
  semantic_origin = 'UNKNOWN',
  candidate_evidence_ids = [],
  candidate_skill_evidence_ids = [],
  candidate_capability_ids = [],
  candidate_experience_ids = [],
  candidate_education_ids = [],
  candidate_certification_ids = [],
  support_dimensions = {},
  unresolved_dimensions = [],
  rationale = { supported: [], unsupported: [] },
  model_metadata = {
    model_id: null,
    prompt_version: 'v1.4.0-phase4',
    task_version: 'v1.4.0-phase4',
    schema_version: 'v1.4.0'
  },
  provenance = {
    requirement_id: String(requirement_id),
    candidate_evidence_quotes: []
  }
}) {
  const entity = {
    requirement_match_id: String(requirement_match_id),
    requirement_id: String(requirement_id),
    relation,
    semantic_origin,
    candidate_evidence_ids: Array.isArray(candidate_evidence_ids) ? [...candidate_evidence_ids] : [],
    candidate_skill_evidence_ids: Array.isArray(candidate_skill_evidence_ids) ? [...candidate_skill_evidence_ids] : [],
    candidate_capability_ids: Array.isArray(candidate_capability_ids) ? [...candidate_capability_ids] : [],
    candidate_experience_ids: Array.isArray(candidate_experience_ids) ? [...candidate_experience_ids] : [],
    candidate_education_ids: Array.isArray(candidate_education_ids) ? [...candidate_education_ids] : [],
    candidate_certification_ids: Array.isArray(candidate_certification_ids) ? [...candidate_certification_ids] : [],
    support_dimensions: { ...support_dimensions },
    unresolved_dimensions: Array.isArray(unresolved_dimensions) ? [...unresolved_dimensions] : [],
    rationale: {
      supported: Array.isArray(rationale?.supported) ? [...rationale.supported] : [],
      unsupported: Array.isArray(rationale?.unsupported) ? [...rationale.unsupported] : []
    },
    model_metadata: {
      model_id: model_metadata?.model_id !== undefined ? model_metadata.model_id : null,
      prompt_version: model_metadata?.prompt_version || 'v1.4.0-phase4',
      task_version: model_metadata?.task_version || 'v1.4.0-phase4',
      schema_version: model_metadata?.schema_version || 'v1.4.0'
    },
    provenance: { ...provenance }
  };
  assertValidRequirementMatchResult(entity);
  return entity;
}

/**
 * Factory for Phase 4 CandidateMatchProfile
 */
export function createCandidateMatchProfile({
  match_profile_id,
  job_id,
  candidate_id,
  requirement_matches = [],
  descriptive_summary,
  telemetry = {
    requirements_evaluated: 0,
    model_calls: 0,
    evidence_bundle_size: 0,
    candidate_retrieval_count: 0,
    cache_hits: 0,
    cache_misses: 0
  },
  model_metadata = {
    model_id: 'heuristic-evaluator',
    prompt_version: 'v1.4.0-phase4',
    task_version: 'v1.4.0-phase4',
    schema_version: 'v1.4.0'
  }
}) {
  const entity = {
    match_profile_id: String(match_profile_id),
    job_id: String(job_id),
    candidate_id: String(candidate_id),
    requirement_matches: Array.isArray(requirement_matches) ? [...requirement_matches] : [],
    descriptive_summary: { ...descriptive_summary },
    telemetry: { ...telemetry },
    model_metadata: { ...model_metadata }
  };
  assertValidCandidateMatchProfile(entity);
  return entity;
}

/**
 * Factory for MatchProfile (supports legacy v1.2 and Phase 4 v1.4)
 */
export function createMatchProfile(params) {
  if (params && params.match_profile_id) {
    return createCandidateMatchProfile(params);
  }
  const {
    match_id,
    job_id,
    candidate_hash,
    requirement_matches = [],
    yoe_comparison,
    legal_eligibility_status,
    critical_gaps = [],
    transferable_strengths = [],
    overall_match_score
  } = params || {};
  const entity = {
    match_id: String(match_id),
    job_id: String(job_id),
    candidate_hash: String(candidate_hash),
    requirement_matches,
    yoe_comparison: {
      required_yoe: yoe_comparison?.required_yoe !== null && yoe_comparison?.required_yoe !== undefined ? Number(yoe_comparison.required_yoe) : null,
      candidate_verified_yoe: Number(yoe_comparison?.candidate_verified_yoe || 0),
      shortfall: Number(yoe_comparison?.shortfall || 0),
      policy_status: yoe_comparison?.policy_status
    },
    legal_eligibility_status,
    critical_gaps: Array.isArray(critical_gaps) ? critical_gaps : [],
    transferable_strengths: Array.isArray(transferable_strengths) ? transferable_strengths : [],
    overall_match_score: Number(overall_match_score)
  };
  assertValidMatchProfile(entity);
  return entity;
}

/**
 * Factory for RequirementPolicyResult
 */
export function createRequirementPolicyResult({
  requirement_id,
  requirement_match_id,
  importance,
  relation,
  policy_value,
  importance_weight,
  contribution,
  hard_gate_triggered = false,
  reason_codes = [],
  support_references = {
    evidence_ids: [],
    skill_evidence_ids: [],
    capability_ids: [],
    experience_ids: [],
    education_ids: [],
    certification_ids: []
  },
  source_reference_ids = []
}) {
  const entity = {
    requirement_id: String(requirement_id),
    requirement_match_id: String(requirement_match_id),
    importance,
    relation,
    policy_value: Number(policy_value),
    importance_weight: Number(importance_weight),
    contribution: Number(contribution),
    hard_gate_triggered: Boolean(hard_gate_triggered),
    reason_codes: Array.isArray(reason_codes) ? [...reason_codes] : [],
    support_references: {
      evidence_ids: Array.isArray(support_references?.evidence_ids) ? [...support_references.evidence_ids] : [],
      skill_evidence_ids: Array.isArray(support_references?.skill_evidence_ids) ? [...support_references.skill_evidence_ids] : [],
      capability_ids: Array.isArray(support_references?.capability_ids) ? [...support_references.capability_ids] : [],
      experience_ids: Array.isArray(support_references?.experience_ids) ? [...support_references.experience_ids] : [],
      education_ids: Array.isArray(support_references?.education_ids) ? [...support_references.education_ids] : [],
      certification_ids: Array.isArray(support_references?.certification_ids) ? [...support_references.certification_ids] : []
    },
    source_reference_ids: Array.isArray(source_reference_ids) ? [...source_reference_ids] : []
  };
  assertValidRequirementPolicyResult(entity);
  return entity;
}

/**
 * Factory for PolicyConfiguration
 */
export function createPolicyConfiguration({
  policy_version,
  policy_status = 'POLICY_INITIAL',
  relation_values,
  importance_weights,
  score_component_scales,
  priority_band_thresholds,
  hard_gates = []
}) {
  const entity = {
    policy_version: String(policy_version),
    policy_status,
    relation_values: { ...relation_values },
    importance_weights: { ...importance_weights },
    score_component_scales: { ...score_component_scales },
    priority_band_thresholds: { ...priority_band_thresholds },
    hard_gates: Array.isArray(hard_gates) ? [...hard_gates] : []
  };
  assertValidPolicyConfiguration(entity);
  return entity;
}

/**
 * Factory for PolicyAssessment
 */
export function createPolicyAssessment({
  policy_assessment_id,
  job_id,
  candidate_id,
  match_profile_id,
  policy_version,
  requirement_policy_results = [],
  aggregate_components,
  raw_score,
  normalized_score,
  priority_band,
  hard_gate_triggered = false,
  blocker_reasons = [],
  risk_reasons = [],
  positive_reasons = [],
  explanation_facts = [],
  score_breakdown = [],
  telemetry = {
    requirements_evaluated: 0,
    unknown_required_count: 0,
    contradiction_count: 0,
    latency_ms: 0
  }
}) {
  const entity = {
    policy_assessment_id: String(policy_assessment_id),
    job_id: String(job_id),
    candidate_id: String(candidate_id),
    match_profile_id: String(match_profile_id),
    policy_version: String(policy_version),
    requirement_policy_results: Array.isArray(requirement_policy_results) ? [...requirement_policy_results] : [],
    aggregate_components: { ...aggregate_components },
    raw_score: Number(raw_score),
    normalized_score: Number(normalized_score),
    priority_band,
    hard_gate_triggered: Boolean(hard_gate_triggered),
    blocker_reasons: Array.isArray(blocker_reasons) ? [...blocker_reasons] : [],
    risk_reasons: Array.isArray(risk_reasons) ? [...risk_reasons] : [],
    positive_reasons: Array.isArray(positive_reasons) ? [...positive_reasons] : [],
    explanation_facts: Array.isArray(explanation_facts) ? [...explanation_facts] : [],
    score_breakdown: Array.isArray(score_breakdown) ? [...score_breakdown] : [],
    telemetry: { ...telemetry }
  };
  assertValidPolicyAssessment(entity);
  return entity;
}
