import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createCvPdfPipeline } from '../../../src/agent/graph/cv-pdf-pipeline.mjs';
import { checkSourceBackedFactuality, hasCanonicalPdfQuality, validatePdf, validatePdfArtifact } from '../../../src/agent/infrastructure/documents/pdf-validator.mjs';

async function tempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-cv-pipeline-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

const sourceTex = String.raw`\documentclass{article}
\begin{document}
\begin{itemize}
\item Project B: built a verified service.
\item Project A: delivered a verified system.
\end{itemize}
\end{document}`;

function fakePdfTools({ pageCount, text, invalidPdfInfo = false }) {
  return (command, args) => {
    if (command === 'pdflatex') {
      const outputDir = args.find((arg) => arg.startsWith('-output-directory='))?.slice('-output-directory='.length);
      const texPath = args.at(-1);
      writeFileSync(join(outputDir, basename(texPath).replace(/\.tex$/i, '.pdf')), Buffer.from('%PDF-1.7 fixture'));
      return Buffer.alloc(0);
    }
    if (command === 'pdfinfo') {
      if (invalidPdfInfo) throw new Error('invalid PDF fixture');
      return `Pages: ${pageCount}\n`;
    }
    if (command === 'pdftotext') return text;
    throw new Error(`Unexpected PDF tool: ${command}`);
  };
}

const REAL_PDF_TOOLS_AVAILABLE = [
  ['pdflatex', '--version'], ['pdfinfo', '-v'], ['pdftotext', '-v']
].every(([command, versionFlag]) => {
  const result = spawnSync(command, [versionFlag], { stdio: 'ignore' });
  return !result.error && result.status === 0;
});

