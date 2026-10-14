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
    assert.equal(school.label, 'Education University / school');
    const legal = greenhouse.find((field) => field.id === 'legal');
    assert.equal(legal.label, 'Personal details Are you authorized to work?');
    const schema = extractApplicationFormSchema({ provider: 'GREENHOUSE', sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1', fields: greenhouse });
    const mappings = mapApplicationFields(schema, { degrees: ['B.Sc.'], degrees_source: 'cv.md:Education' });
    assert.equal(mappings.find((item) => item.field_id === 'school').status, 'NEEDS_REVIEW');
    assert.equal(mappings.find((item) => item.field_id === 'school').proposed_value, null);
    assert.equal(mappings.find((item) => item.field_id === 'legal').status, 'DO_NOT_ANSWER');
  } finally { await browser.close(); }
});
