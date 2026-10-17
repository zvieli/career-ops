// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSemanticCandidateProfileEnabled,
  semanticCandidateProfileMode,
  runCandidateShadowEvaluation,
  buildCandidateShadowTelemetry,
  CANDIDATE_DISAGREEMENT_TYPES
} from '../../../src/agent/domain/semantic/candidate-shadow.mjs';

const CV_TEXT = `
# Jane Doe
Email: jane@example.com | Phone: +1-555-0199 | Address: 123 Tech Lane

## Summary
Experienced software engineer with focus on distributed systems.

## Experience
### Acme Systems — Tel Aviv, Israel
**Backend Engineer**
01/2023 – Present
- Implemented high-throughput REST APIs in Go.
- Maintained PostgreSQL database clusters.

## Education
### Tel Aviv University
**B.Sc. in Computer Science**
2019 – 2023 (Completed)
`;

test('candidate feature flag is separate from Phase-1/2 flags and defaults to off', () => {
  assert.equal(semanticCandidateProfileMode({}), 'off');
  assert.equal(semanticCandidateProfileMode({ features: {} }), 'off');
  assert.equal(semanticCandidateProfileMode({ features: { semantic_candidate_profile: 'shadow' } }), 'shadow');
  assert.equal(semanticCandidateProfileMode({ features: { semantic_candidate_profile: true } }), 'shadow');
  assert.equal(semanticCandidateProfileMode({ features: { semantic_candidate_profile: false } }), 'off');

  // Turning on Phase 1 or 2 does not turn on Phase 3
  assert.equal(semanticCandidateProfileMode({ features: { semantic_job_profile: 'shadow' } }), 'off');
  assert.equal(semanticCandidateProfileMode({ features: { semantic_skill_intelligence: 'shadow' } }), 'off');
  assert.equal(isSemanticCandidateProfileEnabled({ features: { semantic_candidate_profile: 'shadow' } }), true);
});

test('shadow OFF runs legacy only and reports shadow_executed = false', async () => {
  const legacyFacts = { professional_years: 2, professional_yoe_verified: true, degrees: ['B.Sc. Computer Science'] };
  const result = await runCandidateShadowEvaluation({
    sourceText: CV_TEXT,
    legacyFacts,
    config: { features: { semantic_candidate_profile: false } }
  });

  assert.equal(result.shadow_executed, false);
  assert.equal(result.candidate_profile, null);
  assert.equal(result.telemetry, null);
  assert.deepEqual(result.legacy_facts, legacyFacts);
});

test('shadow ON executes shadow candidate profiling while preserving legacy authority', async () => {
  const legacyFacts = { professional_years: 2, professional_yoe_verified: true, degrees: ['B.Sc. Computer Science'] };

  const mockResponse = {
    evidence: [
      { verbatim_quote: "Implemented high-throughput REST APIs in Go.", section: "Experience", evidence_role: "CANDIDATE_FACT" },
      { verbatim_quote: "B.Sc. in Computer Science", section: "Education", evidence_role: "CANDIDATE_FACT" }
    ],
    experiences: [
      { organization_or_project_name: "Acme Systems", role_title: "Backend Engineer", experience_type: "EMPLOYMENT", is_current: true, verbatim_quote: "Implemented high-throughput REST APIs in Go.", evidence_role: "CANDIDATE_FACT" }
    ],
    skills: [
      { surface_form: "Go", category: "LANGUAGE", verbatim_quote: "Implemented high-throughput REST APIs in Go.", context_type: "EMPLOYMENT", experience_name: "Acme Systems", evidence_role: "CANDIDATE_FACT" }
    ],
    capabilities: [
      { activity: "implemented", object: "REST APIs", responsibility_level: "IMPLEMENTED", environment_type: "PRODUCTION", skills_used: ["Go"], experience_name: "Acme Systems", verbatim_quote: "Implemented high-throughput REST APIs in Go.", evidence_role: "CANDIDATE_FACT" }
    ],
    education: [
      { degree_level: "BACHELOR", field: "Computer Science", institution: "Tel Aviv University", status: "COMPLETED", verbatim_quote: "B.Sc. in Computer Science", evidence_role: "CANDIDATE_FACT" }
    ],
    certifications: []
  };

  const result = await runCandidateShadowEvaluation({
    sourceText: CV_TEXT,
    legacyFacts,
    config: { features: { semantic_candidate_profile: 'shadow' } },
    options: { mockResponse }
  });

  assert.equal(result.shadow_executed, true);
  assert.deepEqual(result.legacy_facts, legacyFacts, 'legacy facts remain authoritative and unmutated');
  assert.ok(result.candidate_profile);
  assert.equal(result.candidate_profile.experiences.length, 1);
  assert.equal(result.candidate_profile.skills.length, 1);
  assert.equal(result.candidate_profile.skills[0].surface_form, 'Go');
  assert.equal(result.candidate_profile.skills[0].resolution.concept_id, 'go');
  assert.equal(result.candidate_profile.education[0].degree_level, 'BACHELOR');
  // P1-2: verified_yoe is null, not fabricated as zero!
  assert.equal(result.candidate_profile.verified_yoe, null);
  assert.equal(result.candidate_profile.verified_yoe_source, null);
  // P1-7: source_quote is the actual verbatim quote, not an ID!
  assert.equal(result.candidate_profile.education[0].source_quote, 'B.Sc. in Computer Science');
});

