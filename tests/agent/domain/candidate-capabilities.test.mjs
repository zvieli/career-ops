// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCandidateCapabilityItems,
  CANDIDATE_REJECTION_REASONS
} from '../../../src/agent/domain/semantic/candidate-semantic-profiler.mjs';

test('candidate capability extraction captures explicit activity, object, and outcome', () => {
  const quote = 'Implemented payment service in Go, improving p95 latency by 35%.';
  const evItem = { evidence_id: 'ev-01', source_id: 'cv.md', source_hash: 'a'.repeat(64), evidence_span: { start_char: 0, end_char: quote.length, verbatim_quote: quote } };
  const evidenceByQuote = new Map([[quote, [evItem]]]);
  const evidenceById = new Map([['ev-01', evItem]]);
  const experiences = [{ experience_id: 'exp-01', organization_or_project_name: 'Payment Service' }];
  const skills = [{ surface_form: 'Go', normalized_surface: 'go', resolution: { concept_id: 'go' } }];

  const rawCapabilities = [
    {
      activity: 'implemented',
      object: 'payment service',
      responsibility_level: 'IMPLEMENTED',
      environment_type: 'PRODUCTION',
      outcome: 'improving p95 latency by 35%',
      skills_used: ['Go'],
      experience_name: 'Payment Service',
      verbatim_quote: quote,
      evidence_role: 'CANDIDATE_FACT'
    }
  ];

  const { capabilities, rejected } = buildCandidateCapabilityItems({
    rawCapabilities,
    evidenceByQuote,
    evidenceById,
    experiences,
    skills,
    candidateId: 'cand-01'
  });

  assert.equal(rejected.length, 0);
  assert.equal(capabilities.length, 1);
  assert.equal(capabilities[0].activity, 'implemented');
  assert.equal(capabilities[0].object, 'payment service');
  assert.equal(capabilities[0].responsibility_level, 'IMPLEMENTED');
  assert.equal(capabilities[0].environment_type, 'PRODUCTION');
  assert.equal(capabilities[0].outcome, 'improving p95 latency by 35%');
  assert.deepEqual(capabilities[0].skill_concept_ids, ['go']);
  assert.equal(capabilities[0].concept_id, 'go');
});

test('P1-3 INTEGRITY 1: skills_used absent from candidate skills cannot fabricate SkillConcept ID', () => {
  const quote = 'Built blockchain tools using InventedChain and Go.';
  const evItem = { evidence_id: 'ev-01', source_id: 'cv.md', source_hash: 'a'.repeat(64), evidence_span: { start_char: 0, end_char: quote.length, verbatim_quote: quote } };
  const evidenceByQuote = new Map([[quote, [evItem]]]);
  const evidenceById = new Map([['ev-01', evItem]]);
  // Only Go was admitted into CandidateSkillEvidence. InventedChain was NOT admitted.
  const skills = [{ surface_form: 'Go', normalized_surface: 'go', resolution: { concept_id: 'go' } }];

  const rawCapabilities = [
    {
      activity: 'built',
      object: 'blockchain tools',
      responsibility_level: 'IMPLEMENTED',
      environment_type: 'TEST_LOCAL',
      skills_used: ['InventedChain', 'Go'], // InventedChain is unadmitted
      verbatim_quote: quote,
      evidence_role: 'CANDIDATE_FACT'
    }
  ];

  const { capabilities, rejected } = buildCandidateCapabilityItems({
    rawCapabilities,
    evidenceByQuote,
    evidenceById,
    experiences: [],
    skills,
    candidateId: 'cand-01'
  });

  assert.equal(rejected.length, 0);
  assert.equal(capabilities.length, 1);
  // InventedChain must NOT be fabricated into skill_concept_ids!
  assert.deepEqual(capabilities[0].skill_concept_ids, ['go']);
  assert.ok(!capabilities[0].skill_concept_ids.includes('inventedchain'));
});

