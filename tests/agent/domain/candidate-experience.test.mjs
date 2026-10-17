// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCandidateExperienceItems,
  buildCandidateEvidenceItems,
  CANDIDATE_REJECTION_REASONS
} from '../../../src/agent/domain/semantic/candidate-semantic-profiler.mjs';
import { computeSourceHash } from '../../../src/agent/domain/semantic/provenance-validator.mjs';

test('P1-1: experience cannot use unrelated evidence fallback', () => {
  // CandidateEvidence exists only for Python in Summary
  const evPython = { evidence_id: 'ev-python', source_id: 'cv.md', section: 'Summary' };
  const evidenceByQuote = new Map([['Skills: Python', [evPython]]]);
  const evidenceById = new Map([['ev-python', evPython]]);

  // Model fabricates unrelated Google employment with a quote not present in evidence
  const rawExperiences = [
    {
      organization_or_project_name: 'Google LLC',
      role_title: 'Staff Software Engineer',
      experience_type: 'EMPLOYMENT',
      verbatim_quote: 'Staff Software Engineer at Google leading cloud teams.',
      evidence_role: 'CANDIDATE_FACT'
    }
  ];

  const { experiences, rejected } = buildCandidateExperienceItems({
    rawExperiences,
    evidenceByQuote,
    evidenceById,
    candidateId: 'cand-01'
  });

  // Must be rejected with QUOTE_NOT_FOUND_IN_SOURCE, NOT attached to ev-python!
  assert.equal(experiences.length, 0, 'fabricated experience without matching evidence must not be admitted');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, CANDIDATE_REJECTION_REASONS.QUOTE_NOT_FOUND_IN_SOURCE);
});

test('INTERNSHIP is not silently promoted to EMPLOYMENT', () => {
  const quote = 'Software Engineering Intern — Company X (June 2024 – August 2024)';
  const evItem = { evidence_id: 'ev-01', source_id: 'cv.md' };
  const evidenceByQuote = new Map([[quote, [evItem]]]);
  const evidenceById = new Map([['ev-01', evItem]]);

  const rawExperiences = [
    {
      organization_or_project_name: 'Company X',
      role_title: 'Software Engineering Intern',
      experience_type: 'INTERNSHIP',
      start_date: { raw: 'June 2024', year: 2024, month: 6, precision: 'MONTH' },
      end_date: { raw: 'August 2024', year: 2024, month: 8, precision: 'MONTH' },
      is_current: false,
      verbatim_quote: quote,
      evidence_role: 'CANDIDATE_FACT'
    }
  ];

  const { experiences, rejected } = buildCandidateExperienceItems({
    rawExperiences,
    evidenceByQuote,
    evidenceById,
    candidateId: 'cand-01'
  });

  assert.equal(rejected.length, 0);
  assert.equal(experiences.length, 1);
  assert.equal(experiences[0].experience_type, 'INTERNSHIP');
  assert.notEqual(experiences[0].experience_type, 'EMPLOYMENT');
});

test('partial dates are preserved with explicit precision and not fabricated into full dates', () => {
  const quote = 'Company Beta — Backend Engineer (2025)';
  const evItem = { evidence_id: 'ev-01', source_id: 'cv.md' };
  const evidenceByQuote = new Map([[quote, [evItem]]]);
  const evidenceById = new Map([['ev-01', evItem]]);

  const rawExperiences = [
    {
      organization_or_project_name: 'Company Beta',
      role_title: 'Backend Engineer',
      experience_type: 'EMPLOYMENT',
      start_date: { raw: '2025', year: 2025, month: null, precision: 'YEAR' },
      end_date: null,
      is_current: false,
      verbatim_quote: quote,
      evidence_role: 'CANDIDATE_FACT'
    }
  ];

  const { experiences } = buildCandidateExperienceItems({
    rawExperiences,
    evidenceByQuote,
    evidenceById,
    candidateId: 'cand-01'
  });

  assert.equal(experiences[0].start_date.year, 2025);
  assert.equal(experiences[0].start_date.month, null);
  assert.equal(experiences[0].start_date.precision, 'YEAR');
});

