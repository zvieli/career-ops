// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEMANTIC_SCHEMA_VERSION,
  validateSkillConcept,
  validateCandidateCapability,
  validateJobRequirement,
  validateJobSemanticProfile,
  validateCandidateSemanticProfile,
  validateRequirementMatch,
  validateMatchProfile,
  createSkillConcept,
  createCandidateCapability,
  createJobRequirement,
  createJobSemanticProfile,
  createCandidateSemanticProfile,
  createRequirementMatch,
  createMatchProfile,
  canonicalJsonStringify,
  hashCanonicalJson,
  SemanticValidationError
} from '../../../src/agent/domain/semantic/semantic-entities.mjs';

test('canonicalJsonStringify produces stable, key-sorted output regardless of insertion order', () => {
  const obj1 = { z: 1, a: 2, m: { y: 10, b: 20 } };
  const obj2 = { a: 2, m: { b: 20, y: 10 }, z: 1 };
  assert.equal(canonicalJsonStringify(obj1), canonicalJsonStringify(obj2));
  assert.equal(hashCanonicalJson(obj1), hashCanonicalJson(obj2));
});

test('SkillConcept valid creation and strict validation', () => {
  const valid = createSkillConcept({
    concept_id: 'fastapi',
    canonical_name: 'FastAPI',
    category: 'FRAMEWORK',
    surface_forms: ['FastAPI', 'fast-api'],
    parent_concept_id: 'python',
    ecosystem: 'python'
  });
  const res = validateSkillConcept(valid);
  assert.equal(res.valid, true);

  // Invalid category
  // @ts-ignore
  const invalidCat = { ...valid, category: 'INVALID_CATEGORY' };
  const resCat = validateSkillConcept(invalidCat);
  assert.equal(resCat.valid, false);
  assert.ok(resCat.errors.some((e) => e.code === 'INVALID_ENUM'));

  // Additional property violation
  const withExtra = { ...valid, extra_field: 'not allowed' };
  const resExtra = validateSkillConcept(withExtra);
  assert.equal(resExtra.valid, false);
  assert.ok(resExtra.errors.some((e) => e.code === 'UNEXPECTED_PROPERTY'));

  // Invalid concept_id pattern (uppercase not allowed)
  const invalidPattern = { ...valid, concept_id: 'FastAPI_UPPER' };
  const resPattern = validateSkillConcept(invalidPattern);
  assert.equal(resPattern.valid, false);
  assert.ok(resPattern.errors.some((e) => e.code === 'PATTERN_MISMATCH'));
});

test('CandidateCapability valid creation and strict validation', () => {
  const valid = createCandidateCapability({
    capability_id: 'cap-001',
    concept_id: 'python',
    name: 'Python',
    depth: 'PRODUCTION',
    years_experience: 2,
    is_verified: true,
    provenance: {
      source_file: 'cv.md',
      verbatim_quote: 'Developed scalable microservices in Python',
      source_hash: 'a'.repeat(64)
    }
  });
  assert.equal(validateCandidateCapability(valid).valid, true);

  // Null start_char and end_char remain null and do not coerce to 0
  const nullSpanCap = createCandidateCapability({
    capability_id: 'cap-null-span',
    concept_id: 'python',
    name: 'Python',
    depth: 'PRODUCTION',
    is_verified: true,
    provenance: {
      source_file: 'cv.md',
      verbatim_quote: 'Python',
      source_hash: 'a'.repeat(64),
      start_char: null,
      end_char: null
    }
  });
  assert.equal(nullSpanCap.provenance.start_char, null);
  assert.equal(nullSpanCap.provenance.end_char, null);
  assert.equal(validateCandidateCapability(nullSpanCap).valid, true);

  // Invalid source file
  // @ts-ignore
  const invalidSource = {
    ...valid,
    provenance: { ...valid.provenance, source_file: 'untrusted_website.com' }
  };
  const resSource = validateCandidateCapability(invalidSource);
  assert.equal(resSource.valid, false);
  assert.ok(resSource.errors.some((e) => e.code === 'INVALID_ENUM'));

  // Missing required field
  const missingName = { ...valid };
  // @ts-ignore
  delete missingName.name;
  assert.equal(validateCandidateCapability(missingName).valid, false);
});

