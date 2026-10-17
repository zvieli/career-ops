// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicyAssessment } from '../../../src/agent/domain/semantic/decision-policy-engine.mjs';
import { getPolicyConfiguration } from '../../../src/agent/domain/semantic/policy-configuration.mjs';

test('POLICY INTEGRITY 1: All required requirements satisfied yields HIGH_PRIORITY and bounded score', () => {
  const jobProfile = {
    job_id: 'job-01',
    requirements: [
      { requirement_id: 'req-01', type: 'TECHNICAL_SKILL', importance: 'REQUIRED', description: 'Python' },
      { requirement_id: 'req-02', type: 'TECHNICAL_SKILL', importance: 'REQUIRED', description: 'SQL' }
    ]
  };
  const candidateProfile = { candidate_id: 'cand-01' };
  const matchProfile = {
    match_profile_id: 'cmp-01',
    requirement_matches: [
      { requirement_match_id: 'rmatch-01', requirement_id: 'req-01', relation: 'SATISFIES', candidate_evidence_ids: ['ev-01'] },
      { requirement_match_id: 'rmatch-02', requirement_id: 'req-02', relation: 'SATISFIES', candidate_evidence_ids: ['ev-02'] }
    ]
  };

  const assessment = evaluatePolicyAssessment({ jobProfile, candidateProfile, matchProfile });

  assert.equal(assessment.priority_band, 'HIGH_PRIORITY');
  assert.ok(assessment.normalized_score >= 70);
  assert.ok(assessment.normalized_score <= 100);
  assert.equal(assessment.aggregate_components.required_coverage, 70);
  assert.equal(assessment.aggregate_components.contradiction_penalty, 0);
});

test('POLICY INTEGRITY 2: Score is strictly bounded [0, 100] and finite (no NaN, no Infinity)', () => {
  const jobProfile = {
    job_id: 'job-02',
    requirements: [
      { requirement_id: 'req-01', type: 'LEGAL_ADMINISTRATIVE', importance: 'LEGAL_MANDATORY', description: 'No sponsorship' }
    ]
  };
  const candidateProfile = { candidate_id: 'cand-01' };
  const matchProfile = {
    match_profile_id: 'cmp-02',
    requirement_matches: [
      { requirement_match_id: 'rmatch-01', requirement_id: 'req-01', relation: 'CONTRADICTS', candidate_evidence_ids: ['ev-01'] }
    ]
  };

  const assessment = evaluatePolicyAssessment({ jobProfile, candidateProfile, matchProfile });

  assert.ok(Number.isFinite(assessment.normalized_score));
  assert.ok(!Number.isNaN(assessment.normalized_score));
  assert.ok(assessment.normalized_score >= 0);
  assert.ok(assessment.normalized_score <= 100);
  assert.equal(assessment.hard_gate_triggered, true);
  assert.equal(assessment.priority_band, 'LOW_PRIORITY');
});

