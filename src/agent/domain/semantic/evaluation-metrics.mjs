// @ts-check
/**
 * evaluation-metrics.mjs — Comprehensive Evaluation Metrics & Statistical Analysis
 *
 * Implements mathematically sound metrics:
 * - Precision, Recall, F1
 * - Seniority Accuracy
 * - YOE Tolerance Accuracy (|pred - gold| <= 0.5)
 * - False Rejection Rate (FRR) = Qualified Rejected / Total Qualified
 * - False Positive Acceptance Rate (FPAR) = Unqualified Accepted / Total Unqualified
 * - Abstention Rate = (NEEDS_REVIEW + UNCERTAIN) / Total
 * - Coverage = Evaluated non-skipped / Total
 * - Per-Category Error Breakdown
 * - Wilson Score 95% Confidence Intervals for Binomial Proportions
 * - Safe zero-denominator guards
 * - Strict separation of engineering metrics vs empirical annotation quality
 */

/**
 * Safe division with zero denominator handling
 * @param {number} numerator
 * @param {number} denominator
 * @param {number} [fallback=0]
 * @returns {number}
 */
export function safeDivide(numerator, denominator, fallback = 0) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return fallback;
  }
  return numerator / denominator;
}

/**
 * Wilson score 95% confidence interval for a proportion
 * @param {number} successes
 * @param {number} total
 * @param {number} [z=1.96] - 95% confidence z-score
 * @returns {{ lower: number, upper: number, center: number }}
 */
export function wilsonScoreInterval(successes, total, z = 1.96) {
  if (total <= 0) {
    return { lower: 0, upper: 0, center: 0 };
  }
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const halfWidth = (z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denominator;

  return {
    lower: Math.max(0, center - halfWidth),
    upper: Math.min(1, center + halfWidth),
    center: p
  };
}

/**
 * Compute confusion matrix metrics
 * @param {{ tp: number, fp: number, fn: number, tn?: number }} counts
 * @returns {{ precision: number, recall: number, f1: number }}
 */
export function computeBinaryClassificationMetrics({ tp, fp, fn, tn = 0 }) {
  const precision = safeDivide(tp, tp + fp, 0);
  const recall = safeDivide(tp, tp + fn, 0);
  const rawF1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    precision: Number(precision.toFixed(6)),
    recall: Number(recall.toFixed(6)),
    f1: Number(rawF1.toFixed(6))
  };
}

/**
 * Compute comprehensive evaluation benchmark metrics across evaluation results
 *
 * @param {Array<{
 *   sample: object,
 *   prediction: {
 *     job_profile: object,
 *     match_profile: object,
 *     legacy_diagnostics?: object
 *   },
 *   ground_truth?: object
 * }>} results
 * @returns {object} Comprehensive evaluation report
 */
