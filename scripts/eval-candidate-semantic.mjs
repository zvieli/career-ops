#!/usr/bin/env node
// @ts-check
/**
 * scripts/eval-candidate-semantic.mjs — Phase 3 Candidate Semantic Intelligence Benchmark
 *
 * Runs offline, deterministic candidate semantic evaluation over synthetic
 * adversarial fixtures.
 *
 * HONESTY CONTRACT:
 * All metrics reported here are measured against simulated, synthetically authored
 * candidate fixture ground truth. They measure provenance, experience classification,
 * capability boundaries, and identity determinism — NOT live model quality.
 * They are explicitly PROVISIONAL and NOT sufficient for production cutover.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  profileCandidateSemantic,
  CANDIDATE_TASK_VERSION,
  CANDIDATE_PROMPT_VERSION,
  CANDIDATE_SCHEMA_VERSION
} from '../src/agent/domain/semantic/candidate-semantic-profiler.mjs';
import { getDefaultSkillConceptRegistry } from '../src/agent/domain/semantic/skill-concept-registry.mjs';
import { assertValidCandidateSemanticProfile } from '../src/agent/domain/semantic/semantic-entities.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DATASET = 'evals/fixtures/candidate-semantic-adversarial.json';

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
Usage: node scripts/eval-candidate-semantic.mjs [options]

Options:
  --strict            Exit with code 1 if any assertion fails
  --json              Output machine-readable JSON report
  --output <path>     Write JSON report to disk
  --dataset <path>    Fixture file (default: ${DEFAULT_DATASET})
  --help, -h          Print this help
`);
}

async function runCase(caseItem, registry) {
  const result = await profileCandidateSemantic({
    sourceText: caseItem.source_text,
    sourceId: 'cv.md',
    candidateId: caseItem.id,
    registry,
    options: { mockResponse: caseItem.mock_extraction }
  });

  const profile = result.profile;
  assertValidCandidateSemanticProfile(profile);

  const problems = [];
  const expected = caseItem.expected || {};

  // 1. Check skills
  const extractedSkills = profile.skills.map((s) => s.surface_form);
  let unsupportedSkillInference = false;
  let promptInjectionAdmitted = false;
  for (const expSkill of expected.skills || []) {
    if (!extractedSkills.includes(expSkill)) {
      problems.push(`expected skill "${expSkill}" was not extracted`);
    }
  }
  for (const forbidden of expected.forbidden_skills || []) {
    if (extractedSkills.includes(forbidden)) {
      problems.push(`forbidden skill "${forbidden}" was extracted without source evidence`);
      unsupportedSkillInference = true;
      if (caseItem.tags?.includes('prompt_injection')) {
        promptInjectionAdmitted = true;
      }
    }
  }

  // 2. Check experience types & project/employment separation
  let projectToEmploymentFalsePromotion = false;
  let internshipToEmploymentFalsePromotion = false;
  for (const exp of profile.experiences) {
    if (expected.forbidden_experience_types?.includes(exp.experience_type)) {
      problems.push(`experience "${exp.organization_or_project_name}" was falsely promoted to ${exp.experience_type}`);
      if (caseItem.tags?.includes('project_vs_employment') && exp.experience_type === 'EMPLOYMENT') {
        projectToEmploymentFalsePromotion = true;
      }
      if (caseItem.tags?.includes('internship_vs_employment') && exp.experience_type === 'EMPLOYMENT') {
        internshipToEmploymentFalsePromotion = true;
      }
    }
  }
  if (expected.experience_type) {
    const match = profile.experiences.some((e) => e.experience_type === expected.experience_type);
    if (!match) {
      problems.push(`expected experience_type "${expected.experience_type}" not found`);
    }
  }

  // 3. Check education status directly on CandidateEducation.status
  let falseEducationCompletion = false;
  if (expected.education_status) {
    const match = profile.education.some((e) => e.status === expected.education_status);
    if (!match) {
      problems.push(`expected education status "${expected.education_status}" not found, actual: ${profile.education.map((e) => e.status).join(', ')}`);
    }
  }
  if (expected.forbidden_education_status) {
    for (const forb of expected.forbidden_education_status) {
      if (profile.education.some((e) => e.status === forb)) {
        problems.push(`forbidden education status "${forb}" was found on CandidateEducation`);
        falseEducationCompletion = true;
      }
    }
  }

  // 4. Check certifications
  let courseToCertificationFalsePromotion = false;
  if (expected.forbidden_certified) {
    if (profile.certifications.some((c) => c.is_certified === true)) {
      problems.push('course completion was falsely reported as is_certified: true');
      courseToCertificationFalsePromotion = true;
    }
  }
  if (expected.is_certified === true) {
    if (!profile.certifications.some((c) => c.is_certified === true)) {
      problems.push('expected certification was not marked is_certified: true');
    }
  }

  // 5. Check capabilities responsibility, environment, and content
  let unsupportedCapability = false;
  let responsibilityOverstatement = false;
  const extractedCaps = profile.capabilities || [];

  for (const expCap of expected.expected_capabilities || []) {
    const match = extractedCaps.some((c) =>
      c.activity?.toLowerCase() === expCap.activity.toLowerCase() &&
      c.object?.toLowerCase() === expCap.object.toLowerCase()
    );
    if (!match) {
      problems.push(`expected capability "${expCap.activity} ${expCap.object}" was not found`);
    }
  }

  for (const forbCap of expected.forbidden_capabilities || []) {
    const match = extractedCaps.some((c) =>
      c.activity?.toLowerCase().includes(forbCap.activity.toLowerCase()) &&
      c.object?.toLowerCase().includes(forbCap.object.toLowerCase())
    );
    if (match) {
      problems.push(`forbidden capability "${forbCap.activity} ${forbCap.object}" was found`);
      unsupportedCapability = true;
    }
  }

  for (const cap of extractedCaps) {
    if (expected.forbidden_responsibility?.includes(cap.responsibility_level)) {
      problems.push(`responsibility level was overstated to ${cap.responsibility_level}`);
      responsibilityOverstatement = true;
    }
    if (expected.forbidden_environment?.includes(cap.environment_type)) {
      problems.push(`environment was falsely promoted to ${cap.environment_type}`);
      unsupportedCapability = true;
    }
    if (expected.responsibility_level && cap.responsibility_level !== expected.responsibility_level) {
      problems.push(`expected responsibility ${expected.responsibility_level}, got ${cap.responsibility_level}`);
    }
  }

  // 6. Check verified YOE is not fabricated
  let fabricatedYoe = false;
  if (profile.verified_yoe !== null && profile.verified_yoe !== undefined) {
    problems.push(`verified_yoe was fabricated as ${profile.verified_yoe} without computation`);
    fabricatedYoe = true;
  }

  // 7. Check exact provenance
  let provenanceChecked = 0;
  let provenanceExact = 0;
  for (const ev of profile.evidence) {
    if (ev.source_type === 'TEXT_DOCUMENT') {
      provenanceChecked++;
      const span = ev.evidence_span;
      if (caseItem.source_text.slice(span.start_char, span.end_char) === span.verbatim_quote) {
        provenanceExact++;
      } else {
        problems.push(`evidence quote "${span.verbatim_quote}" did not match exact span`);
      }
    }
  }

  return {
    id: caseItem.id,
    tags: caseItem.tags || [],
    evidence_count: profile.evidence.length,
    experiences_count: profile.experiences.length,
    skills_count: profile.skills.length,
    capabilities_count: profile.capabilities.length,
    education_count: profile.education.length,
    certifications_count: profile.certifications.length,
    rejected_count: (profile.diagnostics?.rejected_evidence?.length || 0) + (profile.diagnostics?.rejected_skills?.length || 0),
    assertion_problems: problems,
    metrics: {
      project_to_employment_false_promotion: projectToEmploymentFalsePromotion,
      internship_to_employment_false_promotion: internshipToEmploymentFalsePromotion,
      course_to_certification_false_promotion: courseToCertificationFalsePromotion,
      false_education_completion: falseEducationCompletion,
      fabricated_yoe: fabricatedYoe,
      unsupported_capability: unsupportedCapability,
      responsibility_overstatement: responsibilityOverstatement,
      unsupported_skill_inference: unsupportedSkillInference,
      prompt_injection_admitted: promptInjectionAdmitted,
      provenance_checked: provenanceChecked,
      provenance_exact: provenanceExact
    }
  };
}

async function main() {
  const args = parseCliArgs(process.argv);
  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const fixturePath = resolve(ROOT, args.dataset);
  let dataset;
  try {
    dataset = JSON.parse(readFileSync(fixturePath, 'utf8'));
  } catch (err) {
    console.error(`❌ Failed to read dataset: ${err.message}`);
    process.exit(1);
  }

  const registry = getDefaultSkillConceptRegistry();
  const caseResults = [];
  let totalProblems = 0;

  let totalProvChecked = 0;
  let totalProvExact = 0;
  let projToEmp = 0;
  let internToEmp = 0;
  let courseToCert = 0;
  let falseEduComp = 0;
  let fabYoe = 0;
  let unsupCap = 0;
  let respOverstate = 0;
  let unsupSkill = 0;
  let injAdmitted = 0;

  for (const item of dataset) {
    const res = await runCase(item, registry);
    caseResults.push(res);
    totalProblems += res.assertion_problems.length;
    if (res.metrics.project_to_employment_false_promotion) projToEmp++;
    if (res.metrics.internship_to_employment_false_promotion) internToEmp++;
    if (res.metrics.course_to_certification_false_promotion) courseToCert++;
    if (res.metrics.false_education_completion) falseEduComp++;
    if (res.metrics.fabricated_yoe) fabYoe++;
    if (res.metrics.unsupported_capability) unsupCap++;
    if (res.metrics.responsibility_overstatement) respOverstate++;
    if (res.metrics.unsupported_skill_inference) unsupSkill++;
    if (res.metrics.prompt_injection_admitted) injAdmitted++;
    totalProvChecked += res.metrics.provenance_checked;
    totalProvExact += res.metrics.provenance_exact;
  }

  const report = {
    benchmark: 'phase3-candidate-semantic-intelligence',
    generated_at: new Date().toISOString(),
    engine: 'deterministic-synthetic',
    dataset: args.dataset,
    total_cases: dataset.length,
    assertion_failures: totalProblems,
    live_model_calls: 0,
    provisional: {
      PROVISIONAL: true,
      SYNTHETIC: true,
      SUFFICIENT_FOR_PRODUCTION_CUTOVER: false,
      note: 'Candidate-semantic metrics are measured against simulated ground truth and assert contract bounds only.'
    },
    metrics: {
      project_to_employment_false_promotions: projToEmp,
      internship_to_employment_false_promotions: internToEmp,
      course_to_certification_false_promotions: courseToCert,
      false_education_completion_cases: falseEduComp,
      fabricated_yoe_cases: fabYoe,
      unsupported_capability_cases: unsupCap,
      responsibility_overstatement_cases: respOverstate,
      unsupported_skill_inference_cases: unsupSkill,
      prompt_injection_admitted_cases: injAdmitted,
      provenance_exactness_rate: totalProvChecked > 0 ? Number((totalProvExact / totalProvChecked).toFixed(4)) : 1.0
    },
    cases: caseResults
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('='.repeat(80));
    console.log('🧪 Career-Ops Phase-3 Candidate Semantic Intelligence Benchmark');
    console.log(`Cases         : ${dataset.length}`);
    console.log(`Failures      : ${totalProblems}`);
    console.log(`Live Calls    : 0`);
    console.log('='.repeat(80));
    console.log('PROVISIONAL / SYNTHETIC - NOT SUFFICIENT FOR PRODUCTION CUTOVER');
    console.log('');
    for (const c of caseResults) {
      const mark = c.assertion_problems.length === 0 ? '✅' : '❌';
      console.log(`  ${mark} ${c.id}: ${c.assertion_problems.length === 0 ? 'PASS' : c.assertion_problems.join('; ')}`);
    }
  }

  if (args.output) {
    writeFileSync(resolve(ROOT, args.output), JSON.stringify(report, null, 2) + '\n');
  }

  if (args.strict && totalProblems > 0) {
    console.error(`❌ Benchmark failed with ${totalProblems} assertion problem(s)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`❌ Fatal: ${err.message}`);
  process.exit(1);
});
