// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSemanticShadowEnabled,
  detectDisagreements,
  runShadowEvaluation,
  runShadowProfilerHook
} from '../../../src/agent/domain/semantic/shadow/shadow-profiler.mjs';
import { evaluateJob } from '../../../src/agent/domain/jobs/job-evaluator.mjs';

test('isSemanticShadowEnabled checks feature flag values correctly', () => {
  assert.equal(isSemanticShadowEnabled({}), false);
  assert.equal(isSemanticShadowEnabled({ features: { semantic_job_profile: false } }), false);
  assert.equal(isSemanticShadowEnabled({ features: { semantic_job_profile: true } }), true);
  assert.equal(isSemanticShadowEnabled({ features: { semantic_job_profile: 'shadow' } }), true);
});

test('detectDisagreements catches hard veto conflict when legacy rejects but semantic passes', () => {
  const legacyResult = {
    legacy_diagnostics: { fit_status: 'REJECT' },
    job_profile: { overall_yoe_required: 0, role_family: 'ai_ml', seniority: { level: 'SENIOR' } }
  };
  const semanticResult = {
    status: 'SUCCESS',
    semantic_diagnostics: { fit_status: 'STRONG' },
    job_profile: { overall_yoe_required: 0, role_family: 'ai_ml', seniority: { level: 'ENTRY' } }
  };

  const diff = detectDisagreements(legacyResult, semanticResult);
  assert.equal(diff.has_disagreement, true);
  assert.equal(diff.is_hard_veto_conflict, true);
  assert.ok(diff.disagreements.includes('LEGACY_REJECT_SEMANTIC_PASS'));
  assert.ok(diff.disagreements.includes('SENIORITY_DISAGREEMENT'));
});

test('detectDisagreements catches YOE and role family mismatches', () => {
  const legacyResult = {
    legacy_diagnostics: { fit_status: 'STRONG' },
    job_profile: { overall_yoe_required: 5, role_family: 'other', seniority: { level: 'MID' } }
  };
  const semanticResult = {
    status: 'SUCCESS',
    semantic_diagnostics: { fit_status: 'STRONG' },
    job_profile: { overall_yoe_required: 1, role_family: 'ai_ml', seniority: { level: 'MID' } }
  };

  const diff = detectDisagreements(legacyResult, semanticResult);
  assert.equal(diff.has_disagreement, true);
  assert.ok(diff.disagreements.includes('REQUIRED_YOE_MISMATCH'));
  assert.ok(diff.disagreements.includes('ROLE_FAMILY_DISAGREEMENT'));

  // Test that undefined/null YOE does not throw or emit false YOE mismatch
  const undefResult = {
    status: 'UNAVAILABLE',
    semantic_diagnostics: { fit_status: 'NEEDS_REVIEW' }
  };
  const diffUndef = detectDisagreements(legacyResult, undefResult);
  assert.ok(!diffUndef.disagreements.includes('REQUIRED_YOE_MISMATCH'));
});

test('detectDisagreements catches PROVENANCE_FAILURE when semantic extraction fails span validation', () => {
  const legacyResult = {
    legacy_diagnostics: { fit_status: 'STRONG' },
    job_profile: { overall_yoe_required: 1, role_family: 'software_engineering' }
  };
  const semanticResult = {
    status: 'ABSTAINED',
    semantic_diagnostics: {
      fit_status: 'NEEDS_REVIEW',
      error_code: 'PROVENANCE_VALIDATION_FAILED',
      error_message: 'Extracted quote could not be located in source JD text'
    }
  };

  const diff = detectDisagreements(legacyResult, semanticResult);
  assert.equal(diff.has_disagreement, true);
  assert.ok(diff.disagreements.includes('EXTRACTION_ABSTENTION'));
  assert.ok(diff.disagreements.includes('PROVENANCE_FAILURE'));
});

