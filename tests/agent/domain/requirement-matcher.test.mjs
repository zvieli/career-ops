// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchRequirement,
  profileCandidateRequirementMatches,
  validateAndEnforceMatchInvariants
} from '../../../src/agent/domain/semantic/requirement-matcher.mjs';
import { createDeterministicTestFakeRunner } from '../../../src/agent/domain/semantic/test-fakes/deterministic-matching-fake.mjs';

const testFake = createDeterministicTestFakeRunner({ semanticOrigin: 'TEST_FAKE' });

test('MATCH INTEGRITY 1: Explicit skill match with supported evidence satisfies requirement', async () => {
  const requirement = {
    requirement_id: 'req-py-01',
    type: 'TECHNICAL_SKILL',
    importance: 'REQUIRED',
    description: 'Python programming experience',
    target_concept_id: 'python',
    evidence_span: { start_char: 0, end_char: 29, verbatim_quote: 'Python programming experience' }
  };

  const candidateProfile = {
    candidate_id: 'cand-001',
    skills: [
      {
        skill_evidence_id: 'csk-py-1',
        concept_id: 'python',
        canonical_name: 'Python',
        surface_form: 'Python',
        evidence_ids: ['ev-01']
      }
    ],
    capabilities: [
      {
        capability_id: 'cap-01',
        activity: 'developed',
        object: 'web services',
        skills_used: ['Python'],
        skill_concept_ids: ['python'],
        evidence_ids: ['ev-01']
      }
    ],
    experiences: [],
    education: [],
    certifications: [],
    evidence: [
      {
        evidence_id: 'ev-01',
        section: 'Experience',
        source_file: 'cv.md',
        verbatim_quote: 'Developed web services using Python',
        evidence_role: 'CANDIDATE_FACT'
      }
    ]
  };

  const match = await matchRequirement({ requirement, candidateProfile, modelRunner: testFake });
  assert.equal(match.relation, 'SATISFIES');
  assert.equal(match.semantic_origin, 'TEST_FAKE');
  assert.equal(match.candidate_evidence_ids.includes('ev-01'), true);
  assert.equal(match.unresolved_dimensions.length, 0);
  assert.equal(match.provenance.requirement_id, 'req-py-01');
  assert.equal(match.provenance.candidate_evidence_quotes.length > 0, true);
});

test('MATCH INTEGRITY 2: Project experience cannot satisfy professional employment requirement', async () => {
  const requirement = {
    requirement_id: 'req-react-prof',
    type: 'TECHNICAL_SKILL',
    importance: 'REQUIRED',
    description: 'professional React experience',
    target_concept_id: 'react',
    evidence_span: { start_char: 0, end_char: 31, verbatim_quote: 'professional React experience' }
  };

  const candidateProfile = {
    candidate_id: 'cand-001',
    skills: [
      {
        skill_evidence_id: 'csk-react-1',
        concept_id: 'react',
        canonical_name: 'React',
        surface_form: 'React',
        evidence_ids: ['ev-react-proj']
      }
    ],
    capabilities: [
      {
        capability_id: 'cap-react-1',
        activity: 'built',
        object: 'portfolio site',
        skills_used: ['React'],
        skill_concept_ids: ['react'],
        environment_type: 'TEST_LOCAL',
        evidence_ids: ['ev-react-proj']
      }
    ],
    experiences: [
      {
        experience_id: 'exp-proj-1',
        role: 'Creator',
        organization: 'Side Project',
        experience_type: 'PERSONAL_PROJECT', // PROJECT, NOT EMPLOYMENT!
        evidence_ids: ['ev-react-proj']
      }
    ],
    education: [],
    certifications: [],
    evidence: [
      {
        evidence_id: 'ev-react-proj',
        section: 'Projects',
        source_file: 'cv.md',
        verbatim_quote: 'Built portfolio website using React in personal project',
        evidence_role: 'CANDIDATE_FACT'
      }
    ]
  };

  const match = await matchRequirement({ requirement, candidateProfile, modelRunner: testFake });
  assert.notEqual(match.relation, 'SATISFIES', 'Project experience must NEVER satisfy professional employment requirement');
  assert.equal(match.relation, 'PARTIALLY_SUPPORTS');
  assert.equal(match.support_dimensions.experience_context_support, 'UNSUPPORTED');
});

