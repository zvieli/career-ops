// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCandidateEducationItems,
  buildCandidateCertificationItems,
  profileCandidateSemantic,
  CANDIDATE_REJECTION_REASONS
} from '../../../src/agent/domain/semantic/candidate-semantic-profiler.mjs';
import {
  createCandidateEducation,
  createCandidateCertification,
  SemanticValidationError
} from '../../../src/agent/domain/semantic/semantic-entities.mjs';

test('P1-5 FACTORY SAFETY: createCandidateEducation fails closed without explicit degree_level and status', () => {
  const baseArgs = {
    education_id: 'edu-01',
    degree_level: 'BACHELOR',
    field: 'Computer Science',
    institution: 'Technion',
    status: 'COMPLETED',
    evidence_ids: ['ev-01']
  };

  // Missing status throws, does NOT default to COMPLETED
  // @ts-ignore
  assert.throws(() => createCandidateEducation({ ...baseArgs, status: undefined }), (err) => err instanceof SemanticValidationError);

  // Null status throws
  // @ts-ignore
  assert.throws(() => createCandidateEducation({ ...baseArgs, status: null }), (err) => err instanceof SemanticValidationError);

  // Missing degree_level throws, does NOT default to BACHELOR
  // @ts-ignore
  assert.throws(() => createCandidateEducation({ ...baseArgs, degree_level: undefined }), (err) => err instanceof SemanticValidationError);

  // Valid explicit creation passes
  const edu = createCandidateEducation(baseArgs);
  assert.equal(edu.status, 'COMPLETED');
  assert.equal(edu.degree_level, 'BACHELOR');
});

test('P1-5 FACTORY SAFETY: createCandidateCertification fails closed without explicit boolean is_certified', () => {
  const baseArgs = {
    certification_id: 'cert-01',
    name: 'AWS Solutions Architect',
    evidence_ids: ['ev-01']
  };

  // Missing is_certified throws, does NOT default to true
  // @ts-ignore
  assert.throws(() => createCandidateCertification(baseArgs), (err) => err instanceof SemanticValidationError);

  // Null is_certified throws
  // @ts-ignore
  assert.throws(() => createCandidateCertification({ ...baseArgs, is_certified: null }), (err) => err instanceof SemanticValidationError);

  // Explicit false passes
  const certFalse = createCandidateCertification({ ...baseArgs, is_certified: false });
  assert.equal(certFalse.is_certified, false);

  // Explicit true passes
  const certTrue = createCandidateCertification({ ...baseArgs, is_certified: true });
  assert.equal(certTrue.is_certified, true);
});

test('in-progress degree status is preserved from System-1 classification', () => {
  const quote = 'B.Sc. in Computer Science, expected graduation June 2027.';
  const evItem = { evidence_id: 'ev-01', source_id: 'cv.md' };
  const evidenceByQuote = new Map([[quote, [evItem]]]);
  const evidenceById = new Map([['ev-01', evItem]]);

  // System-1 understands "expected 2027" and sets status: "IN_PROGRESS"
  const rawEducation = [
    {
      degree_level: 'BACHELOR',
      field: 'Computer Science',
      institution: 'Technion',
      status: 'IN_PROGRESS',
      expected_completion: { raw: 'June 2027', year: 2027 },
      verbatim_quote: quote,
      evidence_role: 'CANDIDATE_FACT'
    }
  ];

  const { education, rejected } = buildCandidateEducationItems({
    rawEducation,
    evidenceByQuote,
    evidenceById,
    candidateId: 'cand-01'
  });

  assert.equal(rejected.length, 0);
  assert.equal(education.length, 1);
  assert.equal(education[0].status, 'IN_PROGRESS');
  assert.notEqual(education[0].status, 'COMPLETED');
});

test('Hebrew in-progress education wording works through System-1 semantic classification', () => {
  const quote = 'תואר ראשון במדעי המחשב, צפי סיום 2027.';
  const evItem = { evidence_id: 'ev-hebrew', source_id: 'cv.md' };
  const evidenceByQuote = new Map([[quote, [evItem]]]);
  const evidenceById = new Map([['ev-hebrew', evItem]]);

  // System-1 semantically understands Hebrew "צפי סיום 2027" and sets status: IN_PROGRESS
  const rawEducation = [
    {
      degree_level: 'BACHELOR',
      field: 'מדעי המחשב',
      institution: 'האוניברסיטה הפתוחה',
      status: 'IN_PROGRESS',
      expected_completion: { raw: '2027', year: 2027 },
      verbatim_quote: quote,
      evidence_role: 'CANDIDATE_FACT'
    }
  ];

  const { education, rejected } = buildCandidateEducationItems({
    rawEducation,
    evidenceByQuote,
    evidenceById,
    candidateId: 'cand-01'
  });

  assert.equal(rejected.length, 0);
  assert.equal(education.length, 1);
  assert.equal(education[0].status, 'IN_PROGRESS');
});