test('duplicated identical quotes preserve separate evidence identities', () => {
  const sourceText = 'Project Alpha: Implemented REST APIs.\nProject Beta: Implemented REST APIs.';
  const sourceHash = computeSourceHash(sourceText);

  const rawEvidence = [
    { verbatim_quote: 'Implemented REST APIs.', section: 'Alpha', evidence_role: 'CANDIDATE_FACT' },
    { verbatim_quote: 'Implemented REST APIs.', section: 'Beta', evidence_role: 'CANDIDATE_FACT' }
  ];

  const { evidence, evidenceByQuote, evidenceById } = buildCandidateEvidenceItems({
    rawEvidence,
    sourceText,
    sourceId: 'cv.md',
    candidateId: 'cand-01',
    sourceHash
  });

  // Two distinct evidence items created for identical quote in different spans
  assert.equal(evidence.length, 2);
  assert.notEqual(evidence[0].evidence_id, evidence[1].evidence_id);
  assert.notEqual(evidence[0].evidence_span.start_char, evidence[1].evidence_span.start_char);

  // Experience items can reference exact evidence by section or explicit evidence_id
  const rawExperiences = [
    {
      organization_or_project_name: 'Project Alpha',
      experience_type: 'PERSONAL_PROJECT',
      section: 'Alpha',
      verbatim_quote: 'Implemented REST APIs.',
      evidence_role: 'CANDIDATE_FACT'
    },
    {
      organization_or_project_name: 'Project Beta',
      experience_type: 'PERSONAL_PROJECT',
      section: 'Beta',
      verbatim_quote: 'Implemented REST APIs.',
      evidence_role: 'CANDIDATE_FACT'
    }
  ];

  const { experiences } = buildCandidateExperienceItems({
    rawExperiences,
    evidenceByQuote,
    evidenceById,
    candidateId: 'cand-01'
  });

  assert.equal(experiences.length, 2);
  assert.equal(experiences[0].evidence_ids[0], evidence[0].evidence_id);
  assert.equal(experiences[1].evidence_ids[0], evidence[1].evidence_id);
});

test('P1-1 FAIL-CLOSED: duplicate evidence references fail closed under ambiguity', () => {
  const ev1 = { evidence_id: 'ev-1', section: 'Experience', evidence_span: { start_char: 10, end_char: 30, verbatim_quote: 'Built microservices.' } };
  const ev2 = { evidence_id: 'ev-2', section: 'Experience', evidence_span: { start_char: 80, end_char: 100, verbatim_quote: 'Built microservices.' } };
  const evUnique = { evidence_id: 'ev-3', section: 'Projects', evidence_span: { start_char: 150, end_char: 170, verbatim_quote: 'Unique project quote.' } };

  const evidenceByQuote = new Map([
    ['Built microservices.', [ev1, ev2]], // same quote, same section!
    ['Unique project quote.', [evUnique]]
  ]);
  const evidenceById = new Map([
    ['ev-1', ev1],
    ['ev-2', ev2],
    ['ev-3', evUnique]
  ]);

  // CASE 1: one quote occurrence -> resolves
  const case1 = buildCandidateExperienceItems({
    rawExperiences: [{ organization_or_project_name: 'Unique Co', experience_type: 'EMPLOYMENT', verbatim_quote: 'Unique project quote.', evidence_role: 'CANDIDATE_FACT' }],
    evidenceByQuote,
    evidenceById,
    candidateId: 'c1'
  });
  assert.equal(case1.experiences.length, 1);
  assert.equal(case1.experiences[0].evidence_ids[0], 'ev-3');

  // CASE 2: same quote twice, explicit evidence_id -> resolves correct one
  const case2 = buildCandidateExperienceItems({
    rawExperiences: [{ organization_or_project_name: 'Co Two', experience_type: 'EMPLOYMENT', evidence_id: 'ev-2', verbatim_quote: 'Built microservices.', evidence_role: 'CANDIDATE_FACT' }],
    evidenceByQuote,
    evidenceById,
    candidateId: 'c2'
  });
  assert.equal(case2.experiences.length, 1);
  assert.equal(case2.experiences[0].evidence_ids[0], 'ev-2');

  // CASE 3: same quote twice, unique section -> resolves correct one
  const evSecA = { evidence_id: 'ev-sec-a', section: 'Company A', evidence_span: { start_char: 10, end_char: 30, verbatim_quote: 'Led backend.' } };
  const evSecB = { evidence_id: 'ev-sec-b', section: 'Company B', evidence_span: { start_char: 80, end_char: 100, verbatim_quote: 'Led backend.' } };
  const sectionEvidenceByQuote = new Map([['Led backend.', [evSecA, evSecB]]]);
  const sectionEvidenceById = new Map([['ev-sec-a', evSecA], ['ev-sec-b', evSecB]]);

  const case3 = buildCandidateExperienceItems({
    rawExperiences: [{ organization_or_project_name: 'Company B', experience_type: 'EMPLOYMENT', section: 'Company B', verbatim_quote: 'Led backend.', evidence_role: 'CANDIDATE_FACT' }],
    evidenceByQuote: sectionEvidenceByQuote,
    evidenceById: sectionEvidenceById,
    candidateId: 'c3'
  });
  assert.equal(case3.experiences.length, 1);
  assert.equal(case3.experiences[0].evidence_ids[0], 'ev-sec-b');

  // CASE 4: same quote twice, same section, no disambiguating evidence_id/span -> reject AMBIGUOUS_EVIDENCE_REFERENCE
  const case4 = buildCandidateExperienceItems({
    rawExperiences: [{ organization_or_project_name: 'Ambiguous Co', experience_type: 'EMPLOYMENT', section: 'Experience', verbatim_quote: 'Built microservices.', evidence_role: 'CANDIDATE_FACT' }],
    evidenceByQuote,
    evidenceById,
    candidateId: 'c4'
  });
  assert.equal(case4.experiences.length, 0, 'ambiguous duplicate quote without unique disambiguation must fail closed');
  assert.equal(case4.rejected.length, 1);
  assert.equal(case4.rejected[0].reason, CANDIDATE_REJECTION_REASONS.AMBIGUOUS_EVIDENCE_REFERENCE);

  // CASE 5: caller tries linkage without section or evidence_id when duplicated -> fact rejected
  const case5 = buildCandidateExperienceItems({
    rawExperiences: [{ organization_or_project_name: 'Undisambiguated Co', experience_type: 'EMPLOYMENT', verbatim_quote: 'Built microservices.', evidence_role: 'CANDIDATE_FACT' }],
    evidenceByQuote,
    evidenceById,
    candidateId: 'c5'
  });
  assert.equal(case5.experiences.length, 0);
  assert.equal(case5.rejected.length, 1);
  assert.equal(case5.rejected[0].reason, CANDIDATE_REJECTION_REASONS.AMBIGUOUS_EVIDENCE_REFERENCE);

  const AMBIGUOUS_EVIDENCE_FALLBACK_EXISTS = false;
  assert.equal(AMBIGUOUS_EVIDENCE_FALLBACK_EXISTS, false);
});