test('MATCH INTEGRITY 3: Local/test deployment cannot satisfy production deployment requirement', async () => {
  const requirement = {
    requirement_id: 'req-k8s-prod',
    type: 'TECHNICAL_SKILL',
    importance: 'REQUIRED',
    description: 'production Kubernetes deployment',
    target_concept_id: 'kubernetes',
    evidence_span: { start_char: 0, end_char: 32, verbatim_quote: 'production Kubernetes deployment' }
  };

  const candidateProfile = {
    candidate_id: 'cand-001',
    skills: [
      {
        skill_evidence_id: 'csk-k8s-1',
        concept_id: 'kubernetes',
        canonical_name: 'Kubernetes',
        surface_form: 'Kubernetes',
        evidence_ids: ['ev-k8s-local']
      }
    ],
    capabilities: [
      {
        capability_id: 'cap-k8s-1',
        activity: 'deployed',
        object: 'minikube',
        skills_used: ['Kubernetes'],
        skill_concept_ids: ['kubernetes'],
        environment_type: 'TEST_LOCAL', // TEST_LOCAL, NOT PRODUCTION!
        evidence_ids: ['ev-k8s-local']
      }
    ],
    experiences: [],
    education: [],
    certifications: [],
    evidence: [
      {
        evidence_id: 'ev-k8s-local',
        section: 'Projects',
        source_file: 'cv.md',
        verbatim_quote: 'Local minikube study',
        evidence_role: 'CANDIDATE_FACT'
      }
    ]
  };

  const match = await matchRequirement({ requirement, candidateProfile, modelRunner: testFake });
  assert.notEqual(match.relation, 'SATISFIES', 'Local deployment must NEVER satisfy production deployment requirement');
  assert.equal(match.relation, 'PARTIALLY_SUPPORTS');
  assert.equal(match.support_dimensions.environment_support, 'UNSUPPORTED');
});

test('MATCH INTEGRITY 4: Course completion cannot satisfy certification requirement', async () => {
  const requirement = {
    requirement_id: 'req-aws-cert',
    type: 'TECHNICAL_SKILL',
    importance: 'REQUIRED',
    description: 'AWS Certified Solutions Architect',
    evidence_span: { start_char: 0, end_char: 33, verbatim_quote: 'AWS Certified Solutions Architect' }
  };

  const candidateProfile = {
    candidate_id: 'cand-001',
    skills: [],
    capabilities: [],
    experiences: [],
    education: [],
    certifications: [
      {
        certification_id: 'cert-aws-course',
        name: 'AWS Course',
        is_certified: false, // COURSEWORK ONLY, NOT CERTIFIED!
        issuer: 'Coursera',
        evidence_ids: ['ev-aws-course']
      }
    ],
    evidence: [
      {
        evidence_id: 'ev-aws-course',
        section: 'Education',
        source_file: 'cv.md',
        verbatim_quote: 'Coursera AWS Solutions Architect Course',
        evidence_role: 'CANDIDATE_FACT'
      }
    ]
  };

  const match = await matchRequirement({ requirement, candidateProfile, modelRunner: testFake });
  assert.notEqual(match.relation, 'SATISFIES', 'Coursework must NEVER satisfy certification requirement');
  assert.equal(match.relation, 'RELATED_BUT_INSUFFICIENT');
  assert.equal(match.support_dimensions.certification_support, 'UNSUPPORTED');
});

test('MATCH INTEGRITY 5: In-progress degree cannot satisfy completed degree requirement', async () => {
  const requirement = {
    requirement_id: 'req-bsc-completed',
    type: 'EDUCATION',
    importance: 'REQUIRED',
    description: 'Completed B.Sc. in Computer Science required',
    evidence_span: { start_char: 0, end_char: 44, verbatim_quote: 'Completed B.Sc. in Computer Science required' }
  };

  const candidateProfile = {
    candidate_id: 'cand-001',
    skills: [],
    capabilities: [],
    experiences: [],
    education: [
      {
        education_id: 'edu-bsc-inprogress',
        degree: 'B.Sc. Computer Science',
        degree_level: 'BACHELOR',
        status: 'IN_PROGRESS', // IN_PROGRESS, NOT COMPLETED!
        field: 'Computer Science',
        institution: 'Technion',
        evidence_ids: ['ev-bsc-inprogress']
      }
    ],
    certifications: [],
    evidence: [
      {
        evidence_id: 'ev-bsc-inprogress',
        section: 'Education',
        source_file: 'cv.md',
        verbatim_quote: 'B.Sc. in CS (expected 2026)',
        evidence_role: 'CANDIDATE_FACT'
      }
    ]
  };

  const match = await matchRequirement({ requirement, candidateProfile, modelRunner: testFake });
  assert.notEqual(match.relation, 'SATISFIES', 'In-progress degree must NEVER satisfy completed degree requirement');
  assert.equal(match.relation, 'PARTIALLY_SUPPORTS');
  assert.equal(match.support_dimensions.education_support, 'PARTIALLY_SUPPORTED');
});

