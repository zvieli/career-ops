import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { extractReadOnlyFormFields } from '../../../../src/agent/infrastructure/browser/ats-form-inspector.mjs';
import { extractApplicationFormSchema, mapApplicationFields } from '../../../../src/agent/domain/applications/ats-preparation.mjs';

const ROOT = join(fileURLToPath(new URL('../../..', import.meta.url)), '..');

test('read-only DOM inspector extracts controlled Greenhouse and Lever HTML fixtures without values or actions', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const name of ['greenhouse-form.html', 'lever-form.html']) {
      const html = readFileSync(join(ROOT, 'tests', 'fixtures', 'ats', name), 'utf8');
      await page.setContent(html);
      const fields = await extractReadOnlyFormFields(page);
      assert.ok(fields.length > 0);
      assert.ok(fields.some((field) => field.type === 'file'));
      assert.ok(fields.every((field) => !Object.hasOwn(field, 'value')));
    }
    const fields = await extractReadOnlyFormFields(page);
    assert.ok(fields.some((field) => field.type === 'select' && field.options.length > 0));
    await page.setContent(readFileSync(join(ROOT, 'tests', 'fixtures', 'ats', 'greenhouse-form.html'), 'utf8'));
    const greenhouse = await extractReadOnlyFormFields(page);
    assert.equal(greenhouse.find((field) => field.id === 'hidden-email').visible, false);
    assert.equal(new Set(greenhouse.map((field) => field.id)).size, greenhouse.length);
    const authorization = greenhouse.find((field) => field.name === 'authorization');
    assert.equal(authorization.type, 'radio');
    assert.equal(authorization.label, 'Are you authorized to work?');
    assert.equal(authorization.required, true);
    assert.deepEqual(authorization.options, [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]);
    const regions = greenhouse.find((field) => field.name === 'regions[]');
    assert.equal(regions.type, 'checkbox');
    assert.deepEqual(regions.options, [{ value: 'na', label: 'North America' }, { value: 'eu', label: 'Europe' }]);
    assert.ok(greenhouse.some((field) => field.name === 'bad_group' && field.type === 'unsupported'));
    const school = greenhouse.find((field) => field.id === 'school');
    assert.equal(school.label, 'University / school');
    assert.equal(school.group_label, 'Education');
    const legal = greenhouse.find((field) => field.id === 'legal');
    assert.equal(legal.label, 'Are you authorized to work?');
    assert.equal(legal.group_label, 'Personal details');
    const major = greenhouse.find((field) => field.id === 'major');
    assert.equal(major.label, 'Field of study');
    assert.equal(major.group_label, 'Education');
    const schema = extractApplicationFormSchema({ provider: 'GREENHOUSE', sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1', fields: greenhouse });
    const mappings = mapApplicationFields(schema, {
      degrees: ['B.Sc. Computer Science'], degrees_source: 'cv.md:Education',
      linkedin_url: 'https://linkedin.example/profile', linkedin_url_source: 'config/profile.yml:candidate.linkedin_url',
      professional_yoe_years: 10, professional_yoe_verified: true, professional_years_source: 'config/profile.yml:candidate.professional_yoe_years'
    });
    for (const id of ['school', 'major']) {
      assert.equal(mappings.find((item) => item.field_id === id).status, 'NEEDS_REVIEW');
      assert.equal(mappings.find((item) => item.field_id === id).proposed_value, null);
    }
    assert.equal(schema.fields.find((field) => field.id === 'major').semantic_type, 'FIELD_OF_STUDY');
    assert.equal(schema.fields.find((field) => field.id === 'major').group_label, 'Education');
    assert.equal(mappings.find((item) => item.field_id === 'legal').status, 'DO_NOT_ANSWER');
    assert.equal(schema.fields.find((field) => field.id === 'linkedin').semantic_type, 'LINKEDIN_URL');
    assert.equal(mappings.find((item) => item.field_id === 'linkedin').status, 'READY');
    assert.equal(schema.fields.find((field) => field.id === 'current-role-years').semantic_type, 'CUSTOM_QUESTION');
    assert.equal(mappings.find((item) => item.field_id === 'current-role-years').status, 'NEEDS_REVIEW');
  } finally { await browser.close(); }
});
