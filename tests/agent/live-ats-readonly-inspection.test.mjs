import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectLiveAtsReadOnly,
  extractApplicationFormSchema,
  mapApplicationFields,
  detectAtsProvider
} from '../../src/agent/domain/applications/ats-preparation.mjs';

test('detectAtsProvider recognizes Greenhouse host and can inspect live read-only', async () => {
  const url = 'https://job-boards.greenhouse.io/nextinsurance66/jobs/7979131003';
  const detection = detectAtsProvider(url);
  assert.equal(detection.provider, 'GREENHOUSE');
  assert.equal(detection.status, 'HOST_RECOGNIZED');
  assert.equal(detection.capability.fixtureTested, true);
  assert.equal(detection.capability.liveExtractionSupported, false);
});

test('inspectLiveAtsReadOnly extracts real read-only questions from live Greenhouse API', async () => {
  const url = 'https://job-boards.greenhouse.io/nextinsurance66/jobs/7979131003';
  const inspection = await inspectLiveAtsReadOnly({
    provider: 'GREENHOUSE',
    sourceUrl: url
  });

  assert.equal(inspection.provider, 'GREENHOUSE');
  assert.equal(inspection.source, 'live_greenhouse_api');
  assert.ok(Array.isArray(inspection.fields));
  assert.ok(inspection.fields.length >= 10, 'Expected at least 10 fields from Next Insurance board');

  // Verify core standard fields are found
  const fieldNames = inspection.fields.map(f => f.name || f.id);
  assert.ok(fieldNames.includes('first_name'));
  assert.ok(fieldNames.includes('last_name'));
  assert.ok(fieldNames.includes('email'));
  assert.ok(fieldNames.includes('phone'));
  assert.ok(fieldNames.includes('resume'));

  // Normalize into ApplicationFormSchema
  const schema = extractApplicationFormSchema({
    provider: 'GREENHOUSE',
    sourceUrl: url,
    fields: inspection.fields,
    source: inspection.source
  });

  assert.equal(schema.extraction_status, 'EXTRACTED');
  assert.equal(schema.source, 'live_greenhouse_api');
  assert.ok(/^[a-f0-9]{64}$/.test(schema.schema_hash));

  // Map against candidate facts
  const candidateFacts = {
    full_name: 'Lior Zvieli',
    full_name_source: 'config/profile.yml:candidate.full_name',
    first_name: 'Lior',
    first_name_source: 'config/profile.yml:candidate.first_name',
    last_name: 'Zvieli',
    last_name_source: 'config/profile.yml:candidate.last_name',
    email: 'liorzvieli@gmail.com',
    email_source: 'config/profile.yml:candidate.email',
    phone: '+972 52-227-6810',
    phone_source: 'config/profile.yml:candidate.phone',
    linkedin_url: 'https://www.linkedin.com/in/zvieli/',
    linkedin_url_source: 'config/profile.yml:candidate.linkedin',
    github_url: 'https://github.com/zvieli',
    github_url_source: 'config/profile.yml:candidate.github',
    professional_yoe_years: 0,
    professional_yoe_verified: true,
    professional_years_source: 'config/profile.yml:candidate.professional_yoe_years',
    gpa: 85,
    gpa_source: 'config/profile.yml:candidate.gpa_value'
  };

  const mappings = mapApplicationFields(schema, candidateFacts);
  assert.ok(Array.isArray(mappings));
  assert.equal(mappings.length, schema.fields.length);

  // Email and phone should be READY
  const emailMapping = mappings.find(m => m.field_id === 'email');
  assert.equal(emailMapping?.status, 'READY');
  assert.equal(emailMapping?.proposed_value, 'liorzvieli@gmail.com');

  const phoneMapping = mappings.find(m => m.field_id === 'phone');
  assert.equal(phoneMapping?.status, 'READY');
  assert.equal(phoneMapping?.proposed_value, '+972 52-227-6810');

  // Visa and attestation questions must NEVER be guessed automatically
  for (const mapping of mappings) {
    if (mapping.semantic_type === 'VISA_SPONSORSHIP' || mapping.semantic_type === 'WORK_AUTHORIZATION') {
      assert.equal(mapping.status, 'DO_NOT_ANSWER', 'Legal/visa questions must remain DO_NOT_ANSWER');
      assert.equal(mapping.proposed_value, null);
    }
  }
});

test('inspectLiveAtsReadOnly fails closed on unsupported provider or invalid URL', async () => {
  await assert.rejects(
    inspectLiveAtsReadOnly({ provider: 'UNSUPPORTED', sourceUrl: 'https://unknown.example.com' }),
    /not supported/i
  );

  await assert.rejects(
    inspectLiveAtsReadOnly({ provider: 'GREENHOUSE', sourceUrl: 'https://job-boards.greenhouse.io/invalid' }),
    /Could not parse/i
  );
});