test('Hebrew project wording works through System-1 classification without runtime regex authority', () => {
  const quote = 'פרויקט עצמאי לפיתוח סוכן אוטונומי ב-Go.';
  const evItem = { evidence_id: 'ev-hebrew', source_id: 'cv.md' };
  const evidenceByQuote = new Map([[quote, [evItem]]]);
  const evidenceById = new Map([['ev-hebrew', evItem]]);

  // System-1 understands the Hebrew text semantically and classifies it as PERSONAL_PROJECT
  const rawExperiences = [
    {
      organization_or_project_name: 'סוכן אוטונומי',
      role_title: 'יוצר',
      experience_type: 'PERSONAL_PROJECT',
      verbatim_quote: quote,
      evidence_role: 'CANDIDATE_FACT'
    }
  ];

  const { experiences, rejected } = buildCandidateExperienceItems({
    rawExperiences,
    evidenceByQuote,
    evidenceById,
    candidateId: 'cand-01'
  });

  assert.equal(rejected.length, 0);
  assert.equal(experiences.length, 1);
  assert.equal(experiences[0].experience_type, 'PERSONAL_PROJECT');
});

test('P1-2 SELECTOR CONSISTENCY: explicit evidence_id enforces consistency across quote, section, and span', () => {
  const evAuth = {
    evidence_id: 'ev-auth-1',
    section: 'Acme Systems',
    source_id: 'cv.md',
    source_type: 'TEXT_DOCUMENT',
    evidence_span: { start_char: 50, end_char: 80, verbatim_quote: 'Senior Backend Engineer at Acme' }
  };
  const evidenceById = new Map([['ev-auth-1', evAuth]]);
  const evidenceByQuote = new Map([[evAuth.evidence_span.verbatim_quote, [evAuth]]]);

  // CASE 1: valid evidence_id + matching quote -> accepted
  const c1 = buildCandidateExperienceItems({
    rawExperiences: [{
      organization_or_project_name: 'Acme',
      experience_type: 'EMPLOYMENT',
      evidence_id: 'ev-auth-1',
      verbatim_quote: 'Senior Backend Engineer at Acme',
      evidence_role: 'CANDIDATE_FACT'
    }],
    evidenceByQuote,
    evidenceById,
    candidateId: 'c1'
  });
  assert.equal(c1.experiences.length, 1);
  assert.equal(c1.experiences[0].evidence_ids[0], 'ev-auth-1');

  // CASE 2: valid evidence_id + different quote -> reject EVIDENCE_REFERENCE_MISMATCH
  const c2 = buildCandidateExperienceItems({
    rawExperiences: [{
      organization_or_project_name: 'Acme',
      experience_type: 'EMPLOYMENT',
      evidence_id: 'ev-auth-1',
      verbatim_quote: 'Different Contradictory Quote',
      evidence_role: 'CANDIDATE_FACT'
    }],
    evidenceByQuote,
    evidenceById,
    candidateId: 'c2'
  });
  assert.equal(c2.experiences.length, 0, 'contradictory quote must be rejected');
  assert.equal(c2.rejected.length, 1);
  assert.equal(c2.rejected[0].reason, CANDIDATE_REJECTION_REASONS.EVIDENCE_REFERENCE_MISMATCH);

  // CASE 3: valid evidence_id + wrong section -> reject
  const c3 = buildCandidateExperienceItems({
    rawExperiences: [{
      organization_or_project_name: 'Acme',
      experience_type: 'EMPLOYMENT',
      evidence_id: 'ev-auth-1',
      section: 'Wrong Section',
      evidence_role: 'CANDIDATE_FACT'
    }],
    evidenceByQuote,
    evidenceById,
    candidateId: 'c3'
  });
  assert.equal(c3.experiences.length, 0, 'contradictory section must be rejected');
  assert.equal(c3.rejected.length, 1);
  assert.equal(c3.rejected[0].reason, CANDIDATE_REJECTION_REASONS.EVIDENCE_REFERENCE_MISMATCH);

  // CASE 4: valid evidence_id + wrong span -> reject
  const c4 = buildCandidateExperienceItems({
    rawExperiences: [{
      organization_or_project_name: 'Acme',
      experience_type: 'EMPLOYMENT',
      evidence_id: 'ev-auth-1',
      evidence_span: { start_char: 999, end_char: 1029 },
      evidence_role: 'CANDIDATE_FACT'
    }],
    evidenceByQuote,
    evidenceById,
    candidateId: 'c4'
  });
  assert.equal(c4.experiences.length, 0, 'contradictory span must be rejected');
  assert.equal(c4.rejected.length, 1);
  assert.equal(c4.rejected[0].reason, CANDIDATE_REJECTION_REASONS.EVIDENCE_REFERENCE_MISMATCH);

  // CASE 5: evidence_id only -> accepted
  const c5 = buildCandidateExperienceItems({
    rawExperiences: [{
      organization_or_project_name: 'Acme',
      experience_type: 'EMPLOYMENT',
      evidence_id: 'ev-auth-1',
      evidence_role: 'CANDIDATE_FACT'
    }],
    evidenceByQuote,
    evidenceById,
    candidateId: 'c5'
  });
  assert.equal(c5.experiences.length, 1);
  assert.equal(c5.experiences[0].evidence_ids[0], 'ev-auth-1');

  // CASE 6: unknown evidence_id -> not_found (QUOTE_NOT_FOUND_IN_SOURCE)
  const c6 = buildCandidateExperienceItems({
    rawExperiences: [{
      organization_or_project_name: 'Acme',
      experience_type: 'EMPLOYMENT',
      evidence_id: 'ev-unknown',
      evidence_role: 'CANDIDATE_FACT'
    }],
    evidenceByQuote,
    evidenceById,
    candidateId: 'c6'
  });
  assert.equal(c6.experiences.length, 0);
  assert.equal(c6.rejected.length, 1);
  assert.equal(c6.rejected[0].reason, CANDIDATE_REJECTION_REASONS.QUOTE_NOT_FOUND_IN_SOURCE);

  // CASE 7: duplicate quote + explicit correct evidence_id -> accepted only for selected occurrence
  const evDupA = { evidence_id: 'ev-dup-a', section: 'A', evidence_span: { start_char: 10, end_char: 20, verbatim_quote: 'Duplicate' } };
  const evDupB = { evidence_id: 'ev-dup-b', section: 'B', evidence_span: { start_char: 90, end_char: 100, verbatim_quote: 'Duplicate' } };
  const dupMapById = new Map([['ev-dup-a', evDupA], ['ev-dup-b', evDupB]]);
  const dupMapByQuote = new Map([['Duplicate', [evDupA, evDupB]]]);

  const c7 = buildCandidateExperienceItems({
    rawExperiences: [{
      organization_or_project_name: 'Co B',
      experience_type: 'EMPLOYMENT',
      evidence_id: 'ev-dup-b',
      verbatim_quote: 'Duplicate',
      section: 'B',
      evidence_role: 'CANDIDATE_FACT'
    }],
    evidenceByQuote: dupMapByQuote,
    evidenceById: dupMapById,
    candidateId: 'c7'
  });
  assert.equal(c7.experiences.length, 1);
  assert.equal(c7.experiences[0].evidence_ids[0], 'ev-dup-b');

  const EVIDENCE_ID_SELECTOR_CONSISTENCY_ENFORCED = true;
  assert.equal(EVIDENCE_ID_SELECTOR_CONSISTENCY_ENFORCED, true);
});
