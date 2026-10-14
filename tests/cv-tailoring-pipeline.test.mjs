// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateTailoringPatch, extractLatexBullets } from '../lib/cv-tailoring-engine.mjs';
import { applyLatexPatch, escapeLatex } from '../lib/latex-patcher.mjs';
import { validatePdf, checkFactuality } from '../lib/pdf-validator.mjs';

const CANONICAL_TEX_PATH = 'cv/lior_zvieli_cv.tex';
const CANONICAL_MD_PATH = 'cv.md';

test('escapeLatex neutralizes special LaTeX symbols', () => {
  assert.equal(escapeLatex('100% & 5$ #1'), '100\\% \\& 5\\$ \\#1');
});

test('extractLatexBullets parses bullets from canonical CV', () => {
  const tex = readFileSync(CANONICAL_TEX_PATH, 'utf8');
  const bullets = extractLatexBullets(tex);
  assert.ok(bullets.length >= 5);
  assert.match(bullets[0].title, /System Architecture/);
});

test('generateTailoringPatch produces valid structured patch matching JD emphasis', () => {
  const cvMd = readFileSync(CANONICAL_MD_PATH, 'utf8');
  const cvTex = readFileSync(CANONICAL_TEX_PATH, 'utf8');
  const jdRequirements = {
    role: 'Backend Systems Focus',
    keywords: ['Backend', 'Asynchronous Systems', 'Kotlin', 'CI/CD', 'REST APIs'],
    emphasis: 'backend, distributed systems, asynchronous pipelines'
  };

  const patch = generateTailoringPatch(cvMd, cvTex, jdRequirements);
  assert.ok(patch.headline_override);
  assert.match(patch.headline_override, /Backend Systems Focus/);
  assert.ok(Array.isArray(patch.bullet_priority_order));
  assert.ok(patch.keywords_to_surface.length > 0);
});

test('applyLatexPatch updates headline and bullet order without modifying facts', () => {
  const originalTex = readFileSync(CANONICAL_TEX_PATH, 'utf8');
  const patch = {
    headline_override: 'Applied AI Engineer — Backend Systems Focus',
    bullet_priority_order: [3, 0, 4, 1, 2, 5, 6],
    keywords_to_surface: ['Backend', 'Asynchronous Systems']
  };

  const patched = applyLatexPatch(originalTex, patch);
  assert.match(patched, /Backend Systems Focus/);
  assert.match(patched, /Lior Zvieli/);
  assert.match(patched, /GPA 85/);
});

test('validatePdf runs two-pass pdflatex and validates 1-page A4 PDF integrity', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'career-ops-cv-val-'));
  try {
    const originalTex = readFileSync(CANONICAL_TEX_PATH, 'utf8');
    const result = await validatePdf(originalTex, {
      outputDir: tempDir,
      cvMdPath: CANONICAL_MD_PATH
    });

    assert.equal(result.compileExitCode, 0);
    assert.equal(result.pageCount, 1);
    assert.ok(result.textCharCount > 1000);
    assert.equal(result.factuality.passed, true);
    assert.equal(result.success, true);
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
});
