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
    assert.equal((await extractReadOnlyFormFields(page)).find((field) => field.id === 'hidden-email').visible, false);
  } finally { await browser.close(); }
});
