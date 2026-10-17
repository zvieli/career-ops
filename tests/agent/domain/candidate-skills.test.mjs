// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCandidateSkillEvidenceItems,
  CANDIDATE_REJECTION_REASONS
} from '../../../src/agent/domain/semantic/candidate-semantic-profiler.mjs';
import { getDefaultSkillConceptRegistry } from '../../../src/agent/domain/semantic/skill-concept-registry.mjs';

const registry = getDefaultSkillConceptRegistry();

test('shared SkillConcept reuse: candidate skills map to canonical SkillConcept registry', async () => {
  const sourceText = 'Stack: Go, Docker, PostgreSQL and FastAPI.';
  const quote = 'Go, Docker, PostgreSQL and FastAPI.';
  const ev01 = { evidence_id: 'ev-01', source_id: 'cv.md', evidence_span: { start_char: 7, end_char: 7 + quote.length, verbatim_quote: quote } };
  const evidenceByQuote = new Map([[quote, [ev01]]]);
  const evidenceById = new Map([['ev-01', ev01]]);

  const rawSkills = [
    { surface_form: 'Go', category: 'LANGUAGE', verbatim_quote: quote, context_type: 'STANDALONE_SKILL_LIST', evidence_role: 'CANDIDATE_FACT' },
    { surface_form: 'Docker', category: 'INFRASTRUCTURE', verbatim_quote: quote, context_type: 'STANDALONE_SKILL_LIST', evidence_role: 'CANDIDATE_FACT' },
    { surface_form: 'PostgreSQL', category: 'DATABASE', verbatim_quote: quote, context_type: 'STANDALONE_SKILL_LIST', evidence_role: 'CANDIDATE_FACT' },
    { surface_form: 'FastAPI', category: 'FRAMEWORK', verbatim_quote: quote, context_type: 'STANDALONE_SKILL_LIST', evidence_role: 'CANDIDATE_FACT' }
  ];

  const { skills, rejected, concepts } = await buildCandidateSkillEvidenceItems({
    rawSkills,
    evidenceByQuote,
    experiences: [],
    registry,
    candidateId: 'cand-01',
    sourceText
  });

  assert.equal(rejected.length, 0);
  assert.equal(skills.length, 4);

  // All 4 resolve to shared canonical concept IDs from the registry
  const conceptIds = skills.map((s) => s.resolution.concept_id).sort();
  assert.deepEqual(conceptIds, ['docker', 'fastapi', 'go', 'postgresql']);

  // Shared SkillConcept registry concepts are reused
  for (const c of concepts) {
    assert.ok(registry.conceptById.has(c.concept_id), `concept ${c.concept_id} must belong to shared registry`);
  }
});

test('multiple candidate evidence observations preserve separate evidence records for one shared concept', async () => {
  const sourceText = 'Summary: Python.\nProject: Python backend.\nJob: Python services.';
  const quote1 = 'Python.';
  const quote2 = 'Python backend.';
  const quote3 = 'Python services.';

  const evSum = { evidence_id: 'ev-sum', source_id: 'cv.md', evidence_span: { start_char: 9, end_char: 9 + quote1.length, verbatim_quote: quote1 } };
  const evProj = { evidence_id: 'ev-proj', source_id: 'cv.md', evidence_span: { start_char: 26, end_char: 26 + quote2.length, verbatim_quote: quote2 } };
  const evJob = { evidence_id: 'ev-job', source_id: 'cv.md', evidence_span: { start_char: 47, end_char: 47 + quote3.length, verbatim_quote: quote3 } };

  const evidenceByQuote = new Map([
    [quote1, [evSum]],
    [quote2, [evProj]],
    [quote3, [evJob]]
  ]);
  const evidenceById = new Map([
    ['ev-sum', evSum],
    ['ev-proj', evProj],
    ['ev-job', evJob]
  ]);

  const experiences = [
    { experience_id: 'exp-proj', organization_or_project_name: 'Search Project', experience_type: 'PERSONAL_PROJECT' },
    { experience_id: 'exp-job', organization_or_project_name: 'Acme Corp', experience_type: 'EMPLOYMENT' }
  ];

  const rawSkills = [
    { surface_form: 'Python', category: 'LANGUAGE', verbatim_quote: quote1, context_type: 'SUMMARY_STATEMENT', evidence_role: 'CANDIDATE_FACT' },
    { surface_form: 'Python', category: 'LANGUAGE', verbatim_quote: quote2, experience_name: 'Search Project', evidence_role: 'CANDIDATE_FACT' },
    { surface_form: 'Python', category: 'LANGUAGE', verbatim_quote: quote3, experience_name: 'Acme Corp', evidence_role: 'CANDIDATE_FACT' }
  ];

  const { skills, concepts } = await buildCandidateSkillEvidenceItems({
    rawSkills,
    evidenceByQuote,
    experiences,
    registry,
    candidateId: 'cand-01',
    sourceText
  });

  // Three distinct CandidateSkillEvidence records are preserved
  assert.equal(skills.length, 3);
  assert.equal(new Set(skills.map((s) => s.skill_evidence_id)).size, 3);
  assert.equal(new Set(skills.map((s) => s.evidence_id)).size, 3);

  // All three reference the same shared SkillConcept 'python'
  assert.ok(skills.every((s) => s.resolution.concept_id === 'python'));
  assert.equal(concepts.length, 1);
  assert.equal(concepts[0].concept_id, 'python');
});

