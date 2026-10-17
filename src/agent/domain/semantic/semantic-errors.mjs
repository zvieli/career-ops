// @ts-check
/**
 * semantic-errors.mjs — Typed Semantic Failure Taxonomy (shared)
 *
 * Extracted from job-semantic-profiler.mjs so that Phase-2 modules
 * (skill-concept-registry, skill-normalization, skill-intelligence) can raise
 * typed failures WITHOUT importing the profiler, which itself imports them.
 * That import direction would be a cycle; the class definition lives here and
 * job-semantic-profiler.mjs re-exports it unchanged, so every existing
 * `import { SemanticProfilerError } from './job-semantic-profiler.mjs'` keeps
 * working.
 *
 * Failure taxonomy invariant (Phase 2):
 *   UNKNOWN is semantic uncertainty.
 *   SCHEMA_VALIDATION_FAILED / INVALID_STRUCTURED_OUTPUT / CONCEPT_REGISTRY_ERROR
 *   are engineering or runtime failures.
 * The two must never be conflated: an engineering error must not be silently
 * downgraded into a semantic "we don't know".
 */

export const SEMANTIC_FAILURE_CODES = Object.freeze([
  // ── transport / provider ────────────────────────────────────────────────
  'MODEL_UNAVAILABLE',
  'MODEL_TIMEOUT',
  'MODEL_TRANSPORT_ERROR',
  // ── structured output / schema ──────────────────────────────────────────
  'INVALID_STRUCTURED_OUTPUT',
  'SCHEMA_VALIDATION_FAILED',
  'PROVENANCE_VALIDATION_FAILED',
  // ── semantic abstention (NOT engineering failures) ──────────────────────
  'INSUFFICIENT_EVIDENCE',
  'AMBIGUOUS_REQUIREMENTS',
  'LOW_CONFIDENCE',
  // ── safety ──────────────────────────────────────────────────────────────
  'PROMPT_SAFETY_FAILURE',
  // ── Phase 2: skill intelligence ─────────────────────────────────────────
  'AMBIGUOUS_SKILL',
  'NORMALIZATION_UNRESOLVED',
  'CONCEPT_REGISTRY_ERROR',
  'CONCEPT_ID_COLLISION',
  'CONCEPT_ALIAS_CONFLICT',
  'NORMALIZATION_DECISION_REJECTED',
  'INTERNAL_ERROR'
]);

export class SemanticProfilerError extends Error {
  /**
   * @param {string} code - One of SEMANTIC_FAILURE_CODES
   * @param {string} message
   * @param {object} [details={}]
   */
  constructor(code, message, details = {}) {
    super(`[${code}] ${message}`);
    this.name = 'SemanticProfilerError';
    this.code = code;
    this.details = details;
  }
}

/**
 * True when a failure code describes semantic uncertainty rather than an
 * engineering/runtime fault. Used to keep the two classes distinct in
 * telemetry and in the benchmark failure breakdown.
 * @param {string} code
 * @returns {boolean}
 */
export function isSemanticUncertaintyCode(code) {
  return code === 'INSUFFICIENT_EVIDENCE' ||
    code === 'AMBIGUOUS_REQUIREMENTS' ||
    code === 'LOW_CONFIDENCE' ||
    code === 'AMBIGUOUS_SKILL' ||
    code === 'NORMALIZATION_UNRESOLVED';
}