export function computeBenchmarkMetrics(results = []) {
  const totalSamples = results.length;
  if (totalSamples === 0) {
    return {
      total_samples: 0,
      coverage: 0,
      summary: 'No evaluation results provided.'
    };
  }

  let evaluatedCount = 0;
  let abstentionCount = 0;
  let humanVerifiedCount = 0;
  let modelProposedCount = 0;
  let unlabeledCount = 0;

  // Seniority metrics
  let seniorityMatches = 0;
  let seniorityComparable = 0;

  // YOE metrics
  let yoeWithinTolerance = 0;
  let yoeComparable = 0;
  let yoeTotalAbsError = 0;

  // Fit decision metrics
  let qualifiedCount = 0;
  let falseRejects = 0;
  let unqualifiedCount = 0;
  let falseApplies = 0;

  // Latencies & Gateway calls
  const latencies = [];
  let totalGatewayCalls = 0;

  // Per category breakdowns
  const roleBreakdown = {};
  const languageBreakdown = {};
  const rejectionBreakdown = {
    POLICY_DISCARD: 0,
    HEURISTIC_DISCARD: 0,
    ELIGIBILITY_DISCARD: 0,
    MISSING_INFO: 0,
    UNCERTAIN: 0,
    NONE: 0
  };

  for (const { sample, prediction, ground_truth } of results) {
    evaluatedCount++;
    const diagnostics = prediction?.semantic_diagnostics || prediction?.legacy_diagnostics || prediction?.diagnostics || {};
    const latency = diagnostics.latency_ms;
    if (typeof latency === 'number') latencies.push(latency);
    totalGatewayCalls += (diagnostics.gateway_calls || 0);
    const fitStatus = prediction?.match_profile?.yoe_comparison?.policy_status || diagnostics.fit_status || 'UNKNOWN';

    if (fitStatus === 'NEEDS_REVIEW' || diagnostics.rejection_type === 'UNCERTAIN') {
      abstentionCount++;
    }

    const rejType = diagnostics.rejection_type || 'NONE';
    if (rejectionBreakdown[rejType] !== undefined) {
      rejectionBreakdown[rejType]++;
    }

    // Role & Language breakdown (prioritize gold annotation, fallback to metadata/prediction)
    const role = sample?.annotations?.gold_profile?.role_family || sample?.metadata?.role_family || prediction?.job_profile?.role_family || 'other';
    const lang = sample?.metadata?.language || 'en';

    roleBreakdown[role] = (roleBreakdown[role] || 0) + 1;
    languageBreakdown[lang] = (languageBreakdown[lang] || 0) + 1;

    // Ground truth evaluation
    const annotations = sample?.annotations || ground_truth;
    const annotationStatus = annotations?.status || 'UNLABELED';

    if (annotationStatus === 'DUAL_HUMAN_VERIFIED' || annotationStatus === 'ADJUDICATED' || annotationStatus === 'HUMAN_REVIEWED') {
      humanVerifiedCount++;
    } else if (annotationStatus === 'MODEL_PROPOSED') {
      modelProposedCount++;
    } else {
      unlabeledCount++;
    }

    const gold = annotations?.gold_profile;
    if (gold) {
      // 1. Seniority comparison
      if (gold.seniority_level) {
        seniorityComparable++;
        const predLevel = prediction?.job_profile?.seniority?.level;
        if (predLevel === gold.seniority_level) {
          seniorityMatches++;
        }
      }

      // 2. YOE comparison (Tolerance <= 0.5 years)
      if (gold.required_yoe !== undefined && gold.required_yoe !== null) {
        yoeComparable++;
        const predYoe = prediction?.job_profile?.overall_yoe_required ?? 0;
        const diff = Math.abs(predYoe - gold.required_yoe);
        yoeTotalAbsError += diff;
        if (diff <= 0.5) {
          yoeWithinTolerance++;
        }
      }

      // 3. Fit Decision False Rejections & False Accepts
      // Expected fit: STRONG, REASONABLE, LONG_STRETCH are considered qualified
      const isQualified = gold.is_early_career_friendly ||
        gold.expected_fit_verdict === 'STRONG' ||
        gold.expected_fit_verdict === 'REASONABLE';

      if (isQualified) {
        qualifiedCount++;
        // If system rejected or tier0 discarded
        if (fitStatus === 'REJECT' || diagnostics.tier0_passed === false) {
          falseRejects++;
        }
      } else {
        unqualifiedCount++;
        if (fitStatus === 'STRONG' || fitStatus === 'REASONABLE') {
          falseApplies++;
        }
      }
    }
  }

  // Calculate Aggregates
  const coverage = safeDivide(evaluatedCount, totalSamples, 1.0);
  const abstentionRate = safeDivide(abstentionCount, totalSamples, 0);
  const seniorityAccuracy = safeDivide(seniorityMatches, seniorityComparable, 0);
  const yoeAccuracy = safeDivide(yoeWithinTolerance, yoeComparable, 0);
  const yoeMae = safeDivide(yoeTotalAbsError, yoeComparable, 0);

  const falseRejectionRate = safeDivide(falseRejects, qualifiedCount, 0);
  const falsePositiveAcceptanceRate = safeDivide(falseApplies, unqualifiedCount, 0);

  // Latency percentiles
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const totalRuntimeMs = latencies.reduce((a, b) => a + b, 0);

  return {
    metadata: {
      total_samples: totalSamples,
      evaluated_count: evaluatedCount,
      coverage,
      abstention_count: abstentionCount,
      abstention_rate: abstentionRate
    },
    annotation_integrity: {
      human_verified_count: humanVerifiedCount,
      model_proposed_count: modelProposedCount,
      unlabeled_count: unlabeledCount,
      is_human_verified_benchmark: humanVerifiedCount === totalSamples,
      is_provisional: humanVerifiedCount === 0,
      integrity_note: humanVerifiedCount === 0
        ? 'PROVISIONAL BENCHMARK: All gold annotations are MODEL_PROPOSED / SYNTHETIC. Human-ground-truth metrics must be confirmed with independent human adjudicators before deployment.'
        : `PARTIALLY VERIFIED: ${humanVerifiedCount}/${totalSamples} cases reviewed by humans.`
    },
    performance_metrics: {
      seniority_accuracy: {
        score: seniorityAccuracy,
        matches: seniorityMatches,
        comparable: seniorityComparable,
        ci95: wilsonScoreInterval(seniorityMatches, seniorityComparable)
      },
      yoe_tolerance_accuracy: {
        score: yoeAccuracy,
        matches: yoeWithinTolerance,
        comparable: yoeComparable,
        mae: yoeMae,
        ci95: wilsonScoreInterval(yoeWithinTolerance, yoeComparable)
      },
      fit_decision_rates: {
        false_rejection_rate: {
          rate: falseRejectionRate,
          false_rejects: falseRejects,
          total_qualified: qualifiedCount,
          ci95: wilsonScoreInterval(falseRejects, qualifiedCount)
        },
        false_positive_acceptance_rate: {
          rate: falsePositiveAcceptanceRate,
          false_accepts: falseApplies,
          total_unqualified: unqualifiedCount,
          ci95: wilsonScoreInterval(falseApplies, unqualifiedCount)
        }
      }
    },
    operational_telemetry: {
      total_runtime_ms: totalRuntimeMs,
      p50_latency_ms: p50,
      p95_latency_ms: p95,
      total_gateway_calls: totalGatewayCalls,
      calls_per_job: safeDivide(totalGatewayCalls, evaluatedCount, 0)
    },
    breakdowns: {
      by_rejection_type: rejectionBreakdown,
      by_role_family: roleBreakdown,
      by_language: languageBreakdown
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: Skill Intelligence Metrics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute Phase-2 skill extraction + normalization metrics.
 *
 * HONESTY CONTRACT: every metric produced here is measured against a fixed,
 * simulated System-1 extraction response stored in a synthetic fixture. It
 * measures the DETERMINISTIC layers (provenance, requirement lineage,
 * normalization, identity) and says nothing about live model extraction
 * quality. The report is therefore always labelled provisional.
 *
 * @param {Array<{
 *   sample: { id?: string, jd_text?: string, expected?: object },
 *   prediction: { skill_intelligence: object|null, telemetry?: object, error?: string }
 * }>} results
 * @returns {object}
 */
export function computeSkillIntelligenceMetrics(results = []) {
  const total = results.length;
  const provisional = {
    PROVISIONAL: true,
    SYNTHETIC: true,
    SUFFICIENT_FOR_PRODUCTION_PROMOTION: false,
    note:
      'Skill-intelligence metrics are measured against simulated, synthetically authored ground truth. ' +
      'They measure provenance, normalization and identity determinism - NOT live model extraction quality. ' +
      'They are NOT sufficient for production promotion.'
  };

  if (total === 0) {
    return { metadata: { total_samples: 0 }, provisional, note: 'No results provided.' };
  }

  let predictedMentions = 0;
  // Mention precision/recall are computed over DISTINCT normalized surfaces:
  // the same technology restated under two requirement clauses is two mentions
  // but one recognized technology, and counting it twice would understate
  // precision for a system that is behaving correctly.
  const predictedSurfaceSet = new Set();
  const expectedSurfaceSet = new Set();
  let matchedSurfaces = 0;
  let expectedMentions = 0;
  let falseSkills = 0;
  let provenanceValid = 0;
  let provenanceChecked = 0;

  let canonicalComparable = 0;
  let canonicalCorrect = 0;

  let mergeComparable = 0;
  let falseMerges = 0;
  let splitComparable = 0;
  let falseSplits = 0;

  let unresolvedMentions = 0;
  let resolvedMentions = 0;

  let newConceptMentions = 0;

  const latencies = [];
  let totalModelCalls = 0;
  let totalNormalizationCalls = 0;
  let totalRetries = 0;
  let totalCacheHits = 0;
  let totalCacheMisses = 0;
  let failures = 0;
  let provenanceFailureCount = 0;
  let rejectedDecisionCount = 0;

  for (const { sample, prediction } of results) {
    const si = prediction?.skill_intelligence;
    if (!si) {
      failures++;
      continue;
    }
    const telemetry = si.telemetry || {};
    latencies.push(telemetry.extraction_ms + telemetry.normalization_ms);
    totalModelCalls += telemetry.model_calls || 0;
    totalNormalizationCalls += telemetry.normalization_model_calls || 0;
    totalRetries += telemetry.retries || 0;
    totalCacheHits += telemetry.cache_hits || 0;
    totalCacheMisses += telemetry.cache_misses || 0;
    provenanceFailureCount += (si.diagnostics?.rejected_mentions || []).length;
    rejectedDecisionCount += (si.diagnostics?.rejected_normalization_decisions || []).length;

    const jdText = sample?.jd_text || '';
    const mentions = si.mentions || [];
    const concepts = si.concepts || [];
    const conceptById = new Map(concepts.map((c) => [c.concept_id, c]));
    const conceptIdBySurface = new Map();
    for (const m of mentions) {
      conceptIdBySurface.set(m.normalized_surface, m.resolution?.concept_id || null);
    }

    predictedMentions += mentions.length;
    for (const m of mentions) {
      if (m.resolution?.state === 'RESOLVED' || m.resolution?.state === 'NEW_CONCEPT') resolvedMentions++;
      else unresolvedMentions++;
      if (m.resolution?.state === 'NEW_CONCEPT') newConceptMentions++;

      provenanceChecked++;
      const sliced = jdText.slice(m.evidence_span.start_char, m.evidence_span.end_char);
      if (sliced === m.evidence_span.verbatim_quote) provenanceValid++;
    }

    const expected = sample?.expected || {};
    const expectedList = Array.isArray(expected.mentions) ? expected.mentions : [];
    expectedMentions += expectedList.length;

    const expectedSurfaces = expectedList.map((e) => normalizeForComparison(e.surface_form));
    const predictedSurfaces = mentions.map((m) => m.normalized_surface);
    for (const surface of new Set(expectedSurfaces)) expectedSurfaceSet.add(surface);
    for (const surface of new Set(predictedSurfaces)) predictedSurfaceSet.add(surface);

    const forbidden = new Set((expected.forbidden_surfaces || []).map(normalizeForComparison));
    for (const m of mentions) {
      if (forbidden.has(m.normalized_surface)) falseSkills++;
    }

    for (const [surface, expectedConcept] of Object.entries(expected.concept_map || {})) {
      const key = normalizeForComparison(surface);
      if (!conceptIdBySurface.has(key)) continue;
      canonicalComparable++;
      const actual = conceptIdBySurface.get(key);
      const concept = actual ? conceptById.get(actual) : null;
      const actualName = concept?.canonical_name || null;
      const correct = actual === expectedConcept || normalizeForComparison(actualName || '') === normalizeForComparison(expectedConcept);
      if (correct) canonicalCorrect++;
    }

    const present = new Set(predictedSurfaces);
    for (const pair of expected.distinct_pairs || []) {
      const a = normalizeForComparison(pair[0]);
      const b = normalizeForComparison(pair[1]);
      if (!present.has(a) || !present.has(b)) continue;
      mergeComparable++;
      const ca = conceptIdBySurface.get(a);
      const cb = conceptIdBySurface.get(b);
      if (ca && cb && ca === cb) falseMerges++;
    }

    for (const group of expected.equivalence_groups || []) {
      const keys = group.map(normalizeForComparison).filter((k) => present.has(k));
      if (keys.length < 2) continue;
      splitComparable++;
      const ids = new Set(keys.map((k) => conceptIdBySurface.get(k)));
      if (ids.size > 1) falseSplits++;
    }
  }

  for (const surface of predictedSurfaceSet) {
    if (expectedSurfaceSet.has(surface)) matchedSurfaces++;
  }

  latencies.sort((a, b) => a - b);

  return {
    metadata: {
      total_samples: total,
      distinct_predicted_surfaces: predictedSurfaceSet.size,
      distinct_expected_surfaces: expectedSurfaceSet.size,
      failed_samples: failures,
      evaluated_samples: total - failures
    },
    provisional,
    extraction_metrics: {
      // A case that expects no skills and produced none is a perfect
      // extraction, not a 0/0 divide-by-zero reported as failure.
      mention_precision: predictedSurfaceSet.size === 0 && expectedSurfaceSet.size === 0
        ? 1
        : safeDivide(matchedSurfaces, predictedSurfaceSet.size, 0),
      mention_recall: predictedSurfaceSet.size === 0 && expectedSurfaceSet.size === 0
        ? 1
        : safeDivide(matchedSurfaces, expectedSurfaceSet.size, 0),
      mention_f1: (() => {
        if (predictedSurfaceSet.size === 0 && expectedSurfaceSet.size === 0) return 1;
        const p = safeDivide(matchedSurfaces, predictedSurfaceSet.size, 0);
        const r = safeDivide(matchedSurfaces, expectedSurfaceSet.size, 0);
        return p + r > 0 ? Number(((2 * p * r) / (p + r)).toFixed(6)) : 0;
      })(),
      distinct_matched_surfaces: matchedSurfaces,
      false_skill_rate: safeDivide(falseSkills, predictedMentions, 0),
      false_skill_count: falseSkills,
      missed_skill_rate: safeDivide(expectedSurfaceSet.size - matchedSurfaces, expectedSurfaceSet.size, 0),
      provenance_validity_rate: safeDivide(provenanceValid, provenanceChecked, 1),
      provenance_checked: provenanceChecked
    },
    normalization_metrics: {
      canonicalization_accuracy: safeDivide(canonicalCorrect, canonicalComparable, 0),
      canonicalization_comparable: canonicalComparable,
      false_merge_rate: safeDivide(falseMerges, mergeComparable, 0),
      false_merge_comparable: mergeComparable,
      false_merge_count: falseMerges,
      false_split_rate: safeDivide(falseSplits, splitComparable, 0),
      false_split_comparable: splitComparable,
      false_split_count: falseSplits,
      unresolved_rate: safeDivide(unresolvedMentions, predictedMentions, 0),
      resolved_mentions: resolvedMentions,
      unresolved_mentions: unresolvedMentions,
      run_local_concept_rate: safeDivide(newConceptMentions, predictedMentions, 0)
    },
    operational_telemetry: {
      calls_per_job: safeDivide(totalModelCalls, total - failures, 0),
      normalization_calls_per_job: safeDivide(totalNormalizationCalls, total - failures, 0),
      retries_per_job: safeDivide(totalRetries, total - failures, 0),
      failures_per_job: safeDivide(failures, total, 0),
      cache_hit_rate: safeDivide(totalCacheHits, totalCacheHits + totalCacheMisses, 0),
      p50_latency_ms: latencies[Math.floor(latencies.length * 0.5)] || 0,
      p95_latency_ms: latencies[Math.floor(latencies.length * 0.95)] || 0,
      provenance_failure_count: provenanceFailureCount,
      rejected_normalization_decision_count: rejectedDecisionCount
    }
  };
}

/**
 * Compare two skill-intelligence digests for identity stability across runs.
 * @param {string} digestA
 * @param {string} digestB
 * @returns {{ stable: boolean }}
 */
export function conceptIdStability(digestA, digestB) {
  return { stable: typeof digestA === 'string' && digestA === digestB };
}

/** Local comparison fold, kept private so metric semantics cannot drift. */
function normalizeForComparison(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\+\+/g, 'plusplus')
    .replace(/\+/g, 'plus')
    .replace(/#/g, 'sharp')
    .replace(/&/g, 'and')
    .replace(/\//g, 'slash')
    .replace(/\./g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}
