import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCvPdfPipeline } from '../../../src/agent/graph/cv-pdf-pipeline.mjs';
import { checkSourceBackedFactuality } from '../../../src/agent/infrastructure/documents/pdf-validator.mjs';

async function tempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-cv-pipeline-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

const sourceTex = String.raw`\begin{document}
\begin{itemize}
\item Project B: built a verified service.
\item Project A: delivered a verified system.
\end{itemize}
\end{document}`;

test('CV pipeline only reorders sourced LaTeX bullets and rejects missing canonical evidence', async () => {
  await tempRoot((dataRoot) => {
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    mkdirSync(join(dataRoot, 'cv'), { recursive: true });
    writeFileSync(join(dataRoot, 'cv.md'), '# CV\n\nBuilt a verified service and delivered a verified system.\n');
    writeFileSync(join(dataRoot, 'cv', 'lior_zvieli_cv.tex'), sourceTex);
    const pipeline = createCvPdfPipeline({ dataRoot, validatePdfImpl: async () => ({ success: false }) });
    const output = pipeline.generate({ jdText: 'Project A requires a verified system.' });
    assert.equal(output.tex.includes('\\item Project A: delivered a verified system.'), true);
    assert.equal(output.tex.includes('\\item Project B: built a verified service.'), true);
    assert.equal(output.tex.includes('\\item Project A: delivered a verified system.\n  \\item Project B'), true);
    assert.equal(output.factuality.verdict === 'block', false);
    rmSync(join(dataRoot, 'cv.md'));
    assert.throws(() => pipeline.generate({ jdText: 'Anything' }), /canonical CV source/i);
  });
});

test('source-backed PDF factuality uses available CV evidence rather than candidate-specific invariants', async () => {
  await tempRoot((dataRoot) => {
    const sourcePath = join(dataRoot, 'cv.md');
    writeFileSync(sourcePath, '# Candidate CV\n\nLior Zvieli\nSoftware engineer.');
    const result = checkSourceBackedFactuality('Lior Zvieli\nSoftware engineer.', [sourcePath]);
    assert.equal(result.passed, true);
    assert.notEqual(result.details?.gpa85, true);
    assert.equal(checkSourceBackedFactuality('Any text', []).passed, false);
  });
});

test('source-backed PDF mode ignores legacy candidate constants and requires source verification', async () => {
  tempRoot(async (dataRoot) => {
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(join(dataRoot, 'cv.md'), '# CV\\n\\nVerified facts.');
    const pipeline = createCvPdfPipeline({ dataRoot, validatePdfImpl: async (_tex, options) => {
      assert.equal(options.factualityMode, 'source-backed');
      writeFileSync(join(options.outputDir, 'fixture.pdf'), Buffer.from('%PDF fixture'));
      return { success: true, pdfPath: join(options.outputDir, 'fixture.pdf'), pageCount: 1, textCharCount: 1200,
        factuality: { passed: true, verdict: 'pass', warnings: [] }, errors: [] };
    } });
    const texPath = join(dataRoot, 'cv.tex');
    writeFileSync(texPath, sourceTex);
    const result = await pipeline.validate({ texPath });
    assert.equal(Buffer.isBuffer(result.pdfBytes), true);
    assert.ok(result.pdfBytes.length > 0);
    assert.equal(readFileSync(texPath, 'utf8'), sourceTex);
  });
});