test('POLICY INTEGRITY 3: Required coverage dominates preferred coverage', () => {
  const policyConfig = getPolicyConfiguration();

  // Job A: Required satisfied, preferred missing
  const jobA = {
    job_id: 'job-A',
    requirements: [
      { requirement_id: 'req-01', type: 'TECHNICAL_SKILL', importance: 'REQUIRED', description: 'Python' },
      { requirement_id: 'req-02', type: 'TECHNICAL_SKILL', importance: 'PREFERRED', description: 'Docker' }
    ]
  };
  const matchA = {
    requirement_matches: [
      { requirement_match_id: 'rmatch-01', requirement_id: 'req-01', relation: 'SATISFIES', candidate_evidence_ids: ['ev-01'] },
      { requirement_match_id: 'rmatch-02', requirement_id: 'req-02', relation: 'NO_EVIDENCE', candidate_evidence_ids: [] }
    ]
  };

  // Job B: Required NO_EVIDENCE, preferred satisfied
  const jobB = {
    job_id: 'job-B',
    requirements: [
      { requirement_id: 'req-01', type: 'TECHNICAL_SKILL', importance: 'REQUIRED', description: 'Python' },
      { requirement_id: 'req-02', type: 'TECHNICAL_SKILL', importance: 'PREFERRED', description: 'Docker' }
    ]
  };
  const matchB = {
    requirement_matches: [
      { requirement_match_id: 'rmatch-01', requirement_id: 'req-01', relation: 'NO_EVIDENCE', candidate_evidence_ids: [] },
      { requirement_match_id: 'rmatch-02', requirement_id: 'req-02', relation: 'SATISFIES', candidate_evidence_ids: ['ev-02'] }
    ]
  };

  const assessA = evaluatePolicyAssessment({ jobProfile: jobA, candidateProfile: { candidate_id: 'cand-01' }, matchProfile: matchA, policyConfig });
  const assessB = evaluatePolicyAssessment({ jobProfile: jobB, candidateProfile: { candidate_id: 'cand-01' }, matchProfile: matchB, policyConfig });

  assert.ok(assessA.normalized_score > assessB.normalized_score, 'Satisfying required must score higher than satisfying only preferred');
  assert.equal(assessA.priority_band, 'MEDIUM_PRIORITY');
  assert.equal(assessB.priority_band, 'LOW_PRIORITY');
});

test('POLICY INTEGRITY 4: Explicit contradiction incurs heavier penalty than NO_EVIDENCE', () => {
  const jobProfile = {
    job_id: 'job-03',
    requirements: [{ requirement_id: 'req-01', type: 'TECHNICAL_SKILL', importance: 'REQUIRED', description: 'Go' }]
  };
  const candidateProfile = { candidate_id: 'cand-01' };

  const matchNoEvidence = {
    requirement_matches: [{ requirement_match_id: 'rmatch-01', requirement_id: 'req-01', relation: 'NO_EVIDENCE', candidate_evidence_ids: [] }]
  };
  const matchContradicts = {
    requirement_matches: [{ requirement_match_id: 'rmatch-01', requirement_id: 'req-01', relation: 'CONTRADICTS', candidate_evidence_ids: ['ev-01'] }]
  };

  const assessNoEv = evaluatePolicyAssessment({ jobProfile, candidateProfile, matchProfile: matchNoEvidence });
  const assessContra = evaluatePolicyAssessment({ jobProfile, candidateProfile, matchProfile: matchContradicts });

  assert.equal(assessNoEv.aggregate_components.contradiction_penalty, 0);
  assert.ok(assessContra.aggregate_components.contradiction_penalty > 0);
  assert.ok(assessContra.raw_score < assessNoEv.raw_score);
});

test('POLICY INTEGRITY 5: INSUFFICIENT_INFORMATION distinguishes low information from poor fit', () => {
  // Case A: Job with 0 requirements
  const zeroReqJob = { job_id: 'job-zero', requirements: [] };
  const assessZero = evaluatePolicyAssessment({
    jobProfile: zeroReqJob,
    candidateProfile: { candidate_id: 'cand-01' },
    matchProfile: { requirement_matches: [] }
  });
  assert.equal(assessZero.priority_band, 'INSUFFICIENT_INFORMATION');

  // Case B: Job with all UNKNOWN requirements
  const unknownJob = {
    job_id: 'job-unk',
    requirements: [{ requirement_id: 'req-01', type: 'TECHNICAL_SKILL', importance: 'REQUIRED', description: 'Cloud' }]
  };
  const assessUnknown = evaluatePolicyAssessment({
    jobProfile: unknownJob,
    candidateProfile: { candidate_id: 'cand-01' },
    matchProfile: { requirement_matches: [{ requirement_match_id: 'rmatch-01', requirement_id: 'req-01', relation: 'UNKNOWN', candidate_evidence_ids: [] }] }
  });
  assert.equal(assessUnknown.priority_band, 'INSUFFICIENT_INFORMATION');

  // Case C: Job with confirmed NO_EVIDENCE on required (Low fit, NOT insufficient information)
  const noEvJob = {
    job_id: 'job-noev',
    requirements: [{ requirement_id: 'req-01', type: 'TECHNICAL_SKILL', importance: 'REQUIRED', description: 'Cloud' }]
  };
  const assessNoEv = evaluatePolicyAssessment({
    jobProfile: noEvJob,
    candidateProfile: { candidate_id: 'cand-01' },
    matchProfile: { requirement_matches: [{ requirement_match_id: 'rmatch-01', requirement_id: 'req-01', relation: 'NO_EVIDENCE', candidate_evidence_ids: [] }] }
  });
  assert.equal(assessNoEv.priority_band, 'LOW_PRIORITY');
});

