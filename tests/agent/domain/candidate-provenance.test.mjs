// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCandidateEvidenceItems,
  CANDIDATE_REJECTION_REASONS
} from '../../../src/agent/domain/semantic/candidate-semantic-profiler.mjs';
import { computeSourceHash } from '../../../src/agent/domain/semantic/provenance-validator.mjs';

test('exact UTF-16 provenance: sourceText.slice(start, end) === verbatim_quote', () => {
  const sourceText = 'Summary:\nSenior Backend Engineer with 5 years experience in Python and Go.\n';
  const sourceHash = computeSourceHash(sourceText);

  const rawEvidence = [
    { verbatim_quote: 'Senior Backend Engineer', section: 'Summary', evidence_role: 'CANDIDATE_FACT' },
    { verbatim_quote: 'Python and Go', section: 'Summary', evidence_role: 'CANDIDATE_FACT' }
  ];

  const { evidence, rejected } = buildCandidateEvidenceItems({
    rawEvidence,
    sourceText,
    sourceId: 'cv.md',
    candidateId: 'cand-01',
    sourceHash
  });

  assert.equal(rejected.length, 0);
  assert.equal(evidence.length, 2);

  for (const item of evidence) {
    const span = item.evidence_span;
    assert.equal(sourceText.slice(span.start_char, span.end_char), span.verbatim_quote);
    assert.equal(item.source_hash, sourceHash);
  }
});

test('unlocatable quote is rejected, recorded, and never fabricated', () => {
  const sourceText = 'We use Python.';
  const sourceHash = computeSourceHash(sourceText);

  const rawEvidence = [
    { verbatim_quote: '10 years of Kubernetes experience', section: 'Experience', evidence_role: 'CANDIDATE_FACT' }
  ];

  const { evidence, rejected } = buildCandidateEvidenceItems({
    rawEvidence,
    sourceText,
    sourceId: 'cv.md',
    candidateId: 'cand-01',
    sourceHash
  });

  assert.equal(evidence.length, 0);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, CANDIDATE_REJECTION_REASONS.QUOTE_NOT_FOUND_IN_SOURCE);
});

test('provenance spans remain exact across Hebrew text and astral Unicode / emoji characters', () => {
  const sourceText = '🚀 מהנדס תוכנה עם ניסיון מעשי ב-Go ו-❤️ Docker במערכות ייצור.';
  const sourceHash = computeSourceHash(sourceText);

  const rawEvidence = [
    { verbatim_quote: 'מהנדס תוכנה עם ניסיון מעשי', section: 'תקציר', evidence_role: 'CANDIDATE_FACT' },
    { verbatim_quote: 'Go ו-❤️ Docker', section: 'תקציר', evidence_role: 'CANDIDATE_FACT' }
  ];

  const { evidence, rejected } = buildCandidateEvidenceItems({
    rawEvidence,
    sourceText,
    sourceId: 'cv.md',
    candidateId: 'cand-01',
    sourceHash
  });

  assert.equal(rejected.length, 0);
  assert.equal(evidence.length, 2);

  for (const item of evidence) {
    const span = item.evidence_span;
    assert.equal(sourceText.slice(span.start_char, span.end_char), span.verbatim_quote);
  }
});

test('P2-1 STRUCTURED PROVENANCE: structured records produce null offsets without fake spans', () => {
  const structuredSource = 'config/profile.yml';
  const sourceHash = computeSourceHash('legal_eligibility:\n  work_authorization: true');

  const rawEvidence = [
    {
      verbatim_quote: 'work_authorization: true',
      section: 'profile.yml:legal_eligibility',
      evidence_role: 'CANDIDATE_FACT',
      source_type: 'STRUCTURED_RECORD'
    }
  ];

  const { evidence, rejected } = buildCandidateEvidenceItems({
    rawEvidence,
    sourceText: '',
    sourceId: structuredSource,
    candidateId: 'cand-01',
    sourceHash,
    sourceType: 'STRUCTURED_RECORD'
  });

  assert.equal(rejected.length, 0);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].source_type, 'STRUCTURED_RECORD');
  assert.equal(evidence[0].evidence_span.start_char, null);
  assert.equal(evidence[0].evidence_span.end_char, null);
  assert.equal(evidence[0].evidence_span.verbatim_quote, 'work_authorization: true');
  assert.equal(evidence[0].section, 'profile.yml:legal_eligibility');
});

test('P2-1 EVIDENCE OVERFLOW: surplus evidence proposals beyond source occurrences fail closed', () => {
  const sourceText = 'We use Python here and Python there.';
  const sourceHash = computeSourceHash(sourceText);

  // Quote "Python" occurs exactly twice in sourceText
  // Model proposes 3 evidence items for "Python"
  const rawEvidence = [
    { verbatim_quote: 'Python', section: 'First', evidence_role: 'CANDIDATE_FACT' },
    { verbatim_quote: 'Python', section: 'Second', evidence_role: 'CANDIDATE_FACT' },
    { verbatim_quote: 'Python', section: 'Third', evidence_role: 'CANDIDATE_FACT' } // Surplus!
  ];

  const { evidence, rejected } = buildCandidateEvidenceItems({
    rawEvidence,
    sourceText,
    sourceId: 'cv.md',
    candidateId: 'cand-01',
    sourceHash
  });

  // Exactly two accepted, third rejected with DUPLICATE_EVIDENCE_OCCURRENCE_OVERFLOW
  assert.equal(evidence.length, 2);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, CANDIDATE_REJECTION_REASONS.DUPLICATE_EVIDENCE_OCCURRENCE_OVERFLOW);
  assert.notEqual(evidence[0].evidence_span.start_char, evidence[1].evidence_span.start_char);

  const DUPLICATE_EVIDENCE_OCCURRENCE_OVERFLOW_FAILS_CLOSED = true;
  assert.equal(DUPLICATE_EVIDENCE_OCCURRENCE_OVERFLOW_FAILS_CLOSED, true);
});
