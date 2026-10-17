#!/usr/bin/env node
// @ts-check
/**
 * eval-semantic-skills.mjs — Offline Phase-2 Skill Intelligence Evaluation
 *
 * Runs the adversarial skill-intelligence fixtures through the DETERMINISTIC
 * layers (provenance, requirement lineage, normalization, identity) and reports
 * metrics. It is offline, $0, and makes zero live model calls.
 *
 * WHAT THIS MEASURES - AND WHAT IT DOES NOT
 *   Each fixture carries a fixed, simulated System-1 extraction response. The
 *   suite therefore measures how the deterministic layers process a given
 *   extraction: exact provenance, canonicalization, alias resolution, stable
 *   identity, false-merge/false-split behaviour, unresolved handling and
 *   operational cost. It does NOT measure live model extraction quality. Every
 *   report is labelled PROVISIONAL / SYNTHETIC / NOT SUFFICIENT FOR PRODUCTION
 *   PROMOTION, and no number here justifies a production cutover.
 *
 * Usage:
 *   node scripts/eval-semantic-skills.mjs
 *   node scripts/eval-semantic-skills.mjs --semantic
 *   node scripts/eval-semantic-skills.mjs --json --output report.json
 *   node scripts/eval-semantic-skills.mjs --strict
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSkillMentionCandidates,
  buildJobSkillIntelligence,
  skillIntelligenceDigest,
  SKILL_PROMPT_VERSION,
  SKILL_TASK_VERSION
} from '../src/agent/domain/semantic/skill-intelligence.mjs';
import {
  getDefaultSkillConceptRegistry,
  normalizeSkillSurface
} from '../src/agent/domain/semantic/skill-concept-registry.mjs';
import { computeSkillIntelligenceMetrics } from '../src/agent/domain/semantic/evaluation-metrics.mjs';
import { SEMANTIC_SCHEMA_VERSION } from '../src/agent/domain/semantic/semantic-entities.mjs';
import { createJobRequirement, validateJobRequirement } from '../src/agent/domain/semantic/semantic-entities.mjs';
import { locateExactSpan } from '../src/agent/domain/semantic/job-semantic-profiler.mjs';
import { NORMALIZATION_TASK_VERSION } from '../src/agent/domain/semantic/skill-normalization.mjs';
import { createNormalizationCache } from '../src/agent/domain/semantic/skill-normalization.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    dataset: 'evals/fixtures/skill-intelligence-adversarial.json',
    output: null,
    semantic: false,
    strict: false,
    json: false,
    verbose: false,
    help: false
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') options.help = true;
    else if (a === '--semantic') options.semantic = true;
    else if (a === '--strict') options.strict = true;
    else if (a === '--json') options.json = true;
    else if (a === '--verbose' || a === '-v') options.verbose = true;
    else if (a === '--dataset' && args[i + 1]) options.dataset = args[++i];
    else if (a.startsWith('--dataset=')) options.dataset = a.split('=')[1];
    else if (a === '--output' && args[i + 1]) options.output = args[++i];
    else if (a.startsWith('--output=')) options.output = a.split('=')[1];
  }
  return options;
}

function printHelp() {
  console.log(`
Career-Ops Phase-2 Skill Intelligence Benchmark (offline, deterministic)
------------------------------------------------------------------------
Usage:
  node scripts/eval-semantic-skills.mjs [options]

Options:
  --semantic          Also exercise the batched semantic resolution stage using
                      each fixture's simulated normalization response
  --dataset <path>    Fixture file (default: evals/fixtures/skill-intelligence-adversarial.json)
  --output <path>     Write the machine-readable JSON report
  --json              Print the JSON report to stdout
  --strict            Exit 1 on any provenance failure, false merge or false split
  --verbose, -v       Per-case detail
  --help, -h          This help
`);
}

/**
 * Build Phase-1 JobRequirements from a fixture's declared requirement clauses.
 * Uses the same locateExactSpan the profiler uses, so lineage here is exercised
 * exactly as it is in production.
 */
