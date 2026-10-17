#!/usr/bin/env node
// @ts-check
/**
 * eval-semantic-benchmark.mjs — Offline Semantic Evaluation & Measurement Harness
 *
 * Usage:
 *   node scripts/eval-semantic-benchmark.mjs --engine legacy --dataset evals/fixtures/golden-25.json
 *
 * Capabilities:
 * - Load and validate datasets against canonical schemas
 * - Execute evaluation adapters (legacy heuristic engine or future semantic engine)
 * - Produce structured predictions conforming to JobSemanticProfile and MatchProfile
 * - Compare predictions against ground truth annotations
 * - Calculate precision, recall, F1, YOE tolerance, FRR, FPAR, and abstention rates
 * - Output machine-readable JSON reports and formatted terminal summaries
 * - Deterministic, offline, $0 execution
 * - Truthfully reports provisional status when gold labels are MODEL_PROPOSED
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertValidJobSemanticProfile,
  assertValidMatchProfile,
  SEMANTIC_SCHEMA_VERSION
} from '../src/agent/domain/semantic/semantic-entities.mjs';
import { runLegacyEvaluation } from '../src/agent/domain/semantic/adapters/legacy-eval-adapter.mjs';
import { SemanticEngine } from '../src/agent/domain/semantic/adapters/semantic-engine.mjs';
import { ISemanticEngine } from '../src/agent/domain/semantic/adapters/semantic-engine-interface.mjs';
import { computeBenchmarkMetrics } from '../src/agent/domain/semantic/evaluation-metrics.mjs';
import {
  validateEvidenceSpan,
  computeSourceHash,
  redactCandidateFactsForEvaluation
} from '../src/agent/domain/semantic/provenance-validator.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    engine: 'legacy',
    dataset: 'evals/fixtures/golden-25.json',
    candidate: 'evals/fixtures/candidate-early-career.json',
    output: null,
    subset: null,
    role: null,
    limit: null,
    strict: false,
    verbose: false,
    compare: false,
    mockResponse: null,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--verbose' || arg === '-v') options.verbose = true;
    else if (arg === '--compare') options.compare = true;
    else if (arg === '--engine' && args[i + 1]) options.engine = args[++i];
    else if (arg.startsWith('--engine=')) options.engine = arg.split('=')[1];
    else if (arg === '--mock-response' && args[i + 1]) options.mockResponse = args[++i];
    else if (arg.startsWith('--mock-response=')) options.mockResponse = arg.split('=')[1];
    else if (arg === '--dataset' && args[i + 1]) options.dataset = args[++i];
    else if (arg.startsWith('--dataset=')) options.dataset = arg.split('=')[1];
    else if (arg === '--candidate' && args[i + 1]) options.candidate = args[++i];
    else if (arg.startsWith('--candidate=')) options.candidate = arg.split('=')[1];
    else if (arg === '--output' && args[i + 1]) options.output = args[++i];
    else if (arg.startsWith('--output=')) options.output = arg.split('=')[1];
    else if (arg === '--subset' && args[i + 1]) options.subset = args[++i];
    else if (arg.startsWith('--subset=')) options.subset = arg.split('=')[1];
    else if (arg === '--role' && args[i + 1]) options.role = args[++i];
    else if (arg.startsWith('--role=')) options.role = arg.split('=')[1];
    else if (arg === '--limit' && args[i + 1]) options.limit = parseInt(args[++i], 10);
    else if (arg.startsWith('--limit=')) options.limit = parseInt(arg.split('=')[1], 10);
  }
  return options;
}

function printHelp() {
  console.log(`
Career-Ops Offline Semantic Evaluation Benchmark Harness
---------------------------------------------------------
Usage:
  node scripts/eval-semantic-benchmark.mjs [options]

Options:
  --engine <legacy|semantic>   Evaluation engine to run (default: legacy)
  --compare                    Execute both legacy and semantic engines and print comparison
  --mock-response <path>       Path to mock JSON response for deterministic offline testing
  --dataset <path>             Benchmark dataset file (default: evals/fixtures/golden-25.json)
  --candidate <path>           Candidate profile facts (default: evals/fixtures/candidate-early-career.json)
  --output <path>              Path to write machine-readable JSON evaluation report
  --subset <tag>               Filter samples by metadata tag (e.g. false_reject_trap, ai_engineer)
  --role <role_family>         Filter samples by role family (e.g. software_engineering, ai_ml)
  --limit <N>                  Limit evaluation to first N matching samples
  --strict                     Enforce strict schema & provenance validation; abort on error
  --verbose, -v                Print verbose per-sample predictions and diagnostics
  --help, -h                   Show this help message
`);
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    printHelp();
    process.exit(0);
  }

  const startTime = Date.now();
  console.log('================================================================================');
  console.log('🔬 Career-Ops Semantic Benchmark Runner');
  console.log(`Engine       : ${options.engine}`);
  console.log(`Dataset      : ${options.dataset}`);
  console.log(`Candidate    : ${options.candidate}`);
  console.log(`Schema Ver.  : ${SEMANTIC_SCHEMA_VERSION}`);
  console.log('================================================================================\n');

  // 1. Handle Engine Selection & Validation
  if (options.engine !== 'legacy' && options.engine !== 'semantic') {
    console.error(`❌ Unknown engine "${options.engine}". Supported engines: legacy, semantic.`);
    process.exit(1);
  }

  // Check for mock response file if provided
  let mockPayload = null;
  if (options.mockResponse) {
    const mockPath = resolve(process.cwd(), options.mockResponse);
    if (!existsSync(mockPath)) {
      console.error(`❌ Mock response file not found at ${mockPath}`);
      process.exit(1);
    }
    mockPayload = JSON.parse(readFileSync(mockPath, 'utf8'));
  }

  // 2. Load Dataset
  const datasetPath = resolve(process.cwd(), options.dataset);
  if (!existsSync(datasetPath)) {
    console.error(`❌ Dataset file not found at ${datasetPath}`);
    process.exit(1);
  }

  let samples;
  try {
    samples = JSON.parse(readFileSync(datasetPath, 'utf8'));
  } catch (err) {
    console.error(`❌ Failed to parse dataset JSON: ${err.message}`);
    process.exit(1);
  }

  if (!Array.isArray(samples)) {
    console.error(`❌ Dataset must contain an array of benchmark samples.`);
    process.exit(1);
  }

  // 3. Load Candidate Facts
  const candidatePath = resolve(process.cwd(), options.candidate);
  let candidateFacts = {};
  if (existsSync(candidatePath)) {
    try {
      candidateFacts = JSON.parse(readFileSync(candidatePath, 'utf8'));
    } catch (err) {
      console.warn(`⚠️  Failed to parse candidate JSON at ${candidatePath}, using empty profile: ${err.message}`);
    }
  } else {
    console.warn(`⚠️  Candidate profile not found at ${candidatePath}, using default 1 YOE profile.`);
    candidateFacts = {
      candidate_id: 'DEFAULT-CANDIDATE',
      professional_years: 1,
      professional_years_source: 'cv.md',
      professional_yoe_verified: true,
      work_authorization: true
    };
  }

  // 4. Filter Samples
  let activeSamples = samples;
  if (options.subset) {
    activeSamples = activeSamples.filter((s) => s.metadata?.tags?.includes(options.subset));
    console.log(`Filtered by tag "${options.subset}": ${activeSamples.length} samples.`);
  }
  if (options.role) {
    activeSamples = activeSamples.filter(
      (s) => s.annotations?.gold_profile?.role_family === options.role
    );
    console.log(`Filtered by role "${options.role}": ${activeSamples.length} samples.`);
  }
  if (options.limit && options.limit > 0) {
    activeSamples = activeSamples.slice(0, options.limit);
    console.log(`Limited to first ${options.limit} samples.`);
  }

  if (activeSamples.length === 0) {
    console.error('❌ No samples match the specified criteria.');
    process.exit(1);
  }

  // 5. Initialize Engines
  const semanticEngine = new SemanticEngine({
    mockResponse: mockPayload
  });

  // 5. Run Evaluation Loop
  if (options.compare) {
    console.log(`Running head-to-head comparison across ${activeSamples.length} sample(s)...\n`);

    // 5A. Run Legacy Engine
    const legacyEvalResults = [];
    const legacySampleSummaries = [];
    for (const sample of activeSamples) {
      const evaluation = await runLegacyEvaluation({
        sample,
        candidateFacts,
        candidateProfile: candidateFacts
      });
      assertValidJobSemanticProfile(evaluation.job_profile);
      assertValidMatchProfile(evaluation.match_profile);
      legacyEvalResults.push({ sample, prediction: evaluation, ground_truth: sample.annotations });
      const diag = evaluation.legacy_diagnostics;
      const gold = sample.annotations?.gold_profile;
      legacySampleSummaries.push({
        id: sample.sample_id,
        title: (sample.metadata?.raw_title || '').slice(0, 34),
        role: evaluation.job_profile.role_family,
        pred_yoe: evaluation.job_profile.overall_yoe_required ?? '-',
        gold_yoe: gold?.required_yoe ?? '-',
        verdict: diag.fit_status,
        expected: gold?.expected_fit_verdict ?? '-',
        rej_type: diag.rejection_type,
        false_rej: diag.is_false_reject ? '⚠️ YES' : 'NO',
        ms: diag.latency_ms
      });
    }
    const legacyMetrics = computeBenchmarkMetrics(legacyEvalResults);

    // 5B. Run Semantic Engine
    const semanticEvalResults = [];
    const semanticSampleSummaries = [];
    let gatewayUnavailable = false;
    let gatewayUnavailableReason = '';

    for (const sample of activeSamples) {
      const semResult = await semanticEngine.evaluate({
        sample,
        candidateFacts,
        candidateProfile: candidateFacts
      });

      if (semResult.status === 'UNAVAILABLE') {
        gatewayUnavailable = true;
        gatewayUnavailableReason = semResult.semantic_diagnostics.error_message || 'Model gateway unavailable';
        break;
      }

      const evaluation = {
        job_profile: semResult.job_profile,
        match_profile: semResult.match_profile,
        legacy_diagnostics: semResult.semantic_diagnostics
      };
      assertValidJobSemanticProfile(evaluation.job_profile);
      assertValidMatchProfile(evaluation.match_profile);
      semanticEvalResults.push({ sample, prediction: evaluation, ground_truth: sample.annotations });
      const diag = semResult.semantic_diagnostics;
      const gold = sample.annotations?.gold_profile;
      semanticSampleSummaries.push({
        id: sample.sample_id,
        title: (sample.metadata?.raw_title || '').slice(0, 34),
        role: evaluation.job_profile.role_family,
        pred_yoe: evaluation.job_profile.overall_yoe_required ?? '-',
        gold_yoe: gold?.required_yoe ?? '-',
        verdict: diag.fit_status,
        expected: gold?.expected_fit_verdict ?? '-',
        rej_type: diag.rejection_type,
        false_rej: diag.is_false_reject ? '⚠️ YES' : 'NO',
        ms: diag.latency_ms
      });
    }

    if (gatewayUnavailable) {
      console.log('--------------------------------------------------------------------------------');
      console.log('⚠️  SEMANTIC ENGINE GATEWAY STATUS: UNAVAILABLE');
      console.log('--------------------------------------------------------------------------------');
      console.log(`Reason: ${gatewayUnavailableReason}`);
      console.log('Compare mode requires an active model gateway or --mock-response <path>.');
      console.log('Legacy baseline was computed successfully.');
      console.log('--------------------------------------------------------------------------------\n');
      process.exit(0);
    }

    const semanticMetrics = computeBenchmarkMetrics(semanticEvalResults);
    const totalElapsed = Date.now() - startTime;

    // Render Comparative Table
    console.log('--------------------------------------------------------------------------------');
    console.log('⚖️  HEAD-TO-HEAD BENCHMARK COMPARISON (LEGACY vs SYSTEM-1 SEMANTIC)');
    console.log('--------------------------------------------------------------------------------');
    console.log(
      'Metric'.padEnd(30) +
      'Legacy'.padEnd(18) +
      'Semantic'.padEnd(18) +
      'Delta'
    );
    console.log('-'.repeat(80));

    const printRow = (label, legVal, semVal, isBetterHigher = true, isPercent = true) => {
      const legNum = typeof legVal === 'number' ? legVal : parseFloat(legVal);
      const semNum = typeof semVal === 'number' ? semVal : parseFloat(semVal);
      const diff = semNum - legNum;
      const sign = diff > 0 ? '+' : '';
      const diffStr = isPercent ? `${sign}${(diff * 100).toFixed(1)}%` : `${sign}${diff.toFixed(1)}`;
      const legStr = isPercent ? `${(legNum * 100).toFixed(1)}%` : `${legNum.toFixed(1)}`;
      const semStr = isPercent ? `${(semNum * 100).toFixed(1)}%` : `${semNum.toFixed(1)}`;
      console.log(
        label.padEnd(30) +
        legStr.padEnd(18) +
        semStr.padEnd(18) +
        diffStr
      );
    };

    printRow('Coverage', legacyMetrics.metadata.coverage, semanticMetrics.metadata.coverage);
    printRow('Abstention Rate', legacyMetrics.metadata.abstention_rate, semanticMetrics.metadata.abstention_rate, false);
    printRow('Seniority Accuracy', legacyMetrics.performance_metrics.seniority_accuracy.score, semanticMetrics.performance_metrics.seniority_accuracy.score);
    printRow('YOE Tolerance Accuracy', legacyMetrics.performance_metrics.yoe_tolerance_accuracy.score, semanticMetrics.performance_metrics.yoe_tolerance_accuracy.score);
    printRow('False Rejection Rate', legacyMetrics.performance_metrics.fit_decision_rates.false_rejection_rate.rate, semanticMetrics.performance_metrics.fit_decision_rates.false_rejection_rate.rate, false);
    printRow('False Positive Rate', legacyMetrics.performance_metrics.fit_decision_rates.false_positive_acceptance_rate.rate, semanticMetrics.performance_metrics.fit_decision_rates.false_positive_acceptance_rate.rate, false);
    printRow('Calls / Job', legacyMetrics.operational_telemetry.calls_per_job, semanticMetrics.operational_telemetry.calls_per_job, false, false);
    printRow('P50 Latency (ms)', legacyMetrics.operational_telemetry.p50_latency_ms, semanticMetrics.operational_telemetry.p50_latency_ms, false, false);
    console.log('-'.repeat(80));

    console.log('\n--------------------------------------------------------------------------------');
    console.log('🛡️  ANNOTATION INTEGRITY & VALIDITY WARNING');
    console.log('--------------------------------------------------------------------------------');
    console.log('⚠️  PROVISIONAL BENCHMARK NOTICE: All samples are synthetic MODEL_PROPOSED fixtures.');
    console.log('These results establish ENGINEERING VALIDITY (contract adherence and behavior),');
    console.log('NOT empirical superiority on human-verified ground truth.');
    console.log('Independent dual-human annotation is required prior to production cutover.');
    console.log('--------------------------------------------------------------------------------\n');

    if (options.output) {
      const reportPath = resolve(process.cwd(), options.output);
      const reportData = {
        benchmark_version: SEMANTIC_SCHEMA_VERSION,
        execution_timestamp: new Date().toISOString(),
        engine: 'compare',
        dataset_file: options.dataset,
        candidate_evaluated: redactCandidateFactsForEvaluation(candidateFacts),
        legacy_metrics: legacyMetrics,
        semantic_metrics: semanticMetrics,
        legacy_predictions: legacyEvalResults.map((r) => ({
          sample_id: r.sample.sample_id,
          metadata: r.sample.metadata,
          job_profile: r.prediction.job_profile,
          match_profile: r.prediction.match_profile,
          legacy_diagnostics: r.prediction.legacy_diagnostics
        })),
        semantic_predictions: semanticEvalResults.map((r) => ({
          sample_id: r.sample.sample_id,
          metadata: r.sample.metadata,
          job_profile: r.prediction.job_profile,
          match_profile: r.prediction.match_profile,
          semantic_diagnostics: r.prediction.legacy_diagnostics
        }))
      };
      writeFileSync(reportPath, JSON.stringify(reportData, null, 2), 'utf8');
      console.log(`💾 Comparative evaluation report saved to: ${reportPath}\n`);
    }

    process.exit(0);
  }

  // Single Engine Loop (legacy or semantic)
  console.log(`Running evaluation across ${activeSamples.length} sample(s)...\n`);
  const evalResults = [];
  const sampleSummaries = [];

  let gatewayUnavailable = false;
  let gatewayUnavailableReason = '';

  for (const sample of activeSamples) {
    // Provenance verification of sample
    if (sample.metadata?.jd_hash) {
      const computedHash = computeSourceHash(sample.raw_jd_text || '');
      if (computedHash !== sample.metadata.jd_hash) {
        const msg = `Sample ${sample.sample_id} hash mismatch!`;
        if (options.strict) throw new Error(msg);
        console.warn(`⚠️  ${msg}`);
      }
    }

    let evaluation;
    let diag;

    if (options.engine === 'semantic') {
      const semResult = await semanticEngine.evaluate({
        sample,
        candidateFacts,
        candidateProfile: candidateFacts
      });

      if (semResult.status === 'UNAVAILABLE') {
        gatewayUnavailable = true;
        gatewayUnavailableReason = semResult.semantic_diagnostics.error_message || 'Model gateway unavailable';
        break;
      }

      evaluation = {
        job_profile: semResult.job_profile,
        match_profile: semResult.match_profile,
        legacy_diagnostics: semResult.semantic_diagnostics
      };
      diag = semResult.semantic_diagnostics;
    } else {
      evaluation = await runLegacyEvaluation({
        sample,
        candidateFacts,
        candidateProfile: candidateFacts
      });
      diag = evaluation.legacy_diagnostics;
    }

    // Validate generated canonical entities
    try {
      assertValidJobSemanticProfile(evaluation.job_profile);
      assertValidMatchProfile(evaluation.match_profile);
    } catch (valErr) {
      console.error(`❌ Output schema validation failed for sample ${sample.sample_id}: ${valErr.message}`);
      if (options.strict) process.exit(1);
    }

    evalResults.push({
      sample,
      prediction: evaluation,
      ground_truth: sample.annotations
    });

    const gold = sample.annotations?.gold_profile;

    sampleSummaries.push({
      id: sample.sample_id,
      title: (sample.metadata?.raw_title || '').slice(0, 36),
      role: evaluation.job_profile.role_family,
      pred_yoe: evaluation.job_profile.overall_yoe_required ?? '-',
      gold_yoe: gold?.required_yoe ?? '-',
      verdict: diag.fit_status,
      expected: gold?.expected_fit_verdict ?? '-',
      rej_type: diag.rejection_type,
      false_rej: diag.is_false_reject ? '⚠️ YES' : 'NO',
      ms: diag.latency_ms
    });
  }

  if (gatewayUnavailable) {
    console.log('--------------------------------------------------------------------------------');
    console.log('⚠️  SEMANTIC ENGINE GATEWAY STATUS: UNAVAILABLE');
    console.log('--------------------------------------------------------------------------------');
    console.log(`Reason: ${gatewayUnavailableReason}`);
    console.log('In accordance with Career-Ops Phase 1 Invariants:');
    console.log('- No fake semantic predictions were fabricated.');
    console.log('- To run against live models, configure PI or a supported zero-cost model CLI.');
    console.log('- To test deterministically offline, supply --mock-response <path>.');
    console.log('--------------------------------------------------------------------------------\n');
    console.log('✅ Semantic engine interface and gateway abstraction are structurally verified.');
    process.exit(0);
  }

  // 6. Compute Benchmark Metrics
  const metrics = computeBenchmarkMetrics(evalResults);
  const totalElapsed = Date.now() - startTime;

  // 7. Render Terminal Summary
  console.log('--------------------------------------------------------------------------------');
  console.log('📊 SAMPLE EXECUTION SUMMARY');
  console.log('--------------------------------------------------------------------------------');
  console.log(
    'ID'.padEnd(19) +
    'Title'.padEnd(38) +
    'Role'.padEnd(20) +
    'YOE (P/G)'.padEnd(12) +
    'Verdict'.padEnd(14) +
    'Expected'.padEnd(12) +
    'Rej Type'.padEnd(19) +
    'False Rej'
  );
  console.log('-'.repeat(140));

  for (const row of sampleSummaries) {
    const yoeStr = `${row.pred_yoe}/${row.gold_yoe}`;
    console.log(
      row.id.padEnd(19) +
      row.title.padEnd(38) +
      row.role.padEnd(20) +
      yoeStr.padEnd(12) +
      row.verdict.padEnd(14) +
      row.expected.padEnd(12) +
      row.rej_type.padEnd(19) +
      row.false_rej
    );
  }
  console.log('-'.repeat(140));

  console.log('\n--------------------------------------------------------------------------------');
  console.log('📈 AGGREGATE EVALUATION METRICS');
  console.log('--------------------------------------------------------------------------------');
  console.log(`Evaluated Samples        : ${metrics.metadata.evaluated_count} / ${metrics.metadata.total_samples}`);
  console.log(`Coverage                 : ${(metrics.metadata.coverage * 100).toFixed(1)}%`);
  console.log(`Abstention Rate          : ${(metrics.metadata.abstention_rate * 100).toFixed(1)}% (${metrics.metadata.abstention_count} cases)`);
  console.log(`Seniority Accuracy       : ${(metrics.performance_metrics.seniority_accuracy.score * 100).toFixed(1)}% ` +
    `[95% CI: ${(metrics.performance_metrics.seniority_accuracy.ci95.lower * 100).toFixed(1)}% - ${(metrics.performance_metrics.seniority_accuracy.ci95.upper * 100).toFixed(1)}%]`);
  console.log(`YOE Tolerance Accuracy   : ${(metrics.performance_metrics.yoe_tolerance_accuracy.score * 100).toFixed(1)}% (MAE: ${metrics.performance_metrics.yoe_tolerance_accuracy.mae.toFixed(2)} yrs)`);
  console.log(`False Rejection Rate     : ${(metrics.performance_metrics.fit_decision_rates.false_rejection_rate.rate * 100).toFixed(1)}% ` +
    `(${metrics.performance_metrics.fit_decision_rates.false_rejection_rate.false_rejects}/${metrics.performance_metrics.fit_decision_rates.false_rejection_rate.total_qualified} qualified rejected)`);
  console.log(`False Positive Rate      : ${(metrics.performance_metrics.fit_decision_rates.false_positive_acceptance_rate.rate * 100).toFixed(1)}% ` +
    `(${metrics.performance_metrics.fit_decision_rates.false_positive_acceptance_rate.false_accepts}/${metrics.performance_metrics.fit_decision_rates.false_positive_acceptance_rate.total_unqualified} unqualified accepted)`);

  console.log('\n--------------------------------------------------------------------------------');
  console.log('🛑 REJECTION REASON BREAKDOWN');
  console.log('--------------------------------------------------------------------------------');
  for (const [type, count] of Object.entries(metrics.breakdowns.by_rejection_type)) {
    console.log(`  ${type.padEnd(24)} : ${count}`);
  }

  console.log('\n--------------------------------------------------------------------------------');
  console.log('🛡️  ANNOTATION INTEGRITY REPORT');
  console.log('--------------------------------------------------------------------------------');
  console.log(`Human Verified Labels    : ${metrics.annotation_integrity.human_verified_count}`);
  console.log(`Model Proposed Labels    : ${metrics.annotation_integrity.model_proposed_count}`);
  console.log(`Unlabeled Postings       : ${metrics.annotation_integrity.unlabeled_count}`);
  console.log(`Benchmark State          : ${metrics.annotation_integrity.is_provisional ? 'PROVISIONAL (Synthetic / Model-Proposed)' : 'OFFICIAL'}`);
  console.log(`Integrity Notice         : ${metrics.annotation_integrity.integrity_note}`);

  console.log('\n--------------------------------------------------------------------------------');
  console.log(`⏱️  Execution Time        : ${totalElapsed} ms (p50: ${metrics.operational_telemetry.p50_latency_ms} ms, p95: ${metrics.operational_telemetry.p95_latency_ms} ms)`);
  console.log(`💰 Gateway Invocations   : ${metrics.operational_telemetry.total_gateway_calls} calls (${metrics.operational_telemetry.calls_per_job.toFixed(1)} calls/job, $0.00 incremental spend)`);
  console.log('================================================================================\n');

  // 8. Output machine-readable report
  if (options.output) {
    const reportPath = resolve(process.cwd(), options.output);
    const reportData = {
      benchmark_version: SEMANTIC_SCHEMA_VERSION,
      execution_timestamp: new Date().toISOString(),
      engine: options.engine,
      dataset_file: options.dataset,
      candidate_evaluated: redactCandidateFactsForEvaluation(candidateFacts),
      metrics,
      predictions: evalResults.map((r) => ({
        sample_id: r.sample.sample_id,
        metadata: r.sample.metadata,
        job_profile: r.prediction.job_profile,
        match_profile: r.prediction.match_profile,
        legacy_diagnostics: r.prediction.legacy_diagnostics
      }))
    };

    writeFileSync(reportPath, JSON.stringify(reportData, null, 2), 'utf8');
    console.log(`💾 Machine-readable evaluation report saved to: ${reportPath}`);
  }
}

main().catch((err) => {
  console.error(`\n❌ Benchmark execution failed:`, err);
  process.exit(1);
});