test('POLICY INTEGRITY 6: Score is mechanically reconstructable from score_breakdown', () => {
  const jobProfile = {
    job_id: 'job-recon',
    requirements: [
      { requirement_id: 'req-01', type: 'TECHNICAL_SKILL', importance: 'REQUIRED', description: 'Python' },
      { requirement_id: 'req-02', type: 'TECHNICAL_SKILL', importance: 'PREFERRED', description: 'Docker' }
    ]
  };
  const candidateProfile = { candidate_id: 'cand-01' };
  const matchProfile = {
    match_profile_id: 'cmp-recon',
    requirement_matches: [
      { requirement_match_id: 'rmatch-01', requirement_id: 'req-01', relation: 'SATISFIES', candidate_evidence_ids: ['ev-01'] },
      { requirement_match_id: 'rmatch-02', requirement_id: 'req-02', relation: 'PARTIALLY_SUPPORTS', candidate_evidence_ids: ['ev-02'] }
    ]
  };

  const assessment = evaluatePolicyAssessment({ jobProfile, candidateProfile, matchProfile });

  const breakdownSum = assessment.score_breakdown.reduce((acc, comp) => acc + comp.contribution, 0);
  assert.equal(Math.round(breakdownSum * 10) / 10, assessment.raw_score, 'Score breakdown contributions must sum to raw_score');
});

test('POLICY INTEGRITY 7: Score monotonicity holds under relation degradation', () => {
  const jobProfile = {
    job_id: 'job-mono',
    requirements: [{ requirement_id: 'req-01', type: 'TECHNICAL_SKILL', importance: 'REQUIRED', description: 'Java' }]
  };
  const candidateProfile = { candidate_id: 'cand-01' };

  const satMatch = { requirement_matches: [{ requirement_match_id: 'rmatch-01', requirement_id: 'req-01', relation: 'SATISFIES', candidate_evidence_ids: ['ev-01'] }] };
  const partMatch = { requirement_matches: [{ requirement_match_id: 'rmatch-01', requirement_id: 'req-01', relation: 'PARTIALLY_SUPPORTS', candidate_evidence_ids: ['ev-01'] }] };
  const noEvMatch = { requirement_matches: [{ requirement_match_id: 'rmatch-01', requirement_id: 'req-01', relation: 'NO_EVIDENCE', candidate_evidence_ids: [] }] };
  const contraMatch = { requirement_matches: [{ requirement_match_id: 'rmatch-01', requirement_id: 'req-01', relation: 'CONTRADICTS', candidate_evidence_ids: ['ev-01'] }] };

  const satAssess = evaluatePolicyAssessment({ jobProfile, candidateProfile, matchProfile: satMatch });
  const partAssess = evaluatePolicyAssessment({ jobProfile, candidateProfile, matchProfile: partMatch });
  const noEvAssess = evaluatePolicyAssessment({ jobProfile, candidateProfile, matchProfile: noEvMatch });
  const contraAssess = evaluatePolicyAssessment({ jobProfile, candidateProfile, matchProfile: contraMatch });

  assert.ok(satAssess.normalized_score >= partAssess.normalized_score);
  assert.ok(partAssess.normalized_score >= noEvAssess.normalized_score);
  assert.ok(noEvAssess.normalized_score >= contraAssess.normalized_score);
});

