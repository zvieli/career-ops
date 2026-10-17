// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SemanticEngine } from '../../../src/agent/domain/semantic/adapters/semantic-engine.mjs';
import {
  validateJobSemanticProfile,
  validateMatchProfile
} from '../../../src/agent/domain/semantic/semantic-entities.mjs';

test('SemanticEngine implements ISemanticEngine contract', () => {
  const engine = new SemanticEngine();
  assert.equal(engine.isImplemented, true);
  assert.equal(engine.engineName, 'semantic-system1');
});

test('SemanticEngine.evaluate produces valid JobSemanticProfile and MatchProfile on success', async () => {
  const jdText = 'We are hiring a Junior AI Engineer. Requirements: 1 year of Python experience.';
  const sample = {
    sample_id: 'SAMPLE-SEM-01',
    metadata: {
      raw_title: 'Junior AI Engineer',
      company: 'Tel Aviv AI',
      language: 'en',
      jurisdiction: 'IL'
    },
    raw_jd_text: jdText
  };

  const candidateFacts = {
    professional_years: 1,
    professional_years_source: 'cv.md',
    professional_yoe_verified: true,
    work_authorization: true
  };

  const mockResponse = {
    role: { primary_family: 'ai_ml', specialization: 'Applied AI' },
    seniority: { level: 'JUNIOR', is_early_career_friendly: true, rationale: 'Junior AI role' },
    experience: { overall_years_required: 1, overall_years_preferred: null },
    work_model: { type: 'HYBRID', allowed_jurisdictions: ['IL'] },
    requirements: [
      {
        description: '1 year Python',
        type: 'YEARS_EXPERIENCE',
        importance: 'REQUIRED',
        min_years: 1,
        verbatim_quote: '1 year of Python experience'
      },
      {
        description: 'Python programming',
        type: 'TECHNICAL_SKILL',
        importance: 'REQUIRED',
        min_years: null,
        verbatim_quote: 'Python'
      }
    ],
    confidence: 0.95
  };

  const engine = new SemanticEngine({ mockResponse });
  const result = await engine.evaluate({ sample, candidateFacts });

  assert.equal(result.status, 'SUCCESS');
  assert.ok(result.job_profile);
  assert.ok(result.match_profile);

  assert.equal(validateJobSemanticProfile(result.job_profile).valid, true);
  assert.equal(validateMatchProfile(result.match_profile).valid, true);

  // Candidate has 1 YOE, job requires 1 YOE -> Shortfall = 0 -> STRONG
  assert.equal(result.match_profile.yoe_comparison.shortfall, 0);
  assert.equal(result.match_profile.yoe_comparison.policy_status, 'STRONG');
  assert.equal(result.semantic_diagnostics.fit_status, 'STRONG');

  // Finding 3: Non-YOE requirements are synthesized with UNKNOWN relation until Phase 4 capability matching
  const skillMatch = result.match_profile.requirement_matches.find((m) => m.evidence_quote === 'Python');
  assert.ok(skillMatch);
  assert.equal(skillMatch.relation, 'UNKNOWN');
});

test('SemanticEngine adheres to Models Understand, Code Decides: shortfall >= 4 yields REJECT regardless of model confidence', async () => {
  const jdText = 'Senior Platform Engineer. Minimum 6 years of experience in Go required.';
  const sample = {
    sample_id: 'SAMPLE-SENIOR-01',
    metadata: { raw_title: 'Senior Platform Engineer', company: 'Scale Corp' },
    raw_jd_text: jdText
  };

  // Candidate with 1 verified YOE
  const candidateFacts = {
    professional_years: 1,
    professional_years_source: 'cv.md',
    professional_yoe_verified: true,
    work_authorization: true
  };

  const mockResponse = {
    role: { primary_family: 'devops_cloud' },
    seniority: { level: 'SENIOR', is_early_career_friendly: false },
    experience: { overall_years_required: 6 },
    work_model: { type: 'ONSITE', allowed_jurisdictions: ['IL'] },
    requirements: [
      {
        description: '6 years in Go',
        type: 'YEARS_EXPERIENCE',
        importance: 'REQUIRED',
        min_years: 6,
        verbatim_quote: '6 years of experience in Go'
      }
    ],
    confidence: 1.0 // High model confidence
  };

  const engine = new SemanticEngine({ mockResponse });
  const result = await engine.evaluate({ sample, candidateFacts });

  assert.equal(result.status, 'SUCCESS');
  // Shortfall = 6 - 1 = 5 >= 4 -> Deterministic policy mandates REJECT
  assert.equal(result.match_profile.yoe_comparison.shortfall, 5);
  assert.equal(result.match_profile.yoe_comparison.policy_status, 'REJECT');
  assert.equal(result.semantic_diagnostics.fit_status, 'REJECT');
  assert.equal(result.semantic_diagnostics.rejection_type, 'POLICY_DISCARD');
});

test('SemanticEngine returns UNAVAILABLE when model gateway cannot be reached', async () => {
  const sample = {
    sample_id: 'SAMPLE-UNAVAIL',
    metadata: { raw_title: 'Developer', company: 'Acme' },
    raw_jd_text: 'Requirements: Python'
  };

  const offlineGateway = async () => {
    const err = new Error('pi CLI binary not found in PATH');
    // @ts-ignore
    err.code = 'CLI_UNAVAILABLE';
    throw err;
  };

  const engine = new SemanticEngine({ gateway: offlineGateway });
  const result = await engine.evaluate({ sample, candidateFacts: {} });

  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.semantic_diagnostics.error_code, 'MODEL_UNAVAILABLE');
});

test('SemanticEngine returns UNAVAILABLE when gateway encounters timeout or transport error', async () => {
  const sample = {
    sample_id: 'SAMPLE-TIMEOUT',
    metadata: { raw_title: 'Developer', company: 'Acme' },
    raw_jd_text: 'Requirements: Python'
  };

  const timeoutGateway = async () => {
    const err = new Error('Execution timed out');
    // @ts-ignore
    err.code = 'TIMEOUT';
    throw err;
  };

  const engine = new SemanticEngine({ gateway: timeoutGateway });
  const result = await engine.evaluate({ sample, candidateFacts: {} });

  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.semantic_diagnostics.error_code, 'MODEL_TIMEOUT');
});

test('SemanticEngine returns ABSTAINED with safe NEEDS_REVIEW profile when output validation fails', async () => {
  const sample = {
    sample_id: 'SAMPLE-ABSTAIN',
    metadata: { raw_title: 'Specialist', company: 'Acme' },
    raw_jd_text: 'Vague requirements text.'
  };

  // Malformed mock response (fabricated quote)
  const invalidMock = {
    role: { primary_family: 'other' },
    seniority: { level: 'UNKNOWN', is_early_career_friendly: false },
    requirements: [
      {
        description: 'Fabricated',
        type: 'TECHNICAL_SKILL',
        importance: 'REQUIRED',
        verbatim_quote: 'Non-existent quote that cannot be found anywhere in the text'
      }
    ]
  };

  const engine = new SemanticEngine({ mockResponse: invalidMock });
  const result = await engine.evaluate({ sample, candidateFacts: {} });

  assert.equal(result.status, 'ABSTAINED');
  assert.ok(result.job_profile);
  assert.ok(result.match_profile);
  assert.equal(result.job_profile.extraction_confidence, 0.20);
  assert.equal(result.match_profile.yoe_comparison.policy_status, 'NEEDS_REVIEW');
  assert.equal(result.semantic_diagnostics.fit_status, 'NEEDS_REVIEW');
});
