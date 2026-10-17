// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANDIDATE_EXPERIENCE_TYPES,
  CANDIDATE_EVIDENCE_ROLES,
  CANDIDATE_RESPONSIBILITY_LEVELS,
  CANDIDATE_EDUCATION_STATUSES,
  CANDIDATE_DEGREE_LEVELS,
  CANDIDATE_ENVIRONMENT_TYPES,
  CANDIDATE_EVIDENCE_CONTEXT_TYPES,
  validateCandidateEvidence,
  validateCandidateExperience,
  validateCandidateSkillEvidence,
  validateCandidateEducation,
  validateCandidateCertification,
  validateCandidateCapability,
  validateCandidateSemanticProfile,
  createCandidateEvidence,
  createCandidateExperience,
  createCandidateSkillEvidence,
  createCandidateEducation,
  createCandidateCertification,
  createCandidateCapability,
  createCandidateSemanticProfile,
  SemanticValidationError
} from '../../../src/agent/domain/semantic/semantic-entities.mjs';

test('CandidateEvidence valid creation and strict schema validation', () => {
  const valid = createCandidateEvidence({
    evidence_id: 'ev-01',
    candidate_id: 'cand-01',
    source_id: 'cv.md',
    source_type: 'TEXT_DOCUMENT',
    source_hash: 'a'.repeat(64),
    section: 'Experience',
    evidence_span: { start_char: 10, end_char: 35, verbatim_quote: 'Built microservices in Go' },
    evidence_role: 'CANDIDATE_FACT',
    extraction_version: 'v1.3.0-phase3'
  });
  assert.equal(validateCandidateEvidence(valid).valid, true);

  // Reject unexpected property
  assert.equal(validateCandidateEvidence({ ...valid, extra: 'bad' }).valid, false);

  // Reject invalid role
  assert.throws(
    // @ts-ignore
    () => createCandidateEvidence({ ...valid, evidence_role: 'INVALID_ROLE' }),
    (err) => err instanceof SemanticValidationError
  );

  // Reject missing role
  assert.throws(
    // @ts-ignore
    () => createCandidateEvidence({ ...valid, evidence_role: undefined }),
    (err) => err instanceof SemanticValidationError
  );
});

test('CandidateExperience valid creation and strict validation', () => {
  const valid = createCandidateExperience({
    experience_id: 'exp-01',
    experience_type: 'EMPLOYMENT',
    organization_or_project_name: 'Acme Corp',
    role_title: 'Senior Software Engineer',
    start_date: { raw: '2022', year: 2022, precision: 'YEAR' },
    end_date: { raw: 'Present', precision: 'PRESENT' },
    is_current: true,
    evidence_ids: ['ev-01'],
    source_confidence: 0.95
  });
  assert.equal(validateCandidateExperience(valid).valid, true);

  // Unknown experience type is rejected
  assert.throws(
    // @ts-ignore
    () => createCandidateExperience({ ...valid, experience_type: 'NOT_A_TYPE' }),
    (err) => err instanceof SemanticValidationError
  );

  // Missing evidence_ids is rejected by schema
  const noEv = { ...valid, evidence_ids: [] };
  assert.equal(validateCandidateExperience(noEv).valid, false);
});

test('CandidateSkillEvidence valid creation and strict validation', () => {
  const valid = createCandidateSkillEvidence({
    skill_evidence_id: 'csk-01',
    surface_form: 'Go',
    normalized_surface: 'go',
    category: 'LANGUAGE',
    evidence_id: 'ev-01',
    experience_id: 'exp-01',
    evidence_context_type: 'EMPLOYMENT',
    resolution: {
      state: 'RESOLVED',
      concept_id: 'go',
      canonical_name: 'Go',
      method: 'EXACT_CANONICAL',
      confidence: 1.0
    },
    confidence: 1.0
  });
  assert.equal(validateCandidateSkillEvidence(valid).valid, true);

  // Invalid resolution state
  const badRes = { ...valid, resolution: { ...valid.resolution, state: 'MAYBE' } };
  assert.equal(validateCandidateSkillEvidence(badRes).valid, false);
});

test('CandidateEducation valid creation and strict validation', () => {
  const valid = createCandidateEducation({
    education_id: 'edu-01',
    degree_level: 'BACHELOR',
    field: 'Computer Science',
    institution: 'Technion',
    status: 'COMPLETED',
    completion_date: { raw: '2024', year: 2024 },
    evidence_ids: ['ev-01']
  });
  assert.equal(validateCandidateEducation(valid).valid, true);

  // Invalid status rejected
  const badStatus = { ...valid, status: 'DONE' };
  assert.equal(validateCandidateEducation(badStatus).valid, false);
});

test('CandidateCertification valid creation and strict validation', () => {
  const valid = createCandidateCertification({
    certification_id: 'cert-01',
    name: 'AWS Certified Solutions Architect',
    issuer: 'AWS',
    is_certified: true,
    evidence_ids: ['ev-01']
  });
  assert.equal(validateCandidateCertification(valid).valid, true);
});

test('CandidateCapability valid creation and strict validation', () => {
  const valid = createCandidateCapability({
    capability_id: 'cap-01',
    concept_id: 'go',
    name: 'Built microservices in Go',
    depth: 'PRODUCTION',
    is_verified: true,
    provenance: {
      source_file: 'cv.md',
      verbatim_quote: 'Built microservices in Go',
      source_hash: 'a'.repeat(64),
      start_char: 10,
      end_char: 35
    },
    activity: 'built',
    object: 'microservices',
    skill_concept_ids: ['go'],
    responsibility_level: 'IMPLEMENTED',
    environment_type: 'PRODUCTION',
    outcome: 'handled 50k req/sec'
  });
  assert.equal(validateCandidateCapability(valid).valid, true);

  // Unknown responsibility level rejected
  assert.equal(validateCandidateCapability({ ...valid, responsibility_level: 'SUPERVISOR' }).valid, false);
});

test('CandidateSemanticProfile full assembly passes strict schema validation', () => {
  const profile = createCandidateSemanticProfile({
    candidate_id: 'cand-01',
    candidate_hash: 'b'.repeat(64),
    verified_yoe: 2,
    verified_yoe_source: 'cv.md',
    capabilities: [],
    education: [],
    legal_eligibility: {
      work_authorization: true,
      security_clearance: false,
      citizenship: ['IL']
    },
    target_roles: ['Software Engineer'],
    provenance_summary: { cv_hash: 'b'.repeat(64) },
    evidence: [],
    experiences: [],
    skills: [],
    certifications: []
  });
  assert.equal(validateCandidateSemanticProfile(profile).valid, true);
});
