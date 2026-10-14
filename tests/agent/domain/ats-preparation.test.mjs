import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ATS_PROVIDER_CAPABILITIES, detectAtsProvider, extractApplicationFormSchema, mapApplicationFields, createPreparationReceipt, assertApplicationScopedArtifact, semanticTypeFor } from '../../../src/agent/domain/applications/ats-preparation.mjs';

test('provider detection separates recognized hosts, fixture coverage, and live extraction capability', () => {
  assert.equal(detectAtsProvider('https://boards.greenhouse.io/acme/jobs/1').status, 'HOST_RECOGNIZED');
  assert.equal(detectAtsProvider('https://boards.greenhouse.io/acme/jobs/1').provider, 'GREENHOUSE');
  assert.equal(detectAtsProvider('https://jobs.lever.co/acme/1').provider, 'LEVER');
  assert.deepEqual(Object.keys(ATS_PROVIDER_CAPABILITIES).sort(), ['ASHBY', 'GREENHOUSE', 'LEVER', 'SMARTRECRUITERS', 'WORKABLE']);
  assert.equal(Object.values(ATS_PROVIDER_CAPABILITIES).every((capability) => capability.liveExtractionSupported === false), true);
  assert.equal(ATS_PROVIDER_CAPABILITIES.GREENHOUSE.fixtureTested, true);
  assert.equal(ATS_PROVIDER_CAPABILITIES.LEVER.fixtureTested, true);
  assert.equal(ATS_PROVIDER_CAPABILITIES.ASHBY.fixtureTested, false);
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

test('provider in schema input must match the trusted source URL', () => {
  assert.throws(() => extractApplicationFormSchema({ provider: 'GREENHOUSE', sourceUrl: 'https://jobs.lever.co/acme/1', fields: [] }), /provider.*URL/i);
});

test('semantic types separate authorization from sponsorship; graduation year maps only from explicit evidence', () => {
  assert.equal(semanticTypeFor('Are you legally authorized to work?'), 'WORK_AUTHORIZATION');
  assert.equal(semanticTypeFor('Will you require visa sponsorship?'), 'VISA_SPONSORSHIP');
  assert.equal(semanticTypeFor('Are you authorized to work without sponsorship?'), 'CUSTOM_QUESTION');
  const schema = extractApplicationFormSchema({ provider: 'GREENHOUSE', sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1', fields: [
    { id: 'auth', label: 'Are you authorized to work?', type: 'radio', required: true },
    { id: 'sponsor', label: 'Will you require visa sponsorship?', type: 'radio', required: true },
    { id: 'year', label: 'Graduation year', type: 'text', required: true },
    { id: 'missing-year', label: 'Year graduated', type: 'text', required: true },
    { id: 'compound-legal', label: 'Are you authorized to work without visa sponsorship?', type: 'text', required: true },
    { id: 'school', label: 'University / school', type: 'text', required: true },
    { id: 'python-years', label: 'Years of experience with Python', type: 'text', required: true }
  ] });
  const mapped = mapApplicationFields(schema, {
    work_authorization: 'unknown', graduation_year: 2026, graduation_year_source: 'cv.md:Education',
    degrees: ['B.Sc.'], degrees_source: 'cv.md:Education', professional_yoe_years: 10,
    professional_yoe_verified: true, professional_years: 10,
    professional_years_source: 'config/profile.yml:candidate.professional_yoe_years'
  });
  assert.deepEqual(mapped.map((item) => item.status), ['DO_NOT_ANSWER', 'DO_NOT_ANSWER', 'READY', 'READY', 'DO_NOT_ANSWER', 'NEEDS_REVIEW', 'NEEDS_REVIEW']);
  assert.equal(mapped[2].proposed_value, '2026');
  assert.equal(mapped[2].provenance.source, 'cv.md:Education');
  assert.equal(mapped[3].proposed_value, '2026');
  assert.equal(mapped[5].semantic_type, 'EDUCATIONAL_INSTITUTION');
  assert.equal(mapped[6].semantic_type, 'SPECIFIC_EXPERIENCE_YEARS');
});

test('education semantics keep degree, institution, field of study, and generic education distinct', () => {
  assert.equal(semanticTypeFor('Degree'), 'DEGREE');
  assert.equal(semanticTypeFor('University / school'), 'EDUCATIONAL_INSTITUTION');
  for (const label of ['Field of study', 'Major', 'Department', 'Concentration']) assert.equal(semanticTypeFor(label), 'FIELD_OF_STUDY');
  assert.equal(semanticTypeFor('Education'), 'EDUCATION');
  assert.equal(semanticTypeFor('Degree and field of study'), 'CUSTOM_QUESTION');
  const schema = extractApplicationFormSchema({ provider: 'GREENHOUSE', sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1', fields: [
    { id: 'degree', name: 'degree', label: 'Degree', type: 'text', required: true, group_label: 'Education' },
    { id: 'major', name: 'major', label: 'Field of study', type: 'text', required: true, group_label: 'Education' },
    { id: 'school', name: 'school', label: 'University / school', type: 'text', required: true, group_label: 'Education' },
    { id: 'education', name: 'education', label: 'Education', type: 'text', required: true }
  ] });
  assert.deepEqual(schema.fields.map((field) => field.group_label), ['Education', 'Education', 'Education', '']);
  const mapped = mapApplicationFields(schema, { degrees: ['B.Sc. Computer Science'], degrees_source: 'cv.md:Education' });
  assert.deepEqual(mapped.map((item) => item.status), ['READY', 'NEEDS_REVIEW', 'NEEDS_REVIEW', 'NEEDS_REVIEW']);
  assert.deepEqual(mapped.slice(1).map((item) => item.proposed_value), [null, null, null]);
});