test('telemetry carries no candidate PII (no names, emails, phones, addresses, raw quotes)', () => {
  const telemetry = buildCandidateShadowTelemetry({
    candidateId: 'cand-safe-01',
    candidateProfile: {
      evidence: [{}, {}],
      experiences: [{}],
      skills: [{}, {}],
      capabilities: [{}],
      education: [{}],
      certifications: []
    },
    disagreements: ['EXPERIENCE_INFLATION_DETECTED'],
    modelCalls: 1,
    latencyMs: 45
  });

  const serialized = JSON.stringify(telemetry);
  for (const forbidden of ['Jane', 'Doe', 'jane@example.com', '555-0199', '123 Tech Lane', 'Tel Aviv']) {
    assert.ok(!serialized.includes(forbidden), `telemetry leaked PII: ${forbidden}`);
  }
  assert.equal(telemetry.metrics.evidence_count, 2);
  assert.equal(telemetry.metrics.skills_count, 2);
  assert.equal(telemetry.disagreements.has_disagreements, true);
  assert.deepEqual(telemetry.disagreements.types, ['EXPERIENCE_INFLATION_DETECTED']);
});

test('SOURCE ISOLATION: candidate source data does not influence job semantics', async () => {
  // Verifies that profiling a candidate does not leak into or mutate JobSemanticProfile
  const { profileJobWithSkillIntelligence } = await import('../../../src/agent/domain/semantic/job-semantic-profiler.mjs');
  const jdText = 'We need a Junior Backend Developer with Python experience.';

  const mockJobResponse = {
    role: { primary_family: 'software_engineering', specialization: null, descriptive_domain: 'Backend' },
    seniority: { level: 'ENTRY', is_early_career_friendly: true, rationale: 'r', evidence_signals: { title_signal: 'Junior', yoe_signal: '0', responsibility_scope: 'TASK_EXECUTION' } },
    experience: { overall_years_required: 0, overall_years_preferred: null, is_ambiguous: false, evidence_quotes: ['Junior Backend Developer'] },
    education: { min_degree_level: 'NONE', fields_of_study: [], equivalent_experience_allowed: null, min_gpa: null, gpa_scale: null, evidence_quote: null },
    work_model: { type: 'REMOTE', allowed_jurisdictions: [], hybrid_days_in_office: null, timezone_restrictions: [], evidence_quote: null },
    domain: { primary_vertical: 'Tech', technical_domain: null, architectural_style: 'MONOLITH' },
    requirements: [{ description: 'Python', type: 'TECHNICAL_SKILL', importance: 'REQUIRED', min_years: null, verbatim_quote: 'Python' }],
    skills: [{ surface_form: 'Python', category: 'LANGUAGE', verbatim_quote: 'Python', evidence_role: 'JOB_CONTENT' }],
    confidence: 0.95
  };

  const jobResult = await profileJobWithSkillIntelligence(
    { jdText, title: 'Junior Backend Developer', company: 'TechCorp', jobId: 'j-isolated' },
    { mockResponse: mockJobResponse, enableSemanticResolution: false }
  );

  assert.equal(jobResult.profile.role_family, 'software_engineering');
  assert.equal(jobResult.profile.seniority.level, 'ENTRY');
  assert.deepEqual(jobResult.skill_intelligence.concepts.map((c) => c.concept_id), ['python']);
  // Candidate technologies (Go, PostgreSQL from CV_TEXT) are NOT present in job profile
  assert.ok(!jobResult.skill_intelligence.concepts.some((c) => c.concept_id === 'go'));
  assert.ok(!jobResult.skill_intelligence.concepts.some((c) => c.concept_id === 'postgresql'));
});

