// @ts-check
/**
 * provenance-validator.mjs — Source Provenance, Evidence Span & Candidate Lineage Verification
 *
 * Requirements:
 * - Verify source document identity & SHA-256 content hash
 * - Verify exact quoted text against start/end span offsets
 * - Handle Unicode, astral characters (emojis), and mixed Hebrew/English text safely
 * - Explicitly define offset semantics: JavaScript UTF-16 code units (String.prototype.slice)
 * - Provide code-point to UTF-16 conversion utilities
 * - Verify requirement-to-source lineage
 * - Verify candidate capability-to-primary-evidence lineage (cv.md, article-digest.md, config/profile.yml, user-stated)
 * - Enforce non-fabrication: reject mismatched hashes, invalid offsets, fabricated quotes
 * - Redact sensitive candidate PII to prevent leaking into evaluation logs
 */

import { createHash } from 'node:crypto';

export const PROVENANCE_OFFSET_ENCODING = 'utf-16';

export const PRIMARY_CANDIDATE_FILES = Object.freeze([
  'cv.md',
  'article-digest.md',
  'config/profile.yml',
  'user-stated'
]);

/**
 * Compute SHA-256 hex digest of a string
 * @param {string} text
 * @returns {string} 64-char lowercase hex string
 */
export function computeSourceHash(text) {
  if (typeof text !== 'string') {
    throw new TypeError(`computeSourceHash expects string, received ${typeof text}`);
  }
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Convert Unicode code-point offsets to JavaScript UTF-16 code unit offsets
 * @param {string} text
 * @param {number} cpStart
 * @param {number} cpEnd
 * @returns {{ start_char: number, end_char: number }}
 */
export function codePointsToUtf16Offsets(text, cpStart, cpEnd) {
  const codePoints = Array.from(text);
  if (cpStart < 0 || cpEnd < cpStart || cpEnd > codePoints.length) {
    throw new RangeError(`Code point range [${cpStart}, ${cpEnd}] out of bounds (length ${codePoints.length})`);
  }
  let utf16Start = 0;
  for (let i = 0; i < cpStart; i++) {
    utf16Start += codePoints[i].length;
  }
  let utf16End = utf16Start;
  for (let i = cpStart; i < cpEnd; i++) {
    utf16End += codePoints[i].length;
  }
  return { start_char: utf16Start, end_char: utf16End };
}

/**
 * Convert JavaScript UTF-16 code unit offsets to Unicode code point offsets
 * @param {string} text
 * @param {number} utf16Start
 * @param {number} utf16End
 * @returns {{ code_point_start: number, code_point_end: number }}
 */
export function utf16ToCodePointOffsets(text, utf16Start, utf16End) {
  if (utf16Start < 0 || utf16End < utf16Start || utf16End > text.length) {
    throw new RangeError(`UTF-16 range [${utf16Start}, ${utf16End}] out of bounds (length ${text.length})`);
  }
  if (utf16Start === utf16End) {
    let cp = 0, u = 0;
    for (const ch of text) {
      if (u === utf16Start) return { code_point_start: cp, code_point_end: cp };
      u += ch.length;
      cp++;
    }
    if (u === utf16Start) return { code_point_start: cp, code_point_end: cp };
    throw new RangeError(`Offsets [${utf16Start}, ${utf16End}] split a surrogate pair`);
  }
  let cpIndex = 0;
  let cpStart = -1;
  let cpEnd = -1;
  let currentUtf16 = 0;

  for (const ch of text) {
    if (currentUtf16 === utf16Start) cpStart = cpIndex;
    currentUtf16 += ch.length;
    cpIndex++;
    if (currentUtf16 === utf16End) {
      cpEnd = cpIndex;
      break;
    }
  }

  if (cpStart === -1 || cpEnd === -1) {
    throw new RangeError(`Offsets [${utf16Start}, ${utf16End}] split a surrogate pair or boundary in UTF-16 string`);
  }

  return { code_point_start: cpStart, code_point_end: cpEnd };
}

/**
 * Validate an evidence span against source text
 * @param {string} sourceText - Full source text (e.g. JD or CV)
 * @param {{ start_char: number, end_char: number, verbatim_quote: string }} span
 * @param {object} [options]
 * @param {boolean} [options.normalizeWhitespace=false]
 * @returns {{ valid: boolean, error?: string, extracted_quote?: string }}
 */
export function validateEvidenceSpan(sourceText, span, options = {}) {
  if (typeof sourceText !== 'string') {
    return { valid: false, error: 'Source text must be a string' };
  }
  if (!span || typeof span !== 'object') {
    return { valid: false, error: 'Evidence span must be an object' };
  }

  const { start_char, end_char, verbatim_quote } = span;

  if (!Number.isInteger(start_char) || start_char < 0) {
    return { valid: false, error: `Invalid start_char ${start_char}: must be non-negative integer` };
  }
  if (!Number.isInteger(end_char) || end_char < start_char) {
    return { valid: false, error: `Invalid end_char ${end_char}: must be >= start_char (${start_char})` };
  }
  if (end_char > sourceText.length) {
    return {
      valid: false,
      error: `end_char ${end_char} exceeds source text length ${sourceText.length}`
    };
  }
  if (typeof verbatim_quote !== 'string' || verbatim_quote.length === 0) {
    return { valid: false, error: 'verbatim_quote must be a non-empty string' };
  }

  const extracted = sourceText.slice(start_char, end_char);

  if (extracted === verbatim_quote) {
    return { valid: true, extracted_quote: extracted };
  }

  if (options.normalizeWhitespace) {
    const normExtracted = extracted.replace(/\s+/g, ' ').trim();
    const normQuote = verbatim_quote.replace(/\s+/g, ' ').trim();
    if (normExtracted === normQuote) {
      return { valid: true, extracted_quote: extracted };
    }
  }

  return {
    valid: false,
    error: `Span mismatch: expected quote "${verbatim_quote}", found "${extracted}" at [${start_char}, ${end_char}]`,
    extracted_quote: extracted
  };
}

/**
 * Validate requirement-to-source lineage
 * @param {object} requirement - JobRequirement entity
 * @param {string} rawJdText - Raw JD text
 * @param {string} [expectedJdHash] - Expected SHA-256 hash of JD text
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateRequirementLineage(requirement, rawJdText, expectedJdHash) {
  const errors = [];

  if (expectedJdHash) {
    const actualHash = computeSourceHash(rawJdText);
    if (actualHash !== expectedJdHash) {
      errors.push(`JD hash mismatch: expected ${expectedJdHash}, calculated ${actualHash}`);
    }
  }

  if (!requirement.evidence_span) {
    errors.push(`Requirement ${requirement.requirement_id || 'unknown'} is missing evidence_span`);
    return { valid: false, errors };
  }

  const spanResult = validateEvidenceSpan(rawJdText, requirement.evidence_span);
  if (!spanResult.valid) {
    errors.push(`Requirement ${requirement.requirement_id || 'unknown'} evidence invalid: ${spanResult.error}`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validate candidate capability provenance against primary documents
 * @param {object} capability - CandidateCapability entity
 * @param {Record<string, string>} primaryDocs - Map of source_file to text content
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateCandidateLineage(capability, primaryDocs = {}) {
  const errors = [];
  const prov = capability.provenance;

  if (!prov) {
    errors.push(`Capability ${capability.capability_id || capability.name} is missing provenance`);
    return { valid: false, errors };
  }

  if (!PRIMARY_CANDIDATE_FILES.includes(prov.source_file)) {
    errors.push(
      `Invalid source_file "${prov.source_file}". Primary evidence must come from [${PRIMARY_CANDIDATE_FILES.join(', ')}]`
    );
  }

  const docText = primaryDocs[prov.source_file];
  if (docText) {
    const expectedHash = computeSourceHash(docText);
    if (prov.source_hash && prov.source_hash !== expectedHash) {
      errors.push(
        `Source hash mismatch for ${prov.source_file}: stated ${prov.source_hash}, actual ${expectedHash}`
      );
    }

    if (prov.verbatim_quote && !docText.includes(prov.verbatim_quote)) {
      errors.push(
        `Fabricated or mismatched quote: "${prov.verbatim_quote}" not found in ${prov.source_file}`
      );
    }

    if (prov.start_char !== null && prov.start_char !== undefined &&
        prov.end_char !== null && prov.end_char !== undefined) {
      const spanResult = validateEvidenceSpan(docText, {
        start_char: prov.start_char,
        end_char: prov.end_char,
        verbatim_quote: prov.verbatim_quote
      });
      if (!spanResult.valid) {
        errors.push(`Capability span invalid in ${prov.source_file}: ${spanResult.error}`);
      }
    }
  }

  // Enforce rule: Inferred or unverified capabilities cannot have is_verified = true
  if (capability.is_verified && (!prov.verbatim_quote || prov.verbatim_quote.trim().length === 0)) {
    errors.push(`Capability ${capability.name} marked as is_verified=true without primary verbatim quote`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Redact sensitive PII from candidate profiles for evaluation reports
 * @param {object} candidateFacts
 * @returns {object} Sanitized evaluation profile
 */
export function redactCandidateFactsForEvaluation(candidateFacts = {}) {
  const safe = { ...candidateFacts };

  // Strip direct personal contact and identity identifiers
  delete safe.full_name;
  delete safe.name;
  delete safe.first_name;
  delete safe.last_name;
  delete safe.email;
  delete safe.phone;
  delete safe.phone_number;
  delete safe.mobile;
  delete safe.contact;
  delete safe.contact_info;
  delete safe.address;
  delete safe.linkedin_url;
  delete safe.github_url;
  delete safe.personal_notes;
  delete safe.telegram_id;
  delete safe.auth_tokens;
  delete safe.api_keys;

  return safe;
}
