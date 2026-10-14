/**
 * lib/pdf-validator.mjs — Compiles LaTeX CV via two-pass pdflatex into an isolated directory,
 * validates compile exit code 0, page count == 1, text extractability > 1000 chars,
 * and executes deterministic factuality checks against canonical cv.md.
 */

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'fs';
import { join, resolve, basename } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { verifyFacts } from '../../../../verify-cv-facts.mjs';

export const PDF_PAGE_COUNT_REQUIRED = 1;
export const PDF_MIN_EXTRACTED_TEXT_CHARS = 1000;

export function hasCanonicalPdfQuality(pageCount, textCharCount) {
  return Number.isSafeInteger(pageCount) && pageCount === PDF_PAGE_COUNT_REQUIRED
    && Number.isSafeInteger(textCharCount) && textCharCount > PDF_MIN_EXTRACTED_TEXT_CHARS;
}

/**
 * Validates extracted PDF text against canonical cv.md facts.
 * Specifically checks invariants: GPA 85, institution HIT, dates, companies.
 *
 * @param {string} pdfText - Raw text extracted from PDF via pdftotext
 * @param {string} cvMdContent - Content of cv.md
 * @returns {{ passed: boolean, details: Record<string, boolean>, errors: string[] }}
 */
export function checkSourceBackedFactuality(pdfText, sourcePaths = [], configPath) {
  const existingSources = sourcePaths.filter((path) => existsSync(resolve(path)));
  if (!existingSources.length) {
    return { passed: false, verdict: 'block', details: {}, errors: ['Source-backed factuality requires at least one available canonical CV source.'] };
  }
  try {
    const result = verifyFacts(pdfText, { sourcePaths: existingSources, ...(configPath ? { configPath } : {}) });
    return {
      passed: result.verdict !== 'block', verdict: result.verdict,
      details: { invented: result.invented.length, unsupportedFacts: result.unsupportedFacts.length,
        forbidden: result.forbidden.length, warnings: result.warnings.length, advisoryFacts: result.advisoryFacts.length,
        coverage: Boolean(result.coverage), configMissing: result.configMissing },
      errors: result.verdict === 'block' ? ['Source-backed factuality rejected unsupported or invented claims.'] : []
    };
  } catch (error) {
    return { passed: false, verdict: 'block', details: {}, errors: [`Source-backed factuality could not run: ${error.message}`] };
  }
}

export function checkFactuality(pdfText, cvMdContent) {
  const errors = [];
  const details = {};

  // 1. Invariant GPA 85
  const gpaMatch = pdfText.includes('85') && /GPA[:\s]+85/i.test(pdfText);
  details.gpa85 = gpaMatch;
  if (!gpaMatch) {
    errors.push('Invariant violated: GPA 85 not found in compiled PDF');
  }

  // 2. Invariant Institution HIT
  const hitMatch = pdfText.includes('Holon Institute of Technology') || /\bHIT\b/.test(pdfText);
  details.institutionHit = hitMatch;
  if (!hitMatch) {
    errors.push('Invariant violated: Institution HIT / Holon Institute of Technology not found in compiled PDF');
  }

  // 3. Invariant Company: IDF MAG Corps
  const idfMatch = pdfText.includes('IDF MAG Corps') || (pdfText.includes('IDF') && pdfText.includes('MAG Corps'));
  details.companyIdfMag = idfMatch;
  if (!idfMatch) {
    errors.push('Invariant violated: Company "IDF MAG Corps" not found in compiled PDF');
  }

  // 4. Invariant Dates: March 2026 – September 2026, Graduation 2026
  const dateMatch = pdfText.includes('2026') && (pdfText.includes('March') || pdfText.includes('September'));
  details.dates2026 = dateMatch;
  if (!dateMatch) {
    errors.push('Invariant violated: Key dates (March 2026 / September 2026) not found in compiled PDF');
  }

  return {
    passed: errors.length === 0,
    details,
    errors
  };
}

