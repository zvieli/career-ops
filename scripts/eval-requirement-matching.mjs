#!/usr/bin/env node
// @ts-check
/**
 * scripts/eval-requirement-matching.mjs — Phase 4 Requirement Matching Benchmark
 *
 * Runs offline, deterministic requirement-level semantic matching evaluation over
 * synthetic adversarial fixtures.
 *
 * HONESTY CONTRACT:
 * All metrics reported here are measured against simulated, synthetically authored
 * requirement/candidate fixture ground truth. They measure evidence awareness,
 * semantic relation accuracy, composite boundary enforcement, and reference integrity.
 * They are explicitly PROVISIONAL, SYNTHETIC, and NOT sufficient for production cutover.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../lib/is-main-module.mjs';
import {
  matchRequirement,
  REQUIREMENT_MATCHING_TASK_VERSION
} from '../src/agent/domain/semantic/requirement-matcher.mjs';
import { createDeterministicTestFakeRunner } from '../src/agent/domain/semantic/test-fakes/deterministic-matching-fake.mjs';
import { assertValidRequirementMatchResult } from '../src/agent/domain/semantic/semantic-entities.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DATASET = 'evals/fixtures/requirement-matching-adversarial.json';

function parseCliArgs(argv) {
  const args = {
    dataset: DEFAULT_DATASET,
    strict: false,
    json: false,
    output: null,
    help: false
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--strict') args.strict = true;
    else if (a === '--json') args.json = true;
    else if (a === '--output' && i + 1 < argv.length) args.output = argv[++i];
    else if (a === '--dataset' && i + 1 < argv.length) args.dataset = argv[++i];
  }
  return args;
}

function printUsage() {
  console.log(`
Usage: node scripts/eval-requirement-matching.mjs [options]

Options:
  --strict            Exit with code 1 if any assertion fails
  --json              Output machine-readable JSON report
  --output <path>     Write JSON report to disk
  --dataset <path>    Fixture file (default: ${DEFAULT_DATASET})
  --help, -h          Print this help message
`.trim());
}

/**
 * Run evaluation over fixture file.
 *
 * @param {object} args
 * @returns {Promise<{ passed: boolean, report: object }>}
 */
