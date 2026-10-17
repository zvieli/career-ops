// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateAndEnforceMatchInvariants,
  matchRequirement
} from '../../../src/agent/domain/semantic/requirement-matcher.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const BENCHMARK_SCRIPT = resolve(ROOT, 'scripts/eval-requirement-matching.mjs');
const FIXTURES_PATH = resolve(ROOT, 'evals/fixtures/requirement-matching-adversarial.json');

test('requirement matching benchmark --help prints usage and exits 0', () => {
  const output = execFileSync(process.execPath, [BENCHMARK_SCRIPT, '--help'], { encoding: 'utf8' });
  assert.ok(output.includes('Usage: node scripts/eval-requirement-matching.mjs'));
  assert.ok(output.includes('--strict'));
  assert.ok(output.includes('--json'));
});

test('requirement matching benchmark runs offline in deterministic mode and labels result provisional', () => {
  const output = execFileSync(process.execPath, [BENCHMARK_SCRIPT, '--json'], { encoding: 'utf8' });
  const parsed = JSON.parse(output);
  assert.equal(parsed.benchmark, 'candidate_requirement_matching_adversarial');
  assert.equal(parsed.evaluation_nature, 'PROVISIONAL_SYNTHETIC');
  assert.equal(parsed.sufficient_for_production, false);
  assert.equal(parsed.summary.total_cases >= 30, true);
  assert.equal(parsed.summary.passed_cases, parsed.summary.total_cases);
  assert.equal(parsed.metrics.system.calls_per_requirement, 0); // honest offline zero calls
});

test('MUTATION 1: validator catches forced SATISFIES on project-only professional requirement', () => {
  const requirement = {
    requirement_id: 'req-react-prof',
    description: 'professional React frontend development experience'
  };
  const interpretation = {
    requirement_id: 'req-react-prof',
    logical_structure: { operator: 'SINGLE', branches: [] },
    mandatory_dimensions: [{ dimension: 'EXPERIENCE_CONTEXT', expected: 'PROFESSIONAL_EMPLOYMENT' }]
  };
  const candidateProfile = {
    candidate_id: 'cand-001',
    evidence: [{ evidence_id: 'ev-01', verbatim_quote: 'React project', source_file: 'cv.md' }],
    skills: [{ skill_evidence_id: 'csk-01', concept_id: 'react', canonical_name: 'React', evidence_ids: ['ev-01'] }],
    capabilities: [],
    experiences: [{ experience_id: 'exp-01', experience_type: 'PERSONAL_PROJECT', evidence_ids: ['ev-01'] }],
    education: [],
    certifications: []
  };

  // Faulty model attempts to return SATISFIES with zero unresolved dimensions
  const faultyModelOutput = {
    relation: 'SATISFIES',
    candidate_evidence_ids: ['ev-01'],
    candidate_skill_evidence_ids: ['csk-01'],
    candidate_capability_ids: [],
    candidate_experience_ids: ['exp-01'],
    candidate_education_ids: [],
    candidate_certification_ids: [],
    support_dimensions: { skill_support: 'SUPPORTED', experience_context_support: 'SUPPORTED' },
    unresolved_dimensions: [],
    rationale: { supported: ['ev-01'], unsupported: [] }
  };

  const result = validateAndEnforceMatchInvariants({
    requirement,
    candidateProfile,
    interpretation,
    matchProposal: faultyModelOutput
  });

  assert.notEqual(result.relation, 'SATISFIES', 'Validator must block false SATISFIES');
  assert.equal(result.relation, 'PARTIALLY_SUPPORTS');
  assert.equal(result.support_dimensions.experience_context_support, 'UNSUPPORTED');
  assert.ok(result.unresolved_dimensions.includes('PROJECT_EMPLOYMENT_CONFUSION'));
});

