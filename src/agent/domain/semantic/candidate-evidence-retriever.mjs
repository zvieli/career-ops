// @ts-check
/**
 * candidate-evidence-retriever.mjs — High-Recall Bounded Candidate Evidence Retrieval
 *
 * Implements deterministic candidate-side evidence retrieval for a given JobRequirement:
 * - High recall across skills, capabilities, experiences, education, certifications, and atomic evidence.
 * - Uses shared SkillConcept identity, entity references, and keyword relevance.
 * - Does NOT decide requirement satisfaction (proposes evidence bundle only).
 * - Bounded bundle size to prevent context overflow and maintain bounded latency.
 * - Non-destructive and read-only: zero mutation of job or candidate state.
 */

import { getDefaultSkillConceptRegistry, exactResolveSurface } from './skill-concept-registry.mjs';

const EDUCATION_TOKENS = new Set([
  'degree', 'bachelor', 'bachelors', 'bsc', 'b.sc', 'ba', 'b.a',
  'master', 'masters', 'msc', 'm.sc', 'ma', 'm.a',
  'phd', 'ph.d', 'doctorate', 'academic', 'university', 'college', 'pursuing'
]);

const CERTIFICATION_TOKENS = new Set([
  'certified', 'certification', 'certificate', 'credential', 'license'
]);

const LEGAL_TOKENS = new Set([
  'sponsorship', 'visa', 'authorized', 'authorization', 'eligible', 'eligibility',
  'clearance', 'citizen', 'citizenship', 'security'
]);

const YOE_TOKENS = new Set([
  'year', 'years', 'yoe', 'experience', 'senior', 'lead', 'staff', 'principal',
  'junior', 'entry', 'intern', 'internship', 'professional'
]);

/**
 * Tokenize and normalize text into clean search terms
 * @param {string} text
 * @returns {Array<string>}
 */
