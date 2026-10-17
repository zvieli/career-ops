// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSourceHash,
  codePointsToUtf16Offsets,
  utf16ToCodePointOffsets,
  validateEvidenceSpan,
  validateRequirementLineage,
  validateCandidateLineage,
  redactCandidateFactsForEvaluation,
  PRIMARY_CANDIDATE_FILES
} from '../../../src/agent/domain/semantic/provenance-validator.mjs';

test('computeSourceHash generates deterministic SHA-256 hex strings', () => {
  const hash1 = computeSourceHash('Hello World');
  const hash2 = computeSourceHash('Hello World');
  assert.equal(hash1, hash2);
  assert.match(hash1, /^[a-f0-9]{64}$/);
});

test('validateEvidenceSpan verifies exact quotes and catches mismatches', () => {
  const text = 'Required: 2 years of experience with Python and FastAPI.';
  const validSpan = {
    start_char: 10,
    end_char: 31,
    verbatim_quote: '2 years of experience'
  };

  const resValid = validateEvidenceSpan(text, validSpan);
  assert.equal(resValid.valid, true);
  assert.equal(resValid.extracted_quote, '2 years of experience');

  // Mismatched quote text
  const mismatchSpan = {
    start_char: 10,
    end_char: 31,
    verbatim_quote: '3 years of experience'
  };
  const resMismatch = validateEvidenceSpan(text, mismatchSpan);
  assert.equal(resMismatch.valid, false);
  assert.ok(resMismatch.error?.includes('Span mismatch'));

  // Out of bounds end_char
  const oobSpan = {
    start_char: 0,
    end_char: 1000,
    verbatim_quote: 'nonexistent'
  };
  assert.equal(validateEvidenceSpan(text, oobSpan).valid, false);

  // Negative offset
  const negSpan = {
    start_char: -1,
    end_char: 10,
    verbatim_quote: 'bad'
  };
  assert.equal(validateEvidenceSpan(text, negSpan).valid, false);
});

test('validateEvidenceSpan handles Hebrew and RTL text accurately', () => {
  const hebrewText = 'דרוש/ה מהנדס/ת תוכנה ג\'וניור בעל/ת תואר ראשון במדעי המחשב';
  const quote = 'תואר ראשון במדעי המחשב';
  const start = hebrewText.indexOf(quote);
  const end = start + quote.length;

  const res = validateEvidenceSpan(hebrewText, {
    start_char: start,
    end_char: end,
    verbatim_quote: quote
  });

  assert.equal(res.valid, true);
  assert.equal(res.extracted_quote, quote);
});

test('Unicode astral character and code point offset conversions', () => {
  // 🚀 (U+1F680) is 2 UTF-16 code units, but 1 Unicode code point
  const text = 'Build 🚀 fast AI systems';
  // Code point indices:
  // "B" (0), "u" (1), "i" (2), "l" (3), "d" (4), " " (5), "🚀" (6), " " (7), "f" (8)...
  const cpRange = codePointsToUtf16Offsets(text, 6, 7);
  assert.equal(text.slice(cpRange.start_char, cpRange.end_char), '🚀');

  const backToCp = utf16ToCodePointOffsets(text, cpRange.start_char, cpRange.end_char);
  assert.equal(backToCp.code_point_start, 6);
  assert.equal(backToCp.code_point_end, 7);

  // Zero-length span at boundary (e.g. [0, 0] or [6, 6])
  const zeroLen = utf16ToCodePointOffsets(text, 6, 6);
  assert.equal(zeroLen.code_point_start, 6);
  assert.equal(zeroLen.code_point_end, 6);
});

test('validateRequirementLineage enforces hash and span integrity', () => {
  const jdText = 'We require 3+ years in Go microservices.';
  const jdHash = computeSourceHash(jdText);

  const requirement = {
    requirement_id: 'req-01',
    evidence_span: {
      start_char: 11,
      end_char: 19,
      verbatim_quote: '3+ years'
    }
  };

  const res = validateRequirementLineage(requirement, jdText, jdHash);
  assert.equal(res.valid, true);

  // Mismatched JD hash
  const badHashRes = validateRequirementLineage(requirement, jdText, 'f'.repeat(64));
  assert.equal(badHashRes.valid, false);
  assert.ok(badHashRes.errors.some((e) => e.includes('hash mismatch')));
});

test('validateCandidateLineage strictly rejects fabricated quotes and non-primary files', () => {
  const cvText = '# Experience\nDeveloped high-throughput APIs in FastAPI.';
  const cvHash = computeSourceHash(cvText);

  const primaryDocs = {
    'cv.md': cvText
  };

  const validCapability = {
    capability_id: 'cap-1',
    concept_id: 'fastapi',
    name: 'FastAPI',
    is_verified: true,
    provenance: {
      source_file: 'cv.md',
      verbatim_quote: 'Developed high-throughput APIs in FastAPI',
      source_hash: cvHash
    }
  };

  const res = validateCandidateLineage(validCapability, primaryDocs);
  assert.equal(res.valid, true);

  // Fabricated quote not in cv.md
  const fabricatedCap = {
    ...validCapability,
    provenance: {
      ...validCapability.provenance,
      verbatim_quote: 'Led a team of 50 Kubernetes architects'
    }
  };
  const resFab = validateCandidateLineage(fabricatedCap, primaryDocs);
  assert.equal(resFab.valid, false);
  assert.ok(resFab.errors.some((e) => e.includes('not found in cv.md')));

  // Disallowed source file
  const externalCap = {
    ...validCapability,
    provenance: {
      ...validCapability.provenance,
      source_file: 'external-blog-post.html'
    }
  };
  const resExt = validateCandidateLineage(externalCap, primaryDocs);
  assert.equal(resExt.valid, false);
  assert.ok(resExt.errors.some((e) => e.includes('Invalid source_file')));
});

test('redactCandidateFactsForEvaluation strips sensitive PII', () => {
  const sensitiveCandidate = {
    full_name: 'Jane Doe',
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane@example.com',
    phone: '+972-50-1234567',
    phone_number: '+972-50-1234567',
    mobile: '+972-50-1234567',
    contact_info: 'contact details',
    address: 'Tel Aviv, Israel',
    telegram_id: '12345678',
    auth_tokens: { secret: 'top_secret' },
    professional_years: 1,
    degrees: ['B.Sc. CS']
  };

  const redacted = redactCandidateFactsForEvaluation(sensitiveCandidate);
  assert.equal(redacted.full_name, undefined);
  assert.equal(redacted.first_name, undefined);
  assert.equal(redacted.last_name, undefined);
  assert.equal(redacted.email, undefined);
  assert.equal(redacted.phone, undefined);
  assert.equal(redacted.phone_number, undefined);
  assert.equal(redacted.mobile, undefined);
  assert.equal(redacted.contact_info, undefined);
  assert.equal(redacted.telegram_id, undefined);
  assert.equal(redacted.auth_tokens, undefined);
  assert.equal(redacted.professional_years, 1);
  assert.deepEqual(redacted.degrees, ['B.Sc. CS']);
});