test('CV pipeline only reorders sourced LaTeX bullets and rejects missing canonical evidence', async () => {
  await tempRoot((dataRoot) => {
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    mkdirSync(join(dataRoot, 'cv'), { recursive: true });
    writeFileSync(join(dataRoot, 'cv.md'), '# CV\n\n- Project B: built a verified service.\n- Project A: delivered a verified system.\n');
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

test('source-backed PDF factuality uses available CV evidence rather than candidate-specific invariants and still blocks without config', async () => {
  await tempRoot((dataRoot) => {
    const sourcePath = join(dataRoot, 'cv.md');
    writeFileSync(sourcePath, '# Candidate CV\n\nLior Zvieli\nSoftware engineer.\nImproved reliability for 25 users.');
    const result = checkSourceBackedFactuality('Lior Zvieli\nSoftware engineer.', [sourcePath], join(dataRoot, 'missing-facts.json'));
    assert.equal(result.passed, true);
    assert.equal(result.details?.configMissing, true);
    assert.notEqual(result.details?.gpa85, true);
    const invented = checkSourceBackedFactuality('Improved reliability for 250 users.', [sourcePath], join(dataRoot, 'missing-facts.json'));
    assert.equal(invented.passed, false);
    assert.equal(invented.verdict, 'block');
    assert.equal(invented.details?.configMissing, true);
    assert.equal(checkSourceBackedFactuality('Any text', [], join(dataRoot, 'missing-facts.json')).passed, false);
  });
});

test('source-backed PDF mode ignores legacy candidate constants and requires source verification', async () => {
  await tempRoot(async (dataRoot) => {
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(join(dataRoot, 'cv.md'), '# CV\\n\\n- Project B: built a verified service.\\n- Project A: delivered a verified system.');
    writeFileSync(join(dataRoot, 'article-digest.md'), 'Additional approved proof points.');
    let validationSources;
    const pipeline = createCvPdfPipeline({ dataRoot, validatePdfImpl: async (_tex, options) => {
      validationSources = options.sourcePaths;
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
    assert.deepEqual(validationSources, [join(dataRoot, 'cv.md'), join(dataRoot, 'article-digest.md')]);
    assert.equal(validationSources.includes(texPath), false);
    assert.equal(readFileSync(texPath, 'utf8'), sourceTex);
  });
});

test('every visible canonical LaTeX content block must be backed by cv.md or article-digest, not by LaTeX itself', async () => {
  await tempRoot((dataRoot) => {
    mkdirSync(join(dataRoot, 'cv'), { recursive: true });
    const markdown = '# Candidate\n\n## Experience\n\n- **Project A:** Built a system for 25 users.\n';
    const tex = String.raw`\documentclass{article}
\begin{document}
\section*{Experience}
\begin{itemize}
\item \textbf{Project A:} Built a system for 25 users.
\end{itemize}
\end{document}`;
    writeFileSync(join(dataRoot, 'cv.md'), markdown);
    writeFileSync(join(dataRoot, 'cv', 'lior_zvieli_cv.tex'), tex);
    const pipeline = createCvPdfPipeline({ dataRoot, validatePdfImpl: async () => ({ success: false }) });
    assert.doesNotThrow(() => pipeline.generate());
    writeFileSync(join(dataRoot, 'cv', 'lior_zvieli_cv.tex'), tex.replace('25 users', '250 users'));
    assert.throws(() => pipeline.generate(), /canonical LaTeX content is not backed by approved CV sources/i);
  });
});

test('unsourced text injected by a LaTeX preamble hook is rejected', async () => {
  await tempRoot((dataRoot) => {
    mkdirSync(join(dataRoot, 'cv'), { recursive: true });
    writeFileSync(join(dataRoot, 'cv.md'), '# Candidate\n\n- Project A: Built a verified service.\n- Project B: Delivered a verified system.');
    writeFileSync(join(dataRoot, 'cv', 'lior_zvieli_cv.tex'), String.raw`\documentclass{article}
\AtBeginDocument{Experienced negotiator\par}
\begin{document}
\begin{itemize}
\item \textbf{Project A:} Built a verified service.
\item \textbf{Project B:} Delivered a verified system.
\end{itemize}
\end{document}`);
    const pipeline = createCvPdfPipeline({ dataRoot });
    assert.throws(() => pipeline.generate(), /unsupported.*preamble/i);
  });
});

test('TeX ^^ character escapes cannot hide preamble control sequences', async () => {
  await tempRoot((dataRoot) => {
    mkdirSync(join(dataRoot, 'cv'), { recursive: true });
    writeFileSync(join(dataRoot, 'cv.md'), '# Candidate\n\n- Project A: Built a verified service.\n- Project B: Delivered a verified system.');
    const tex = String.raw`\documentclass{article}
\usepackage{enumitem}
\setlist[itemize]{before=^^5cinput^^7b/tmp/unsupported.tex^^7d}
\begin{document}
\begin{itemize}
\item \textbf{Project A:} Built a verified service.
\item \textbf{Project B:} Delivered a verified system.
\end{itemize}
\end{document}`;
    writeFileSync(join(dataRoot, 'cv', 'lior_zvieli_cv.tex'), tex);
    const pipeline = createCvPdfPipeline({ dataRoot });
    assert.throws(() => pipeline.generate(), /unsupported.*TeX.*escapes/i);
  });
});

test('enumitem list hooks cannot add visible text outside the approved CV sources', async () => {
  await tempRoot((dataRoot) => {
    mkdirSync(join(dataRoot, 'cv'), { recursive: true });
    writeFileSync(join(dataRoot, 'cv.md'), '# Candidate\n\n- Project A: Built a verified service.\n- Project B: Delivered a verified system.');
    const tex = String.raw`\documentclass{article}
\usepackage{enumitem}
\setlist[itemize]{before=Experienced negotiator}
\begin{document}
\begin{itemize}
\item \textbf{Project A:} Built a verified service.
\item \textbf{Project B:} Delivered a verified system.
\end{itemize}
\end{document}`;
    writeFileSync(join(dataRoot, 'cv', 'lior_zvieli_cv.tex'), tex);
    const pipeline = createCvPdfPipeline({ dataRoot });
    assert.throws(() => pipeline.generate(), /unsupported.*preamble/i);
  });
});

test('visible preamble formatting text must also be source-backed', async () => {
  await tempRoot((dataRoot) => {
    mkdirSync(join(dataRoot, 'cv'), { recursive: true });
    writeFileSync(join(dataRoot, 'cv.md'), '# Candidate\n\n- Project A: Built a verified service.\n- Project B: Delivered a verified system.');
    const tex = String.raw`\documentclass{article}
\titleformat{\section}{\large\bfseries}{}{0pt}{Experienced negotiator}
\begin{document}
\begin{itemize}
\item \textbf{Project A:} Built a verified service.
\item \textbf{Project B:} Delivered a verified system.
\end{itemize}
\end{document}`;
    writeFileSync(join(dataRoot, 'cv', 'lior_zvieli_cv.tex'), tex);
    const pipeline = createCvPdfPipeline({ dataRoot });
    assert.throws(() => pipeline.generate(), /canonical LaTeX content is not backed by approved CV sources/i);
  });
});

test('HTML-like claims in canonical LaTeX are rejected before normalization', async () => {
  await tempRoot((dataRoot) => {
    mkdirSync(join(dataRoot, 'cv'), { recursive: true });
    writeFileSync(join(dataRoot, 'cv.md'), '# Candidate\n\n- Project A: Built a verified service.\n- Project B: Delivered a verified system.');
    writeFileSync(join(dataRoot, 'cv', 'lior_zvieli_cv.tex'), String.raw`\documentclass{article}
\begin{document}
\begin{itemize}
\item \textbf{Project A:} Built a verified service. <Experienced negotiator>
\item \textbf{Project B:} Delivered a verified system.
\end{itemize}
\end{document}`);
    const pipeline = createCvPdfPipeline({ dataRoot });
    assert.throws(() => pipeline.generate(), /HTML-like markup/i);
  });
});

test('fresh source-backed validation rejects HTML-like claims extracted from a real PDF', { skip: !REAL_PDF_TOOLS_AVAILABLE }, async () => {
  await tempRoot(async (dataRoot) => {
    const repeated = 'Built and maintained a verified document processing service. '.repeat(24);
    const sourcePath = join(dataRoot, 'cv.md');
    writeFileSync(sourcePath, `# Candidate\n\n- Project A: ${repeated}`);
    const tex = String.raw`\documentclass{article}
\usepackage[T1]{fontenc}
\begin{document}
\fontsize{7}{8}\selectfont
\begin{itemize}
\item \textbf{Project A:} ${repeated}<Experienced negotiator>
\end{itemize}
\end{document}`;
    const result = await validatePdf(tex, { factualityMode: 'source-backed', sourcePaths: [sourcePath],
      configPath: join(dataRoot, 'missing-facts.json'), outputDir: join(dataRoot, 'real-pdf') });
    assert.equal(result.compileExitCode, 0, result.errors.join('; '));
    assert.equal(result.pageCount, 1);
    assert.ok(result.textCharCount > 1000);
    assert.equal(result.factuality.verdict, 'block');
    assert.equal(result.success, false);
    const extracted = spawnSync('pdftotext', [result.pdfPath, '-'], { encoding: 'utf8' });
    assert.equal(extracted.status, 0);
    assert.match(extracted.stdout, /Experienced negotiator/);
  });
});

test('recovery source-backed validation rejects HTML-like PDF text', async () => {
  await tempRoot((dataRoot) => {
    const sourcePath = join(dataRoot, 'cv.md');
    const pdfPath = join(dataRoot, 'persisted.pdf');
    const repeated = 'Built and maintained a verified document processing service. '.repeat(24);
    writeFileSync(sourcePath, `# Candidate\n\n- Project A: ${repeated}`);
    writeFileSync(pdfPath, Buffer.from('%PDF-1.7 fixture'));
    const recovery = validatePdfArtifact(pdfPath, { sourcePaths: [sourcePath], execFileSyncImpl: (command) => {
      if (command === 'pdfinfo') return 'Pages: 1\n';
      if (command === 'pdftotext') return `${repeated}<Experienced negotiator>`;
      throw new Error(`Unexpected PDF tool: ${command}`);
    } });
    assert.equal(recovery.pageCount, 1);
    assert.ok(recovery.textCharCount > 1000);
    assert.equal(recovery.factuality.verdict, 'block');
    assert.equal(recovery.success, false);
  });
});

test('fresh and recovery PDF validation share exactly one page and more than 1000 extracted characters', async () => {
  assert.equal(hasCanonicalPdfQuality(1, 1001), true);
  assert.equal(hasCanonicalPdfQuality(1, 1000), false);
  assert.equal(hasCanonicalPdfQuality(1, 1), false);
  assert.equal(hasCanonicalPdfQuality(2, 2000), false);
  assert.equal(hasCanonicalPdfQuality(0, 2000), false);
  assert.equal(hasCanonicalPdfQuality(Number.NaN, 2000), false);

  await tempRoot(async (dataRoot) => {
    const text = 'Document processing and engineering experience. '.repeat(30);
    const source = join(dataRoot, 'cv.md');
    const tex = join(dataRoot, 'uncompiled.tex');
    const persistedPdf = join(dataRoot, 'persisted.pdf');
    writeFileSync(tex, 'intentionally not valid TeX; fake compiler is injected');
    writeFileSync(persistedPdf, Buffer.from('%PDF fixture'));
    const scenarios = [
      { label: 'two pages', pageCount: 2, text, expected: false },
      { label: 'zero pages', pageCount: 0, text, expected: false },
      { label: 'invalid PDF metadata', pageCount: 1, text, invalidPdfInfo: true, expected: false },
      { label: 'tiny text', pageCount: 1, text: 'Short text.', expected: false },
      { label: 'exact threshold', pageCount: 1, text: 'x'.repeat(1000), expected: false },
      { label: 'one page with meaningful text', pageCount: 1, text, expected: true }
    ];
    for (const scenario of scenarios) {
      writeFileSync(source, scenario.text);
      const tools = fakePdfTools(scenario);
      const fresh = await validatePdf(tex, { factualityMode: 'source-backed', sourcePaths: [source],
        configPath: join(dataRoot, 'config', 'cv-facts.json'), outputDir: join(dataRoot, `fresh-${scenario.label.replaceAll(' ', '-')}`),
        execFileSyncImpl: tools });
      const recovery = validatePdfArtifact(persistedPdf, { sourcePaths: [source],
        configPath: join(dataRoot, 'config', 'cv-facts.json'), execFileSyncImpl: tools });
      assert.equal(fresh.success, scenario.expected, `fresh validation: ${scenario.label}; errors=${fresh.errors.join('; ')}`);
      assert.equal(recovery.success, scenario.expected, `recovery validation: ${scenario.label}; errors=${recovery.errors.join('; ')}`);
    }
  });
});