test('runShadowEvaluation preserves legacy authority when flag is off', async () => {
  const sample = {
    sample_id: 'SAMPLE-01',
    metadata: { raw_title: 'Junior Developer', company: 'Acme' },
    raw_jd_text: 'Requires 1 year Python experience.'
  };

  const candidateFacts = { professional_years: 1, professional_years_source: 'cv.md', professional_yoe_verified: true, work_authorization: true };
  const candidateProfile = { features: { semantic_job_profile: false } };

  const result = await runShadowEvaluation({ sample, candidateFacts, candidateProfile });
  assert.equal(result.shadow_executed, false);
  assert.ok(result.production_result);
});

test('runShadowEvaluation executes shadow and logs PII-free telemetry when flag is enabled', async () => {
  const jdText = 'Lead AI Specialist - New Graduate Program. 0-1 years of experience in Python required.';
  const sample = {
    sample_id: 'SAMPLE-SHADOW-01',
    metadata: { raw_title: 'Lead AI Specialist - New Graduate Program', company: 'Tel Aviv Labs' },
    raw_jd_text: jdText
  };

  const candidateFacts = {
    full_name: 'Jane Candidate',
    email: 'private@example.com',
    phone: '+972-50-1234567',
    professional_years: 1,
    professional_years_source: 'cv.md',
    professional_yoe_verified: true,
    work_authorization: true
  };

  const candidateProfile = {
    no_senior: true,
    target_seniority: 'junior',
    features: { semantic_job_profile: 'shadow' }
  };

  const mockResponse = {
    role: { primary_family: 'ai_ml', specialization: 'Applied AI' },
    seniority: {
      level: 'ENTRY',
      is_early_career_friendly: true,
      rationale: 'Accelerated program targeting new university graduates.',
      evidence_signals: { title_signal: 'Lead AI Specialist', yoe_signal: '0-1 years', responsibility_scope: 'TASK_EXECUTION' }
    },
    experience: { overall_years_required: 0, overall_years_preferred: 1 },
    work_model: { type: 'ONSITE', allowed_jurisdictions: ['IL'] },
    requirements: [
      {
        description: '0-1 YOE Python',
        type: 'YEARS_EXPERIENCE',
        importance: 'REQUIRED',
        min_years: 0,
        verbatim_quote: '0-1 years of experience in Python required'
      }
    ],
    confidence: 0.95
  };

  const result = await runShadowEvaluation({
    sample,
    candidateFacts,
    candidateProfile,
    options: { mockResponse }
  });

  assert.equal(result.shadow_executed, true);
  assert.ok(result.telemetry);

  // Invariant 8 & 9: Legacy remains authoritative for production_result
  assert.equal(result.production_result.legacy_diagnostics.fit_status, 'REJECT'); // Legacy title veto fired
  assert.equal(result.shadow_result?.semantic_diagnostics.fit_status, 'STRONG'); // Semantic understood new-grad nature

  // Telemetry logged disagreement and recommended review routing
  assert.equal(result.telemetry.disagreement.detected, true);
  assert.ok(result.telemetry.disagreement.types.includes('LEGACY_REJECT_SEMANTIC_PASS'));
  assert.equal(result.telemetry.disagreement.is_hard_veto_conflict, true);
  assert.equal(result.telemetry.disagreement.recommended_routing, 'NEEDS_REVIEW');

  // Verify zero candidate PII in telemetry
  const serializedTelemetry = JSON.stringify(result.telemetry);
  assert.ok(!serializedTelemetry.includes('Jane Candidate'));
  assert.ok(!serializedTelemetry.includes('private@example.com'));
  assert.ok(!serializedTelemetry.includes('+972-50-1234567'));
});