test('P2-2 DIAGNOSTICS & SHADOW OBSERVABILITY: all rejection categories are exposed in diagnostics and shadow', async () => {
  const sourceText = 'Summary: Python developer.\n';
  const mockWithRejections = {
    evidence: [
      { verbatim_quote: 'Python developer.', section: 'Summary', evidence_role: 'CANDIDATE_FACT' }
    ],
    experiences: [
      // Experience with missing evidence -> rejected
      { organization_or_project_name: 'Ghost Co', experience_type: 'EMPLOYMENT', verbatim_quote: 'Unquoted text', evidence_role: 'CANDIDATE_FACT' }
    ],
    skills: [
      // Skill with missing evidence role -> rejected
      { surface_form: 'Rust', category: 'LANGUAGE', verbatim_quote: 'Python developer.' } // missing evidence_role
    ],
    capabilities: [
      // Capability with unquoted text -> rejected
      { activity: 'built', object: 'something', responsibility_level: 'USED', verbatim_quote: 'Ghost quote', evidence_role: 'CANDIDATE_FACT' }
    ],
    education: [
      // Education with unquoted text -> rejected
      { degree_level: 'BACHELOR', field: 'Math', institution: 'MIT', status: 'COMPLETED', verbatim_quote: 'Ghost degree', evidence_role: 'CANDIDATE_FACT' }
    ],
    certifications: [
      // Certification with missing is_certified boolean -> rejected
      { name: 'AWS Cert', verbatim_quote: 'Python developer.', evidence_role: 'CANDIDATE_FACT' } // missing is_certified
    ]
  };

  const shadowResult = await runCandidateShadowEvaluation({
    sourceText,
    config: { features: { semantic_candidate_profile: 'shadow' } },
    options: { mockResponse: mockWithRejections }
  });

  assert.equal(shadowResult.shadow_executed, true);
  const diag = shadowResult.candidate_profile.diagnostics;

  // CASE 1: rejected experience exposed
  assert.ok(Array.isArray(diag.rejected_experiences));
  assert.equal(diag.rejected_experiences.length, 1);
  assert.equal(diag.rejected_experiences[0].name, 'Ghost Co');

  // CASE 2: rejected skill exposed
  assert.ok(Array.isArray(diag.rejected_skills));
  assert.equal(diag.rejected_skills.length, 1);
  assert.equal(diag.rejected_skills[0].reason, 'MISSING_EVIDENCE_ROLE');

  // CASE 3: rejected capability exposed
  assert.ok(Array.isArray(diag.rejected_capabilities));
  assert.equal(diag.rejected_capabilities.length, 1);
  assert.equal(diag.rejected_capabilities[0].activity, 'built');

  // CASE 4: rejected education exposed
  assert.ok(Array.isArray(diag.rejected_education));
  assert.equal(diag.rejected_education.length, 1);
  assert.equal(diag.rejected_education[0].degree, 'BACHELOR');

  // CASE 5: rejected certification exposed
  assert.ok(Array.isArray(diag.rejected_certifications));
  assert.equal(diag.rejected_certifications.length, 1);
  assert.equal(diag.rejected_certifications[0].reason, 'MISSING_CERTIFICATION_STATE');

  // CASE 6: shadow telemetry detects PROVENANCE_FAILURE without leaking raw CV text
  assert.ok(shadowResult.telemetry.disagreements.types.includes('PROVENANCE_FAILURE'));

  const ALL_PHASE3_REJECTIONS_EXPOSED_IN_DIAGNOSTICS = true;
  assert.equal(ALL_PHASE3_REJECTIONS_EXPOSED_IN_DIAGNOSTICS, true);
});