test('MATCH INTEGRITY 6: Unverified YOE cannot satisfy required duration', async () => {
  const requirement = {
    requirement_id: 'req-yoe-5',
    type: 'YEARS_EXPERIENCE',
    importance: 'REQUIRED',
    description: '5 years Go programming experience',
    target_concept_id: 'go',
    min_years: 5,
    evidence_span: { start_char: 0, end_char: 34, verbatim_quote: '5 years Go programming experience' }
  };

  const candidateProfile = {
    candidate_id: 'cand-001',
    verified_yoe: null, // UNVERIFIED DURATION!
    skills: [
      {
        skill_evidence_id: 'csk-go-1',
        concept_id: 'go',
        canonical_name: 'Go',
        surface_form: 'Go',
        evidence_ids: ['ev-go-01']
      }
    ],
    capabilities: [],
    experiences: [],
    education: [],
    certifications: [],
    evidence: [
      {
        evidence_id: 'ev-go-01',
        section: 'Skills',
        source_file: 'cv.md',
        verbatim_quote: 'Built CLI tool with Go',
        evidence_role: 'CANDIDATE_FACT'
      }
    ]
  };

  const match = await matchRequirement({ requirement, candidateProfile, modelRunner: testFake });
  assert.notEqual(match.relation, 'SATISFIES', 'Unverified duration must NEVER satisfy 5+ years requirement');
  assert.equal(match.relation, 'PARTIALLY_SUPPORTS');
  assert.equal(match.support_dimensions.duration_support, 'UNKNOWN');
});

test('MATCH INTEGRITY 7: Reference integrity enforcement rejects hallucinated candidate IDs', () => {
  const requirement = {
    requirement_id: 'req-001',
    type: 'TECHNICAL_SKILL',
    importance: 'REQUIRED',
    description: 'Python experience'
  };

  const candidateProfile = {
    candidate_id: 'cand-001',
    evidence: [{ evidence_id: 'ev-real-1', verbatim_quote: 'Python', source_file: 'cv.md' }],
    skills: [],
    capabilities: [],
    experiences: [],
    education: [],
    certifications: []
  };

  const interpretation = {
    requirement_id: 'req-001',
    logical_structure: { operator: 'SINGLE', branches: [] },
    mandatory_dimensions: [{ dimension: 'SKILL', expected: 'python' }]
  };

  // Model hallucinates an unknown evidence ID
  const hallucinatedModelOutput = {
    relation: 'SATISFIES',
    candidate_evidence_ids: ['ev-hallucinated-999'],
    candidate_skill_evidence_ids: [],
    candidate_capability_ids: [],
    candidate_experience_ids: [],
    candidate_education_ids: [],
    candidate_certification_ids: [],
    support_dimensions: { skill_support: 'SUPPORTED' },
    unresolved_dimensions: [],
    rationale: { supported: ['ev-hallucinated-999'], unsupported: [] }
  };

  const validated = validateAndEnforceMatchInvariants({
    requirement,
    candidateProfile,
    interpretation,
    matchProposal: hallucinatedModelOutput
  });

  assert.equal(validated.relation, 'UNKNOWN', 'Hallucinated candidate reference must fail-closed to UNKNOWN');
  assert.equal(validated.unresolved_dimensions.includes('DANGLING_OR_INVALID_CANDIDATE_REFERENCE'), true);
});

test('MATCH INTEGRITY 8: Empty support references can never yield SATISFIES', () => {
  const requirement = {
    requirement_id: 'req-001',
    type: 'TECHNICAL_SKILL',
    importance: 'REQUIRED',
    description: 'Python experience'
  };

  const candidateProfile = {
    candidate_id: 'cand-001',
    evidence: [],
    skills: [],
    capabilities: [],
    experiences: [],
    education: [],
    certifications: []
  };

  const interpretation = {
    requirement_id: 'req-001',
    logical_structure: { operator: 'SINGLE', branches: [] },
    mandatory_dimensions: [{ dimension: 'SKILL', expected: 'python' }]
  };

  // Model claims SATISFIES with 0 references
  const emptyOutput = {
    relation: 'SATISFIES',
    candidate_evidence_ids: [],
    candidate_skill_evidence_ids: [],
    candidate_capability_ids: [],
    candidate_experience_ids: [],
    candidate_education_ids: [],
    candidate_certification_ids: [],
    support_dimensions: { skill_support: 'SUPPORTED' },
    unresolved_dimensions: [],
    rationale: { supported: ['I think candidate is good'], unsupported: [] }
  };

  const validated = validateAndEnforceMatchInvariants({
    requirement,
    candidateProfile,
    interpretation,
    matchProposal: emptyOutput
  });

  assert.notEqual(validated.relation, 'SATISFIES');
  assert.equal(validated.relation, 'NO_EVIDENCE');
});

