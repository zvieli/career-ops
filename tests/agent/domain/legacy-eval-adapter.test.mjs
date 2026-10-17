// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLegacyEvaluation } from '../../../src/agent/domain/semantic/adapters/legacy-eval-adapter.mjs';
import {
  validateJobSemanticProfile,
  validateMatchProfile
} from '../../../src/agent/domain/semantic/semantic-entities.mjs';

test('runLegacyEvaluation produces strictly schema-valid JobSemanticProfile and MatchProfile', async () => {
  const sample = {
    sample_id: 'TEST-001',
    metadata: {
      raw_title: 'Junior Python Developer',
      company: 'Haifa Software Labs',
      language: 'en',
      jurisdiction: 'IL'
    },
    raw_jd_text: 'We are hiring a Junior Python Developer. Requires 1 year of experience with Python and FastAPI.'
  };

  const candidateFacts = {
    professional_years: 1,
    professional_years_source: 'cv.md',
    professional_yoe_verified: true,
    work_authorization: true
  };

  const result = await runLegacyEvaluation({ sample, candidateFacts });

  assert.ok(result.job_profile);
  assert.ok(result.match_profile);
  assert.ok(result.legacy_diagnostics);

  const jobValidation = validateJobSemanticProfile(result.job_profile);
  assert.equal(jobValidation.valid, true, `JobProfile schema errors: ${JSON.stringify(jobValidation.errors)}`);

  const matchValidation = validateMatchProfile(result.match_profile);
  assert.equal(matchValidation.valid, true, `MatchProfile schema errors: ${JSON.stringify(matchValidation.errors)}`);

  assert.equal(result.legacy_diagnostics.fit_status, 'STRONG');
  assert.equal(result.legacy_diagnostics.rejection_type, 'NONE');
  assert.equal(result.legacy_diagnostics.is_false_reject, false);
});

test('runLegacyEvaluation faithfully reproduces title regex false rejection', async () => {
  const sample = {
    sample_id: 'TEST-FALSE-REJECT',
    metadata: {
      raw_title: 'Lead AI Specialist - New Graduate Program',
      company: 'Tel Aviv AI Labs',
      language: 'en',
      jurisdiction: 'IL'
    },
    raw_jd_text: 'New graduate program. 0-1 years of experience in Python required.'
  };

  const candidateFacts = {
    professional_years: 1,
    professional_years_source: 'cv.md',
    professional_yoe_verified: true,
    work_authorization: true
  };

  const candidateProfile = {
    no_senior: true,
    target_seniority: 'junior'
  };

  const result = await runLegacyEvaluation({ sample, candidateFacts, candidateProfile });

  // Legacy tier0 or candidate fit gate rejects because of "Lead" token in title
  assert.equal(result.legacy_diagnostics.fit_status, 'REJECT');
  assert.equal(result.match_profile.yoe_comparison.policy_status, 'REJECT');
  assert.equal(result.legacy_diagnostics.rejection_type, 'HEURISTIC_DISCARD');
  assert.equal(result.legacy_diagnostics.is_false_reject, true);
});

test('runLegacyEvaluation Tier-0 blacklist discard propagates REJECT to match_profile and fit_status', async () => {
  const sample = {
    sample_id: 'TEST-BLACKLIST',
    metadata: {
      raw_title: 'Junior Developer',
      company: 'BadCompany Ltd',
      language: 'en',
      jurisdiction: 'IL'
    },
    raw_jd_text: 'Requirements: 1 year of software engineering experience.'
  };

  const candidateFacts = {
    professional_years: 1,
    professional_years_source: 'cv.md',
    professional_yoe_verified: true,
    work_authorization: true,
    blacklist: ['badcompany ltd']
  };

  const result = await runLegacyEvaluation({
    sample,
    candidateFacts,
    candidateProfile: candidateFacts
  });

  assert.equal(result.legacy_diagnostics.tier0_passed, false);
  assert.equal(result.legacy_diagnostics.tier0_reason, 'BLACKLISTED_COMPANY');
  assert.equal(result.legacy_diagnostics.fit_status, 'REJECT');
  assert.equal(result.match_profile.yoe_comparison.policy_status, 'REJECT');
  assert.equal(result.legacy_diagnostics.rejection_type, 'POLICY_DISCARD');
});

test('runLegacyEvaluation correctly rejects true senior role with high YOE', async () => {
  const sample = {
    sample_id: 'TEST-TRUE-SENIOR',
    metadata: {
      raw_title: 'Senior Backend Engineer',
      company: 'Scale Ops Ltd',
      language: 'en',
      jurisdiction: 'IL'
    },
    raw_jd_text: 'Must have at least 8 years of experience building distributed systems in Go.'
  };

  const candidateFacts = {
    professional_years: 1,
    professional_years_source: 'cv.md',
    professional_yoe_verified: true,
    work_authorization: true
  };

  const result = await runLegacyEvaluation({ sample, candidateFacts });

  assert.equal(result.legacy_diagnostics.fit_status, 'REJECT');
  assert.equal(result.legacy_diagnostics.is_false_reject, false);
});