test('MUTATION 2: validator catches forced SATISFIES on test deployment vs production requirement', () => {
  const requirement = {
    requirement_id: 'req-k8s-prod',
    description: 'production Kubernetes deployment experience'
  };
  const interpretation = {
    requirement_id: 'req-k8s-prod',
    logical_structure: { operator: 'SINGLE', branches: [] },
    mandatory_dimensions: [{ dimension: 'ENVIRONMENT', expected: 'PRODUCTION' }],
    semantic_constraints: { environment_required: 'PRODUCTION' }
  };
  const candidateProfile = {
    candidate_id: 'cand-001',
    evidence: [{ evidence_id: 'ev-01', verbatim_quote: 'Minikube', source_file: 'cv.md' }],
    skills: [{ skill_evidence_id: 'csk-01', concept_id: 'kubernetes', canonical_name: 'Kubernetes', evidence_ids: ['ev-01'] }],
    capabilities: [{ capability_id: 'cap-01', activity: 'deployed', object: 'minikube', environment_type: 'TEST_LOCAL', evidence_ids: ['ev-01'] }],
    experiences: [],
    education: [],
    certifications: []
  };

  const faultyModelOutput = {
    relation: 'SATISFIES',
    candidate_evidence_ids: ['ev-01'],
    candidate_skill_evidence_ids: ['csk-01'],
    candidate_capability_ids: ['cap-01'],
    candidate_experience_ids: [],
    candidate_education_ids: [],
    candidate_certification_ids: [],
    support_dimensions: { environment_support: 'SUPPORTED' },
    unresolved_dimensions: [],
    rationale: { supported: ['ev-01'], unsupported: [] }
  };

  const result = validateAndEnforceMatchInvariants({
    requirement,
    candidateProfile,
    interpretation,
    matchProposal: faultyModelOutput
  });

  assert.notEqual(result.relation, 'SATISFIES');
  assert.equal(result.relation, 'PARTIALLY_SUPPORTS');
  assert.equal(result.support_dimensions.environment_support, 'UNSUPPORTED');
  assert.ok(result.unresolved_dimensions.includes('TEST_PRODUCTION_CONFUSION'));
});

test('MUTATION 3: validator catches forced SATISFIES on course vs certification', () => {
  const requirement = {
    requirement_id: 'req-aws-cert',
    description: 'AWS Certified Solutions Architect required'
  };
  const interpretation = {
    requirement_id: 'req-aws-cert',
    logical_structure: { operator: 'SINGLE', branches: [] },
    mandatory_dimensions: [{ dimension: 'CERTIFICATION', expected: 'AWS Certified Solutions Architect' }],
    semantic_constraints: { certification_required: true }
  };
  const candidateProfile = {
    candidate_id: 'cand-001',
    evidence: [{ evidence_id: 'ev-01', verbatim_quote: 'Coursera course', source_file: 'cv.md' }],
    skills: [],
    capabilities: [],
    experiences: [],
    education: [],
    certifications: [{ certification_id: 'cert-course-only', name: 'AWS Course', is_certified: false, evidence_ids: ['ev-01'] }]
  };

  const faultyModelOutput = {
    relation: 'SATISFIES',
    candidate_evidence_ids: ['ev-01'],
    candidate_skill_evidence_ids: [],
    candidate_capability_ids: [],
    candidate_experience_ids: [],
    candidate_education_ids: [],
    candidate_certification_ids: ['cert-course-only'],
    support_dimensions: { certification_support: 'SUPPORTED' },
    unresolved_dimensions: [],
    rationale: { supported: ['ev-01'], unsupported: [] }
  };

  const result = validateAndEnforceMatchInvariants({
    requirement,
    candidateProfile,
    interpretation,
    matchProposal: faultyModelOutput
  });

  assert.notEqual(result.relation, 'SATISFIES');
  assert.equal(result.relation, 'RELATED_BUT_INSUFFICIENT');
  assert.equal(result.support_dimensions.certification_support, 'UNSUPPORTED');
  assert.ok(result.unresolved_dimensions.includes('COURSE_CERTIFICATION_CONFUSION'));
});

