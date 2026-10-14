import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRequiredEligibility, evaluateCandidateFit } from '../lib/candidate-fit-gate.mjs';

const base = { status: 'PASSED', extraction: { required_yoe: 0, preferred_yoe: null, degree: null, gpa: null } };
const zeroYears = {
  professional_years: 0,
  professional_years_source: 'config/profile.yml',
  professional_yoe_years: 0,
  professional_yoe_verified: true
};

test('0 YOE candidate vs required 4+ is REJECT', () => {
  const result = evaluateCandidateFit({ evaluation: { ...base, extraction: { ...base.extraction, required_yoe: 4 } }, candidateFacts: zeroYears });
  assert.equal(result.status, 'REJECT');
});

test('0 verified YOE vs required 3+ is LONG_STRETCH under the existing policy', () => {
  const result = evaluateCandidateFit({ evaluation: { ...base, extraction: { ...base.extraction, required_yoe: 3 } }, candidateFacts: zeroYears });
  assert.equal(result.status, 'LONG_STRETCH');
});

test('zero YOE requirement does not require a candidate YOE fact', () => {
  const result = evaluateCandidateFit({ evaluation: base, candidateFacts: {} });
  assert.equal(result.status, 'STRONG');
});

test('0 YOE candidate vs preferred 2+ may be REASONABLE', () => {
  const result = evaluateCandidateFit({ evaluation: { ...base, extraction: { ...base.extraction, preferred_yoe: 2 } }, candidateFacts: zeroYears });
  assert.equal(result.status, 'REASONABLE');
});

test('graduate role with supported requirements is STRONG', () => {
  const result = evaluateCandidateFit({ evaluation: base, candidateFacts: zeroYears, title: 'Graduate Software Engineer' });
  assert.equal(result.status, 'STRONG');
});

test('senior title is REJECT', () => {
  assert.equal(evaluateCandidateFit({ evaluation: base, candidateFacts: zeroYears, title: 'Senior Software Engineer' }).status, 'REJECT');
});

test('mandatory authorization language creates a material candidate-fact gate', () => {
  const requirements = detectRequiredEligibility('Applicants must be legally authorized to work in Israel.');
  assert.deepEqual(requirements, ['work_authorization']);
  assert.equal(evaluateCandidateFit({ evaluation: base, candidateFacts: {}, requiredEligibility: requirements }).status, 'NEEDS_REVIEW');
});

test('explicitly false work authorization rejects and non-mandatory clearance does not gate', () => {
  assert.equal(evaluateCandidateFit({ evaluation: base, candidateFacts: { work_authorization: false }, requiredEligibility: ['work_authorization'] }).status, 'REJECT');
  assert.deepEqual(detectRequiredEligibility('No security clearance is required.'), []);
});

test('unknown material eligibility fact is NEEDS_REVIEW', () => {
  const result = evaluateCandidateFit({ evaluation: base, candidateFacts: { ...zeroYears, work_authorization: null }, requiredEligibility: ['work_authorization'] });
  assert.equal(result.status, 'NEEDS_REVIEW');
});

test('B.Sc. is an exact bachelor-level match for an unspecified bachelor requirement', () => {
  const result = evaluateCandidateFit({
    evaluation: { ...base, extraction: { ...base.extraction, degree: "Bachelor's degree" } },
    candidateFacts: { degrees: ['B.Sc. in Computer Science'], degrees_source: 'cv.md' }
  });
  assert.equal(result.status, 'STRONG');
});

test('JD alternative qualifications do not imply candidate evidence', () => {
  const result = evaluateCandidateFit({
    evaluation: { ...base, extraction: { ...base.extraction, degree: 'Bachelor in Electrical Engineering', alternative_qualifications: true } },
    candidateFacts: { degrees: ['B.Sc. in Computer Science'], degrees_source: 'cv.md' }
  });
  assert.equal(result.status, 'NEEDS_REVIEW');
});

test('degree field mismatch is not inferred away', () => {
  const result = evaluateCandidateFit({
    evaluation: { ...base, extraction: { ...base.extraction, degree: 'Bachelor in Electrical Engineering' } },
    candidateFacts: { degrees: ['B.Sc. in Computer Science'], degrees_source: 'cv.md' }
  });
  assert.equal(result.status, 'NEEDS_REVIEW');
});

test('unknown GPA scale does not block when the JD has no numeric GPA requirement', () => {
  const evaluation = { ...base, extraction: { ...base.extraction, gpa: null, gpa_scale: null } };
  assert.equal(evaluateCandidateFit({ evaluation, candidateFacts: { gpa: 85, gpa_source: 'cv.md' } }).status, 'STRONG');
});

test('GPA comparison requires primary provenance and matching explicit scales', () => {
  const evaluation = { ...base, extraction: { ...base.extraction, gpa: 85, gpa_scale: '100-point' } };
  assert.equal(evaluateCandidateFit({ evaluation, candidateFacts: { gpa: 85, gpa_source: 'cv.md', gpa_scale: '100-point' } }).status, 'STRONG');
  assert.equal(evaluateCandidateFit({ evaluation, candidateFacts: { gpa: 85, gpa_source: 'cv.md' } }).status, 'NEEDS_REVIEW');
  assert.equal(evaluateCandidateFit({ evaluation, candidateFacts: { gpa: 85, gpa_scale: '4.0', gpa_source: 'cv.md' } }).status, 'NEEDS_REVIEW');
});

test('unverified zero professional YOE remains NEEDS_REVIEW rather than treated as verified', () => {
  const result = evaluateCandidateFit({ evaluation: { ...base, extraction: { ...base.extraction, required_yoe: 4 } }, candidateFacts: { professional_years: 0, professional_years_source: 'config/profile.yml', professional_yoe_verified: false } });
  assert.equal(result.status, 'NEEDS_REVIEW');
});

test('missing professional YOE remains NEEDS_REVIEW rather than assumed zero', () => {
  const result = evaluateCandidateFit({ evaluation: { ...base, extraction: { ...base.extraction, required_yoe: 4 } }, candidateFacts: {} });
  assert.equal(result.status, 'NEEDS_REVIEW');
});
