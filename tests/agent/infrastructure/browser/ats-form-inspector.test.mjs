import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { extractReadOnlyFormFields } from '../../../../src/agent/infrastructure/browser/ats-form-inspector.mjs';

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
  } finally { await browser.close(); }
});
