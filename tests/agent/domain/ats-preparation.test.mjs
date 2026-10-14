import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAtsProvider, extractApplicationFormSchema, mapApplicationFields, createPreparationReceipt, assertApplicationScopedArtifact } from '../../../src/agent/domain/applications/ats-preparation.mjs';

test('provider detection is deterministic and refuses untrusted or unsupported hosts', () => {
  assert.equal(detectAtsProvider('https://boards.greenhouse.io/acme/jobs/1').provider, 'GREENHOUSE');
  assert.equal(detectAtsProvider('https://jobs.lever.co/acme/1').provider, 'LEVER');
  assert.equal(detectAtsProvider('https://evil.test', 'greenhouse').status, 'ATS_UNSUPPORTED');
  assert.equal(detectAtsProvider('http://boards.greenhouse.io/acme').status, 'ATS_UNSUPPORTED');
});

test('schema extraction fingerprints normalized fields and preserves unknown widgets as unsupported', () => {
  const schema = extractApplicationFormSchema({ provider: 'GREENHOUSE', sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1', fields: [
    { id: 'email', name: 'email', label: 'Email', type: 'email', required: true },
    { id: 'widget', label: 'Custom widget', type: 'custom-widget', required: true }
  ] });
  assert.equal(schema.fields[0].semantic_type, 'EMAIL');
  assert.equal(schema.fields[1].type, 'UNSUPPORTED');
  assert.equal(schema.fields[0].name, 'email');
  assert.match(schema.schema_hash, /^[a-f0-9]{64}$/);
});

test('mapping requires provenance and fails closed on sensitive, YOE, GPA scale, and custom facts', () => {
  const schema = extractApplicationFormSchema({ provider: 'GREENHOUSE', sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1', fields: [
    { id: 'email', label: 'Email', type: 'email', required: true },
    { id: 'yoe', label: 'Years of professional experience', type: 'text', required: true },
    { id: 'auth', label: 'Are you authorized to work?', type: 'radio', required: true },
    { id: 'gpa', label: 'GPA on a 4.0 scale', type: 'text', required: true },
    { id: 'custom', label: 'Why do you want this job?', type: 'textarea', required: true }
  ] });
  const mapped = mapApplicationFields(schema, { email: 'candidate@example.test', professional_yoe_years: 0, professional_yoe_verified: true, gpa_value: 85, gpa_scale: 'GPA_SCALE_UNKNOWN' });
  assert.deepEqual(mapped.map((item) => item.status), ['READY', 'READY', 'DO_NOT_ANSWER', 'NEEDS_REVIEW', 'NEEDS_REVIEW']);
  assert.equal(mapped[1].proposed_value, '0');
  assert.ok(mapped.every((item) => item.provenance));
  assert.equal(mapped[3].proposed_value, null);
});

test('attestations, incompatible GPA scales, and unmatched choice options never become READY answers', () => {
  const schema = extractApplicationFormSchema({ provider: 'LEVER', sourceUrl: 'https://jobs.lever.co/acme/1', fields: [
    { id: 'attest', label: 'I certify my full name is accurate', type: 'text', required: true },
    { id: 'gpa', label: 'GPA on a 4.0 scale', type: 'text', required: true },
    { id: 'degree', label: 'Degree', type: 'select', required: true, options: [{ value: 'bsc', label: 'BSc' }] },
    { id: 'scale-short', label: 'GPA (4.0)', name: 'gpa_scale', type: 'text', required: true },
    { id: 'consent', label: 'Full name', name: 'consent', type: 'text', required: true }
  ] });
  const mapped = mapApplicationFields(schema, { full_name: 'Jane Smith', gpa_value: 85, gpa_scale: '100-point', degrees: ['B.Sc. Computer Science'], degrees_source: 'cv.md' });
  assert.deepEqual(mapped.map((item) => item.status), ['DO_NOT_ANSWER', 'NEEDS_REVIEW', 'NEEDS_REVIEW', 'NEEDS_REVIEW', 'DO_NOT_ANSWER']);
  assert.equal(mapped[1].proposed_value, null);
  assert.equal(mapped[2].proposed_value, null);
  assert.equal(mapped[3].proposed_value, null);
  assert.equal(mapped[4].proposed_value, null);
  assert.ok(mapped.every((item) => item.provenance));
});

test('preparation receipt is immutable metadata with no submission capability; artifact refs are scoped', () => {
  const schema = extractApplicationFormSchema({ provider: 'LEVER', sourceUrl: 'https://jobs.lever.co/acme/1', fields: [] });
  const receipt = createPreparationReceipt({ applicationId: 'app-111111111111111111111111', provider: 'LEVER', schema, mappings: [], pdfSha256: 'a'.repeat(64), jdHash: 'b'.repeat(64), cvFingerprint: 'c'.repeat(64) });
  assert.equal(receipt.submission_performed, false);
  assert.equal(receipt.submit_capability, false);
  assert.equal(assertApplicationScopedArtifact(`${receipt.application_id}/artifact.pdf`, receipt.application_id), `${receipt.application_id}/artifact.pdf`);
  assert.throws(() => assertApplicationScopedArtifact('../foreign.pdf', receipt.application_id));
});
