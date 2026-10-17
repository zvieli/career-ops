// @ts-check
/**
 * policy-configuration.mjs — Phase 5 Match Policy Configuration as Data
 *
 * Implements explicit, versioned, transparent match policy rules:
 * - Policy as versioned data: no magic numbers scattered in code.
 * - Explicit relation values (SATISFIES, PARTIAL, RELATED, NO_EVIDENCE, UNKNOWN, CONTRADICTS).
 * - Importance weights (REQUIRED vs PREFERRED vs OPTIONAL).
 * - Component score limits (Required 70, Preferred 20, Optional 10).
 * - Calibrated penalty factors and priority band thresholds.
 * - Explicit hard gates.
 */

import { createPolicyConfiguration } from './semantic-entities.mjs';

export const DEFAULT_POLICY_VERSION = 'phase5-v1.0';

/**
 * Standard Phase-5 Default Match Policy Configuration
 */
export const DEFAULT_POLICY_SPEC = Object.freeze({
  policy_version: DEFAULT_POLICY_VERSION,
  policy_status: 'POLICY_INITIAL',
  relation_values: Object.freeze({
    SATISFIES: 1.0,
    PARTIALLY_SUPPORTS: 0.5,
    RELATED_BUT_INSUFFICIENT: 0.1,
    NO_EVIDENCE: 0.0,
    UNKNOWN: 0.0,
    CONTRADICTS: -1.5
  }),
  importance_weights: Object.freeze({
    LEGAL_MANDATORY: 1.0,
    REQUIRED: 1.0,
    PREFERRED: 0.4,
    OPTIONAL: 0.1,
    RESPONSIBILITY: 0.2,
    CONTEXT: 0.1
  }),
  score_component_scales: Object.freeze({
    required_max: 70,
    preferred_max: 20,
    optional_max: 5,
    evidence_quality_max: 5,
    contradiction_penalty_per_item: 25,
    uncertainty_penalty_per_item: 5
  }),
  priority_band_thresholds: Object.freeze({
    high_priority_floor: 75,
    medium_priority_floor: 50,
    max_tolerated_unknown_required_ratio: 0.5
  }),
  hard_gates: Object.freeze([
    Object.freeze({
      gate_id: 'gate-legal-auth-contradiction',
      trigger_source: 'UNRESOLVED_DIMENSION',
      trigger_value: 'requires_sponsorship_contradiction',
      action: 'BLOCK_OPPORTUNITY',
      reason_code: 'HARD_GATE_LEGAL_CONTRADICTION'
    }),
    Object.freeze({
      gate_id: 'gate-security-clearance-contradiction',
      trigger_source: 'UNRESOLVED_DIMENSION',
      trigger_value: 'security_clearance_unsupported',
      action: 'BLOCK_OPPORTUNITY',
      reason_code: 'HARD_GATE_CLEARANCE_CONTRADICTION'
    }),
    Object.freeze({
      gate_id: 'gate-legal-type-contradiction',
      trigger_source: 'REQUIREMENT_TYPE',
      trigger_value: 'LEGAL_ADMINISTRATIVE',
      action: 'BLOCK_OPPORTUNITY',
      reason_code: 'HARD_GATE_LEGAL_CONTRADICTION'
    })
  ])
});

/**
 * Get validated PolicyConfiguration instance
 * @param {object} [customOverrides]
 * @returns {object} Validated PolicyConfiguration
 */
export function getPolicyConfiguration(customOverrides = {}) {
  const merged = {
    ...DEFAULT_POLICY_SPEC,
    ...customOverrides,
    relation_values: {
      ...DEFAULT_POLICY_SPEC.relation_values,
      ...customOverrides.relation_values
    },
    importance_weights: {
      ...DEFAULT_POLICY_SPEC.importance_weights,
      ...customOverrides.importance_weights
    },
    score_component_scales: {
      ...DEFAULT_POLICY_SPEC.score_component_scales,
      ...customOverrides.score_component_scales
    },
    priority_band_thresholds: {
      ...DEFAULT_POLICY_SPEC.priority_band_thresholds,
      ...customOverrides.priority_band_thresholds
    },
    hard_gates: customOverrides.hard_gates || DEFAULT_POLICY_SPEC.hard_gates
  };

  return createPolicyConfiguration(merged);
}