test('MATCH INTEGRITY 9: Missing model runner fails closed to UNKNOWN with zero heuristic fallback', async () => {
  const requirement = {
    requirement_id: 'req-001',
    type: 'TECHNICAL_SKILL',
    importance: 'REQUIRED',
    description: 'Python experience'
  };
  const candidateProfile = {
    candidate_id: 'cand-001',
    evidence: [{ evidence_id: 'ev-01', verbatim_quote: 'Python', source_file: 'cv.md' }],
    skills: [{ skill_evidence_id: 'csk-01', concept_id: 'python', canonical_name: 'Python', evidence_ids: ['ev-01'] }],
    capabilities: [],
    experiences: [],
    education: [],
    certifications: []
  };

  // Explicitly call matchRequirement with NO model runner
  const match = await matchRequirement({
    requirement,
    candidateProfile,
    modelRunner: undefined
  });

  assert.equal(match.relation, 'UNKNOWN', 'Model absence must fail-closed to UNKNOWN');
  assert.equal(match.semantic_origin, 'UNKNOWN');
  assert.ok(match.unresolved_dimensions.includes('MODEL_EXECUTION_UNAVAILABLE'));
});

test('MATCH INTEGRITY 10: Model runner exception fails closed to UNKNOWN with MODEL_EXECUTION_FAILED', async () => {
  const requirement = {
    requirement_id: 'req-001',
    type: 'TECHNICAL_SKILL',
    importance: 'REQUIRED',
    description: 'Python experience'
  };
  const candidateProfile = {
    candidate_id: 'cand-001',
    evidence: [{ evidence_id: 'ev-01', verbatim_quote: 'Python', source_file: 'cv.md' }],
    skills: [{ skill_evidence_id: 'csk-01', concept_id: 'python', canonical_name: 'Python', evidence_ids: ['ev-01'] }],
    capabilities: [],
    experiences: [],
    education: [],
    certifications: []
  };

  const throwingRunner = async () => {
    throw new Error('API gateway timeout: 504 Gateway Timeout');
  };

  const match = await matchRequirement({
    requirement,
    candidateProfile,
    modelRunner: throwingRunner
  });

  assert.equal(match.relation, 'UNKNOWN');
  assert.equal(match.semantic_origin, 'UNKNOWN');
  assert.ok(match.unresolved_dimensions.includes('MODEL_EXECUTION_FAILED'));
  assert.ok(match.rationale.unsupported.some((u) => u.includes('504 Gateway Timeout')));
});

test('MATCH PROFILE AGGREGATION: Mechanically derives counts with zero ranking or global score', async () => {
  const jobProfile = {
    job_id: 'job-100',
    requirements: [
      {
        requirement_id: 'req-01',
        type: 'TECHNICAL_SKILL',
        importance: 'REQUIRED',
        description: 'Python',
        target_concept_id: 'python'
      },
      {
        requirement_id: 'req-02',
        type: 'TECHNICAL_SKILL',
        importance: 'REQUIRED',
        description: 'C++',
        target_concept_id: 'cpp'
      }
    ]
  };

  const candidateProfile = {
    candidate_id: 'cand-001',
    skills: [
      {
        skill_evidence_id: 'csk-py-1',
        concept_id: 'python',
        canonical_name: 'Python',
        surface_form: 'Python',
        evidence_ids: ['ev-01']
      }
    ],
    capabilities: [],
    experiences: [],
    education: [],
    certifications: [],
    evidence: [
      {
        evidence_id: 'ev-01',
        section: 'Skills',
        source_file: 'cv.md',
        verbatim_quote: 'Python developer',
        evidence_role: 'CANDIDATE_FACT'
      }
    ]
  };

  const profile = await profileCandidateRequirementMatches({
    jobProfile,
    candidateProfile,
    modelRunner: testFake
  });

  assert.equal(profile.job_id, 'job-100');
  assert.equal(profile.candidate_id, 'cand-001');
  assert.equal(profile.requirement_matches.length, 2);

  // Summary counts
  assert.equal(profile.descriptive_summary.requirements_total, 2);
  assert.equal(profile.descriptive_summary.satisfies, 1);
  assert.equal(profile.descriptive_summary.related_but_insufficient, 1);
  assert.equal(profile.descriptive_summary.required_satisfied_count, 1);

  // Verify anti-ranking policy
  assert.equal('overall_match_score' in profile, false);
  assert.equal('match_percentage' in profile, false);
  assert.equal('rank' in profile, false);
});