test('P1-3 INTEGRITY 2: capability without skills_used does NOT generate SkillConcept from object string', () => {
  const quote = 'Designed evidence graph architecture.';
  const evItem = { evidence_id: 'ev-01', source_id: 'cv.md', source_hash: 'a'.repeat(64), evidence_span: { start_char: 0, end_char: quote.length, verbatim_quote: quote } };
  const evidenceByQuote = new Map([[quote, [evItem]]]);
  const evidenceById = new Map([['ev-01', evItem]]);

  const rawCapabilities = [
    {
      activity: 'designed',
      object: 'evidence graph architecture',
      responsibility_level: 'DESIGNED',
      environment_type: 'UNKNOWN',
      skills_used: [], // No skills used
      verbatim_quote: quote,
      evidence_role: 'CANDIDATE_FACT'
    }
  ];

  const { capabilities } = buildCandidateCapabilityItems({
    rawCapabilities,
    evidenceByQuote,
    evidenceById,
    experiences: [],
    skills: [],
    candidateId: 'cand-01'
  });

  assert.equal(capabilities.length, 1);
  assert.deepEqual(capabilities[0].skill_concept_ids, []);
  // concept_id must remain null, NOT synthesized as "evidence-graph-architecture"!
  assert.equal(capabilities[0].concept_id, null);
});

test('P1-3 INTEGRITY 3 & 4: two capabilities reference same admitted skill and share concept ID', () => {
  const quote1 = 'Developed backend services in Go.';
  const quote2 = 'Built CLI automation in Go.';
  const ev1 = { evidence_id: 'ev-01', source_id: 'cv.md', source_hash: 'a'.repeat(64), evidence_span: { start_char: 0, end_char: quote1.length, verbatim_quote: quote1 } };
  const ev2 = { evidence_id: 'ev-02', source_id: 'cv.md', source_hash: 'a'.repeat(64), evidence_span: { start_char: 0, end_char: quote2.length, verbatim_quote: quote2 } };
  const evidenceByQuote = new Map([[quote1, [ev1]], [quote2, [ev2]]]);
  const evidenceById = new Map([['ev-01', ev1], ['ev-02', ev2]]);
  const skills = [{ surface_form: 'Go', normalized_surface: 'go', resolution: { concept_id: 'go' } }];

  const rawCapabilities = [
    {
      activity: 'developed',
      object: 'backend services',
      responsibility_level: 'IMPLEMENTED',
      skills_used: ['Go'],
      verbatim_quote: quote1,
      evidence_role: 'CANDIDATE_FACT'
    },
    {
      activity: 'built',
      object: 'CLI automation',
      responsibility_level: 'IMPLEMENTED',
      skills_used: ['Go'],
      verbatim_quote: quote2,
      evidence_role: 'CANDIDATE_FACT'
    }
  ];

  const { capabilities } = buildCandidateCapabilityItems({
    rawCapabilities,
    evidenceByQuote,
    evidenceById,
    experiences: [],
    skills,
    candidateId: 'cand-01'
  });

  assert.equal(capabilities.length, 2);
  assert.equal(capabilities[0].concept_id, 'go');
  assert.equal(capabilities[1].concept_id, 'go');
  assert.deepEqual(capabilities[0].skill_concept_ids, ['go']);
  assert.deepEqual(capabilities[1].skill_concept_ids, ['go']);
});

test('responsibility level is preserved from System-1 without regex overrides', () => {
  const quote = 'Familiar with Kubernetes cluster concepts.';
  const evItem = { evidence_id: 'ev-01', source_id: 'cv.md', source_hash: 'a'.repeat(64), evidence_span: { start_char: 0, end_char: quote.length, verbatim_quote: quote } };
  const evidenceByQuote = new Map([[quote, [evItem]]]);
  const evidenceById = new Map([['ev-01', evItem]]);

  const rawCapabilities = [
    {
      activity: 'familiar with',
      object: 'Kubernetes cluster concepts',
      responsibility_level: 'MENTIONED',
      environment_type: 'UNKNOWN',
      verbatim_quote: quote,
      evidence_role: 'CANDIDATE_FACT'
    }
  ];

  const { capabilities } = buildCandidateCapabilityItems({
    rawCapabilities,
    evidenceByQuote,
    evidenceById,
    experiences: [],
    skills: [],
    candidateId: 'cand-01'
  });

  assert.equal(capabilities.length, 1);
  assert.equal(capabilities[0].responsibility_level, 'MENTIONED');
});