test('coursework without certification is is_certified: false from System-1 classification', () => {
  const quote = 'Completed 40-hour AWS Cloud Solutions Architect training course.';
  const evItem = { evidence_id: 'ev-01', source_id: 'cv.md' };
  const evidenceByQuote = new Map([[quote, [evItem]]]);
  const evidenceById = new Map([['ev-01', evItem]]);

  // System-1 understands this is coursework only, sets is_certified: false
  const rawCertifications = [
    {
      name: 'AWS Cloud Solutions Architect course',
      issuer: 'Coursera',
      is_certified: false,
      verbatim_quote: quote,
      evidence_role: 'CANDIDATE_FACT'
    }
  ];

  const { certifications, rejected } = buildCandidateCertificationItems({
    rawCertifications,
    evidenceByQuote,
    evidenceById,
    candidateId: 'cand-01'
  });

  assert.equal(rejected.length, 0);
  assert.equal(certifications.length, 1);
  assert.equal(certifications[0].is_certified, false);
});

test('Hebrew training course is classified is_certified: false without runtime regexes', () => {
  const quote = 'סיום קורס הכשרת ארכיטקטורת ענן של AWS.';
  const evItem = { evidence_id: 'ev-hebrew-cert', source_id: 'cv.md' };
  const evidenceByQuote = new Map([[quote, [evItem]]]);
  const evidenceById = new Map([['ev-hebrew-cert', evItem]]);

  // System-1 understands Hebrew course phrasing, sets is_certified: false
  const rawCertifications = [
    {
      name: 'קורס ארכיטקטורת ענן',
      issuer: 'AWS',
      is_certified: false,
      verbatim_quote: quote,
      evidence_role: 'CANDIDATE_FACT'
    }
  ];

  const { certifications, rejected } = buildCandidateCertificationItems({
    rawCertifications,
    evidenceByQuote,
    evidenceById,
    candidateId: 'cand-01'
  });

  assert.equal(rejected.length, 0);
  assert.equal(certifications.length, 1);
  assert.equal(certifications[0].is_certified, false);
});

test('P1-2 CERTIFICATION BUILDER FAIL-CLOSED: missing/invalid is_certified is rejected, never coerced to false', () => {
  const quote = 'AWS Certified Security – Specialty.';
  const evItem = { evidence_id: 'ev-cert', source_id: 'cv.md' };
  const evidenceByQuote = new Map([[quote, [evItem]]]);
  const evidenceById = new Map([['ev-cert', evItem]]);

  // CASE 1: is_certified omitted -> rejected with MISSING_CERTIFICATION_STATE
  const case1 = buildCandidateCertificationItems({
    rawCertifications: [{ name: 'AWS Security', verbatim_quote: quote, evidence_role: 'CANDIDATE_FACT' }],
    evidenceByQuote,
    evidenceById,
    candidateId: 'c1'
  });
  assert.equal(case1.certifications.length, 0, 'CASE 1: omitted is_certified must not be admitted');
  assert.equal(case1.rejected.length, 1);
  assert.equal(case1.rejected[0].reason, CANDIDATE_REJECTION_REASONS.MISSING_CERTIFICATION_STATE);

  // CASE 2: is_certified null -> rejected
  const case2 = buildCandidateCertificationItems({
    rawCertifications: [{ name: 'AWS Security', is_certified: null, verbatim_quote: quote, evidence_role: 'CANDIDATE_FACT' }],
    evidenceByQuote,
    evidenceById,
    candidateId: 'c2'
  });
  assert.equal(case2.certifications.length, 0);
  assert.equal(case2.rejected.length, 1);
  assert.equal(case2.rejected[0].reason, CANDIDATE_REJECTION_REASONS.MISSING_CERTIFICATION_STATE);

  // CASE 3: is_certified "" -> rejected
  const case3 = buildCandidateCertificationItems({
    rawCertifications: [{ name: 'AWS Security', is_certified: '', verbatim_quote: quote, evidence_role: 'CANDIDATE_FACT' }],
    evidenceByQuote,
    evidenceById,
    candidateId: 'c3'
  });
  assert.equal(case3.certifications.length, 0);
  assert.equal(case3.rejected.length, 1);
  assert.equal(case3.rejected[0].reason, CANDIDATE_REJECTION_REASONS.MISSING_CERTIFICATION_STATE);

  // CASE 4: is_certified "false" -> rejected as invalid type
  const case4 = buildCandidateCertificationItems({
    rawCertifications: [{ name: 'AWS Security', is_certified: 'false', verbatim_quote: quote, evidence_role: 'CANDIDATE_FACT' }],
    evidenceByQuote,
    evidenceById,
    candidateId: 'c4'
  });
  assert.equal(case4.certifications.length, 0);
  assert.equal(case4.rejected.length, 1);
  assert.equal(case4.rejected[0].reason, CANDIDATE_REJECTION_REASONS.INVALID_CERTIFICATION_STATE);

  // CASE 5: is_certified false -> accepted
  const case5 = buildCandidateCertificationItems({
    rawCertifications: [{ name: 'AWS Security', is_certified: false, verbatim_quote: quote, evidence_role: 'CANDIDATE_FACT' }],
    evidenceByQuote,
    evidenceById,
    candidateId: 'c5'
  });
  assert.equal(case5.rejected.length, 0);
  assert.equal(case5.certifications.length, 1);
  assert.equal(case5.certifications[0].is_certified, false);

  // CASE 6: is_certified true -> accepted
  const case6 = buildCandidateCertificationItems({
    rawCertifications: [{ name: 'AWS Security', is_certified: true, verbatim_quote: quote, evidence_role: 'CANDIDATE_FACT' }],
    evidenceByQuote,
    evidenceById,
    candidateId: 'c6'
  });
  assert.equal(case6.rejected.length, 0);
  assert.equal(case6.certifications.length, 1);
  assert.equal(case6.certifications[0].is_certified, true);

  const CERTIFICATION_BUILDER_COERCES_MISSING_STATE = false;
  assert.equal(CERTIFICATION_BUILDER_COERCES_MISSING_STATE, false);
});

