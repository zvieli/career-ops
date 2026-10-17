// @ts-check
/**
 * job-ranker.mjs — Phase 5 Deterministic Multi-Job Ranking & Tie-Breaking Engine
 *
 * Implements pure deterministic job ranking:
 * - "MODELS UNDERSTAND. CODE DECIDES."
 * - Zero model involvement in ranking or sorting.
 * - Input-order independent: permuting the input array produces the exact same rank order.
 * - Explicit, documented tie-breakers:
 *   1. normalized_score (descending)
 *   2. contradiction_count (ascending — fewer contradictions wins)
 *   3. required_coverage (descending — greater required coverage wins)
 *   4. unknown_required_count (ascending — fewer unknowns wins)
 *   5. job_id (ascending lexicographical — stable identity tie-break)
 */

/**
 * Compare two PolicyAssessments deterministically using explicit tie-breakers.
 *
 * @param {object} a PolicyAssessment
 * @param {object} b PolicyAssessment
 * @returns {number} Negative if a ranks ahead of b, positive if b ranks ahead of a, 0 if identical
 */
export function compareAssessments(a, b) {
  // 1. Normalized Score (Descending)
  const scoreDiff = b.normalized_score - a.normalized_score;
  if (Math.abs(scoreDiff) >= 0.001) {
    return scoreDiff;
  }

  // 2. Contradiction Count (Ascending — fewer contradictions ranks higher)
  const aContradictions = a.telemetry?.contradiction_count ?? 0;
  const bContradictions = b.telemetry?.contradiction_count ?? 0;
  const contradictionDiff = aContradictions - bContradictions;
  if (contradictionDiff !== 0) {
    return contradictionDiff;
  }

  // 3. Required Coverage (Descending — greater required coverage ranks higher)
  const aRequired = a.aggregate_components?.required_coverage ?? 0;
  const bRequired = b.aggregate_components?.required_coverage ?? 0;
  const requiredDiff = bRequired - aRequired;
  if (Math.abs(requiredDiff) >= 0.001) {
    return requiredDiff;
  }

  // 4. Unknown Required Count (Ascending — fewer unknowns ranks higher)
  const aUnknown = a.telemetry?.unknown_required_count ?? 0;
  const bUnknown = b.telemetry?.unknown_required_count ?? 0;
  const unknownDiff = aUnknown - bUnknown;
  if (unknownDiff !== 0) {
    return unknownDiff;
  }

  // 5. Stable Job ID (Ascending lexicographical)
  const aId = String(a.job_id || '');
  const bId = String(b.job_id || '');
  return aId.localeCompare(bId);
}

/**
 * Rank multiple job assessments deterministically.
 *
 * @param {Array<object>} assessments Array of PolicyAssessment objects
 * @returns {Array<object>} Ranked list of assessments with rank and tie-breaker metadata
 */
export function rankJobAssessments(assessments = []) {
  if (!Array.isArray(assessments)) {
    throw new TypeError('assessments must be an array');
  }

  // Make a shallow copy to prevent mutating the input array
  const copies = assessments.map((item, idx) => ({ item, initialIdx: idx }));

  // Deterministic stable sort
  copies.sort((x, y) => compareAssessments(x.item, y.item));

  return copies.map((entry, index) => {
    return {
      rank: index + 1,
      job_id: entry.item.job_id,
      normalized_score: entry.item.normalized_score,
      priority_band: entry.item.priority_band,
      policy_assessment_id: entry.item.policy_assessment_id,
      assessment: entry.item
    };
  });
}
