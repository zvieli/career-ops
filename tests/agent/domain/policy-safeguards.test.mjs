// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateSemanticFitPolicy,
  PROVISIONAL_EXTRACTION_CONFIDENCE_THRESHOLD
} from '../../../src/agent/domain/semantic/policy-safeguards.mjs';

test('PROVISIONAL_EXTRACTION_CONFIDENCE_THRESHOLD is exported and configurable (Finding P2-1)', () => {
  assert.equal(PROVISIONAL_EXTRACTION_CONFIDENCE_THRESHOLD, 0.70);

  const jobProfile = {
    job_id: 'job-threshold-test',
    title: 'Developer',
    extraction_confidence: 0.75, // Above default 0.70, but below custom 0.80
    seniority: { level: 'JUNIOR', is_early_career_friendly: true },
    overall_yoe_required: 1,
    requirements: []
  };
  const candidate = { verified_yoe: 1, legal_eligibility: {} };

  // Default threshold (0.70): 0.75 passes as STRONG
  const defaultRes = evaluateSemanticFitPolicy({ jobProfile, candidateProfile: candidate });
  assert.equal(defaultRes.policy_status, 'STRONG');

  // Custom strict threshold (0.80): 0.75 triggers NEEDS_REVIEW
  const strictRes = evaluateSemanticFitPolicy({
    jobProfile,
    candidateProfile: candidate,
    options: { confidenceThreshold: 0.80 }
  });
  assert.equal(strictRes.policy_status, 'NEEDS_REVIEW');
  assert.ok(strictRes.reasons.some((r) => r.includes('< threshold 0.80')));

  // Custom permissive threshold (0.60): 0.65 passes as STRONG
  const lowJob = { ...jobProfile, extraction_confidence: 0.65 };
  const permRes = evaluateSemanticFitPolicy({
    jobProfile: lowJob,
    candidateProfile: candidate,
    options: { confidenceThreshold: 0.60 }
  });
  assert.equal(permRes.policy_status, 'STRONG');
});

test('low extraction confidence escalates to NEEDS_REVIEW', () => {
  const jobProfile = {
    job_id: 'job-1',
    title: 'Junior Developer',
    extraction_confidence: 0.65,
    seniority: { level: 'JUNIOR', is_early_career_friendly: true },
    overall_yoe_required: 1,
    requirements: []
  };
  const candidateProfile = { verified_yoe: 1, legal_eligibility: {} };

  const result = evaluateSemanticFitPolicy({ jobProfile, candidateProfile });
  assert.equal(result.policy_status, 'NEEDS_REVIEW');
  assert.equal(result.requires_human_review, true);
  assert.ok(result.reasons.some((r) => r.includes('Low extraction confidence')));
});

test('unknown work authorization in mandatory job escalates to NEEDS_REVIEW, never false REJECT', () => {
  const jobProfile = {
    job_id: 'job-2',
    title: 'Junior Backend Engineer',
    extraction_confidence: 0.95,
    seniority: { level: 'JUNIOR', is_early_career_friendly: true },
    overall_yoe_required: 1,
    requirements: [
      {
        requirement_id: 'req-legal',
        type: 'LEGAL_ADMINISTRATIVE',
        importance: 'LEGAL_MANDATORY',
        description: 'Work authorization required in Israel'
      }
    ]
  };

  // Candidate with null (unknown) work authorization
  const candidateProfile = {
    verified_yoe: 1,
    legal_eligibility: { work_authorization: null }
  };

  const result = evaluateSemanticFitPolicy({ jobProfile, candidateProfile });
  assert.equal(result.legal_eligibility_status, 'NEEDS_REVIEW');
  assert.equal(result.policy_status, 'NEEDS_REVIEW');
  assert.equal(result.requires_human_review, true);
  assert.notEqual(result.policy_status, 'REJECT');
});

test('confirmed lack of work authorization yields INELIGIBLE and REJECT', () => {
  const jobProfile = {
    job_id: 'job-3',
    title: 'Junior Backend Engineer',
    extraction_confidence: 0.95,
    seniority: { level: 'JUNIOR', is_early_career_friendly: true },
    overall_yoe_required: 1,
    requirements: [
      {
        requirement_id: 'req-legal',
        type: 'LEGAL_ADMINISTRATIVE',
        importance: 'LEGAL_MANDATORY',
        description: 'Work authorization required in Israel'
      }
    ]
  };

  const candidateProfile = {
    verified_yoe: 1,
    legal_eligibility: { work_authorization: false }
  };

  const result = evaluateSemanticFitPolicy({ jobProfile, candidateProfile });
  assert.equal(result.legal_eligibility_status, 'INELIGIBLE');
  assert.equal(result.policy_status, 'REJECT');
});

test('title inflation trap: Lead title with 0 YOE is identified as early-career friendly and false-reject risk', () => {
  const jobProfile = {
    job_id: 'job-4',
    title: 'Lead AI Specialist - New Graduate Program',
    extraction_confidence: 0.95,
    seniority: {
      level: 'ENTRY',
      is_early_career_friendly: true,
      rationale: 'Accelerated leadership track for new university graduates'
    },
    overall_yoe_required: 0,
    requirements: []
  };

  const candidateProfile = {
    verified_yoe: 1,
    legal_eligibility: { work_authorization: true }
  };

  // Semantic policy evaluates true requirements -> STRONG, flags false reject risk
  const result = evaluateSemanticFitPolicy({ jobProfile, candidateProfile });
  assert.equal(result.policy_status, 'STRONG');
  assert.equal(result.is_false_reject_risk, true);

  // Under legacy strict title veto, this would be rejected
  const legacyVetoResult = evaluateSemanticFitPolicy({
    jobProfile,
    candidateProfile,
    options: { enforceSeniorTitleVeto: true }
  });
  assert.equal(legacyVetoResult.policy_status, 'REJECT');
  assert.equal(legacyVetoResult.is_false_reject_risk, true);
});

test('YOE shortfall tiers: 0 is STRONG, 1-3 is LONG_STRETCH, >=4 is REJECT', () => {
  const makeJob = (reqYoe) => ({
    job_id: 'job-yoe',
    title: 'Software Engineer',
    extraction_confidence: 0.95,
    seniority: { level: 'MID', is_early_career_friendly: false },
    overall_yoe_required: reqYoe,
    requirements: []
  });

  const candidate = {
    verified_yoe: 1,
    legal_eligibility: { work_authorization: true }
  };

  assert.equal(evaluateSemanticFitPolicy({ jobProfile: makeJob(1), candidateProfile: candidate }).policy_status, 'STRONG');
  assert.equal(evaluateSemanticFitPolicy({ jobProfile: makeJob(3), candidateProfile: candidate }).policy_status, 'LONG_STRETCH');
  assert.equal(evaluateSemanticFitPolicy({ jobProfile: makeJob(5), candidateProfile: candidate }).policy_status, 'REJECT');
});
