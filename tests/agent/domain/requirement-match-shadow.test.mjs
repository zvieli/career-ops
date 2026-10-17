// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  semanticRequirementMatchingMode,
  isSemanticRequirementMatchingEnabled,
  buildRequirementMatchingShadowTelemetry,
  runRequirementMatchingShadow
} from '../../../src/agent/domain/semantic/requirement-match-shadow.mjs';
import { createDeterministicTestFakeRunner } from '../../../src/agent/domain/semantic/test-fakes/deterministic-matching-fake.mjs';

const testFake = createDeterministicTestFakeRunner({ semanticOrigin: 'TEST_FAKE' });

test('requirement matching feature flag defaults to off and recognizes shadow', () => {
  assert.equal(semanticRequirementMatchingMode(), 'off');
  assert.equal(semanticRequirementMatchingMode({}), 'off');
  assert.equal(semanticRequirementMatchingMode({ features: {} }), 'off');
  assert.equal(semanticRequirementMatchingMode({ features: { semantic_requirement_matching: false } }), 'off');

  assert.equal(semanticRequirementMatchingMode({ features: { semantic_requirement_matching: 'shadow' } }), 'shadow');
  assert.equal(semanticRequirementMatchingMode({ features: { semantic_requirement_matching: true } }), 'shadow');

  assert.equal(isSemanticRequirementMatchingEnabled({ features: { semantic_requirement_matching: 'shadow' } }), true);
  assert.equal(isSemanticRequirementMatchingEnabled({ features: { semantic_requirement_matching: false } }), false);
});

test('shadow OFF returns legacy result only and does not execute shadow', async () => {
  const jobProfile = { job_id: 'job-101', requirements: [] };
  const candidateProfile = { candidate_id: 'cand-101' };
  const legacyMatch = { legacy_score: 4.2, fit_decision: 'STRONG' };

  const result = await runRequirementMatchingShadow({
    jobProfile,
    candidateProfile,
    legacyMatchResult: legacyMatch,
    config: { features: { semantic_requirement_matching: false } }
  });

  assert.equal(result.shadowExecuted, false);
  assert.deepEqual(result.authoritativeResult, legacyMatch);
  assert.equal(result.matchProfile, null);
  assert.equal(result.telemetry, null);
});

test('shadow ON executes requirement matching while preserving legacy authority', async () => {
  const jobProfile = {
    job_id: 'job-101',
    requirements: [
      {
        requirement_id: 'req-01',
        type: 'TECHNICAL_SKILL',
        importance: 'REQUIRED',
        description: 'Python experience',
        target_concept_id: 'python'
      }
    ]
  };

  const candidateProfile = {
    candidate_id: 'cand-101',
    skills: [
      {
        skill_evidence_id: 'csk-py-1',
        concept_id: 'python',
        canonical_name: 'Python',
        surface_form: 'Python',
        evidence_ids: ['ev-01']
      }
    ],
    capabilities: [],
    experiences: [],
    education: [],
    certifications: [],
    evidence: [
      {
        evidence_id: 'ev-01',
        section: 'Skills',
        source_file: 'cv.md',
        verbatim_quote: 'Python programming',
        evidence_role: 'CANDIDATE_FACT'
      }
    ]
  };

  const legacyMatch = { legacy_score: 4.2, fit_decision: 'STRONG' };

  const result = await runRequirementMatchingShadow({
    jobProfile,
    candidateProfile,
    legacyMatchResult: legacyMatch,
    config: { features: { semantic_requirement_matching: 'shadow' } },
    options: { modelRunner: testFake }
  });

  assert.equal(result.shadowExecuted, true);
  assert.deepEqual(result.authoritativeResult, legacyMatch, 'Legacy match authority must be 100% preserved');
  assert.ok(result.matchProfile);
  assert.equal(result.matchProfile.descriptive_summary.satisfies, 1);
  assert.ok(result.telemetry);
  assert.equal(result.telemetry.component, 'semantic_requirement_matching_shadow');
});

test('telemetry carries no candidate PII, raw CV text, or raw JD text', () => {
  const telemetry = buildRequirementMatchingShadowTelemetry({
    jobId: 'job-sec-01',
    candidateId: 'cand-sec-01',
    matchProfile: {
      descriptive_summary: {
        requirements_total: 5,
        satisfies: 3,
        partially_supports: 1,
        related_but_insufficient: 0,
        contradicts: 0,
        no_evidence: 1,
        unknown: 0
      }
    },
    modelCalls: 5,
    latencyMs: 120
  });

  const serialized = JSON.stringify(telemetry);
  assert.equal(serialized.includes('John Doe'), false);
  assert.equal(serialized.includes('john@example.com'), false);
  assert.equal(serialized.includes('054-'), false);
  assert.equal(serialized.includes('raw_text'), false);
  assert.equal(serialized.includes('cv_text'), false);
  assert.equal(serialized.includes('jd_text'), false);
  assert.equal(telemetry.metrics.requirements_total, 5);
  assert.equal(telemetry.metrics.satisfies, 3);
});