export async function runRequirementMatchingBenchmark(args) {
  const fixturePath = resolve(ROOT, args.dataset);
  let rawCases;
  try {
    rawCases = JSON.parse(readFileSync(fixturePath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to load fixture dataset from ${fixturePath}: ${err.message}`);
  }

  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    throw new Error(`Fixture dataset at ${fixturePath} is empty or not an array`);
  }

  const results = [];
  let totalCases = rawCases.length;
  let passedCases = 0;
  let failedCases = 0;

  // Granular metric counters
  let totalRelationTests = 0;
  let correctRelations = 0;
  let satisfiesFalsePositives = 0;
  let satisfiesFalseNegatives = 0;

  let partialTests = 0;
  let partialCorrect = 0;

  let noEvidenceTests = 0;
  let noEvidenceCorrect = 0;

  let contradictsTests = 0;
  let contradictsCorrect = 0;

  let unknownCount = 0;

  let missingMandatoryFalseSatisfies = 0;
  let orBranchTests = 0;
  let orBranchCorrect = 0;
  let andBranchTests = 0;
  let andBranchCorrect = 0;

  let positiveMatchWithoutEvidence = 0;
  let danglingReferences = 0;
  let wrongCandidateEvidence = 0;
  let provenanceCompleteCount = 0;

  let projectToProfessionalFalseSatisfies = 0;
  let testToProductionFalseSatisfies = 0;
  let courseToCertFalseSatisfies = 0;
  let inProgressToCompletedFalseSatisfies = 0;
  let familiarityToImplFalseSatisfies = 0;
  let skillOnlyToYoeFalseSatisfies = 0;

  const latencies = [];
  let totalCandidatesRetrieved = 0;

  const testFake = createDeterministicTestFakeRunner({ semanticOrigin: 'BENCHMARK_SYNTHETIC' });

  for (const c of rawCases) {
    const startTime = Date.now();
    const caseErrors = [];

    let match;
    try {
      match = await matchRequirement({
        requirement: c.requirement,
        candidateProfile: c.candidate,
        modelRunner: testFake,
        options: { modelId: 'benchmark-synthetic-runner' }
      });
      assertValidRequirementMatchResult(match);
    } catch (err) {
      caseErrors.push(`Execution error: ${err.message}`);
    }

    const elapsed = Date.now() - startTime;
    latencies.push(elapsed);

    if (match) {
      if (match.relation === 'UNKNOWN') unknownCount++;

      // Check relation correctness
      totalRelationTests++;
      if (c.expected.relation) {
        if (c.expected.relation === 'PARTIALLY_SUPPORTS') {
          partialTests++;
          if (match.relation === 'PARTIALLY_SUPPORTS') partialCorrect++;
        }
        if (c.expected.relation === 'NO_EVIDENCE') {
          noEvidenceTests++;
          if (match.relation === 'NO_EVIDENCE') noEvidenceCorrect++;
        }
        if (c.expected.relation === 'CONTRADICTS') {
          contradictsTests++;
          if (match.relation === 'CONTRADICTS') contradictsCorrect++;
        }

        if (match.relation === c.expected.relation) {
          correctRelations++;
        } else {
          caseErrors.push(`Relation mismatch: expected ${c.expected.relation}, got ${match.relation}`);
          if (match.relation === 'SATISFIES') satisfiesFalsePositives++;
          if (c.expected.relation === 'SATISFIES') satisfiesFalseNegatives++;
        }
      }

      // Check forbidden relations
      if (Array.isArray(c.expected.forbidden_relations)) {
        for (const forbidden of c.expected.forbidden_relations) {
          if (match.relation === forbidden) {
            caseErrors.push(`Forbidden relation produced: ${forbidden}`);
            if (forbidden === 'SATISFIES') {
              satisfiesFalsePositives++;

              // Categorize boundary violation
              const reqText = String(c.requirement.description || '').toLowerCase();
              if (/\bprofessional\b/.test(reqText)) projectToProfessionalFalseSatisfies++;
              if (/\bproduction\b/.test(reqText)) testToProductionFalseSatisfies++;
              if (/\bcertif/.test(reqText)) courseToCertFalseSatisfies++;
              if (/\bdegree|bachelor\b/.test(reqText)) inProgressToCompletedFalseSatisfies++;
              if (/\bdesigned|led\b/.test(reqText)) familiarityToImplFalseSatisfies++;
              if (c.requirement.min_years) skillOnlyToYoeFalseSatisfies++;
              if (c.id === 'RM-30') missingMandatoryFalseSatisfies++;
            }
          }
        }
      }

      // Logic composition tests
      if (c.id === 'RM-22') {
        orBranchTests++;
        if (match.relation === 'SATISFIES') orBranchCorrect++;
      }
      if (c.id === 'RM-23') {
        andBranchTests++;
        if (match.relation === 'PARTIALLY_SUPPORTS') andBranchCorrect++;
      }

      // Evidence integrity tests
      const totalSupportRefs = (match.candidate_evidence_ids?.length || 0) +
        (match.candidate_skill_evidence_ids?.length || 0) +
        (match.candidate_capability_ids?.length || 0) +
        (match.candidate_experience_ids?.length || 0) +
        (match.candidate_education_ids?.length || 0) +
        (match.candidate_certification_ids?.length || 0);

      totalCandidatesRetrieved += match._retrieval_metadata?.total_bundle_items || 0;

      if ((match.relation === 'SATISFIES' || match.relation === 'PARTIALLY_SUPPORTS') && totalSupportRefs === 0) {
        positiveMatchWithoutEvidence++;
        caseErrors.push('Positive match relation without supporting candidate references');
      }

      // Check dangling references across all 6 categories using stable IDs
      const validEvIds = new Set((c.candidate.evidence || []).map((e) => e.evidence_id));
      const validSkillIds = new Set((c.candidate.skills || []).map((s) => s.skill_evidence_id));
      const validCapIds = new Set((c.candidate.capabilities || []).map((cap) => cap.capability_id));
      const validExpIds = new Set((c.candidate.experiences || []).map((exp) => exp.experience_id));
      const validEduIds = new Set((c.candidate.education || []).map((edu) => edu.education_id));
      const validCertIds = new Set((c.candidate.certifications || []).map((cert) => cert.certification_id));

      for (const id of match.candidate_evidence_ids || []) {
        if (!validEvIds.has(id)) {
          danglingReferences++;
          caseErrors.push(`Dangling evidence ID referenced: ${id}`);
        }
      }
      for (const id of match.candidate_skill_evidence_ids || []) {
        if (!validSkillIds.has(id)) {
          danglingReferences++;
          caseErrors.push(`Dangling skill evidence ID referenced: ${id}`);
        }
      }
      for (const id of match.candidate_capability_ids || []) {
        if (!validCapIds.has(id)) {
          danglingReferences++;
          caseErrors.push(`Dangling capability ID referenced: ${id}`);
        }
      }
      for (const id of match.candidate_experience_ids || []) {
        if (!validExpIds.has(id)) {
          danglingReferences++;
          caseErrors.push(`Dangling experience ID referenced: ${id}`);
        }
      }
      for (const id of match.candidate_education_ids || []) {
        if (!validEduIds.has(id)) {
          danglingReferences++;
          caseErrors.push(`Dangling education ID referenced: ${id}`);
        }
      }
      for (const id of match.candidate_certification_ids || []) {
        if (!validCertIds.has(id)) {
          danglingReferences++;
          caseErrors.push(`Dangling certification ID referenced: ${id}`);
        }
      }

      // Check fixture-declared forbidden and allowed candidate evidence IDs (zero lexical heuristics)
      if (Array.isArray(c.expected.forbidden_candidate_evidence_ids)) {
        for (const evId of match.candidate_evidence_ids || []) {
          if (c.expected.forbidden_candidate_evidence_ids.includes(evId)) {
            wrongCandidateEvidence++;
            caseErrors.push(`Referenced forbidden candidate evidence ID: ${evId}`);
          }
        }
      }
      if (Array.isArray(c.expected.allowed_candidate_evidence_ids) && c.expected.allowed_candidate_evidence_ids.length > 0) {
        for (const evId of match.candidate_evidence_ids || []) {
          if (!c.expected.allowed_candidate_evidence_ids.includes(evId)) {
            wrongCandidateEvidence++;
            caseErrors.push(`Referenced unexpected candidate evidence ID: ${evId}`);
          }
        }
      }

      // Provenance check
      if (match.provenance && match.provenance.requirement_id) {
        if (match.relation === 'SATISFIES' && (!match.provenance.candidate_evidence_quotes || match.provenance.candidate_evidence_quotes.length === 0)) {
          caseErrors.push('Provenance incomplete: SATISFIES without candidate evidence quotes');
        } else {
          provenanceCompleteCount++;
        }
      } else {
        caseErrors.push('Missing provenance block in match result');
      }
    }

    const passed = caseErrors.length === 0;
    if (passed) passedCases++;
    else failedCases++;

    results.push({
      id: c.id,
      title: c.title,
      passed,
      errors: caseErrors,
      actual_relation: match?.relation,
      expected_relation: c.expected.relation
    });
  }

  // Calculate dynamic metrics
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;

  const report = {
    benchmark: 'candidate_requirement_matching_adversarial',
    evaluation_nature: 'PROVISIONAL_SYNTHETIC',
    sufficient_for_production: false,
    task_version: REQUIREMENT_MATCHING_TASK_VERSION,
    timestamp: new Date().toISOString(),
    summary: {
      total_cases: totalCases,
      passed_cases: passedCases,
      failed_cases: failedCases,
      case_pass_rate: totalCases > 0 ? passedCases / totalCases : 0
    },
    metrics: {
      requirement_relation: {
        exact_relation_accuracy: totalRelationTests > 0 ? correctRelations / totalRelationTests : 0,
        satisfies_false_positive_count: satisfiesFalsePositives,
        satisfies_false_negative_count: satisfiesFalseNegatives,
        partially_supports_accuracy: partialTests > 0 ? partialCorrect / partialTests : 0,
        no_evidence_accuracy: noEvidenceTests > 0 ? noEvidenceCorrect / noEvidenceTests : 0,
        contradicts_accuracy: contradictsTests > 0 ? contradictsCorrect / contradictsTests : 0,
        unknown_rate: totalCases > 0 ? unknownCount / totalCases : 0
      },
      composite_requirements: {
        missing_mandatory_dimension_false_satisfaction_count: missingMandatoryFalseSatisfies,
        or_branch_resolution_accuracy: orBranchTests > 0 ? orBranchCorrect / orBranchTests : 0,
        and_branch_partial_support_accuracy: andBranchTests > 0 ? andBranchCorrect / andBranchTests : 0
      },
      evidence_integrity: {
        positive_match_without_evidence_count: positiveMatchWithoutEvidence,
        dangling_reference_count: danglingReferences,
        wrong_candidate_evidence_reference_count: wrongCandidateEvidence,
        provenance_completeness_rate: totalCases > 0 ? provenanceCompleteCount / totalCases : 0
      },
      semantic_boundaries: {
        project_to_professional_false_satisfaction: projectToProfessionalFalseSatisfies,
        test_to_production_false_satisfaction: testToProductionFalseSatisfies,
        course_to_certification_false_satisfaction: courseToCertFalseSatisfies,
        in_progress_to_completed_degree_false_satisfaction: inProgressToCompletedFalseSatisfies,
        familiarity_to_implementation_false_satisfaction: familiarityToImplFalseSatisfies,
        skill_only_to_yoe_false_satisfaction: skillOnlyToYoeFalseSatisfies
      },
      system: {
        calls_per_pair: 0,
        calls_per_requirement: 0,
        evidence_candidates_retrieved: totalCandidatesRetrieved,
        cache_hits: 0,
        latency_p50_ms: p50,
        latency_p95_ms: p95
      }
    },
    case_results: results
  };

  const allPassed = failedCases === 0;
  return { passed: allPassed, report };
}

// CLI entrypoint
if (isMainModule(import.meta.url)) {
  const args = parseCliArgs(process.argv);
  if (args.help) {
    printUsage();
    process.exit(0);
  }

  runRequirementMatchingBenchmark(args)
    .then(({ passed, report }) => {
      if (args.output) {
        writeFileSync(resolve(ROOT, args.output), JSON.stringify(report, null, 2), 'utf8');
      }

      if (args.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`\n==================================================`);
        console.log(`Phase 4 Requirement Matching Adversarial Benchmark`);
        console.log(`STATUS: ${passed ? 'PASS' : 'FAIL'} (${report.summary.passed_cases}/${report.summary.total_cases} cases)`);
        console.log(`Exact Relation Accuracy: ${(report.metrics.requirement_relation.exact_relation_accuracy * 100).toFixed(1)}%`);
        console.log(`SATISFIES False Positives: ${report.metrics.requirement_relation.satisfies_false_positive_count}`);
        console.log(`Dangling References: ${report.metrics.evidence_integrity.dangling_reference_count}`);
        console.log(`Boundary Violations: ${
          report.metrics.semantic_boundaries.project_to_professional_false_satisfaction +
          report.metrics.semantic_boundaries.test_to_production_false_satisfaction +
          report.metrics.semantic_boundaries.course_to_certification_false_satisfaction
        }`);
        console.log(`NOTE: Metrics are PROVISIONAL and SYNTHETIC.`);
        console.log(`==================================================\n`);

        if (!passed) {
          report.case_results.filter((r) => !r.passed).forEach((r) => {
            console.error(`❌ [${r.id}] ${r.title}: ${r.errors.join('; ')}`);
          });
        }
      }

      if (args.strict && !passed) {
        process.exit(1);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error(`FATAL: ${err.message}`);
      process.exit(1);
    });
}