function buildFixtureRequirements(caseItem) {
  const reqs = [];
  let i = 0;
  for (const raw of caseItem.requirements || []) {
    const span = locateExactSpan(caseItem.jd_text, raw.verbatim_quote);
    if (!span) {
      throw new Error(`fixture ${caseItem.id}: requirement quote not locatable: ${JSON.stringify(raw.verbatim_quote)}`);
    }
    const req = createJobRequirement({
      requirement_id: `req-${caseItem.id}-${i++}`,
      type: raw.type || 'TECHNICAL_SKILL',
      importance: raw.importance || 'REQUIRED',
      description: raw.verbatim_quote,
      evidence_span: span,
      confidence: 0.9
    });
    const check = validateJobRequirement(req);
    if (!check.valid) throw new Error(`fixture ${caseItem.id}: invalid requirement`);
    reqs.push(req);
  }
  return reqs;
}

/**
 * Build a semantic resolver from a fixture's simulated normalization response.
 * `by_surface` maps a source surface form to a concept id; `by_mention_id`
 * maps a generated mention id directly. Both produce a well-formed
 * normalization response envelope.
 */
function buildFixtureResolver(caseItem, candidates) {
  const mock = caseItem.mock_normalization;
  if (!mock) return null;
  const bySurface = mock.by_surface || {};
  const byMentionId = mock.by_mention_id || {};

  return async () => {
    const decisions = [];
    for (const c of candidates) {
      if (byMentionId[c.mention_id]) {
        const target = byMentionId[c.mention_id];
        if (target === 'NEW' || target === '__NEW__') {
          decisions.push({ mention_id: c.mention_id, decision: 'NEW', concept_id: null, confidence: 0.95 });
        } else {
          decisions.push({ mention_id: c.mention_id, decision: 'EXISTING', concept_id: target, confidence: 0.95 });
        }
        continue;
      }
      const target = bySurface[c.surface_form];
      if (target === 'NEW' || target === '__NEW__') {
        decisions.push({ mention_id: c.mention_id, decision: 'NEW', concept_id: null, confidence: 0.95 });
        continue;
      }
      if (target) {
        decisions.push({ mention_id: c.mention_id, decision: 'EXISTING', concept_id: target, confidence: 0.95 });
        continue;
      }
      decisions.push({ mention_id: c.mention_id, decision: 'UNRESOLVED', concept_id: null, confidence: 0.2 });
    }
    return JSON.stringify({ decisions });
  };
}

async function runCase(caseItem, registry, { semantic }) {
  const requirements = buildFixtureRequirements(caseItem);
  const { candidates, rejected_mentions } = buildSkillMentionCandidates({
    parsed: caseItem.mock_extraction,
    rawJdText: caseItem.jd_text,
    jobId: caseItem.id,
    requirements
  });

  const resolver = semantic ? buildFixtureResolver(caseItem, candidates) : null;

  const built = await buildJobSkillIntelligence({
    candidates,
    rejected_mentions,
    rawJdText: caseItem.jd_text,
    jobId: caseItem.id,
    registry,
    semanticResolver: resolver,
    cache: null,
    options: { enableSemanticResolution: semantic }
  });

  // Determinism: the same input must produce the same concept identities.
  const built2 = await buildJobSkillIntelligence({
    candidates,
    rejected_mentions,
    rawJdText: caseItem.jd_text,
    jobId: caseItem.id,
    registry,
    semanticResolver: resolver,
    cache: null,
    options: { enableSemanticResolution: semantic }
  });

  const digestA = skillIntelligenceDigest(built.skill_intelligence);
  const digestB = skillIntelligenceDigest(built2.skill_intelligence);

  const expected = buildExpected(caseItem, semantic);

  return {
    sample: { id: caseItem.id, tags: caseItem.tags || [], jd_text: caseItem.jd_text, expected },
    prediction: {
      skill_intelligence: built.skill_intelligence,
      telemetry: built.telemetry
    },
    digest_a: digestA,
    digest_b: digestB,
    stable: digestA === digestB
  };
}