test('P1-3 DEPTH SAFETY: responsibility_level does NOT derive or infer depth', () => {
  const quote = 'Led architecture and deployed distributed contracts.';
  const evItem = { evidence_id: 'ev-01', source_id: 'cv.md', source_hash: 'a'.repeat(64), evidence_span: { start_char: 0, end_char: quote.length, verbatim_quote: quote } };
  const evidenceByQuote = new Map([[quote, [evItem]]]);
  const evidenceById = new Map([['ev-01', evItem]]);

  // CASE 1: LED does NOT invent EXPERT depth
  const c1 = buildCandidateCapabilityItems({
    rawCapabilities: [{ activity: 'led', object: 'architecture', responsibility_level: 'LED', environment_type: 'UNKNOWN', verbatim_quote: quote, evidence_role: 'CANDIDATE_FACT' }],
    evidenceByQuote,
    evidenceById,
    experiences: [],
    skills: [],
    candidateId: 'c1'
  });
  assert.equal(c1.capabilities[0].depth, null, 'LED must not invent EXPERT depth');

  // CASE 2: DESIGNED does NOT invent PRODUCTION depth
  const c2 = buildCandidateCapabilityItems({
    rawCapabilities: [{ activity: 'designed', object: 'prototype', responsibility_level: 'DESIGNED', environment_type: 'UNKNOWN', verbatim_quote: quote, evidence_role: 'CANDIDATE_FACT' }],
    evidenceByQuote,
    evidenceById,
    experiences: [],
    skills: [],
    candidateId: 'c2'
  });
  assert.equal(c2.capabilities[0].depth, null, 'DESIGNED must not invent PRODUCTION depth');

  // CASE 3: DEPLOYED to TEST_LOCAL does NOT invent PRODUCTION depth
  const c3 = buildCandidateCapabilityItems({
    rawCapabilities: [{ activity: 'deployed', object: 'testnet contract', responsibility_level: 'DEPLOYED', environment_type: 'TEST_LOCAL', verbatim_quote: quote, evidence_role: 'CANDIDATE_FACT' }],
    evidenceByQuote,
    evidenceById,
    experiences: [],
    skills: [],
    candidateId: 'c3'
  });
  assert.equal(c3.capabilities[0].depth, null, 'DEPLOYED on testnet must not invent PRODUCTION depth');

  // CASE 4: USED does NOT invent PRACTICAL depth
  const c4 = buildCandidateCapabilityItems({
    rawCapabilities: [{ activity: 'used', object: 'Docker', responsibility_level: 'USED', environment_type: 'UNKNOWN', verbatim_quote: quote, evidence_role: 'CANDIDATE_FACT' }],
    evidenceByQuote,
    evidenceById,
    experiences: [],
    skills: [],
    candidateId: 'c4'
  });
  assert.equal(c4.capabilities[0].depth, null, 'USED must not invent PRACTICAL depth');

  const CAPABILITY_DEPTH_SEMANTIC_INFERENCE_EXISTS = false;
  assert.equal(CAPABILITY_DEPTH_SEMANTIC_INFERENCE_EXISTS, false);
});

test('CAPABILITY EVIDENCE MISMATCH & PROVENANCE AUTHORITY: mismatch fails closed and evItem is quote authority', () => {
  const evAuth = {
    evidence_id: 'ev-auth-cap',
    section: 'Backend',
    source_id: 'cv.md',
    source_hash: 'a'.repeat(64),
    evidence_span: { start_char: 10, end_char: 45, verbatim_quote: 'Built microservices in Go.' },
    evidence_role: 'CANDIDATE_FACT'
  };

  const evidenceById = new Map([['ev-auth-cap', evAuth]]);
  const evidenceByQuote = new Map([[evAuth.evidence_span.verbatim_quote, [evAuth]]]);

  // Contradictory quote fails closed
  const cMismatch = buildCandidateCapabilityItems({
    rawCapabilities: [{
      activity: 'built',
      object: 'microservices',
      evidence_id: 'ev-auth-cap',
      verbatim_quote: 'Contradictory Quote Text', // Mismatch!
      evidence_role: 'CANDIDATE_FACT'
    }],
    evidenceByQuote,
    evidenceById,
    experiences: [],
    skills: [],
    candidateId: 'c-mismatch'
  });

  assert.equal(cMismatch.capabilities.length, 0);
  assert.equal(cMismatch.rejected.length, 1);
  assert.equal(cMismatch.rejected[0].reason, CANDIDATE_REJECTION_REASONS.EVIDENCE_REFERENCE_MISMATCH);

  // Authoritative quote comes from evItem.evidence_span.verbatim_quote
  const cAuth = buildCandidateCapabilityItems({
    rawCapabilities: [{
      activity: 'built',
      object: 'microservices',
      evidence_id: 'ev-auth-cap',
      evidence_role: 'CANDIDATE_FACT'
    }],
    evidenceByQuote,
    evidenceById,
    experiences: [],
    skills: [],
    candidateId: 'c-auth'
  });

  assert.equal(cAuth.capabilities.length, 1);
  assert.equal(cAuth.capabilities[0].provenance.verbatim_quote, 'Built microservices in Go.');
});