test('MUTATION 4: validator catches forced SATISFIES with zero supporting evidence', () => {
  const requirement = {
    requirement_id: 'req-py-01',
    description: 'Python developer'
  };
  const interpretation = {
    requirement_id: 'req-py-01',
    logical_structure: { operator: 'SINGLE', branches: [] },
    mandatory_dimensions: [{ dimension: 'SKILL', expected: 'python' }]
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

  const faultyModelOutput = {
    relation: 'SATISFIES',
    candidate_evidence_ids: [],
    candidate_skill_evidence_ids: [],
    candidate_capability_ids: [],
    candidate_experience_ids: [],
    candidate_education_ids: [],
    candidate_certification_ids: [],
    support_dimensions: { skill_support: 'SUPPORTED' },
    unresolved_dimensions: [],
    rationale: { supported: ['I feel candidate knows python'], unsupported: [] }
  };

  const result = validateAndEnforceMatchInvariants({
    requirement,
    candidateProfile,
    interpretation,
    matchProposal: faultyModelOutput
  });

  assert.notEqual(result.relation, 'SATISFIES');
  assert.equal(result.relation, 'NO_EVIDENCE');
  assert.ok(result.unresolved_dimensions.includes('MISSING_MANDATORY_EVIDENCE'));
});

test('MUTATION 5: validator catches hallucinated candidate references across all categories', () => {
  const requirement = {
    requirement_id: 'req-py-01',
    description: 'Python developer'
  };
  const candidateProfile = {
    candidate_id: 'cand-001',
    evidence: [{ evidence_id: 'ev-real', verbatim_quote: 'Python', source_file: 'cv.md' }],
    skills: [],
    capabilities: [],
    experiences: [],
    education: [],
    certifications: []
  };

  // Model hallucinates an invented certification ID
  const faultyModelOutput = {
    relation: 'SATISFIES',
    candidate_evidence_ids: ['ev-real'],
    candidate_skill_evidence_ids: [],
    candidate_capability_ids: [],
    candidate_experience_ids: [],
    candidate_education_ids: [],
    candidate_certification_ids: ['cert-hallucinated-999'],
    support_dimensions: {},
    unresolved_dimensions: [],
    rationale: { supported: ['ev-real'], unsupported: [] }
  };

  const interpretation = {
    requirement_id: 'req-py-01',
    logical_structure: { operator: 'SINGLE', branches: [] },
    mandatory_dimensions: []
  };

  const result = validateAndEnforceMatchInvariants({
    requirement,
    candidateProfile,
    interpretation,
    matchProposal: faultyModelOutput
  });

  assert.equal(result.relation, 'UNKNOWN');
  assert.ok(result.unresolved_dimensions.includes('DANGLING_OR_INVALID_CANDIDATE_REFERENCE'));
});

test('MUTATION 6: validator catches forced SATISFIES when mandatory dimension is unsupported', () => {
  const requirement = {
    requirement_id: 'req-and-01',
    description: 'Python AND Docker experience required'
  };
  const interpretation = {
    requirement_id: 'req-and-01',
    logical_structure: { operator: 'AND', branches: [] },
    mandatory_dimensions: [{ dimension: 'SKILL', expected: 'Docker' }]
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

  // Model claims SATISFIES even though Docker dimension is unsupported
  const faultyModelOutput = {
    relation: 'SATISFIES',
    candidate_evidence_ids: ['ev-01'],
    candidate_skill_evidence_ids: ['csk-01'],
    candidate_capability_ids: [],
    candidate_experience_ids: [],
    candidate_education_ids: [],
    candidate_certification_ids: [],
    support_dimensions: { skill_support: 'UNSUPPORTED' },
    unresolved_dimensions: [],
    rationale: { supported: ['ev-01'], unsupported: [] }
  };

  const result = validateAndEnforceMatchInvariants({
    requirement,
    candidateProfile,
    interpretation,
    matchProposal: faultyModelOutput
  });

  assert.notEqual(result.relation, 'SATISFIES');
  assert.equal(result.relation, 'PARTIALLY_SUPPORTS');
  assert.ok(result.unresolved_dimensions.includes('SKILL_UNSUPPORTED'));
});

test('MUTATION 7: validator catches CONTRADICTS with no contradictory evidence', () => {
  const requirement = {
    requirement_id: 'req-sponsorship-01',
    description: 'must not require visa sponsorship'
  };
  const candidateProfile = {
    candidate_id: 'cand-001',
    legal_eligibility: { requires_sponsorship: null }, // UNSTATED
    evidence: [],
    skills: [],
    capabilities: [],
    experiences: [],
    education: [],
    certifications: []
  };

  // Model claims CONTRADICTS with zero contradictory evidence
  const faultyModelOutput = {
    relation: 'CONTRADICTS',
    candidate_evidence_ids: [],
    candidate_skill_evidence_ids: [],
    candidate_capability_ids: [],
    candidate_experience_ids: [],
    candidate_education_ids: [],
    candidate_certification_ids: [],
    support_dimensions: {},
    unresolved_dimensions: [],
    rationale: { supported: [], unsupported: ['I assume candidate needs visa'] }
  };

  const interpretation = {
    requirement_id: 'req-sponsorship-01',
    logical_structure: { operator: 'SINGLE', branches: [] },
    mandatory_dimensions: []
  };

  const result = validateAndEnforceMatchInvariants({
    requirement,
    candidateProfile,
    interpretation,
    matchProposal: faultyModelOutput
  });

  assert.notEqual(result.relation, 'CONTRADICTS', 'Absence of evidence cannot yield CONTRADICTS');
  assert.equal(result.relation, 'NO_EVIDENCE');
});

test('REGRESSION TEST 1: interpretation = null with SATISFIES matchProposal fails closed to UNKNOWN', () => {
  const requirement = {
    requirement_id: 'req-sec-01',
    description: '3+ years professional Python experience in production'
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

  const matchProposal = {
    relation: 'SATISFIES',
    candidate_evidence_ids: ['ev-01'],
    candidate_skill_evidence_ids: ['csk-01'],
    candidate_capability_ids: [],
    candidate_experience_ids: [],
    candidate_education_ids: [],
    candidate_certification_ids: [],
    support_dimensions: { skill_support: 'SUPPORTED' },
    unresolved_dimensions: [],
    rationale: { supported: ['ev-01'], unsupported: [] }
  };

  // Explicitly null interpretation with valid supporting IDs
  const result = validateAndEnforceMatchInvariants({
    requirement,
    candidateProfile,
    interpretation: null,
    matchProposal
  });

  assert.equal(result.relation, 'UNKNOWN', 'Must fail closed to UNKNOWN when interpretation is null');
  assert.equal(result.semantic_origin, 'UNKNOWN');
  assert.ok(result.unresolved_dimensions.includes('MISSING_REQUIREMENT_INTERPRETATION'));
});

test('REGRESSION TEST 2: cannot bypass RequirementInterpretation via omitted interpretation or rawMatch', () => {
  const requirement = {
    requirement_id: 'req-sec-02',
    description: '3+ years professional Python experience in production'
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

  // Attempting to pass rawMatch with interpretation omitted
  // @ts-ignore
  const result = validateAndEnforceMatchInvariants({
    requirement,
    candidateProfile,
    // @ts-ignore
    rawMatch: {
      relation: 'SATISFIES',
      candidate_evidence_ids: ['ev-01'],
      candidate_skill_evidence_ids: ['csk-01']
    }
  });

  assert.equal(result.relation, 'UNKNOWN', 'Omitted interpretation must never yield SATISFIES');
  assert.ok(result.unresolved_dimensions.includes('MISSING_REQUIREMENT_INTERPRETATION'));
});

test('MUTATION 8: technology names absent anywhere in repository source still match via generic interpretation', () => {
  const requirement = {
    requirement_id: 'req-future-tech',
    type: 'TECHNICAL_SKILL',
    importance: 'REQUIRED',
    description: 'QuantumFlow 4.0 runtime experience',
    target_concept_id: 'quantum-flow'
  };
  const interpretation = {
    requirement_id: 'req-future-tech',
    logical_structure: { operator: 'SINGLE', branches: [] },
    mandatory_dimensions: [{ dimension: 'SKILL', expected: 'quantum-flow' }]
  };
  const candidateProfile = {
    candidate_id: 'cand-001',
    evidence: [{ evidence_id: 'ev-qf', verbatim_quote: 'QuantumFlow 4.0 production developer', source_file: 'cv.md' }],
    skills: [{ skill_evidence_id: 'csk-qf', concept_id: 'quantum-flow', canonical_name: 'QuantumFlow', evidence_ids: ['ev-qf'] }],
    capabilities: [],
    experiences: [],
    education: [],
    certifications: []
  };

  const validModelOutput = {
    relation: 'SATISFIES',
    candidate_evidence_ids: ['ev-qf'],
    candidate_skill_evidence_ids: ['csk-qf'],
    candidate_capability_ids: [],
    candidate_experience_ids: [],
    candidate_education_ids: [],
    candidate_certification_ids: [],
    support_dimensions: { skill_support: 'SUPPORTED' },
    unresolved_dimensions: [],
    rationale: { supported: ['ev-qf'], unsupported: [] }
  };

  const result = validateAndEnforceMatchInvariants({
    requirement,
    candidateProfile,
    interpretation,
    matchProposal: validModelOutput,
    semanticOrigin: 'TEST_FAKE'
  });

  assert.equal(result.relation, 'SATISFIES', 'Generic matching must succeed without hardcoded technology branches');
  assert.equal(result.semantic_origin, 'TEST_FAKE');
});

test('CLI strict mode exits 1 and names failed case when adversarial expectation is violated', () => {
  const raw = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8'));
  const mutated = raw.map((c) => {
    if (c.id === 'RM-01') {
      return { ...c, expected: { relation: 'NO_EVIDENCE' } };
    }
    return c;
  });

  const tmpPath = resolve(ROOT, 'evals/fixtures/tmp-mutation-cli.json');
  writeFileSync(tmpPath, JSON.stringify(mutated, null, 2), 'utf8');

  try {
    let capturedError = '';
    try {
      execFileSync(process.execPath, [BENCHMARK_SCRIPT, '--strict', '--dataset', 'evals/fixtures/tmp-mutation-cli.json'], {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    } catch (err) {
      capturedError = err.stdout + '\n' + err.stderr;
    }
    assert.ok(capturedError.includes('RM-01'), 'CLI must report specific failed case ID');
    assert.ok(capturedError.includes('Relation mismatch'), 'CLI must report relation mismatch');
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
});