/** Revalidates a persisted PDF after a crash between artifact and state publication. */
export function validatePdfArtifact(pdfPath, { sourcePaths = [], configPath, execFileSyncImpl = execFileSync } = {}) {
  const result = { success: false, pageCount: 0, textCharCount: 0, factuality: { passed: false, verdict: 'block', details: {}, errors: [] }, errors: [] };
  if (typeof pdfPath !== 'string' || !existsSync(pdfPath) || !sourcePaths.some((path) => existsSync(resolve(path)))) {
    result.errors.push('Persisted PDF or canonical source evidence is unavailable.');
    return result;
  }
  let extractedText = '';
  try {
    const info = execFileSyncImpl('pdfinfo', [pdfPath], { encoding: 'utf8', timeout: 30_000 });
    result.pageCount = Number(info.match(/Pages:\s+(\d+)/)?.[1] || 0);
  } catch (error) { result.errors.push(`pdfinfo failed: ${error.message}`); }
  try {
    extractedText = execFileSyncImpl('pdftotext', [pdfPath, '-'], { encoding: 'utf8', timeout: 30_000 });
    result.textCharCount = extractedText.length;
  } catch (error) { result.errors.push(`pdftotext failed: ${error.message}`); }
  if (result.pageCount !== PDF_PAGE_COUNT_REQUIRED) result.errors.push(`Persisted PDF must have exactly ${PDF_PAGE_COUNT_REQUIRED} page.`);
  if (result.textCharCount <= PDF_MIN_EXTRACTED_TEXT_CHARS) result.errors.push(`Persisted PDF must contain more than ${PDF_MIN_EXTRACTED_TEXT_CHARS} extractable characters.`);
  result.factuality = checkSourceBackedFactuality(extractedText, sourcePaths, configPath);
  result.errors.push(...result.factuality.errors);
  result.success = result.errors.length === 0 && hasCanonicalPdfQuality(result.pageCount, result.textCharCount) && result.factuality.passed;
  return result;
}

/**
 * Compiles and validates a LaTeX CV file or content.
 *
 * @param {string} texInput - Path to .tex file OR raw .tex content
 * @param {object} [options]
 * @param {string} [options.cvMdPath] - Path to cv.md (default: 'cv.md')
 * @param {'source-backed'} [options.factualityMode] - Use the supplied canonical source set instead of legacy candidate-specific checks.
 * @param {string[]} [options.sourcePaths] - Canonical Markdown evidence files required by source-backed mode.
 * @param {string} [options.configPath] - Optional fact-policy configuration path.
 * @param {string} [options.outputDir] - Directory for compilation (default: isolated tmpdir)
 * @param {boolean} [options.keepArtifacts] - Whether to keep generated PDF
 * @returns {Promise<{
 *   success: boolean,
 *   compileExitCode: number,
 *   pageCount: number,
 *   textCharCount: number,
 *   factuality: { passed: boolean, details: object, errors: string[] },
 *   pdfPath: string | null,
 *   outputDir: string,
 *   errors: string[]
 * }>}
 */
