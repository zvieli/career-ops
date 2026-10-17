// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieveCandidateEvidenceForRequirement } from '../../../src/agent/domain/semantic/candidate-evidence-retriever.mjs';

test('retrieveCandidateEvidenceForRequirement retrieves skills and capabilities by target_concept_id', () => {
  const requirement = {
    requirement_id: 'req-python-01',
    type: 'TECHNICAL_SKILL',
    importance: 'REQUIRED',
    description: '3+ years of Python backend development experience',
    target_concept_id: 'python',
    min_years: 3,
    evidence_span: {
      start_char: 0,
      end_char: 45,
      verbatim_quote: '3+ years of Python backend development experience'
    }
  };

  const candidateProfile = {
    candidate_id: 'cand-001',
    verified_yoe: 4,
    skills: [
      {
        skill_evidence_id: 'csk-py-1',
        concept_id: 'python',
        canonical_name: 'Python',
        surface_form: 'Python',
        evidence_ids: ['ev-01']
      },
      {
        skill_evidence_id: 'csk-ts-1',
        concept_id: 'typescript',
        canonical_name: 'TypeScript',
        surface_form: 'TypeScript',
        evidence_ids: ['ev-02']
      }
    ],
    capabilities: [
      {
        capability_id: 'cap-py-1',
        activity: 'developed',
        object: 'backend REST APIs',
        skills_used: ['Python'],
        skill_concept_ids: ['python'],
        evidence_ids: ['ev-01']
      }
    ],
    experiences: [
      {
        experience_id: 'exp-01',
        role: 'Senior Python Engineer',
        organization: 'Acme Corp',
        experience_type: 'EMPLOYMENT',
        evidence_ids: ['ev-01']
      }
    ],
    education: [],
    certifications: [],
    evidence: [
      {
        evidence_id: 'ev-01',
        section: 'Experience',
        source_file: 'cv.md',
        verbatim_quote: 'Developed backend REST APIs in Python at Acme Corp',
        evidence_role: 'CANDIDATE_FACT'
      },
      {
        evidence_id: 'ev-02',
        section: 'Skills',
        source_file: 'cv.md',
        verbatim_quote: 'Proficient in TypeScript',
        evidence_role: 'CANDIDATE_FACT'
      }
    ]
  };

  const bundle = retrieveCandidateEvidenceForRequirement({ requirement, candidateProfile });
  assert.equal(bundle.candidate_bundle.skills.length, 1);
  assert.equal(bundle.candidate_bundle.skills[0].concept_id, 'python');
  assert.equal(bundle.candidate_bundle.capabilities.length, 1);
  assert.equal(bundle.candidate_bundle.capabilities[0].capability_id, 'cap-py-1');
  assert.equal(bundle.candidate_bundle.experiences.length, 1);
  assert.equal(bundle.candidate_bundle.evidence_records.length, 1);
  assert.equal(bundle.candidate_bundle.evidence_records[0].evidence_id, 'ev-01');
});

test('retrieveCandidateEvidenceForRequirement retrieves education and certifications when requested', () => {
  const eduReq = {
    requirement_id: 'req-edu-01',
    type: 'EDUCATION',
    importance: 'REQUIRED',
    description: 'B.Sc. in Computer Science or equivalent',
    target_concept_id: null
  };

  const candidateProfile = {
    candidate_id: 'cand-001',
    skills: [],
    capabilities: [],
    experiences: [],
    education: [
      {
        degree: 'B.Sc. Computer Science',
        degree_level: 'BACHELOR',
        status: 'COMPLETED',
        field: 'Computer Science',
        institution: 'Technion',
        evidence_ids: ['ev-edu-1']
      }
    ],
    certifications: [
      {
        name: 'AWS Certified Solutions Architect',
        is_certified: true,
        evidence_ids: ['ev-cert-1']
      }
    ],
    evidence: [
      {
        evidence_id: 'ev-edu-1',
        section: 'Education',
        source_file: 'cv.md',
        verbatim_quote: 'B.Sc. Computer Science, Technion (2020-2024)',
        evidence_role: 'CANDIDATE_FACT'
      },
      {
        evidence_id: 'ev-cert-1',
        section: 'Certifications',
        source_file: 'cv.md',
        verbatim_quote: 'AWS Certified Solutions Architect (2023)',
        evidence_role: 'CANDIDATE_FACT'
      }
    ]
  };

  const bundle = retrieveCandidateEvidenceForRequirement({ requirement: eduReq, candidateProfile });
  assert.equal(bundle.candidate_bundle.education.length, 1);
  assert.equal(bundle.candidate_bundle.education[0].degree, 'B.Sc. Computer Science');
  assert.equal(bundle.candidate_bundle.evidence_records.some((e) => e.evidence_id === 'ev-edu-1'), true);
});

test('retrieveCandidateEvidenceForRequirement fails closed on invalid inputs', () => {
  assert.throws(() => {
    // @ts-ignore
    retrieveCandidateEvidenceForRequirement({ requirement: null, candidateProfile: {} });
  }, TypeError);

  assert.throws(() => {
    // @ts-ignore
    retrieveCandidateEvidenceForRequirement({ requirement: {}, candidateProfile: null });
  }, TypeError);
});