test('POLICY INTEGRITY 8: Sensitive/protected personal attributes have zero effect on score or ranking', () => {
  const jobProfile = {
    job_id: 'job-fairness',
    requirements: [{ requirement_id: 'req-01', type: 'TECHNICAL_SKILL', importance: 'REQUIRED', description: 'Python' }]
  };
  const matchProfile = {
    requirement_matches: [{ requirement_match_id: 'rmatch-01', requirement_id: 'req-01', relation: 'SATISFIES', candidate_evidence_ids: ['ev-01'] }]
  };

  const normalCandidate = { candidate_id: 'cand-normal' };
  const sensitiveCandidate = {
    candidate_id: 'cand-normal',
    age: 48,
    gender: 'female',
    marital_status: 'married',
    religion: 'none',
    ethnicity: 'group-x'
  };

  const assess1 = evaluatePolicyAssessment({ jobProfile, candidateProfile: normalCandidate, matchProfile });
  const assess2 = evaluatePolicyAssessment({ jobProfile, candidateProfile: sensitiveCandidate, matchProfile });

  assert.equal(assess1.normalized_score, assess2.normalized_score);
  assert.equal(assess1.priority_band, assess2.priority_band);
  assert.deepEqual(assess1.aggregate_components, assess2.aggregate_components);
});

// P1-1 TESTS: Hard gates as policy-as-data
test('P1-1 TEST 1 & 2: Natural-language sponsorship/clearance wording alone cannot trigger hard gate', () => {
  // Requirement contains sponsorship words, but relation is NO_EVIDENCE (not contradiction)
  const jobProfile = {
    job_id: 'job-word-gate',
    requirements: [
      { requirement_id: 'req-01', type: 'LEGAL_ADMINISTRATIVE', importance: 'LEGAL_MANDATORY', description: 'Must have citizenship, no visa sponsorship' }
    ]
  };
  const cand = { candidate_id: 'cand-01' };
  const matchNoEv = {
    requirement_matches: [
      { requirement_match_id: 'rmatch-01', requirement_id: 'req-01', relation: 'NO_EVIDENCE', candidate_evidence_ids: [] }
    ]
  };

  const assess = evaluatePolicyAssessment({ jobProfile, candidateProfile: cand, matchProfile: matchNoEv });
  assert.equal(assess.hard_gate_triggered, false, 'Wording alone without contradiction cannot trigger hard gate');
  assert.equal(assess.blocker_reasons.length, 0);
});

test('P1-1 TEST 3 & 4: Removing gate from PolicyConfiguration disables gate without code changes', () => {
  const jobProfile = {
    job_id: 'job-gate-cfg',
    requirements: [
      { requirement_id: 'req-01', type: 'LEGAL_ADMINISTRATIVE', importance: 'LEGAL_MANDATORY', description: 'Visa' }
    ]
  };
  const cand = { candidate_id: 'cand-01' };
  const matchContra = {
    requirement_matches: [
      {
        requirement_match_id: 'rmatch-01',
        requirement_id: 'req-01',
        relation: 'CONTRADICTS',
        unresolved_dimensions: ['requires_sponsorship_contradiction'],
        candidate_evidence_ids: ['ev-01']
      }
    ]
  };

  // With default gates: triggers gate
  const assessWithGate = evaluatePolicyAssessment({ jobProfile, candidateProfile: cand, matchProfile: matchContra });
  assert.equal(assessWithGate.hard_gate_triggered, true);

  // Policy configuration with hard_gates cleared:
  const configNoGates = getPolicyConfiguration({
    policy_version: 'policy-no-gates',
    hard_gates: []
  });
  const assessNoGate = evaluatePolicyAssessment({ jobProfile, candidateProfile: cand, matchProfile: matchContra, policyConfig: configNoGates });
  assert.equal(assessNoGate.hard_gate_triggered, false, 'Removing gate from configuration must disable it without code change');
});