function tokenize(text = '') {
  if (typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#._-]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Deterministically retrieve relevant candidate evidence for one JobRequirement.
 *
 * @param {object} params
 * @param {object} params.requirement JobRequirement
 * @param {object} params.candidateProfile CandidateSemanticProfile
 * @param {object} [params.registry] SkillConceptRegistry
 * @param {object} [params.options]
 * @param {number} [params.options.maxItemsPerCategory=10]
 * @returns {object} Bounded candidate evidence bundle
 */
export function retrieveCandidateEvidenceForRequirement({
  requirement,
  candidateProfile,
  registry = getDefaultSkillConceptRegistry(),
  options = {}
}) {
  if (!requirement || typeof requirement !== 'object') {
    throw new TypeError('requirement must be a valid object');
  }
  if (!candidateProfile || typeof candidateProfile !== 'object') {
    throw new TypeError('candidateProfile must be a valid object');
  }

  const maxPerCat = options.maxItemsPerCategory || 10;
  const reqDesc = String(requirement.description || '');
  const reqTextLower = reqDesc.toLowerCase();
  const reqTokens = tokenize(reqDesc);
  const reqTokenSet = new Set(reqTokens);

  // 1. Identify target concept IDs
  const targetConceptIds = new Set();
  if (requirement.target_concept_id) {
    targetConceptIds.add(requirement.target_concept_id);
  }

  // Check tokens against registry
  for (const token of reqTokens) {
    if (registry?.conceptById?.has(token)) {
      const entry = registry.conceptById.get(token);
      targetConceptIds.add(entry.concept_id);
      if (entry.parent_concept_id) targetConceptIds.add(entry.parent_concept_id);
    } else if (registry) {
      const resolved = exactResolveSurface(registry, token);
      if (resolved?.concept_id) {
        targetConceptIds.add(resolved.concept_id);
        const entry = registry.conceptById?.get(resolved.concept_id);
        if (entry?.parent_concept_id) targetConceptIds.add(entry.parent_concept_id);
      }
    }
  }

  // 2. Retrieve Candidate Skills
  const candidateSkills = Array.isArray(candidateProfile.skills) ? candidateProfile.skills : [];
  const matchedSkills = [];
  const matchedEvidenceIds = new Set();

  for (const sk of candidateSkills) {
    const conceptMatches = sk.concept_id && targetConceptIds.has(sk.concept_id);
    const nameMatches = sk.canonical_name && reqTokenSet.has(sk.canonical_name.toLowerCase());
    const surfaceMatches = sk.surface_form && reqTextLower.includes(sk.surface_form.toLowerCase());
    const regEntry = sk.concept_id && registry?.conceptById ? registry.conceptById.get(sk.concept_id) : null;
    const parentMatches = regEntry?.parent_concept_id && targetConceptIds.has(regEntry.parent_concept_id);

    // Targeted matching
    if (conceptMatches || nameMatches || surfaceMatches || parentMatches) {
      matchedSkills.push(sk);
      if (Array.isArray(sk.evidence_ids)) {
        sk.evidence_ids.forEach((id) => matchedEvidenceIds.add(id));
      }
    }
  }

  // If no targeted skill matches, include candidate skills if pool is small (high recall fallback)
  if (matchedSkills.length === 0 && candidateSkills.length <= 10) {
    for (const sk of candidateSkills) {
      matchedSkills.push(sk);
      if (Array.isArray(sk.evidence_ids)) {
        sk.evidence_ids.forEach((id) => matchedEvidenceIds.add(id));
      }
    }
  }

  // 3. Retrieve Candidate Capabilities
  const candidateCaps = Array.isArray(candidateProfile.capabilities) ? candidateProfile.capabilities : [];
  const matchedCapabilities = [];

  for (const cap of candidateCaps) {
    let matches = false;

    // Check skill concept overlap
    if (Array.isArray(cap.skill_concept_ids)) {
      for (const cid of cap.skill_concept_ids) {
        if (targetConceptIds.has(cid)) {
          matches = true;
          break;
        }
      }
    }

    // Check skills_used names
    if (!matches && Array.isArray(cap.skills_used)) {
      for (const s of cap.skills_used) {
        if (reqTokenSet.has(String(s).toLowerCase())) {
          matches = true;
          break;
        }
      }
    }

    // Check activity or object tokens (with stemming / prefix matching)
    if (!matches) {
      const capText = `${cap.activity || ''} ${cap.object || ''} ${cap.description || ''}`.toLowerCase();
      for (const tok of reqTokens) {
        if (tok.length > 2) {
          const stem = tok.slice(0, 4);
          if (capText.includes(tok) || (stem.length >= 4 && capText.includes(stem))) {
            matches = true;
            break;
          }
        }
      }
    }

    if (matches) {
      matchedCapabilities.push(cap);
      if (Array.isArray(cap.evidence_ids)) {
        cap.evidence_ids.forEach((id) => matchedEvidenceIds.add(id));
      }
    }
  }

  // If no targeted capability matches, include candidate capabilities if pool is small (high recall fallback)
  if (matchedCapabilities.length === 0 && candidateCaps.length <= 10) {
    for (const cap of candidateCaps) {
      matchedCapabilities.push(cap);
      if (Array.isArray(cap.evidence_ids)) {
        cap.evidence_ids.forEach((id) => matchedEvidenceIds.add(id));
      }
    }
  }

  // 4. Retrieve Candidate Experiences
  const candidateExps = Array.isArray(candidateProfile.experiences) ? candidateProfile.experiences : [];
  const matchedExperiences = [];

  const isYoeOrExpReq = requirement.type === 'YEARS_EXPERIENCE' ||
    reqTokens.some((t) => YOE_TOKENS.has(t)) ||
    requirement.min_years !== null && requirement.min_years !== undefined ||
    candidateExps.length <= 10;

  for (const exp of candidateExps) {
    let expMatches = false;

    if (isYoeOrExpReq) {
      // For general experience/YOE, all experiences are relevant context
      expMatches = true;
    } else {
      const expText = `${exp.role || ''} ${exp.organization || ''} ${exp.notes || ''}`.toLowerCase();
      for (const tok of reqTokens) {
        if (tok.length > 2 && expText.includes(tok)) {
          expMatches = true;
          break;
        }
      }
    }

    if (expMatches) {
      matchedExperiences.push(exp);
      if (Array.isArray(exp.evidence_ids)) {
        exp.evidence_ids.forEach((id) => matchedEvidenceIds.add(id));
      }
    }
  }

  // If no targeted experience matches, include candidate experiences if pool is small
  if (matchedExperiences.length === 0 && candidateExps.length <= 10) {
    for (const exp of candidateExps) {
      matchedExperiences.push(exp);
      if (Array.isArray(exp.evidence_ids)) {
        exp.evidence_ids.forEach((id) => matchedEvidenceIds.add(id));
      }
    }
  }

  // 5. Retrieve Candidate Education
  const candidateEdu = Array.isArray(candidateProfile.education) ? candidateProfile.education : [];
  const matchedEducation = [];

  const isEduReq = requirement.type === 'EDUCATION' || reqTokens.some((t) => EDUCATION_TOKENS.has(t));
  if (isEduReq) {
    for (const edu of candidateEdu) {
      matchedEducation.push(edu);
      if (Array.isArray(edu.evidence_ids)) {
        edu.evidence_ids.forEach((id) => matchedEvidenceIds.add(id));
      }
    }
  }

  // 6. Retrieve Candidate Certifications
  const candidateCerts = Array.isArray(candidateProfile.certifications) ? candidateProfile.certifications : [];
  const matchedCertifications = [];

  const isCertReq = reqTokens.some((t) => CERTIFICATION_TOKENS.has(t)) ||
    targetConceptIds.size > 0 ||
    reqTextLower.includes('certif');

  for (const cert of candidateCerts) {
    let certMatches = false;
    if (isCertReq) {
      const certText = `${cert.name || ''} ${cert.issuer || ''}`.toLowerCase();
      for (const tok of reqTokens) {
        if (tok.length > 2 && certText.includes(tok)) {
          certMatches = true;
          break;
        }
      }
      if (!certMatches && candidateCerts.length <= 5) {
        // High recall: if small count of certs, include for context
        certMatches = true;
      }
    }

    if (certMatches) {
      matchedCertifications.push(cert);
      if (Array.isArray(cert.evidence_ids)) {
        cert.evidence_ids.forEach((id) => matchedEvidenceIds.add(id));
      }
    }
  }

  // 7. Keyword scan across all candidate atomic evidence for direct lexical hits
  const allCandidateEvidence = Array.isArray(candidateProfile.evidence) ? candidateProfile.evidence : [];
  for (const ev of allCandidateEvidence) {
    if (matchedEvidenceIds.has(ev.evidence_id)) continue;
    const evText = String(ev.verbatim_quote || '').toLowerCase();
    for (const tok of reqTokens) {
      if (tok.length > 3 && evText.includes(tok)) {
        matchedEvidenceIds.add(ev.evidence_id);
        break;
      }
    }
  }

  // 8. Resolve full CandidateEvidence records
  const evidenceMap = new Map();
  for (const ev of allCandidateEvidence) {
    evidenceMap.set(ev.evidence_id, ev);
  }

  const resolvedEvidenceRecords = [];
  for (const evId of matchedEvidenceIds) {
    const record = evidenceMap.get(evId);
    if (record) {
      resolvedEvidenceRecords.push({
        evidence_id: record.evidence_id,
        section: record.section,
        source_file: record.source_file,
        verbatim_quote: record.verbatim_quote,
        evidence_role: record.evidence_role,
        evidence_span: record.evidence_span
      });
    }
  }

  // 9. Bound the candidate bundle to avoid unbounded token inflation
  const boundedSkills = matchedSkills.slice(0, maxPerCat);
  const boundedCaps = matchedCapabilities.slice(0, maxPerCat);
  const boundedExps = matchedExperiences.slice(0, maxPerCat);
  const boundedEdu = matchedEducation.slice(0, maxPerCat);
  const boundedCerts = matchedCertifications.slice(0, maxPerCat);
  const boundedEvRecords = resolvedEvidenceRecords.slice(0, maxPerCat * 2);

  return {
    requirement: {
      requirement_id: String(requirement.requirement_id),
      type: requirement.type,
      importance: requirement.importance,
      description: reqDesc,
      target_concept_id: requirement.target_concept_id || null,
      min_years: requirement.min_years !== undefined ? requirement.min_years : null,
      evidence_quote: requirement.evidence_span?.verbatim_quote || reqDesc
    },
    candidate_bundle: {
      skills: boundedSkills,
      capabilities: boundedCaps,
      experiences: boundedExps,
      education: boundedEdu,
      certifications: boundedCerts,
      legal_eligibility: candidateProfile.legal_eligibility || null,
      verified_yoe: candidateProfile.verified_yoe !== undefined ? candidateProfile.verified_yoe : null,
      verified_yoe_source: candidateProfile.verified_yoe_source || null,
      evidence_records: boundedEvRecords
    },
    retrieval_metadata: {
      retrieved_skills_count: boundedSkills.length,
      retrieved_capabilities_count: boundedCaps.length,
      retrieved_experiences_count: boundedExps.length,
      retrieved_education_count: boundedEdu.length,
      retrieved_certifications_count: boundedCerts.length,
      retrieved_evidence_count: boundedEvRecords.length,
      total_bundle_items: boundedSkills.length + boundedCaps.length + boundedExps.length +
        boundedEdu.length + boundedCerts.length + boundedEvRecords.length
    }
  };
}