test('runShadowProfilerHook respects feature flag state (Finding P1-2)', async () => {
  const job = { jdText: 'Developer role requiring Python.', title: 'Dev', company: 'Acme' };
  const legacyResult = { status: 'PASSED', tier: 1 };

  // Flag OFF
  const resOff = await runShadowProfilerHook({
    job,
    legacyResult,
    candidateProfile: { features: { semantic_job_profile: false } }
  });
  assert.equal(resOff.shadow_executed, false);
  assert.equal(resOff.telemetry, undefined);

  // Flag SHADOW
  const mockResponse = {
    role: { primary_family: 'software_engineering' },
    seniority: { level: 'JUNIOR', is_early_career_friendly: true },
    experience: { overall_years_required: 1 },
    work_model: { type: 'ONSITE', allowed_jurisdictions: [] },
    education: { min_degree_level: 'NONE', fields_of_study: [], equivalent_experience_allowed: true },
    domain: { primary_vertical: 'Technology', technical_domain: 'Software', architectural_style: 'UNKNOWN' },
    requirements: [
      {
        description: 'Python',
        type: 'TECHNICAL_SKILL',
        importance: 'REQUIRED',
        verbatim_quote: 'Python'
      }
    ],
    confidence: 0.95
  };

  const resShadow = await runShadowProfilerHook({
    job,
    legacyResult,
    candidateProfile: { features: { semantic_job_profile: 'shadow' } },
    options: { mockResponse }
  });
  assert.equal(resShadow.shadow_executed, true);
  assert.ok(resShadow.telemetry);
  assert.equal(resShadow.telemetry.component, 'live_evaluation_shadow_hook');
});

test('production entrypoint evaluateJob integrates shadow hook without changing legacy authority (Finding P1-2)', async () => {
  const jdText = 'Lead AI Specialist - New Graduate Program. 0-1 years of experience in Python required.';
  const jobParams = {
    title: 'Lead AI Specialist - New Graduate Program',
    company: 'Tel Aviv Labs',
    jdText
  };

  // Production evaluation with shadow OFF
  const resOff = await evaluateJob({
    ...jobParams,
    candidateProfile: {
      no_senior: true,
      target_seniority: 'junior',
      features: { semantic_job_profile: false }
    }
  });

  // Legacy Tier 0 vetoes on Lead token
  assert.equal(resOff.status, 'REJECTED');
  assert.equal(resOff.tier, 0);
  assert.equal(resOff.shadow_telemetry, undefined); // Zero System-1 execution when OFF

  // Production evaluation with shadow ON (using injected deterministic mock gateway)
  const mockShadowResponse = {
    role: { primary_family: 'ai_ml', specialization: 'Applied AI' },
    seniority: {
      level: 'ENTRY',
      is_early_career_friendly: true,
      rationale: 'Accelerated program targeting new university graduates.',
      evidence_signals: { title_signal: 'Lead AI Specialist', yoe_signal: '0-1 years', responsibility_scope: 'TASK_EXECUTION' }
    },
    experience: { overall_years_required: 0, overall_years_preferred: 1 },
    work_model: { type: 'ONSITE', allowed_jurisdictions: [] },
    education: { min_degree_level: null, fields_of_study: [], equivalent_experience_allowed: null },
    domain: { primary_vertical: null, technical_domain: null, architectural_style: 'UNKNOWN' },
    requirements: [
      {
        description: '0-1 YOE Python',
        type: 'YEARS_EXPERIENCE',
        importance: 'REQUIRED',
        min_years: 0,
        verbatim_quote: '0-1 years of experience in Python required'
      }
    ],
    confidence: 0.95
  };

  const resShadow = await evaluateJob({
    ...jobParams,
    candidateProfile: {
      no_senior: true,
      target_seniority: 'junior',
      features: { semantic_job_profile: 'shadow' }
    },
    semanticOptions: { mockResponse: mockShadowResponse }
  });

  // Legacy Tier 0 still authoritatively decides REJECTED (Zero production behavior change)
  assert.equal(resShadow.status, 'REJECTED');
  assert.equal(resShadow.tier, 0);
  // Shadow telemetry is non-destructively attached
  assert.ok(resShadow.shadow_telemetry);
  assert.equal(resShadow.shadow_telemetry.component, 'live_evaluation_shadow_hook');
  assert.equal(resShadow.shadow_telemetry.legacy.status, 'REJECTED');
});