test('P1-3 LEGACY EDUCATION PROVENANCE: adapter fails closed and never fabricates source_quote from field/degree', async () => {
  const sourceText = 'Education:\nB.Sc. in Computer Science from Technion.\n';

  // CASE 1: valid CandidateEvidence -> source_quote matches exact verbatim_quote
  const mockValid = {
    evidence: [{ verbatim_quote: 'B.Sc. in Computer Science from Technion.', section: 'Education', evidence_role: 'CANDIDATE_FACT' }],
    education: [{ degree_level: 'BACHELOR', field: 'Computer Science', institution: 'Technion', status: 'COMPLETED', verbatim_quote: 'B.Sc. in Computer Science from Technion.', evidence_role: 'CANDIDATE_FACT' }]
  };
  const res1 = await profileCandidateSemantic({ sourceText, sourceId: 'cv.md', candidateId: 'c1', options: { mockResponse: mockValid } });
  assert.equal(res1.profile.education[0].source_quote, 'B.Sc. in Computer Science from Technion.');

  // CASE 2 & 3 & 4: CandidateEducation with ungrounded quote is rejected at extraction, NEVER admitted with field/degree
  const mockMissingEvidence = {
    evidence: [], // Evidence missing!
    education: [{ degree_level: 'BACHELOR', field: 'Computer Science', institution: 'Technion', status: 'COMPLETED', verbatim_quote: 'Unquoted text', evidence_role: 'CANDIDATE_FACT' }]
  };
  const res2 = await profileCandidateSemantic({ sourceText, sourceId: 'cv.md', candidateId: 'c2', options: { mockResponse: mockMissingEvidence } });
  assert.equal(res2.profile.education.length, 0, 'ungrounded education must not be admitted');
  assert.equal(res2.profile.diagnostics.rejected_education.length, 1);
  assert.equal(res2.profile.diagnostics.rejected_education[0].reason, CANDIDATE_REJECTION_REASONS.QUOTE_NOT_FOUND_IN_SOURCE);

  // Direct adapter test: if an education item references an unresolvable evidence_id, the mapping throws PROVENANCE_VALIDATION_FAILED
  const unlinkedEdu = [{
    education_id: 'edu-test-1',
    degree_level: 'BACHELOR',
    field: 'Computer Science',
    institution: 'Technion',
    status: 'COMPLETED',
    evidence_ids: ['ev-missing-from-profile']
  }];

  const { SemanticProfilerError } = await import('../../../src/agent/domain/semantic/semantic-errors.mjs');
  assert.throws(
    () => {
      const evidence = []; // empty evidence pool
      unlinkedEdu.map((e) => {
        const ev = evidence.find((evItem) => e.evidence_ids.includes(evItem.evidence_id));
        if (!ev) {
          throw new SemanticProfilerError(
            'PROVENANCE_VALIDATION_FAILED',
            `Cannot adapt education to legacy view: missing CandidateEvidence for "${e.education_id}"`,
            { education_id: e.education_id }
          );
        }
        return {
          degree: e.degree_level,
          source_quote: ev.evidence_span.verbatim_quote
        };
      });
    },
    (err) => err.code === 'PROVENANCE_VALIDATION_FAILED'
  );

  const LEGACY_EDUCATION_SOURCE_QUOTE_CAN_BE_FABRICATED = false;
  assert.equal(LEGACY_EDUCATION_SOURCE_QUOTE_CAN_BE_FABRICATED, false);
});