test('parenthetical experience specialization cannot map verified total professional YOE', () => {
  assert.equal(semanticTypeFor('Years of professional experience'), 'YEARS_EXPERIENCE');
  assert.equal(semanticTypeFor('Years of experience (Python)'), 'SPECIFIC_EXPERIENCE_YEARS');
  const schema = extractApplicationFormSchema({ provider: 'GREENHOUSE', sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1', fields: [
    { id: 'general-yoe', label: 'Years of professional experience', type: 'text', required: true },
    { id: 'python-yoe', label: 'Years of experience (Python)', type: 'text', required: true }
  ] });
  const mapped = mapApplicationFields(schema, {
    professional_yoe_years: 10, professional_years: 10, professional_yoe_verified: true,
    professional_years_source: 'config/profile.yml:candidate.professional_yoe_years'
  });
  assert.equal(mapped.find((item) => item.field_id === 'general-yoe').status, 'READY');
  assert.equal(mapped.find((item) => item.field_id === 'python-yoe').status, 'NEEDS_REVIEW');
  assert.equal(mapped.find((item) => item.field_id === 'python-yoe').proposed_value, null);
});

test('mapping requires provenance and fails closed on sensitive, YOE, GPA scale, and custom facts', () => {
  const schema = extractApplicationFormSchema({ provider: 'GREENHOUSE', sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1', fields: [
    { id: 'email', label: 'Email', type: 'email', required: true },
    { id: 'yoe', label: 'Years of professional experience', type: 'text', required: true },
    { id: 'auth', label: 'Are you authorized to work?', type: 'radio', required: true },
    { id: 'gpa', label: 'GPA on a 4.0 scale', type: 'text', required: true },
    { id: 'custom', label: 'Why do you want this job?', type: 'textarea', required: true }
  ] });
  const mapped = mapApplicationFields(schema, { email: 'candidate@example.test', email_source: 'config/profile.yml:candidate.email', professional_yoe_years: 0, professional_years: 0, professional_yoe_verified: true, professional_years_source: 'config/profile.yml:candidate.professional_yoe_years', gpa: 85, gpa_source: 'cv.md:Education', gpa_scale: 'GPA_SCALE_UNKNOWN', gpa_scale_source: 'cv.md:Education' });
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

test('explicit source provenance is preserved and inferred name parts are not mapped', () => {
  const schema = extractApplicationFormSchema({ provider: 'GREENHOUSE', sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1', fields: [
    { id: 'portfolio', label: 'Portfolio URL', type: 'url', required: true },
    { id: 'first', label: 'First name', type: 'text', required: true },
    { id: 'last', label: 'Last name', type: 'text', required: true }
  ] });
  const mapped = mapApplicationFields(schema, { portfolio_url: 'https://jane.example', portfolio_url_source: 'config/profile.yml:candidate.portfolio_url', first_name: 'Jane', first_name_source: 'config/profile.yml:candidate.first_name' });
  assert.deepEqual(mapped.map((item) => item.status), ['READY', 'READY', 'NEEDS_REVIEW']);
  assert.equal(mapped[0].provenance.source, 'config/profile.yml:candidate.portfolio_url');
  assert.equal(mapped[1].provenance.source, 'config/profile.yml:candidate.first_name');
});

test('ambiguous choice fields and duplicate field IDs fail closed', () => {
  const schema = extractApplicationFormSchema({ provider: 'LEVER', sourceUrl: 'https://jobs.lever.co/acme/1', fields: [
    { id: 'choice', name: 'choice', label: 'Preferred location', type: 'radio', required: true, options: [{ value: 'remote', label: 'Remote' }, { value: 'remote', label: 'Remote elsewhere' }] },
    { id: 'dup', label: 'Email', type: 'email' }, { id: 'dup', label: 'Phone', type: 'tel' }
  ] });
  assert.ok(schema.fields.every((field) => field.type === 'UNSUPPORTED'));
  assert.ok(schema.fields.every((field) => field.normalization_error));
});

test('radio choice values map only to a unique exact option; checkbox groups are never guessed', () => {
  const schema = extractApplicationFormSchema({ provider: 'GREENHOUSE', sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1', fields: [
    { id: 'location', label: 'Location preference', type: 'radio', required: true, options: [{ value: 'remote', label: 'Remote' }, { value: 'office', label: 'Office' }] },
    { id: 'regions', label: 'Preferred regions', type: 'checkbox', required: false, options: [{ value: 'na', label: 'North America' }, { value: 'eu', label: 'Europe' }] }
  ] });
  const mapped = mapApplicationFields(schema, { location: 'Remote', location_source: 'config/profile.yml:candidate.location' });
  assert.deepEqual(mapped.map((item) => item.status), ['READY', 'DO_NOT_ANSWER']);
  assert.equal(mapped[0].proposed_value, 'remote');
});

test('preparation receipt is immutable metadata with no submission capability; artifact refs are scoped', () => {
  const schema = extractApplicationFormSchema({ provider: 'LEVER', sourceUrl: 'https://jobs.lever.co/acme/1', fields: [] });
  const receipt = createPreparationReceipt({ applicationId: 'app-111111111111111111111111', provider: 'LEVER', schema, mappings: [], pdfSha256: 'a'.repeat(64), jdHash: 'b'.repeat(64), cvFingerprint: 'c'.repeat(64) });
  assert.equal(receipt.submission_performed, false);
  assert.equal(receipt.submit_capability, false);
  assert.equal(assertApplicationScopedArtifact(`${receipt.application_id}/artifact.pdf`, receipt.application_id), `${receipt.application_id}/artifact.pdf`);
  assert.throws(() => assertApplicationScopedArtifact('../foreign.pdf', receipt.application_id));
});
