// @ts-check
/**
 * semantic-engine-interface.mjs — Formal Contract for Future System-1 Semantic Evaluation Engines
 *
 * NOTE: Phase 0 establishes the interface and measurement harness.
 * In accordance with Phase 0 architectural invariants:
 * - NO FAKE SEMANTIC ENGINE IS IMPLEMENTED.
 * - The semantic engine will be implemented in Phase 1 (System-1 bundled extraction).
 * - Invoking evaluate() on this interface in Phase 0 throws or returns an explicit NOT_IMPLEMENTED status.
 */

/**
 * @typedef {object} SemanticEngineOptions
 * @property {string} [modelTier='SYSTEM1']
 * @property {string} [modelId]
 * @property {boolean} [enableSystem2Escalation=false]
 */

/**
 * Interface contract for future semantic engines
 */
export class ISemanticEngine {
  constructor(options = {}) {
    /** @type {SemanticEngineOptions} */
    this.options = options;
    this.engineName = 'semantic-system1';
    this.isImplemented = false;
  }

  /**
   * Run semantic evaluation on a benchmark sample
   * @param {object} params
   * @param {object} params.sample
   * @param {object} [params.candidateProfile]
   * @returns {Promise<never>}
   */
  async evaluate(params) {
    const error = new Error(
      'Semantic engine is an interface contract in Phase 0 and is not yet implemented. ' +
      'Phase 0 establishes the evaluation harness, schemas, provenance validators, and legacy baseline. ' +
      'Semantic System-1 extraction will be implemented in Phase 1.'
    );
    // @ts-ignore
    error.code = 'ERR_SEMANTIC_ENGINE_NOT_IMPLEMENTED';
    throw error;
  }
}
