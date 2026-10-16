import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const workflow = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');

test('test runners install only the browser and native assets used by the suite', () => {
  assert.match(workflow, /npm install --ignore-scripts/);
  assert.match(workflow, /npm rebuild better-sqlite3/);
  assert.match(workflow, /playwright install --with-deps chromium/);
  assert.match(workflow, /playwright install chromium/);
  assert.match(workflow, /CAREER_OPS_REQUIRE_PDF_TOOLS=1 node --test tests\/agent\/domain\/cv-tailoring-pipeline\.test\.mjs/);
  const dockerfile = readFileSync(new URL('../tests/cv-visual/Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /texlive-latex-base/);
  assert.match(dockerfile, /texlive-latex-recommended/);
});

test('the updater integration apply gate runs only against canonical upstream main', () => {
  assert.match(
    workflow,
    /if:\s*\$\{\{\s*github\.repository == 'career-ops-hq\/career-ops'\s*\}\}/,
  );
});

test('CV pipeline tests use committed synthetic fixtures rather than ignored candidate files', () => {
  const testFile = new URL('./agent/domain/cv-tailoring-pipeline.test.mjs', import.meta.url);
  const source = readFileSync(testFile, 'utf8');
  assert.match(source, /fixtures\/cv-tailoring\/example-candidate\.md/);
  assert.doesNotMatch(source, /cv\/lior_zvieli_cv\.tex|readFileSync\(['"]cv\.md/);
});

test('CV pipeline test resolves its fixtures when launched outside the repository root', () => {
  const testFile = fileURLToPath(new URL('./agent/domain/cv-tailoring-pipeline.test.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--test', testFile], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