test('JobRequirement valid creation and strict validation', () => {
  const valid = createJobRequirement({
    requirement_id: 'req-001',
    type: 'TECHNICAL_SKILL',
    importance: 'REQUIRED',
    description: 'Requires Python 3.11+ proficiency',
    target_concept_id: 'python',
    evidence_span: {
      start_char: 10,
      end_char: 25,
      verbatim_quote: 'Python 3.11+'
    },
    confidence: 0.95
  });
  assert.equal(validateJobRequirement(valid).valid, true);

  // Invalid confidence range (> 1.0)
  const invalidConf = { ...valid, confidence: 1.5 };
  assert.equal(validateJobRequirement(invalidConf).valid, false);

  // Negative offset
  const invalidSpan = {
    ...valid,
    evidence_span: { ...valid.evidence_span, start_char: -5 }
  };
  assert.equal(validateJobRequirement(invalidSpan).valid, false);
});

test('JobSemanticProfile valid creation with nested requirements', () => {
  const req = createJobRequirement({
    requirement_id: 'req-001',
    type: 'TECHNICAL_SKILL',
    importance: 'REQUIRED',
    description: 'Python experience',
    evidence_span: { start_char: 0, end_char: 6, verbatim_quote: 'Python' },
    confidence: 1.0
  });

  const profile = createJobSemanticProfile({
    job_id: 'job-100',
    title: 'Junior AI Developer',
    company: 'Tel Aviv Tech',
    role_family: 'ai_ml',
    seniority: {
      level: 'JUNIOR',
      is_early_career_friendly: true,
      rationale: 'Junior title and 0 YOE requirement'
    },
    work_model: {
      type: 'HYBRID',
      allowed_jurisdictions: ['IL']
    },
    requirements: [req],
    overall_yoe_required: 1,
    jd_hash: 'b'.repeat(64),
    model_metadata: {
      model_id: 'legacy-adapter',
      prompt_version: 'v1.0.0',
      schema_version: SEMANTIC_SCHEMA_VERSION
    }
  });

  assert.equal(validateJobSemanticProfile(profile).valid, true);

  // Proves Task 9, 10, 11 values are retained across serialization under additionalProperties: false (Finding P1-1)
  const fullProfile = createJobSemanticProfile({
    job_id: 'job-full',
    title: 'Senior Systems Engineer',
    company: 'Enterprise Corp',
    role_family: 'software_engineering',
    seniority: {
      level: 'SENIOR',
      is_early_career_friendly: false,
      rationale: 'Staff-level responsibilities',
      evidence_signals: {
        title_signal: 'Senior Systems Engineer',
        yoe_signal: '5+ years',
        responsibility_scope: 'SYSTEM_OWNERSHIP'
      }
    },
    work_model: {
      type: 'HYBRID',
      allowed_jurisdictions: ['US', 'IL'],
      hybrid_days_in_office: 3,
      timezone_restrictions: ['UTC-5', 'UTC+2'],
      evidence_span: { start_char: 0, end_char: 6, verbatim_quote: 'Python' }
    },
    education: {
      min_degree_level: 'BACHELOR',
      fields_of_study: ['Computer Science', 'Electrical Engineering'],
      equivalent_experience_allowed: true,
      min_gpa: 3.5,
      gpa_scale: '4.0',
      evidence_span: { start_char: 0, end_char: 6, verbatim_quote: 'Python' }
    },
    domain: {
      primary_vertical: 'Fintech',
      technical_domain: 'High-Throughput Distributed Systems',
      architectural_style: 'EVENT_DRIVEN'
    },
    requirements: [req],
    overall_yoe_required: 5,
    jd_hash: 'b'.repeat(64),
    model_metadata: {
      model_id: 'test-profiler',
      prompt_version: 'v1.2.0',
      schema_version: SEMANTIC_SCHEMA_VERSION
    }
  });

  const serialized = canonicalJsonStringify(fullProfile);
  const deserialized = JSON.parse(serialized);
  assert.equal(validateJobSemanticProfile(deserialized).valid, true);

  assert.equal(deserialized.education.min_degree_level, 'BACHELOR');
  assert.deepEqual(deserialized.education.fields_of_study, ['Computer Science', 'Electrical Engineering']);
  assert.equal(deserialized.education.min_gpa, 3.5);
  assert.equal(deserialized.work_model.hybrid_days_in_office, 3);
  assert.deepEqual(deserialized.work_model.timezone_restrictions, ['UTC-5', 'UTC+2']);
  assert.equal(deserialized.domain.primary_vertical, 'Fintech');
  assert.equal(deserialized.domain.architectural_style, 'EVENT_DRIVEN');
  assert.equal(deserialized.seniority.evidence_signals.responsibility_scope, 'SYSTEM_OWNERSHIP');

  // Invalid nested requirement inside array
  const badNested = {
    ...profile,
    requirements: [{ ...req, type: 'UNKNOWN_TYPE' }]
  };
  const badRes = validateJobSemanticProfile(badNested);
  assert.equal(badRes.valid, false);
  assert.ok(badRes.errors.some((e) => e.path.includes('requirements[0].type')));
});

