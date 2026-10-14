// @ts-check
export const FIT_POLICY_VERSION = 'v1.1.0';
const SENIOR_TITLE = /\b(senior|sr\.?|lead|principal|staff|director|head|chief)\b/i;

function normalized(value) {
  return typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() : '';
}

function degreeLevel(value) {
  const text = normalized(value).replace(/\bb\s+sc\b/g, 'bsc').replace(/\bm\s+sc\b/g, 'msc').replace(/\bb\s+a\b/g, 'ba').replace(/\bm\s+a\b/g, 'ma');
  if (/\b(bachelor|bsc|ba)\b/.test(text)) return 'bachelor';
  if (/\b(master|msc|ma)\b/.test(text)) return 'master';
  if (/\b(phd|doctorate)\b/.test(text)) return 'doctorate';
  return null;
}

/** Detect only explicit mandatory eligibility language; it does not infer candidate status. */
export function detectRequiredEligibility(jdText = '') {
  const text = String(jdText).toLowerCase();
  const requirements = [];
  if (/\b(?:must be|must have|requires? (?:the applicant to be|applicants? to be)?)\s+(?:legally )?(?:authorized|eligible) to work\b|\b(?:work )?authorization required\b|\bno (?:visa )?sponsorship\b|\b(?:must|required)\b[^.\n]{0,60}\b(?:visa|sponsorship)\b/.test(text)) {
    requirements.push('work_authorization');
  }
  if (/\b(?:must|required)\b[^.\n]{0,60}\bsecurity clearance\b|\bsecurity clearance required\b/.test(text)) {
    requirements.push('security_clearance');
  }
  if (/\b(?:must be|only|requires?)\s+(?:a\s+)?citizen(?:ship)?\b|\bcitizenship required\b/.test(text)) {
    requirements.push('citizenship');
  }
  return requirements;
}

function degreeMatches(required, candidate) {
  const req = normalized(required);
  const actual = normalized(candidate);
  if (req === actual) return true;
  const level = degreeLevel(required);
  if (!level || degreeLevel(candidate) !== level) return false;
  const fields = (value) => normalized(value)
    .replace(/\b(bachelor|bsc|ba|master|msc|ma|phd|doctorate|degree|of|in|the|s|arts|science)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const requiredFields = fields(required);
  return !requiredFields || fields(candidate) === requiredFields;
}

/**
 * Deterministic, fail-closed comparison using only explicitly supplied canonical evidence.
 * `professional_years` must be computed from professional employment, never projects.
 */
export function evaluateCandidateFit({ evaluation, candidateFacts = {}, title = '', requiredEligibility = [] } = {}) {
  if (SENIOR_TITLE.test(title)) return { status: 'REJECT', reasons: ['Senior/lead title conflicts with the early-career fit gate.'] };
  if (evaluation?.status !== 'PASSED' || !evaluation.extraction) {
    return { status: 'NEEDS_REVIEW', reasons: ['JD extraction did not pass validation.'] };
  }

  for (const field of requiredEligibility) {
    if (candidateFacts[field] === undefined || candidateFacts[field] === null || candidateFacts[field] === '') {
      return { status: 'NEEDS_REVIEW', reasons: [`Required eligibility fact is unknown: ${field}.`] };
    }
    if (candidateFacts[field] === false) return { status: 'REJECT', reasons: [`Candidate does not meet required eligibility: ${field}.`] };
    if (candidateFacts[field] !== true) return { status: 'NEEDS_REVIEW', reasons: [`Required eligibility fact is not explicitly verified: ${field}.`] };
  }

  const extracted = evaluation.extraction;
  const years = candidateFacts.professional_years;
  if (Number.isFinite(extracted.required_yoe) && extracted.required_yoe > 0) {
    if (!Number.isFinite(years) || years < 0 || candidateFacts.professional_yoe_verified !== true
      || !['cv.md', 'config/profile.yml', 'user-stated'].includes(candidateFacts.professional_years_source)) {
      return { status: 'NEEDS_REVIEW', reasons: ['Verified professional YOE from cv.md, config/profile.yml, or a direct user statement is unavailable.'] };
    }
    const shortfall = extracted.required_yoe - years;
    if (shortfall >= 4) return { status: 'REJECT', reasons: [`Required professional YOE exceeds verified candidate YOE by ${shortfall}.`] };
    if (shortfall > 0) return { status: 'LONG_STRETCH', reasons: [`Required professional YOE exceeds verified candidate YOE by ${shortfall}.`] };
  }

  if (extracted.degree) {
    const degrees = Array.isArray(candidateFacts.degrees) ? candidateFacts.degrees : [];
    if (!degrees.length) return { status: 'NEEDS_REVIEW', reasons: ['Candidate degree evidence is unavailable.'] };
    if (!degrees.some((degree) => degreeMatches(extracted.degree, degree))) {
      if (!extracted.alternative_qualifications || candidateFacts.alternative_qualification_evidence !== true) {
        return { status: 'NEEDS_REVIEW', reasons: ['Degree equivalence requires candidate evidence and human review.'] };
      }
    }
  }

  if (Number.isFinite(extracted.gpa)) {
    if (!Number.isFinite(candidateFacts.gpa) || !['cv.md', 'config/profile.yml', 'user-stated'].includes(candidateFacts.gpa_source)) {
      return { status: 'NEEDS_REVIEW', reasons: ['Candidate GPA is unavailable from a primary source for a material requirement.'] };
    }
    if (!candidateFacts.gpa_scale || !extracted.gpa_scale || normalized(candidateFacts.gpa_scale) !== normalized(extracted.gpa_scale)) {
      return { status: 'NEEDS_REVIEW', reasons: ['GPA scale is not explicit and comparable on both the CV and job requirement.'] };
    }
    if (candidateFacts.gpa < extracted.gpa) return { status: 'REJECT', reasons: ['Verified candidate GPA is below the stated requirement.'] };
  }

  if (Number.isFinite(extracted.preferred_yoe)) {
    if (!Number.isFinite(years) || candidateFacts.professional_yoe_verified !== true
      || !['cv.md', 'config/profile.yml', 'user-stated'].includes(candidateFacts.professional_years_source)) {
      return { status: 'NEEDS_REVIEW', reasons: ['Verified professional YOE is unavailable for the preferred YOE comparison.'] };
    }
    if (extracted.preferred_yoe > years) {
      return { status: 'REASONABLE', reasons: ['Candidate meets the stated requirements but not the preferred YOE.'] };
    }
  }

  return { status: 'STRONG', reasons: ['No hard requirement mismatch found against the supplied canonical candidate evidence.'] };
}
