// keyword-match must read the canonical English heading and preserve parsing
// of non-English reports already stored in the user-owned reports directory.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEYWORDS_HEADINGS, extractKeywords } from '../keyword-match.mjs';
import { pass, fail, NODE, ROOT, rmSync } from './helpers.mjs';

console.log('\nkeyword-match: canonical and archived report headings');

function check(label, run) {
  try { run(); pass(label); } catch (error) { fail(`${label}: ${error.message}`); }
}

const KEYWORDS = ['Python', 'gRPC', 'Kubernetes'];
const keywordsUnder = (heading) =>
  extractKeywords(`${heading}\n- Python, gRPC\n- Kubernetes\n\n## Next\n- not a keyword\n`);

check('canonical English evaluation and batch prompts expose a readable keyword heading', () => {
  const mode = readFileSync(join(ROOT, 'modes', 'oferta.md'), 'utf8');
  const batch = readFileSync(join(ROOT, 'batch', 'batch-prompt.md'), 'utf8');
  assert.match(mode, /^## Keywords extracted$/m);
  assert.match(batch, /^- `## Keywords extracted`$/m);
  assert.deepEqual(keywordsUnder('## Keywords extracted'), KEYWORDS);
});

check('historical non-English report headings remain readable', () => {
  assert.ok(KEYWORDS_HEADINGS.length > 1, 'historical headings must not be pruned with translated mode files');
  for (const title of KEYWORDS_HEADINGS) {
    assert.deepEqual(keywordsUnder(`## ${title}`), KEYWORDS, title);
    assert.deepEqual(keywordsUnder(`## ${title} (18)`), KEYWORDS, `${title} (18)`);
  }
});

check('case and diacritic variants remain readable in archived reports', () => {
  for (const heading of ['## Mots-clés extraits', '## Извлеченные ключевые слова', '## KEYWORDS EXTRACTED']) {
    assert.deepEqual(keywordsUnder(heading), KEYWORDS, heading);
  }
});

check('unrelated headings are not mistaken for the keyword section', () => {
  for (const heading of ['## Keyword Coverage', '### Keywords extracted', '## निकले गए Keywords']) {
    assert.deepEqual(keywordsUnder(heading), [], heading);
  }
});

check('the CLI reads an archived Spanish report', () => {
  const work = mkdtempSync(join(tmpdir(), 'keyword-match-archive-'));
  try {
    const report = join(work, '042-acme-2026-10-03.md');
    const cv = join(work, 'cv-acme.html');
    writeFileSync(report, [
      '# Evaluación: Acme — Staff Engineer',
      '',
      '## Palabras clave extraídas',
      '- Python, gRPC',
      '- Kubernetes',
      '',
      '## Job Description (archived verbatim)',
      'Posted: not visible in source',
      '',
    ].join('\n'));
    writeFileSync(cv, '<html><body><p>Python and gRPC services on Kubernetes.</p></body></html>');
    const out = execFileSync(NODE, [join(ROOT, 'keyword-match.mjs'), report, '--cv', cv, '--json'], {
      encoding: 'utf-8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(out);
    assert.equal(result.coveragePct, 100);
    assert.deepEqual(result.present, KEYWORDS);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