test('CandidateSemanticProfile valid creation and strict validation', () => {
  const cap = createCandidateCapability({
    capability_id: 'cap-1',
    concept_id: 'python',
    name: 'Python',
    depth: 'PRODUCTION',
    is_verified: true,
    provenance: {
      source_file: 'cv.md',
      verbatim_quote: 'Python development',
      source_hash: 'c'.repeat(64)
    }
  });

  const candidate = createCandidateSemanticProfile({
    candidate_id: 'cand-001',
    candidate_hash: 'd'.repeat(64),
    verified_yoe: 1,
    verified_yoe_source: 'cv.md',
    capabilities: [cap],
    education: [{
      degree: 'B.Sc.',
      field: 'Computer Science',
      institution: 'Tel Aviv University',
      gpa: 88,
      gpa_scale: '100',
      is_verified: true,
      source_file: 'cv.md',
      source_quote: 'B.Sc. in Computer Science, Tel Aviv University'
    }],
    legal_eligibility: {
      work_authorization: true,
      security_clearance: false,
      citizenship: ['IL'],
      requires_sponsorship: false
    },
    target_roles: ['software_engineering', 'ai_ml'],
    provenance_summary: {
      cv_hash: 'e'.repeat(64)
    }
  });

  assert.equal(validateCandidateSemanticProfile(candidate).valid, true);

  // Incomplete legal eligibility (missing required field)
  const incomplete = {
    ...candidate,
    legal_eligibility: { work_authorization: true }
  };
  assert.equal(validateCandidateSemanticProfile(incomplete).valid, false);
});

test('MatchProfile valid creation and strict validation', () => {
  const reqMatch = createRequirementMatch({
    requirement_id: 'req-001',
    relation: 'EXACT',
    evidence_quote: 'Python',
    is_gap: false,
    match_confidence: 1.0
  });

  const matchProfile = createMatchProfile({
    match_id: 'match-001',
    job_id: 'job-100',
    candidate_hash: 'f'.repeat(64),
    requirement_matches: [reqMatch],
    yoe_comparison: {
      required_yoe: 1,
      candidate_verified_yoe: 1,
      shortfall: 0,
      policy_status: 'STRONG'
    },
    legal_eligibility_status: 'ELIGIBLE',
    critical_gaps: [],
    transferable_strengths: [],
    overall_match_score: 4.5
  });

  assert.equal(validateMatchProfile(matchProfile).valid, true);

  // Invalid match score out of range (6.0 > 5.0)
  const invalidScore = { ...matchProfile, overall_match_score: 6.0 };
  assert.equal(validateMatchProfile(invalidScore).valid, false);
});
