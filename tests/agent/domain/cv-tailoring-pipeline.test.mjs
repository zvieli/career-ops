// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { generateTailoringPatch, extractLatexBullets } from '../../../lib/cv-tailoring-engine.mjs';
import { applyLatexPatch, escapeLatex } from '../../../lib/latex-patcher.mjs';
import { validatePdf } from '../../../lib/pdf-validator.mjs';

const FIXTURE_MD = fileURLToPath(new URL('../../fixtures/cv-tailoring/example-candidate.md', import.meta.url));
const FIXTURE_TEX = fileURLToPath(new URL('../../fixtures/cv-tailoring/example-candidate.tex', import.meta.url));
const SAMPLE_TEX = String.raw`\documentclass{article}
\begin{document}
{\large\textbf{Example Candidate}}\\[8pt]
\section*{Experience}
\begin{itemize}
  \item \textbf{Example Backend Service:} Built a synthetic API and asynchronous worker.
  \item \textbf{Example Test Suite:} Added fictional unit and integration tests.
\end{itemize}
\section*{Technical Skills}
\textbf{Backend Systems:} Example APIs\\
\section*{Education}
Fictional test fixture
\end{document}`;

function commandAvailable(command) {
  try {
    return spawnSync(command, ['--version'], { stdio: 'ignore', timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
}

const PDF_TOOLS_AVAILABLE = ['pdflatex', 'pdfinfo', 'pdftotext'].every(commandAvailable);
const PDF_TOOLS_REQUIRED = process.env.CAREER_OPS_REQUIRE_PDF_TOOLS === '1';

test('escapeLatex neutralizes special LaTeX symbols', () => {
  assert.equal(escapeLatex('100% & 5$ #1'), '100\\% \\& 5\\$ \\#1');
});

test('extractLatexBullets parses bullets from a synthetic CV fixture', () => {
  const tex = readFileSync(FIXTURE_TEX, 'utf8');
  const bullets = extractLatexBullets(tex);
  assert.ok(bullets.length >= 1);
  assert.match(bullets[0].raw, /Example Backend Service/);
});

test('generateTailoringPatch produces a structured patch from synthetic sources', () => {
  const cvMd = readFileSync(FIXTURE_MD, 'utf8');
  const cvTex = readFileSync(FIXTURE_TEX, 'utf8');
  const jdRequirements = {
    role: 'Example Backend Systems Role',
    keywords: ['Backend', 'Asynchronous Systems', 'Example API', 'CI/CD'],
    summary_emphasis: ['synthetic asynchronous systems']
  };

  const patch = generateTailoringPatch(cvMd, cvTex, jdRequirements);
  assert.ok(patch.headline_override);
  assert.match(patch.headline_override, /Example Backend Systems Role/);
  assert.ok(Array.isArray(patch.bullet_priority_order));
  assert.ok(patch.keywords_to_surface.length > 0);
});

test('applyLatexPatch updates the synthetic headline and bullet order without adding facts', () => {
  const patch = {
    headline_override: 'Example Candidate — Synthetic Backend Focus',
    bullet_priority_order: [2, 1],
    keywords_to_surface: ['Example API']
  };

  const patched = applyLatexPatch(SAMPLE_TEX, patch);
  assert.match(patched, /Synthetic Backend Focus/);
  assert.match(patched, /Example Candidate/);
  assert.ok(patched.indexOf('Example Test Suite') < patched.indexOf('Example Backend Service'));
});

test('validatePdf compiles a synthetic source-backed one-page PDF', {
  skip: !PDF_TOOLS_AVAILABLE && !PDF_TOOLS_REQUIRED
    ? 'pdflatex, pdfinfo, and pdftotext are installed in the dedicated CV visual CI image'
    : false
}, async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'career-ops-cv-val-'));
  try {
    const result = await validatePdf(FIXTURE_TEX, {
      outputDir: tempDir,
      cvMdPath: FIXTURE_MD,
      factualityMode: 'source-backed',
      sourcePaths: [FIXTURE_MD]
    });

    assert.equal(result.compileExitCode, 0, result.errors.join('\n'));
    assert.equal(result.pageCount, 1);
    assert.ok(result.textCharCount > 1000);
    assert.equal(result.factuality.passed, true, result.factuality.errors.join('\n'));
    assert.equal(result.success, true, result.errors.join('\n'));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
