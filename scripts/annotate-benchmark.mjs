#!/usr/bin/env node
// @ts-check
/**
 * annotate-benchmark.mjs — CLI Utility for Benchmark Annotation Management & Integrity Checking
 *
 * Capabilities:
 * - Validate annotation schema and evidence spans
 * - Report annotation status breakdown (UNLABELED, MODEL_PROPOSED, HUMAN_REVIEWED, DUAL_HUMAN_VERIFIED, ADJUDICATED)
 * - Flag invalid spans, mismatched hashes, or fabricated quotes
 * - Set or update sample status with auditor signature
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { validateEvidenceSpan, computeSourceHash } from '../src/agent/domain/semantic/provenance-validator.mjs';

const VALID_STATUSES = ['UNLABELED', 'MODEL_PROPOSED', 'HUMAN_REVIEWED', 'DUAL_HUMAN_VERIFIED', 'ADJUDICATED'];

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    dataset: 'evals/fixtures/golden-25.json',
    verifyOnly: false,
    sampleId: null,
    setStatus: null,
    annotator: null,
    checkDisagreements: false,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--verify' || arg === '--verify-only') options.verifyOnly = true;
    else if (arg === '--check-disagreements') options.checkDisagreements = true;
    else if (arg === '--dataset' && args[i + 1]) options.dataset = args[++i];
    else if (arg.startsWith('--dataset=')) options.dataset = arg.split('=')[1];
    else if (arg === '--sample' && args[i + 1]) options.sampleId = args[++i];
    else if (arg.startsWith('--sample=')) options.sampleId = arg.split('=')[1];
    else if (arg === '--set-status' && args[i + 1]) options.setStatus = args[++i];
    else if (arg.startsWith('--set-status=')) options.setStatus = arg.split('=')[1];
    else if (arg === '--annotator' && args[i + 1]) options.annotator = args[++i];
    else if (arg.startsWith('--annotator=')) options.annotator = arg.split('=')[1];
  }
  return options;
}

function printHelp() {
  console.log(`
Usage: node scripts/annotate-benchmark.mjs [options]

Options:
  --dataset <path>            Path to benchmark JSON (default: evals/fixtures/golden-25.json)
  --verify                    Verify all evidence spans and hashes in dataset
  --check-disagreements       Check for reviewer disagreements requiring adjudication
  --sample <id>               Target specific sample ID
  --set-status <status>       Set status: ${VALID_STATUSES.join(' | ')}
  --annotator <id>            Annotator signature / name
  --help, -h                  Show this help message
`);
}

function run() {
  const options = parseArgs();
  if (options.help) {
    printHelp();
    process.exit(0);
  }

  const datasetPath = resolve(process.cwd(), options.dataset);
  if (!existsSync(datasetPath)) {
    console.error(`❌ Dataset file not found at ${datasetPath}`);
    process.exit(1);
  }

  const rawData = readFileSync(datasetPath, 'utf8');
  let samples;
  try {
    samples = JSON.parse(rawData);
  } catch (err) {
    console.error(`❌ Failed to parse JSON in ${datasetPath}: ${err.message}`);
    process.exit(1);
  }

  if (!Array.isArray(samples)) {
    console.error(`❌ Dataset must contain a top-level array of benchmark samples`);
    process.exit(1);
  }

  console.log(`\n📋 Benchmark Annotation Inspector: ${datasetPath}`);
  console.log(`Loaded ${samples.length} samples.\n`);

  // Status breakdown
  const statusCounts = {};
  for (const s of VALID_STATUSES) statusCounts[s] = 0;

  let spanErrors = 0;
  let hashErrors = 0;

  for (const sample of samples) {
    const status = sample.annotations?.status || 'UNLABELED';
    statusCounts[status] = (statusCounts[status] || 0) + 1;

    // Verify JD Hash
    const actualHash = computeSourceHash(sample.raw_jd_text || '');
    if (sample.metadata?.jd_hash && sample.metadata.jd_hash !== actualHash) {
      console.error(`❌ [${sample.sample_id}] JD Hash mismatch! Stated: ${sample.metadata.jd_hash}, Actual: ${actualHash}`);
      hashErrors++;
    }

    // Verify Spans
    const reqSkills = sample.annotations?.gold_profile?.required_skills || [];
    for (const skill of reqSkills) {
      if (skill.verbatim_span) {
        const spanRes = validateEvidenceSpan(sample.raw_jd_text, skill.verbatim_span);
        if (!spanRes.valid) {
          console.error(`❌ [${sample.sample_id}] Span error for skill "${skill.name}": ${spanRes.error}`);
          spanErrors++;
        }
      }
    }
  }

  console.log('--- Annotation Status Breakdown ---');
  for (const [st, count] of Object.entries(statusCounts)) {
    console.log(`  ${st.padEnd(22)} : ${count}`);
  }
  console.log('-----------------------------------');

  if (options.checkDisagreements) {
    console.log('\n--- Reviewer Disagreements & Adjudication Queue ---');
    const conflicts = [];
    for (const sample of samples) {
      const reviewers = sample.annotations?.reviewers || [];
      if (reviewers.length >= 2) {
        const [r1, r2] = reviewers;
        if (r1.seniority_level !== r2.seniority_level || r1.required_yoe !== r2.required_yoe || r1.expected_fit_verdict !== r2.expected_fit_verdict) {
          conflicts.push({ id: sample.sample_id, r1, r2 });
        }
      }
    }
    if (conflicts.length === 0) {
      console.log('✅ No active reviewer disagreements found across samples.');
      console.log(`   (${statusCounts.MODEL_PROPOSED} MODEL_PROPOSED; dual human reviews not yet submitted)`);
    } else {
      console.log(`⚠️ Found ${conflicts.length} sample(s) with conflicting annotations requiring adjudication:`);
      for (const c of conflicts) {
        console.log(`  - [${c.id}] R1: ${JSON.stringify(c.r1)} vs R2: ${JSON.stringify(c.r2)}`);
      }
    }
    console.log('---------------------------------------------------');
  }

  if (spanErrors > 0 || hashErrors > 0) {
    console.error(`\n❌ Validation Failed: ${spanErrors} span errors, ${hashErrors} hash errors.`);
    process.exit(1);
  }

  console.log(`\n✅ All evidence spans and content hashes are 100% verified.`);

  // Handle status update
  if (options.sampleId && options.setStatus) {
    if (!VALID_STATUSES.includes(options.setStatus)) {
      console.error(`❌ Invalid status "${options.setStatus}". Allowed: ${VALID_STATUSES.join(', ')}`);
      process.exit(1);
    }
    const target = samples.find((s) => s.sample_id === options.sampleId);
    if (!target) {
      console.error(`❌ Sample ${options.sampleId} not found in dataset.`);
      process.exit(1);
    }

    target.annotations = target.annotations || {};
    target.annotations.status = options.setStatus;
    target.annotations.annotator = options.annotator || 'operator';
    target.annotations.annotation_date = new Date().toISOString().split('T')[0];

    writeFileSync(datasetPath, JSON.stringify(samples, null, 2), 'utf8');
    console.log(`✅ Updated sample ${options.sampleId} status to "${options.setStatus}" by ${target.annotations.annotator}`);
  }
}

run();