export async function validatePdf(texInput, options = {}) {
  const cvMdPath = resolve(options.cvMdPath || 'cv.md');
  const cvMdContent = existsSync(cvMdPath) ? readFileSync(cvMdPath, 'utf-8') : '';

  const outputDir = options.outputDir
    ? resolve(options.outputDir)
    : mkdtempSync(join(tmpdir(), 'cv-pipeline-val-'));

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  let texFilePath;
  if (existsSync(texInput)) {
    // texInput is a path
    const originalTex = readFileSync(texInput, 'utf-8');
    texFilePath = join(outputDir, basename(texInput));
    writeFileSync(texFilePath, originalTex, 'utf-8');
  } else {
    // texInput is raw LaTeX content
    texFilePath = join(outputDir, 'cv.tex');
    writeFileSync(texFilePath, texInput, 'utf-8');
  }

  const result = {
    success: false,
    compileExitCode: -1,
    pageCount: 0,
    textCharCount: 0,
    factuality: { passed: false, details: {}, errors: [] },
    pdfPath: null,
    outputDir,
    errors: []
  };

  const execFileSyncImpl = options.execFileSyncImpl || execFileSync;
  const sourceBacked = options.factualityMode === 'source-backed';
  if (options.factualityMode && !sourceBacked) throw new Error(`Unsupported PDF factuality mode: ${options.factualityMode}`);
  if (sourceBacked && (!Array.isArray(options.sourcePaths) || !options.sourcePaths.some((path) => existsSync(resolve(path))))) {
    result.errors.push('Source-backed factuality requires an available canonical CV source.');
    return result;
  }

  // 1. Two-pass pdflatex compilation. Shell escape is disabled and compiler
  // execution is time-bounded even when compiling a canonical user template.
  try {
    // Pass 1
    execFileSyncImpl('pdflatex', [
      '-interaction=nonstopmode', '-no-shell-escape',
      `-output-directory=${outputDir}`,
      texFilePath
    ], { stdio: 'pipe', cwd: outputDir, timeout: 30_000 });

    // Pass 2 (resolves cross-references, outlines, geometry)
    execFileSyncImpl('pdflatex', [
      '-interaction=nonstopmode', '-no-shell-escape',
      `-output-directory=${outputDir}`,
      texFilePath
    ], { stdio: 'pipe', cwd: outputDir, timeout: 30_000 });

    result.compileExitCode = 0;
  } catch (err) {
    result.compileExitCode = err.status || 1;
    result.errors.push(`pdflatex compilation failed with status ${result.compileExitCode}: ${err.message}`);
    return result;
  }

  const pdfFileName = basename(texFilePath).replace(/\.tex$/, '.pdf');
  const pdfPath = join(outputDir, pdfFileName);

  if (!existsSync(pdfPath)) {
    result.errors.push(`Compiled PDF not found at ${pdfPath}`);
    return result;
  }
  result.pdfPath = pdfPath;

  // 2. Page count check via pdfinfo
  try {
    const infoOutput = execFileSyncImpl('pdfinfo', [pdfPath], { encoding: 'utf-8', timeout: 30_000, cwd: outputDir });
    const match = infoOutput.match(/Pages:\s+(\d+)/);
    if (match) {
      result.pageCount = parseInt(match[1], 10);
    } else {
      result.errors.push('Could not determine page count from pdfinfo output');
    }
  } catch (err) {
    result.errors.push(`pdfinfo failed: ${err.message}`);
  }

  if (result.pageCount !== PDF_PAGE_COUNT_REQUIRED) {
    result.errors.push(`Page count check failed: expected exactly ${PDF_PAGE_COUNT_REQUIRED} page, found ${result.pageCount}`);
  }

  // 3. Text extractability check via pdftotext (> 1000 chars)
  let extractedText = '';
  try {
    extractedText = execFileSyncImpl('pdftotext', [pdfPath, '-'], { encoding: 'utf-8', timeout: 30_000, cwd: outputDir });
    result.textCharCount = extractedText.length;
  } catch (err) {
    result.errors.push(`pdftotext failed: ${err.message}`);
  }

  if (result.textCharCount <= PDF_MIN_EXTRACTED_TEXT_CHARS) {
    result.errors.push(`Text extractability check failed: extracted ${result.textCharCount} chars (required > ${PDF_MIN_EXTRACTED_TEXT_CHARS})`);
  }

  // 4. Either source-backed fact verification (production graph) or the legacy
  // candidate-specific checks (standalone compatibility path).
  result.factuality = sourceBacked
    ? checkSourceBackedFactuality(extractedText, options.sourcePaths, options.configPath)
    : checkFactuality(extractedText, cvMdContent);
  if (!result.factuality.passed) {
    result.errors.push(...result.factuality.errors);
  }

  result.success = result.compileExitCode === 0 &&
    hasCanonicalPdfQuality(result.pageCount, result.textCharCount) &&
    result.factuality.passed &&
    result.errors.length === 0;

  return result;
}