test('P1-1 TEST 5, 6 & 7: Custom hard gate and configured actions (BLOCK_OPPORTUNITY vs REQUIRE_HUMAN_REVIEW)', () => {
  const jobProfile = {
    job_id: 'job-custom-gate',
    requirements: [
      { requirement_id: 'req-deg', type: 'EDUCATION', importance: 'REQUIRED', description: 'Degree' }
    ]
  };
  const cand = { candidate_id: 'cand-01' };
  const match = {
    requirement_matches: [
      {
        requirement_match_id: 'rmatch-01',
        requirement_id: 'req-deg',
        relation: 'CONTRADICTS',
        reason_codes: ['CUSTOM_DEGREE_CONTRADICTION'],
        candidate_evidence_ids: ['ev-01']
      }
    ]
  };

  // Custom gate with BLOCK_OPPORTUNITY
  const blockConfig = getPolicyConfiguration({
    policy_version: 'custom-block',
    hard_gates: [
      {
        gate_id: 'gate-custom-degree',
        trigger_source: 'MATCH_REASON_CODE',
        trigger_value: 'CUSTOM_DEGREE_CONTRADICTION',
        action: 'BLOCK_OPPORTUNITY',
        reason_code: 'HARD_GATE_DEGREE_BLOCKER'
      }
    ]
  });

  const assessBlock = evaluatePolicyAssessment({ jobProfile, candidateProfile: cand, matchProfile: match, policyConfig: blockConfig });
  assert.equal(assessBlock.hard_gate_triggered, true);
  assert.equal(assessBlock.normalized_score, 0, 'BLOCK_OPPORTUNITY must zero the score');
  assert.equal(assessBlock.priority_band, 'LOW_PRIORITY');
  assert.ok(assessBlock.blocker_reasons.some((r) => r.includes('HARD_GATE_DEGREE_BLOCKER')));

  // Custom gate with REQUIRE_HUMAN_REVIEW
  const reviewConfig = getPolicyConfiguration({
    policy_version: 'custom-review',
    hard_gates: [
      {
        gate_id: 'gate-custom-degree',
        trigger_source: 'MATCH_REASON_CODE',
        trigger_value: 'CUSTOM_DEGREE_CONTRADICTION',
        action: 'REQUIRE_HUMAN_REVIEW',
        reason_code: 'HARD_GATE_HUMAN_REVIEW'
      }
    ]
  });

  const assessReview = evaluatePolicyAssessment({ jobProfile, candidateProfile: cand, matchProfile: match, policyConfig: reviewConfig });
  assert.equal(assessReview.hard_gate_triggered, true);
  assert.equal(assessReview.priority_band, 'INSUFFICIENT_INFORMATION', 'REQUIRE_HUMAN_REVIEW must set INSUFFICIENT_INFORMATION');
});

// P1-2 TESTS: Evidence quality scale as policy-as-data
test('P1-2 MUTATION: Changing evidence_quality_max changes score and records new policy version without code change', () => {
  const jobProfile = {
    job_id: 'job-eq-scale',
    requirements: [{ requirement_id: 'req-01', type: 'TECHNICAL_SKILL', importance: 'REQUIRED', description: 'Python' }]
  };
  const cand = { candidate_id: 'cand-01' };
  const match = {
    requirement_matches: [{ requirement_match_id: 'rmatch-01', requirement_id: 'req-01', relation: 'SATISFIES', candidate_evidence_ids: ['ev-01'] }]
  };

  const configA = getPolicyConfiguration({
    policy_version: 'policy-eq-5',
    score_component_scales: { evidence_quality_max: 5 }
  });
  const configB = getPolicyConfiguration({
    policy_version: 'policy-eq-8',
    score_component_scales: { evidence_quality_max: 8 }
  });

  const assessA = evaluatePolicyAssessment({ jobProfile, candidateProfile: cand, matchProfile: match, policyConfig: configA });
  const assessB = evaluatePolicyAssessment({ jobProfile, candidateProfile: cand, matchProfile: match, policyConfig: configB });

  assert.equal(assessA.policy_version, 'policy-eq-5');
  assert.equal(assessB.policy_version, 'policy-eq-8');
  assert.equal(assessA.aggregate_components.evidence_quality_component, 5);
  assert.equal(assessB.aggregate_components.evidence_quality_component, 8);
  assert.ok(assessB.normalized_score > assessA.normalized_score);
});

