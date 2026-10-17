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

export const MATCH_RELATIONS = Object.freeze([
  'EXACT',
  'EQUIVALENT',
  'STRONG_RELATED',
  'TRANSFERABLE',
  'PARTIAL',
  'NO_EVIDENCE',
  'UNKNOWN'
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
  'user-stated'
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
export const validateCandidateCapability = (data) => validateEntity('CandidateCapability', data);
export const validateJobRequirement = (data) => validateEntity('JobRequirement', data);
export const validateJobSemanticProfile = (data) => validateEntity('JobSemanticProfile', data);
export const validateCandidateSemanticProfile = (data) => validateEntity('CandidateSemanticProfile', data);
export const validateRequirementMatch = (data) => validateEntity('RequirementMatch', data);
export const validateMatchProfile = (data) => validateEntity('MatchProfile', data);

export const assertValidSkillConcept = (data) => assertValidEntity('SkillConcept', data);
export const assertValidCandidateCapability = (data) => assertValidEntity('CandidateCapability', data);
export const assertValidJobRequirement = (data) => assertValidEntity('JobRequirement', data);
export const assertValidJobSemanticProfile = (data) => assertValidEntity('JobSemanticProfile', data);
export const assertValidCandidateSemanticProfile = (data) => assertValidEntity('CandidateSemanticProfile', data);
export const assertValidRequirementMatch = (data) => assertValidEntity('RequirementMatch', data);
export const assertValidMatchProfile = (data) => assertValidEntity('MatchProfile', data);

/**
 * Factory for SkillConcept
 */
export function createSkillConcept({
  concept_id,
  canonical_name,
  category,
  surface_forms = [],
  parent_concept_id = null,
  ecosystem = null
}) {
  const entity = {
    concept_id: String(concept_id || '').toLowerCase().trim(),
    canonical_name: String(canonical_name || '').trim(),
    category,
    surface_forms: Array.from(new Set(surface_forms.map((s) => String(s).trim()))).filter(Boolean),
    parent_concept_id: parent_concept_id ? String(parent_concept_id).toLowerCase().trim() : null,
    ecosystem: ecosystem ? String(ecosystem).trim() : null
  };
  assertValidSkillConcept(entity);
  return entity;
}

/**
 * Factory for CandidateCapability
 */
export function createCandidateCapability({
  capability_id,
  concept_id,
  name,
  depth = 'PRACTICAL',
  years_experience = null,
  is_verified = true,
  provenance
}) {
  const entity = {
    capability_id: String(capability_id),
    concept_id: String(concept_id).toLowerCase().trim(),
    name: String(name),
    depth,
    years_experience: years_experience !== null && years_experience !== undefined ? Number(years_experience) : null,
    is_verified: Boolean(is_verified),
    provenance: {
      source_file: provenance?.source_file,
      verbatim_quote: String(provenance?.verbatim_quote || ''),
      source_hash: String(provenance?.source_hash || ''),
      start_char: provenance?.start_char !== undefined && provenance?.start_char !== null ? Number(provenance.start_char) : null,
      end_char: provenance?.end_char !== undefined && provenance?.end_char !== null ? Number(provenance.end_char) : null
    }
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
  verified_yoe,
  verified_yoe_source,
  capabilities = [],
  education = [],
  legal_eligibility,
  target_roles = [],
  provenance_summary
}) {
  const entity = {
    candidate_id: String(candidate_id),
    candidate_hash: String(candidate_hash),
    verified_yoe: Number(verified_yoe),
    verified_yoe_source,
    capabilities,
    education: education.map((edu) => ({
      degree: String(edu.degree),
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
    }
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
 * Factory for MatchProfile
 */
export function createMatchProfile({
  match_id,
  job_id,
  candidate_hash,
  requirement_matches = [],
  yoe_comparison,
  legal_eligibility_status,
  critical_gaps = [],
  transferable_strengths = [],
  overall_match_score
}) {
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