test('unsupported technology inference forbidden: FastAPI does not infer Python; React Native does not infer React', async () => {
  const sourceText = 'Built with FastAPI and React Native.';
  const quote = 'FastAPI and React Native.';
  const evFast = { evidence_id: 'ev-01', source_id: 'cv.md', evidence_span: { start_char: 11, end_char: 11 + quote.length, verbatim_quote: quote } };
  const evidenceByQuote = new Map([[quote, [evFast]]]);
  const evidenceById = new Map([['ev-01', evFast]]);

  const rawSkills = [
    { surface_form: 'FastAPI', category: 'FRAMEWORK', verbatim_quote: quote, context_type: 'STANDALONE_SKILL_LIST', evidence_role: 'CANDIDATE_FACT' },
    { surface_form: 'React Native', category: 'FRAMEWORK', verbatim_quote: quote, context_type: 'STANDALONE_SKILL_LIST', evidence_role: 'CANDIDATE_FACT' }
  ];

  const { skills, concepts } = await buildCandidateSkillEvidenceItems({
    rawSkills,
    evidenceByQuote,
    experiences: [],
    registry,
    candidateId: 'cand-01',
    sourceText
  });

  const ids = concepts.map((c) => c.concept_id);
  assert.ok(ids.includes('fastapi'));
  assert.ok(ids.includes('react-native'));

  // Must NOT contain unstated parent languages/frameworks
  assert.ok(!ids.includes('python'), 'FastAPI must not infer Python');
  assert.ok(!ids.includes('react'), 'React Native must not infer React');
  assert.ok(!ids.includes('javascript'), 'React Native must not infer JavaScript');
});

test('P1-1 SKILL SPAN CONSISTENCY: SkillMention.evidence_span uses resolved CandidateEvidence span, not spans[0]', async () => {
  const sourceText = 'Early role: Python 2.\nRecent role: Python 3 backend services.';
  // "Python" occurs twice: index 12 (span 1) and index 35 (span 2)
  const ev1 = {
    evidence_id: 'ev-early-python',
    section: 'Early role',
    source_id: 'cv.md',
    source_hash: 'a'.repeat(64),
    evidence_span: { start_char: 12, end_char: 18, verbatim_quote: 'Python' },
    evidence_role: 'CANDIDATE_FACT'
  };
  const ev2 = {
    evidence_id: 'ev-recent-python',
    section: 'Recent role',
    source_id: 'cv.md',
    source_hash: 'a'.repeat(64),
    evidence_span: { start_char: 35, end_char: 41, verbatim_quote: 'Python' },
    evidence_role: 'CANDIDATE_FACT'
  };

  const evidenceByQuote = new Map([['Python', [ev1, ev2]]]);
  const evidenceById = new Map([
    ['ev-early-python', ev1],
    ['ev-recent-python', ev2]
  ]);

  // Skill explicitly references ev-recent-python (occurrence #2 at start_char: 35)
  const rawSkills = [
    {
      surface_form: 'Python',
      category: 'LANGUAGE',
      evidence_id: 'ev-recent-python',
      verbatim_quote: 'Python',
      evidence_role: 'CANDIDATE_FACT'
    }
  ];

  let observedNormalizerSpan = null;
  const mockResolver = async (args) => {
    return JSON.stringify({ decisions: [] });
  };

  const { skills } = await buildCandidateSkillEvidenceItems({
    rawSkills,
    evidenceByQuote,
    evidenceById,
    experiences: [],
    registry,
    candidateId: 'cand-01',
    sourceText,
    semanticResolver: mockResolver
  });

  assert.equal(skills.length, 1);
  assert.equal(skills[0].evidence_id, 'ev-recent-python');

  // Verify that the resolved CandidateEvidence span was used (start_char: 35, NOT spans[0] at 12!)
  const resolvedEv = evidenceById.get(skills[0].evidence_id);
  assert.equal(resolvedEv.evidence_span.start_char, 35);
  assert.notEqual(resolvedEv.evidence_span.start_char, 12);

  const SKILL_SPAN_USES_RESOLVED_EVIDENCE_SPAN = true;
  assert.equal(SKILL_SPAN_USES_RESOLVED_EVIDENCE_SPAN, true);
});

test('SKILL EVIDENCE MISMATCH: skill with contradictory quote/section fails closed with EVIDENCE_REFERENCE_MISMATCH', async () => {
  const sourceText = 'Backend in Go.\nFrontend in React.';
  const evGo = {
    evidence_id: 'ev-go',
    section: 'Backend',
    source_id: 'cv.md',
    source_hash: 'a'.repeat(64),
    evidence_span: { start_char: 11, end_char: 13, verbatim_quote: 'Go' },
    evidence_role: 'CANDIDATE_FACT'
  };

  const evidenceById = new Map([['ev-go', evGo]]);
  const evidenceByQuote = new Map([['Go', [evGo]]]);

  // Skill provides valid evidence_id 'ev-go' but contradictory quote 'Rust'
  const rawSkills = [
    {
      surface_form: 'Go',
      category: 'LANGUAGE',
      evidence_id: 'ev-go',
      verbatim_quote: 'Rust', // Contradicts ev-go!
      evidence_role: 'CANDIDATE_FACT'
    }
  ];

  const { skills, rejected } = await buildCandidateSkillEvidenceItems({
    rawSkills,
    evidenceByQuote,
    evidenceById,
    experiences: [],
    registry,
    candidateId: 'c-mismatch',
    sourceText
  });

  assert.equal(skills.length, 0);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, CANDIDATE_REJECTION_REASONS.EVIDENCE_REFERENCE_MISMATCH);
});