// P1-3 TESTS: Complete Phase-4 support provenance
test('P1-3 TESTS 1-5: SATISFIES supported only by non-evidence categories retains typed provenance', () => {
  const jobProfile = {
    job_id: 'job-prov',
    requirements: [
      { requirement_id: 'req-cap', type: 'TECHNICAL_SKILL', importance: 'REQUIRED', description: 'Deployment' },
      { requirement_id: 'req-sk', type: 'TECHNICAL_SKILL', importance: 'REQUIRED', description: 'Python' },
      { requirement_id: 'req-edu', type: 'EDUCATION', importance: 'REQUIRED', description: 'Degree' },
      { requirement_id: 'req-cert', type: 'TECHNICAL_SKILL', importance: 'REQUIRED', description: 'Cert' },
      { requirement_id: 'req-exp', type: 'TECHNICAL_SKILL', importance: 'REQUIRED', description: 'Work' }
    ]
  };
  const cand = { candidate_id: 'cand-01' };
  const matchProfile = {
    requirement_matches: [
      { requirement_match_id: 'rmatch-cap', requirement_id: 'req-cap', relation: 'SATISFIES', candidate_capability_ids: ['cap-01'] },
      { requirement_match_id: 'rmatch-sk', requirement_id: 'req-sk', relation: 'SATISFIES', candidate_skill_evidence_ids: ['csk-01'] },
      { requirement_match_id: 'rmatch-edu', requirement_id: 'req-edu', relation: 'SATISFIES', candidate_education_ids: ['edu-01'] },
      { requirement_match_id: 'rmatch-cert', requirement_id: 'req-cert', relation: 'SATISFIES', candidate_certification_ids: ['cert-01'] },
      { requirement_match_id: 'rmatch-exp', requirement_id: 'req-exp', relation: 'SATISFIES', candidate_experience_ids: ['exp-01'] }
    ]
  };

  const assess = evaluatePolicyAssessment({ jobProfile, candidateProfile: cand, matchProfile });

  const rCap = assess.requirement_policy_results.find((r) => r.requirement_id === 'req-cap');
  assert.deepEqual(rCap.support_references.capability_ids, ['cap-01']);
  assert.ok(rCap.source_reference_ids.includes('cap-01'));

  const rSk = assess.requirement_policy_results.find((r) => r.requirement_id === 'req-sk');
  assert.deepEqual(rSk.support_references.skill_evidence_ids, ['csk-01']);

  const rEdu = assess.requirement_policy_results.find((r) => r.requirement_id === 'req-edu');
  assert.deepEqual(rEdu.support_references.education_ids, ['edu-01']);

  const rCert = assess.requirement_policy_results.find((r) => r.requirement_id === 'req-cert');
  assert.deepEqual(rCert.support_references.certification_ids, ['cert-01']);

  const rExp = assess.requirement_policy_results.find((r) => r.requirement_id === 'req-exp');
  assert.deepEqual(rExp.support_references.experience_ids, ['exp-01']);

  // P1-3 Test 6: Evidence quality credits valid non-evidence-ids support
  assert.ok(assess.aggregate_components.evidence_quality_component > 0);
});

test('P1-3 TESTS 7 & 8: Missing requirement_match_id fails closed (no synthetic rmatch fabricated)', () => {
  const jobProfile = {
    job_id: 'job-no-rmatch',
    requirements: [{ requirement_id: 'req-01', type: 'TECHNICAL_SKILL', importance: 'REQUIRED', description: 'Core' }]
  };
  const cand = { candidate_id: 'cand-01' };
  // match item omits requirement_match_id
  const matchMissingId = {
    requirement_matches: [{ requirement_id: 'req-01', relation: 'SATISFIES', candidate_evidence_ids: ['ev-01'] }]
  };

  assert.throws(() => {
    evaluatePolicyAssessment({ jobProfile, candidateProfile: cand, matchProfile: matchMissingId });
  }, /Missing requirement_match_id/);
});
