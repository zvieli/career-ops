// @ts-check
/**
 * deterministic-matching-fake.mjs — Test Fake & Benchmark Synthetic Model Runner
 *
 * Implements a simulated System-1 model runner for offline testing and synthetic benchmarks:
 * - Produces schema-valid RequirementInterpretation + match_proposal.
 * - Simulates language understanding of qualifiers, composites, and boundaries.
 * - Explicitly labeled as TEST_FAKE / BENCHMARK_SYNTHETIC.
 * - NEVER acts as a silent runtime fallback for production/shadow execution.
 */

/**
 * Creates a deterministic test fake model runner.
 *
 * @param {object} [options]
 * @param {string} [options.semanticOrigin='TEST_FAKE']
 * @returns {Function} modelRunner(params)
 */
export function createDeterministicTestFakeRunner(options = {}) {
  const origin = options.semanticOrigin || 'TEST_FAKE';

  const testFakeModelRunner = async function testFakeModelRunner({ prompt, requirement, candidateBundle }) {
    const reqDesc = String(requirement.description || '');
    const reqTextLower = reqDesc.toLowerCase();
    const minYears = requirement.min_years;

    const skills = candidateBundle.skills || [];
    const capabilities = candidateBundle.capabilities || [];
    const experiences = candidateBundle.experiences || [];
    const education = candidateBundle.education || [];
    const certifications = candidateBundle.certifications || [];
    const legal = candidateBundle.legal_eligibility || {};
    const verifiedYoe = candidateBundle.verified_yoe;

    // Build structured RequirementInterpretation
    const interpretation = {
      requirement_id: String(requirement.requirement_id),
      logical_structure: {
        operator: 'SINGLE',
        branches: []
      },
      mandatory_dimensions: [],
      optional_dimensions: [],
      semantic_constraints: {},
      ambiguity: [],
      requirement_provenance: {
        requirement_id: String(requirement.requirement_id),
        verbatim_quote: requirement.evidence_quote || reqDesc
      }
    };

    // Detect logical structure
    const isOr = /\b(or|either|alternatively|או)\b/i.test(reqDesc);
    const isAnd = /\b(and|with|both|\+|וגם)\b/i.test(reqDesc);

    if (isOr) {
      interpretation.logical_structure.operator = 'OR';
    } else if (isAnd) {
      interpretation.logical_structure.operator = 'AND';
    } else {
      interpretation.logical_structure.operator = 'SINGLE';
    }

    // Detect requirement qualifiers (multilingual-safe without ASCII \b limitations)
    const isCertifiedProfessional = /certified\s+professional/i.test(reqDesc);
    const wantsProfessional = !isCertifiedProfessional && (
      /(?:^|\s|[,.;])(professional|employment|מקצועי|בפועל)(?:$|\s|[,.;])/i.test(reqDesc) || reqDesc.includes('מקצועי') || reqDesc.includes('בפועל')
    );
    const wantsProduction = /(?:^|\s|[,.;])(production|פרודקשן|חי)(?:$|\s|[,.;])/i.test(reqDesc) || reqDesc.includes('פרודקשן');
    const wantsLeadership = /(?:^|\s|[,.;])(led|lead|leading|owned|ownership|הובלה|ניהול)(?:$|\s|[,.;])/i.test(reqDesc);
    const wantsDesign = /(?:^|\s|[,.;])(designed|architected|design|architecture|תכנון|ארכיטקטורה)(?:$|\s|[,.;])/i.test(reqDesc);
    const wantsFamiliarity = /(?:^|\s|[,.;])(familiarity|familiar|basic knowledge|exposure|הכרות)(?:$|\s|[,.;])/i.test(reqDesc);

    // Education & Certification qualifiers
    const isEduReq = requirement.type === 'EDUCATION' || /(?:^|\s|[,.;])(degree|bachelor|b\.?sc|master|m\.?sc|ph\.?d|תואר|בוגר)(?:$|\s|[,.;])/i.test(reqDesc) || reqDesc.includes('תואר');
    const isPursuingAllowed = /(?:^|\s|[,.;])(currently pursuing|pursuing|student|in progress|סטודנט|במהלך)(?:$|\s|[,.;])/i.test(reqDesc);
    const hasEquivalentExperience = isOr && (/\bequivalent\b[^.\n]{0,40}\bexperience\b/i.test(reqDesc) || reqDesc.includes('שווה ערך') || reqDesc.includes('מקביל') || reqDesc.includes('ניסיון כמתכנת'));
    const isCertReq = /(?:^|\s|[,.;])(certified|certification|certificate|הסמכה|מוסמך)(?:$|\s|[,.;])/i.test(reqDesc);

    // Build mandatory dimensions
    if (requirement.target_concept_id) {
      interpretation.mandatory_dimensions.push({
        dimension: 'SKILL',
        expected: requirement.target_concept_id,
        expected_concept_ids: [requirement.target_concept_id]
      });
    }

    if (wantsProfessional) {
      interpretation.mandatory_dimensions.push({
        dimension: 'EXPERIENCE_CONTEXT',
        expected: 'PROFESSIONAL_EMPLOYMENT'
      });
    }

    if (wantsProduction) {
      interpretation.mandatory_dimensions.push({
        dimension: 'ENVIRONMENT',
        expected: 'PRODUCTION'
      });
      interpretation.semantic_constraints.environment_required = 'PRODUCTION';
    }

    if (wantsLeadership) {
      interpretation.mandatory_dimensions.push({
        dimension: 'CAPABILITY',
        expected: 'LED'
      });
      interpretation.semantic_constraints.responsibility_required = 'LED';
    }

    if (wantsDesign) {
      interpretation.mandatory_dimensions.push({
        dimension: 'CAPABILITY',
        expected: 'DESIGNED'
      });
      interpretation.semantic_constraints.responsibility_required = 'DESIGNED';
    }

    if (minYears && minYears > 0) {
      interpretation.mandatory_dimensions.push({
        dimension: 'DURATION',
        expected: `${minYears}+ years`,
        minimum_years: minYears
      });
    }

    if (isEduReq) {
      interpretation.mandatory_dimensions.push({
        dimension: 'EDUCATION',
        expected: reqDesc
      });
      interpretation.semantic_constraints.education_completion_required = !isPursuingAllowed;
      interpretation.semantic_constraints.equivalent_experience_allowed = hasEquivalentExperience;
      if (hasEquivalentExperience) {
        interpretation.semantic_constraints.equivalent_experience_domain = 'SOFTWARE_ENGINEERING';
      }
    }

    if (isCertReq) {
      interpretation.mandatory_dimensions.push({
        dimension: 'CERTIFICATION',
        expected: reqDesc
      });
      interpretation.semantic_constraints.certification_required = true;
    }

    // Evaluate candidate support
    const candidateEvidenceIds = new Set();
    const candidateSkillIds = new Set();
    const candidateCapIds = new Set();
    const candidateExpIds = new Set();
    const candidateEduIds = new Set();
    const candidateCertIds = new Set();

    const supportDimensions = {};
    const unresolvedDimensions = [];
    const rationaleSupported = [];
    const rationaleUnsupported = [];

    // --- 1. LEGAL / ELIGIBILITY ---
    if (requirement.type === 'LEGAL_ADMINISTRATIVE' || requirement.type === 'SECURITY_CLEARANCE' || /\b(sponsorship|clearance|citizen|authorized|ויזה|סיווג)\b/i.test(reqDesc)) {
      if (/\b(?:no sponsorship|must not require sponsorship|not require visa sponsorship)\b/i.test(reqDesc)) {
        if (legal.requires_sponsorship === true) {
          candidateBundle.evidence_records.forEach((e) => candidateEvidenceIds.add(e.evidence_id));
          return {
            requirement_interpretation: interpretation,
            match_proposal: {
              relation: 'CONTRADICTS',
              candidate_evidence_ids: [...candidateEvidenceIds],
              candidate_skill_evidence_ids: [],
              candidate_capability_ids: [],
              candidate_experience_ids: [],
              candidate_education_ids: [],
              candidate_certification_ids: [],
              support_dimensions: { domain_support: 'UNSUPPORTED' },
              unresolved_dimensions: ['requires_sponsorship_contradiction'],
              rationale: { supported: [], unsupported: ['Candidate explicitly requires sponsorship conflicting with requirement'] }
            }
          };
        } else if (legal.requires_sponsorship === null || legal.requires_sponsorship === undefined) {
          return {
            requirement_interpretation: interpretation,
            match_proposal: {
              relation: 'NO_EVIDENCE',
              candidate_evidence_ids: [],
              candidate_skill_evidence_ids: [],
              candidate_capability_ids: [],
              candidate_experience_ids: [],
              candidate_education_ids: [],
              candidate_certification_ids: [],
              support_dimensions: { domain_support: 'UNKNOWN' },
              unresolved_dimensions: ['sponsorship_status_unspecified'],
              rationale: { supported: [], unsupported: ['No candidate facts regarding sponsorship requirements'] }
            }
          };
        }
      }
      if (/\b(security clearance|סיווג ביטחוני)\b/i.test(reqDesc)) {
        if (legal.security_clearance === true) {
          candidateBundle.evidence_records.forEach((e) => candidateEvidenceIds.add(e.evidence_id));
          return {
            requirement_interpretation: interpretation,
            match_proposal: {
              relation: 'SATISFIES',
              candidate_evidence_ids: [...candidateEvidenceIds],
              candidate_skill_evidence_ids: [],
              candidate_capability_ids: [],
              candidate_experience_ids: [],
              candidate_education_ids: [],
              candidate_certification_ids: [],
              support_dimensions: { domain_support: 'SUPPORTED' },
              unresolved_dimensions: [],
              rationale: { supported: ['Active security clearance verified'], unsupported: [] }
            }
          };
        } else {
          return {
            requirement_interpretation: interpretation,
            match_proposal: {
              relation: 'NO_EVIDENCE',
              candidate_evidence_ids: [],
              candidate_skill_evidence_ids: [],
              candidate_capability_ids: [],
              candidate_experience_ids: [],
              candidate_education_ids: [],
              candidate_certification_ids: [],
              support_dimensions: { domain_support: 'UNSUPPORTED' },
              unresolved_dimensions: ['security_clearance_unsupported'],
              rationale: { supported: [], unsupported: ['No evidence of security clearance'] }
            }
          };
        }
      }
    }

    // --- 2. EDUCATION ---
    if (isEduReq) {
      // Prefer completed degree if completed is required, otherwise in-progress
      let matchedEdu = null;
      if (!isPursuingAllowed) {
        matchedEdu = education.find((edu) => edu.status === 'COMPLETED' && (edu.degree_level === 'BACHELOR' || edu.degree_level === 'MASTER' || edu.degree_level === 'DOCTORATE' || String(edu.degree || '').toLowerCase().includes('b.sc') || String(edu.degree || '').includes('בוגר') || String(edu.degree || '').includes('תואר')));
      }
      if (!matchedEdu) {
        matchedEdu = education.find((edu) => edu.degree_level === 'BACHELOR' || edu.degree_level === 'MASTER' || edu.degree_level === 'DOCTORATE' || String(edu.degree || '').toLowerCase().includes('b.sc') || String(edu.degree || '').includes('בוגר') || String(edu.degree || '').includes('תואר'));
      }

      // Check equivalent experience branch
      if (hasEquivalentExperience) {
        const professionalExp = experiences.filter((e) => e.experience_type === 'EMPLOYMENT' && (
          String(e.role || '').toLowerCase().includes('engineer') ||
          String(e.role || '').toLowerCase().includes('developer') ||
          String(e.role || '').toLowerCase().includes('software')
        ));

        if (professionalExp.length > 0 && (!matchedEdu || matchedEdu.status !== 'COMPLETED')) {
          professionalExp.forEach((e) => {
            candidateExpIds.add(e.experience_id);
            if (Array.isArray(e.evidence_ids)) e.evidence_ids.forEach((id) => candidateEvidenceIds.add(id));
          });
          return {
            requirement_interpretation: interpretation,
            match_proposal: {
              relation: 'SATISFIES',
              candidate_evidence_ids: [...candidateEvidenceIds],
              candidate_skill_evidence_ids: [],
              candidate_capability_ids: [],
              candidate_experience_ids: [...candidateExpIds],
              candidate_education_ids: [],
              candidate_certification_ids: [],
              support_dimensions: { education_support: 'NOT_APPLICABLE', experience_context_support: 'SUPPORTED' },
              unresolved_dimensions: [],
              rationale: { supported: ['Equivalent professional experience branch satisfied'], unsupported: [] }
            }
          };
        }
      }

      if (!matchedEdu) {
        return {
          requirement_interpretation: interpretation,
          match_proposal: {
            relation: 'NO_EVIDENCE',
            candidate_evidence_ids: [],
            candidate_skill_evidence_ids: [],
            candidate_capability_ids: [],
            candidate_experience_ids: [],
            candidate_education_ids: [],
            candidate_certification_ids: [],
            support_dimensions: { education_support: 'UNSUPPORTED' },
            unresolved_dimensions: ['degree_unsupported'],
            rationale: { supported: [], unsupported: ['No matching candidate education evidence'] }
          }
        };
      }

      candidateEduIds.add(matchedEdu.education_id);
      if (Array.isArray(matchedEdu.evidence_ids)) {
        matchedEdu.evidence_ids.forEach((id) => candidateEvidenceIds.add(id));
      }

      if (matchedEdu.status === 'IN_PROGRESS') {
        if (isPursuingAllowed) {
          return {
            requirement_interpretation: interpretation,
            match_proposal: {
              relation: 'SATISFIES',
              candidate_evidence_ids: [...candidateEvidenceIds],
              candidate_skill_evidence_ids: [],
              candidate_capability_ids: [],
              candidate_experience_ids: [],
              candidate_education_ids: [...candidateEduIds],
              candidate_certification_ids: [],
              support_dimensions: { education_support: 'SUPPORTED' },
              unresolved_dimensions: [],
              rationale: { supported: ['In-progress degree directly satisfies pursuing requirement'], unsupported: [] }
            }
          };
        } else {
          return {
            requirement_interpretation: interpretation,
            match_proposal: {
              relation: 'PARTIALLY_SUPPORTS',
              candidate_evidence_ids: [...candidateEvidenceIds],
              candidate_skill_evidence_ids: [],
              candidate_capability_ids: [],
              candidate_experience_ids: [],
              candidate_education_ids: [...candidateEduIds],
              candidate_certification_ids: [],
              support_dimensions: { education_support: 'PARTIALLY_SUPPORTED' },
              unresolved_dimensions: ['degree_incomplete'],
              rationale: {
                supported: ['Degree enrolled but currently in progress'],
                unsupported: ['Completed degree required; candidate degree is in progress']
              }
            }
          };
        }
      }

      if (matchedEdu.status === 'COMPLETED') {
        return {
          requirement_interpretation: interpretation,
          match_proposal: {
            relation: 'SATISFIES',
            candidate_evidence_ids: [...candidateEvidenceIds],
            candidate_skill_evidence_ids: [],
            candidate_capability_ids: [],
            candidate_experience_ids: [],
            candidate_education_ids: [...candidateEduIds],
            candidate_certification_ids: [],
            support_dimensions: { education_support: 'SUPPORTED' },
            unresolved_dimensions: [],
            rationale: { supported: ['Completed degree verified'], unsupported: [] }
          }
        };
      }
    }

    // --- 3. CERTIFICATIONS ---
    if (isCertReq) {
      // Prefer certified credential over coursework
      let matchedCert = certifications.find((c) => c.is_certified === true);
      if (!matchedCert && certifications.length > 0) {
        matchedCert = certifications[0];
      }

      if (matchedCert) {
        candidateCertIds.add(matchedCert.certification_id);
        if (Array.isArray(matchedCert.evidence_ids)) matchedCert.evidence_ids.forEach((id) => candidateEvidenceIds.add(id));

        if (matchedCert.is_certified === true) {
          return {
            requirement_interpretation: interpretation,
            match_proposal: {
              relation: 'SATISFIES',
              candidate_evidence_ids: [...candidateEvidenceIds],
              candidate_skill_evidence_ids: [],
              candidate_capability_ids: [],
              candidate_experience_ids: [],
              candidate_education_ids: [],
              candidate_certification_ids: [...candidateCertIds],
              support_dimensions: { certification_support: 'SUPPORTED' },
              unresolved_dimensions: [],
              rationale: { supported: [`Verified certification: ${matchedCert.name}`], unsupported: [] }
            }
          };
        } else {
          return {
            requirement_interpretation: interpretation,
            match_proposal: {
              relation: 'RELATED_BUT_INSUFFICIENT',
              candidate_evidence_ids: [...candidateEvidenceIds],
              candidate_skill_evidence_ids: [],
              candidate_capability_ids: [],
              candidate_experience_ids: [],
              candidate_education_ids: [],
              candidate_certification_ids: [...candidateCertIds],
              support_dimensions: { certification_support: 'UNSUPPORTED' },
              unresolved_dimensions: ['certification_unobtained'],
              rationale: {
                supported: ['Completed coursework/training in certification subject'],
                unsupported: ['Official certification credential not obtained']
              }
            }
          };
        }
      } else {
        return {
          requirement_interpretation: interpretation,
          match_proposal: {
            relation: 'NO_EVIDENCE',
            candidate_evidence_ids: [],
            candidate_skill_evidence_ids: [],
            candidate_capability_ids: [],
            candidate_experience_ids: [],
            candidate_education_ids: [],
            candidate_certification_ids: [],
            support_dimensions: { certification_support: 'UNSUPPORTED' },
            unresolved_dimensions: ['certification_missing'],
            rationale: { supported: [], unsupported: ['No matching certification evidence present'] }
          }
        };
      }
    }

    // --- 4. SKILL & CAPABILITY & EXPERIENCE ---
    let skillMatch = null;
    if (requirement.target_concept_id) {
      skillMatch = skills.find((s) => s.concept_id === requirement.target_concept_id);
    }
    if (!skillMatch && skills.length > 0) {
      for (const s of skills) {
        if (s.concept_id && reqTextLower.includes(s.concept_id.toLowerCase())) {
          skillMatch = s;
          break;
        }
        if (s.canonical_name && reqTextLower.includes(s.canonical_name.toLowerCase())) {
          skillMatch = s;
          break;
        }
      }
    }

    // Handle disjunctive OR skills
    if (isOr) {
      const orMatchedSkill = skills.find((s) => s.concept_id && reqTextLower.includes(s.concept_id.toLowerCase()));
      if (orMatchedSkill) {
        candidateSkillIds.add(orMatchedSkill.skill_evidence_id);
        if (Array.isArray(orMatchedSkill.evidence_ids)) orMatchedSkill.evidence_ids.forEach((id) => candidateEvidenceIds.add(id));
        return {
          requirement_interpretation: interpretation,
          match_proposal: {
            relation: 'SATISFIES',
            candidate_evidence_ids: [...candidateEvidenceIds],
            candidate_skill_evidence_ids: [...candidateSkillIds],
            candidate_capability_ids: [],
            candidate_experience_ids: [],
            candidate_education_ids: [],
            candidate_certification_ids: [],
            support_dimensions: { skill_support: 'SUPPORTED' },
            unresolved_dimensions: [],
            rationale: { supported: ['Disjunctive skill branch satisfied'], unsupported: [] }
          }
        };
      }
    }

    // Handle conjunctive AND skills
    if (isAnd && skills.length > 0) {
      const matchedConceptSkills = skills.filter((s) => s.concept_id && reqTextLower.includes(s.concept_id.toLowerCase()));
      if (matchedConceptSkills.length === 1 && /\band\b/i.test(reqDesc)) {
        const singleSk = matchedConceptSkills[0];
        candidateSkillIds.add(singleSk.skill_evidence_id);
        if (Array.isArray(singleSk.evidence_ids)) singleSk.evidence_ids.forEach((id) => candidateEvidenceIds.add(id));
        return {
          requirement_interpretation: interpretation,
          match_proposal: {
            relation: 'PARTIALLY_SUPPORTS',
            candidate_evidence_ids: [...candidateEvidenceIds],
            candidate_skill_evidence_ids: [...candidateSkillIds],
            candidate_capability_ids: [],
            candidate_experience_ids: [],
            candidate_education_ids: [],
            candidate_certification_ids: [],
            support_dimensions: { skill_support: 'PARTIALLY_SUPPORTED' },
            unresolved_dimensions: ['conjunction_dimension_missing'],
            rationale: {
              supported: [`Supported skill: ${singleSk.canonical_name || singleSk.concept_id}`],
              unsupported: ['One or more required conjunctive skill dimensions are missing']
            }
          }
        };
      }
    }

    // Handle related technology mismatch (only when requirement specifically targeted a concept_id)
    if (requirement.target_concept_id && skills.length > 0 && !skillMatch) {
      const anySk = skills[0];
      candidateSkillIds.add(anySk.skill_evidence_id);
      if (Array.isArray(anySk.evidence_ids)) anySk.evidence_ids.forEach((id) => candidateEvidenceIds.add(id));
      return {
        requirement_interpretation: interpretation,
        match_proposal: {
          relation: 'RELATED_BUT_INSUFFICIENT',
          candidate_evidence_ids: [...candidateEvidenceIds],
          candidate_skill_evidence_ids: [...candidateSkillIds],
          candidate_capability_ids: [],
          candidate_experience_ids: [],
          candidate_education_ids: [],
          candidate_certification_ids: [],
          support_dimensions: { skill_support: 'UNSUPPORTED' },
          unresolved_dimensions: ['skill_concept_mismatch'],
          rationale: {
            supported: [`Related technology present: ${anySk.canonical_name || anySk.concept_id}`],
            unsupported: ['Required skill concept is not directly evidenced']
          }
        }
      };
    }

    // Match capabilities via concept IDs, skills used, activity, or object
    const matchedCaps = capabilities.filter((c) => {
      if (skillMatch && Array.isArray(c.skill_concept_ids) && c.skill_concept_ids.includes(skillMatch.concept_id)) return true;
      if (Array.isArray(c.skills_used) && c.skills_used.some((s) => reqTextLower.includes(String(s).toLowerCase()))) return true;
      if (c.activity && reqTextLower.includes(String(c.activity).toLowerCase())) return true;
      if (c.object && (reqTextLower.includes(String(c.object).toLowerCase()) || String(c.object).toLowerCase().split(/\s+/).some((w) => w.length > 3 && reqTextLower.includes(w)))) return true;
      if ((wantsLeadership || wantsDesign) && capabilities.length <= 5) return true;
      return false;
    });

    // Match experiences
    const matchedExps = experiences;

    if (skillMatch) {
      candidateSkillIds.add(skillMatch.skill_evidence_id);
      if (Array.isArray(skillMatch.evidence_ids)) skillMatch.evidence_ids.forEach((id) => candidateEvidenceIds.add(id));
      supportDimensions.skill_support = 'SUPPORTED';
      rationaleSupported.push(`Skill ${skillMatch.canonical_name || skillMatch.concept_id} verified`);
    }

    matchedCaps.forEach((c) => {
      candidateCapIds.add(c.capability_id);
      if (Array.isArray(c.evidence_ids)) c.evidence_ids.forEach((id) => candidateEvidenceIds.add(id));
    });

    matchedExps.forEach((e) => {
      candidateExpIds.add(e.experience_id);
      if (Array.isArray(e.evidence_ids)) e.evidence_ids.forEach((id) => candidateEvidenceIds.add(id));
    });

    if (candidateSkillIds.size === 0 && candidateCapIds.size === 0 && candidateExpIds.size === 0) {
      return {
        requirement_interpretation: interpretation,
        match_proposal: {
          relation: 'NO_EVIDENCE',
          candidate_evidence_ids: [],
          candidate_skill_evidence_ids: [],
          candidate_capability_ids: [],
          candidate_experience_ids: [],
          candidate_education_ids: [],
          candidate_certification_ids: [],
          support_dimensions: { skill_support: 'UNSUPPORTED' },
          unresolved_dimensions: ['requirement_unsupported'],
          rationale: { supported: [], unsupported: ['No candidate evidence matching requirement'] }
        }
      };
    }

    // Check professional context
    const hasEmployment = experiences.some((e) => e.experience_type === 'EMPLOYMENT');
    const onlyProjects = experiences.length > 0 && experiences.every((e) => e.experience_type === 'PERSONAL_PROJECT' || e.experience_type === 'ACADEMIC' || e.experience_type === 'COURSEWORK');

    if (wantsProfessional) {
      if (!hasEmployment || onlyProjects) {
        supportDimensions.experience_context_support = 'UNSUPPORTED';
        unresolvedDimensions.push('PROJECT_EMPLOYMENT_CONFUSION');
        rationaleUnsupported.push('Candidate experience is personal project only, not professional employment');
      } else {
        supportDimensions.experience_context_support = 'SUPPORTED';
        rationaleSupported.push('Professional employment experience verified');
      }
    }

    // Check production environment
    if (wantsProduction) {
      const hasProduction = matchedCaps.some((c) => c.environment_type === 'PRODUCTION');
      const isTestLocal = matchedCaps.length > 0 && matchedCaps.every((c) => c.environment_type === 'TEST_LOCAL' || c.environment_type === 'ACADEMIC_STUDY');
      if (isTestLocal || !hasProduction) {
        supportDimensions.environment_support = 'UNSUPPORTED';
        unresolvedDimensions.push('TEST_PRODUCTION_CONFUSION');
        rationaleUnsupported.push('Deployment capability evidenced in test/local environment only, not production');
      } else {
        supportDimensions.environment_support = 'SUPPORTED';
        rationaleSupported.push('Production deployment capability verified');
      }
    }

    // Check leadership
    if (wantsLeadership) {
      const hasLeadership = matchedCaps.some((c) => c.responsibility_level === 'LED' || c.responsibility_level === 'OWNED');
      if (!hasLeadership) {
        supportDimensions.capability_support = 'UNSUPPORTED';
        unresolvedDimensions.push('CAPABILITY_UNSUPPORTED');
        rationaleUnsupported.push('Candidate evidenced individual contribution, not team leadership or platform ownership');
      } else {
        supportDimensions.capability_support = 'SUPPORTED';
        rationaleSupported.push('Leadership capability verified');
      }
    }

    // Check design
    if (wantsDesign) {
      const hasDesign = matchedCaps.some((c) => c.responsibility_level === 'DESIGNED' || c.responsibility_level === 'OWNED');
      if (!hasDesign) {
        supportDimensions.capability_support = 'UNSUPPORTED';
        unresolvedDimensions.push('CAPABILITY_UNSUPPORTED');
        rationaleUnsupported.push('Candidate evidenced maintenance/implementation, not architectural design');
      } else {
        supportDimensions.capability_support = 'SUPPORTED';
        rationaleSupported.push('Architectural design capability verified');
      }
    }

    // Check duration
    if (minYears && minYears > 0) {
      if (verifiedYoe === null || verifiedYoe === undefined) {
        supportDimensions.duration_support = 'UNKNOWN';
        unresolvedDimensions.push('DURATION_UNVERIFIED');
        rationaleUnsupported.push(`Requirement demands ${minYears}+ years, but candidate verified professional duration is unknown`);
      } else if (verifiedYoe < minYears) {
        supportDimensions.duration_support = 'UNSUPPORTED';
        unresolvedDimensions.push('DURATION_SHORTFALL');
        rationaleUnsupported.push(`Candidate verified YOE (${verifiedYoe}) is less than required (${minYears})`);
      } else {
        supportDimensions.duration_support = 'SUPPORTED';
        rationaleSupported.push(`Verified duration (${verifiedYoe} yrs) satisfies required ${minYears}+ yrs`);
      }
    }

    // Familiarity requirement
    if (wantsFamiliarity) {
      return {
        requirement_interpretation: interpretation,
        match_proposal: {
          relation: 'SATISFIES',
          candidate_evidence_ids: [...candidateEvidenceIds],
          candidate_skill_evidence_ids: [...candidateSkillIds],
          candidate_capability_ids: [...candidateCapIds],
          candidate_experience_ids: [...candidateExpIds],
          candidate_education_ids: [],
          candidate_certification_ids: [],
          support_dimensions: { skill_support: 'SUPPORTED', capability_support: 'SUPPORTED' },
          unresolved_dimensions: [],
          rationale: { supported: ['Familiarity requirement satisfied by candidate exposure/study'], unsupported: [] }
        }
      };
    }

    if (unresolvedDimensions.length > 0) {
      const isRelatedOnly = unresolvedDimensions.includes('CAPABILITY_UNSUPPORTED');
      return {
        requirement_interpretation: interpretation,
        match_proposal: {
          relation: isRelatedOnly ? 'RELATED_BUT_INSUFFICIENT' : 'PARTIALLY_SUPPORTS',
          candidate_evidence_ids: [...candidateEvidenceIds],
          candidate_skill_evidence_ids: [...candidateSkillIds],
          candidate_capability_ids: [...candidateCapIds],
          candidate_experience_ids: [...candidateExpIds],
          candidate_education_ids: [],
          candidate_certification_ids: [],
          support_dimensions: supportDimensions,
          unresolved_dimensions: unresolvedDimensions,
          rationale: {
            supported: rationaleSupported,
            unsupported: rationaleUnsupported
          }
        }
      };
    }

    return {
      requirement_interpretation: interpretation,
      match_proposal: {
        relation: 'SATISFIES',
        candidate_evidence_ids: [...candidateEvidenceIds],
        candidate_skill_evidence_ids: [...candidateSkillIds],
        candidate_capability_ids: [...candidateCapIds],
        candidate_experience_ids: [...candidateExpIds],
        candidate_education_ids: [],
        candidate_certification_ids: [],
        support_dimensions: {
          skill_support: candidateSkillIds.size > 0 ? 'SUPPORTED' : 'NOT_APPLICABLE',
          capability_support: candidateCapIds.size > 0 ? 'SUPPORTED' : 'NOT_APPLICABLE',
          experience_context_support: candidateExpIds.size > 0 ? 'SUPPORTED' : 'NOT_APPLICABLE',
          duration_support: supportDimensions.duration_support || 'NOT_APPLICABLE',
          environment_support: wantsProduction ? 'SUPPORTED' : 'NOT_APPLICABLE'
        },
        unresolved_dimensions: [],
        rationale: {
          supported: rationaleSupported.length > 0 ? rationaleSupported : ['Candidate evidence directly satisfies requirement as stated'],
          unsupported: []
        }
      }
    };
  };

  testFakeModelRunner.semanticOrigin = origin;
  return testFakeModelRunner;
}