/** Merge a fixture's deterministic expectations with its semantic overlay. */
function buildExpected(caseItem, semantic) {
  const base = JSON.parse(JSON.stringify(caseItem.expected || {}));
  if (!semantic) return base;
  const overlay = caseItem.expected_semantic;
  if (!overlay) return base;
  base.concept_map = { ...(base.concept_map || {}), ...(overlay.concept_map || {}) };
  if (Array.isArray(overlay.equivalence_groups)) {
    base.equivalence_groups = [...(base.equivalence_groups || []), ...overlay.equivalence_groups];
  }
  const resolved = new Set(overlay.resolved_unresolved || []);
  base.expect_unresolved = (base.expect_unresolved || []).filter((s) => !resolved.has(s));
  return base;
}

/** Per-case assertions that the aggregate metrics do not express. */
function checkCaseAssertions(caseItem, result, { semantic }) {
  const problems = [];
  const si = result.prediction.skill_intelligence;
  // Merge the mode-specific overlay FIRST: a surface the semantic stage is
  // expected to resolve must not still be asserted as unresolved.
  const expected = buildExpected(caseItem, semantic);

  if (typeof expected.expect_mention_count === 'number' &&
      si.mentions.length !== expected.expect_mention_count) {
    problems.push(`expected ${expected.expect_mention_count} mentions, got ${si.mentions.length}`);
  }

  if (Array.isArray(expected.expect_requirement_importances)) {
    const actual = si.mentions.map((m) => m.requirement_importance);
    const expectedSet = [...expected.expect_requirement_importances].sort();
    const actualSet = [...actual].sort();
    if (JSON.stringify(expectedSet) !== JSON.stringify(actualSet)) {
      problems.push(`requirement importances ${JSON.stringify(actualSet)} != ${JSON.stringify(expectedSet)}`);
    }
  }

  // Every mention must satisfy exact UTF-16 provenance.
  for (const m of si.mentions) {
    const sliced = caseItem.jd_text.slice(m.evidence_span.start_char, m.evidence_span.end_char);
    if (sliced !== m.evidence_span.verbatim_quote) {
      problems.push(`mention ${m.mention_id} provenance mismatch`);
    }
  }

  // Expected-unresolved surfaces must be unresolved by surface.
  const unresolvedKeys = new Set((si.unresolved_surfaces || []).map(normalizeSkillSurface));
  for (const surface of expected.expect_unresolved || []) {
    if (!unresolvedKeys.has(normalizeSkillSurface(surface))) {
      problems.push(`expected "${surface}" to stay unresolved`);
    }
  }

  // Forbidden surfaces must never appear as a resolved concept of their own.
  // Skipped for a fixture that DELIBERATELY simulates a compromised model:
  // there the metric, not the assertion, is the thing under test, and the
  // honest outcome is that the injected skills are counted rather than
  // silently absorbed.
  if (!caseItem.simulated_model_error) {
    const forbidden = new Set((expected.forbidden_surfaces || []).map(normalizeSkillSurface));
    for (const m of si.mentions) {
      if (forbidden.has(m.normalized_surface) && m.resolution?.state === 'RESOLVED') {
        problems.push(`forbidden surface "${m.surface_form}" resolved to ${m.resolution.concept_id}`);
      }
    }
  } else if (typeof expected.expect_false_skills === 'number') {
    const forbidden = new Set((expected.forbidden_surfaces || []).map(normalizeSkillSurface));
    const observed = si.mentions.filter((m) => forbidden.has(m.normalized_surface)).length;
    if (observed !== caseItem.expected.expect_false_skills) {
      problems.push(`simulated-error case: expected ${expected.expect_false_skills} injected mentions, saw ${observed}`);
    }
  }

  return problems;
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    printHelp();
    process.exit(0);
  }

  const datasetPath = resolve(ROOT, options.dataset);
  const cases = JSON.parse(readFileSync(datasetPath, 'utf8'));
  const registry = getDefaultSkillConceptRegistry();

  const results = [];
  const cleanResults = [];
  const caseReports = [];
  let assertionFailures = 0;

  for (const caseItem of cases) {
    const result = await runCase(caseItem, registry, { semantic: options.semantic });
    results.push({ sample: result.sample, prediction: result.prediction });
    if (!caseItem.simulated_model_error) {
      cleanResults.push({ sample: result.sample, prediction: result.prediction });
    }

    const problems = checkCaseAssertions(caseItem, result, { semantic: options.semantic });
    if (problems.length > 0) assertionFailures += problems.length;

    const si = result.prediction.skill_intelligence;
    caseReports.push({
      id: caseItem.id,
      tags: caseItem.tags || [],
      simulated_model_error: caseItem.simulated_model_error === true,
      mentions: si.mentions.length,
      concepts: si.concepts.map((c) => c.concept_id),
      unresolved_surfaces: si.unresolved_surfaces,
      resolution_states: si.mentions.map((m) => `${m.surface_form}:${m.resolution.state}`),
      rejected_mentions: si.diagnostics.rejected_mentions,
      rejected_normalization_decisions: si.diagnostics.rejected_normalization_decisions || [],
      concept_id_stable: result.stable,
      assertion_problems: problems
    });
  }

  const metrics = computeSkillIntelligenceMetrics(results);
  // The clean aggregate excludes fixtures that deliberately simulate a
  // compromised model, so an intentionally-injected skill cannot be mistaken
  // for a system defect - and is still reported, separately and loudly.
  const cleanMetrics = computeSkillIntelligenceMetrics(cleanResults);

  const report = {
    benchmark: 'phase2-skill-intelligence',
    generated_at: new Date().toISOString(),
    engine: options.semantic ? 'deterministic+simulated-semantic' : 'deterministic',
    dataset: options.dataset,
    registry_version: registry.registry_version,
    normalization_version: registry.normalization_version,
    schema_version: SEMANTIC_SCHEMA_VERSION,
    task_version: SKILL_TASK_VERSION,
    prompt_version: SKILL_PROMPT_VERSION,
    normalization_task_version: NORMALIZATION_TASK_VERSION,
    live_model_calls: 0,
    assertion_failures: assertionFailures,
    all_concept_ids_stable: caseReports.every((c) => c.concept_id_stable),
    metrics,
    clean_metrics: cleanMetrics,
    simulated_model_error_cases: caseReports.filter((c) => c.simulated_model_error).map((c) => c.id),
    cases: caseReports
  };

  if (options.verbose && !options.json) {
    console.log('Per-case:');
    for (const c of caseReports) {
      console.log(`  ${c.id.padEnd(7)} mentions=${c.mentions} concepts=[${c.concepts.join(', ')}] unresolved=[${c.unresolved_surfaces.join(', ')}]${c.assertion_problems.length ? ' PROBLEMS=' + JSON.stringify(c.assertion_problems) : ''}`);
    }
    console.log('');
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('================================================================================');
    console.log('🧪 Career-Ops Phase-2 Skill Intelligence Benchmark');
    console.log(`Engine        : ${report.engine}`);
    console.log(`Dataset       : ${options.dataset} (${cases.length} cases)`);
    console.log(`Registry      : ${report.registry_version}`);
    console.log(`Normalization : ${report.normalization_version}`);
    console.log(`Live calls    : ${report.live_model_calls}`);
    console.log('================================================================================');
    console.log('');
    console.log('EXTRACTION METRICS');
    console.log(`  mention precision        : ${metrics.extraction_metrics.mention_precision}`);
    console.log(`  mention recall           : ${metrics.extraction_metrics.mention_recall}`);
    console.log(`  false skill rate         : ${metrics.extraction_metrics.false_skill_rate} (count ${metrics.extraction_metrics.false_skill_count})`);
    console.log(`  provenance validity      : ${metrics.extraction_metrics.provenance_validity_rate} over ${metrics.extraction_metrics.provenance_checked} mentions`);
    console.log('');
    console.log('NORMALIZATION METRICS');
    console.log(`  canonicalization accuracy: ${metrics.normalization_metrics.canonicalization_accuracy} (n=${metrics.normalization_metrics.canonicalization_comparable})`);
    console.log(`  FALSE MERGE RATE         : ${metrics.normalization_metrics.false_merge_rate} (count ${metrics.normalization_metrics.false_merge_count}, n=${metrics.normalization_metrics.false_merge_comparable})`);
    console.log(`  false split rate         : ${metrics.normalization_metrics.false_split_rate} (count ${metrics.normalization_metrics.false_split_count}, n=${metrics.normalization_metrics.false_split_comparable})`);
    console.log(`  unresolved rate          : ${metrics.normalization_metrics.unresolved_rate}`);
    console.log(`  run-local concept rate   : ${metrics.normalization_metrics.run_local_concept_rate}`);
    console.log('');
    console.log('OPERATIONAL METRICS');
    console.log(`  calls/job                : ${metrics.operational_telemetry.calls_per_job}`);
    console.log(`  normalization calls/job  : ${metrics.operational_telemetry.normalization_calls_per_job}`);
    console.log(`  retries/job              : ${metrics.operational_telemetry.retries_per_job}`);
    console.log(`  failures/job             : ${metrics.operational_telemetry.failures_per_job}`);
    console.log(`  cache hit rate           : ${metrics.operational_telemetry.cache_hit_rate}`);
    console.log(`  p50 latency ms           : ${metrics.operational_telemetry.p50_latency_ms}`);
    console.log(`  p95 latency ms           : ${metrics.operational_telemetry.p95_latency_ms}`);
    console.log('');
    console.log('DETERMINISM');
    console.log(`  concept ids stable       : ${report.all_concept_ids_stable}`);
    console.log(`  per-case assertion fails : ${assertionFailures}`);
    console.log('');
    console.log('⚠️  PROVISIONAL / SYNTHETIC - NOT SUFFICIENT FOR PRODUCTION PROMOTION');
    console.log(`   ${metrics.provisional.note}`);
    console.log('');
    console.log('CLEAN AGGREGATE (excludes ' + report.simulated_model_error_cases.join(', ') + ')');
    console.log(`  false skill count        : ${cleanMetrics.extraction_metrics.false_skill_count}`);
    console.log(`  mention precision        : ${cleanMetrics.extraction_metrics.mention_precision}`);
    console.log(`  false merge count        : ${cleanMetrics.normalization_metrics.false_merge_count}`);
    console.log(`  false split count        : ${cleanMetrics.normalization_metrics.false_split_count}`);
    console.log('');
  }

  if (options.output) {
    const outPath = resolve(ROOT, options.output);
    writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    if (!options.json) console.log(`Report written to ${outPath}`);
  }

  const strictFailures = [];
  if (cleanMetrics.extraction_metrics.provenance_validity_rate < 1) strictFailures.push('provenance_validity_rate < 1');
  if (cleanMetrics.extraction_metrics.false_skill_count > 0) strictFailures.push('false skill detected');
  if (cleanMetrics.normalization_metrics.false_merge_count > 0) strictFailures.push('false merge detected');
  if (cleanMetrics.normalization_metrics.false_split_count > 0) strictFailures.push('false split detected');
  if (!report.all_concept_ids_stable) strictFailures.push('concept ids not stable across runs');
  if (assertionFailures > 0) strictFailures.push('per-case assertions failed');

  if (options.strict && strictFailures.length > 0) {
    if (!options.json) console.error(`❌ STRICT FAILURES: ${strictFailures.join('; ')}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`❌ benchmark crashed: ${err?.stack || err}`);
  process.exit(1);
});